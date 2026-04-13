/**
 * Floe Pi extension — the main integration point between Pi and the Floe daemon.
 *
 * When loaded by Pi (via `pi install`), this extension:
 *
 * 1. Injects the Floe identity into the system prompt via before_agent_start
 * 2. Starts the Floe daemon on session_start
 * 3. Registers Floe tools for feature management, worker coordination, etc.
 * 4. Runs onboarding when the project is not yet configured
 * 5. Shuts down the daemon cleanly on session_shutdown
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DaemonService } from "../daemon/service.ts";
import { DaemonServer } from "../daemon/server.ts";
import { PiSubstrate } from "../daemon/pi-substrate.ts";
import { sendDaemonRequest } from "../daemon/client.ts";

let daemonService: DaemonService | null = null;
let daemonServer: DaemonServer | null = null;

/** Resolve the package root (1 level up from extensions/). */
function packageRoot(): string {
  const thisDir =
    (import.meta as any).dir ??
    (typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url)));
  return resolve(thisDir, "..");
}

function getSocketPath(projectRoot: string): string {
  const stateDir = join(projectRoot, ".floe", "state", "daemon");
  mkdirSync(stateDir, { recursive: true });
  return join(stateDir, "daemon.sock");
}

function ensureFloeInit(projectRoot: string): void {
  const floeDir = join(projectRoot, ".floe");
  if (existsSync(floeDir)) return;

  mkdirSync(floeDir, { recursive: true });
  mkdirSync(join(floeDir, "state"), { recursive: true });

  writeFileSync(
    join(floeDir, "config.json"),
    JSON.stringify({ defaultProvider: "pi", configured: false }, null, 2),
  );
  writeFileSync(
    join(floeDir, "dod.json"),
    JSON.stringify({
      criteria: [
        "Code compiles and passes all existing tests",
        "New behaviour has test coverage",
        "No regressions introduced",
        "Changes follow existing project conventions",
      ],
    }, null, 2),
  );
  writeFileSync(join(floeDir, ".gitignore"), "state/\n*.log\n");
}

function loadFloeConfig(projectRoot: string): Record<string, any> {
  const configPath = join(projectRoot, ".floe", "config.json");
  if (!existsSync(configPath)) return { configured: false };
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return { configured: false };
  }
}

function loadRolePrompt(): string {
  const rolePath = join(packageRoot(), "prompts", "floe.md");
  if (existsSync(rolePath)) {
    return readFileSync(rolePath, "utf-8");
  }
  return "You are Floe, an AI agent for structured software delivery. Help the user plan, implement, and review their software projects.";
}

async function ensureDaemon(projectRoot: string): Promise<string> {
  const socketPath = getSocketPath(projectRoot);

  if (daemonService) return socketPath;

  try {
    const result = await sendDaemonRequest(socketPath, {
      action: "runtime.status",
      payload: {},
    });
    if (result && (result as any).ok !== false) return socketPath;
  } catch {
    // Not running — start one
  }

  daemonService = new DaemonService(projectRoot, socketPath);
  const piSubstrate = new PiSubstrate();
  daemonService.setSubstrate(piSubstrate);
  await daemonService.init();

  daemonServer = new DaemonServer(daemonService, socketPath);
  await daemonServer.start();

  return socketPath;
}

export default function floeExtension(pi: ExtensionAPI) {
  const projectRoot = process.cwd();
  let socketPath: string | null = null;

  // ─── Identity injection ─────────────────────────────────────────────
  // Use before_agent_start to inject the Floe role prompt into the system
  // prompt. This makes the agent BE Floe from the first message.

  pi.on("before_agent_start", async (event) => {
    const floeRole = loadRolePrompt();
    const config = loadFloeConfig(projectRoot);

    let systemPrompt = event.systemPrompt + "\n\n" + floeRole;

    if (!config.configured) {
      systemPrompt += `\n\n## Onboarding Required\n\nThis project has not been configured for Floe yet. The file \`.floe/config.json\` has \`configured: false\`.\n\nBefore proceeding with any work, run the floe-preflight skill (/skill:floe-preflight) to set up the project. This will configure the model, source root, and other settings.\n\nDo this automatically — do not wait for the user to ask.`;
    }

    return { systemPrompt };
  });

  // ─── Lifecycle ───────────────────────────────────────────────────────

  pi.on("session_start", async () => {
    ensureFloeInit(projectRoot);
    socketPath = await ensureDaemon(projectRoot);
  });

  pi.on("session_shutdown", async () => {
    if (daemonServer) {
      daemonServer.close();
      daemonServer = null;
    }
    daemonService = null;
  });

  // ─── Helper: send daemon request ─────────────────────────────────────

  async function daemon(action: string, payload: Record<string, unknown> = {}): Promise<any> {
    if (!socketPath) throw new Error("Floe daemon not started");
    return sendDaemonRequest(socketPath, { action, payload });
  }

  // ─── Tools ───────────────────────────────────────────────────────────

  pi.registerTool({
    name: "floe_manage_feature",
    label: "Manage Feature",
    description: "Start a feature implementation with coordinated implementer and reviewer workers. Launches a daemon-managed workflow that handles the full implementation lifecycle.",
    promptSnippet: "Use floe_manage_feature to start feature implementation workflows with autonomous implementer + reviewer cycles.",
    parameters: Type.Object({
      featureId: Type.String({ description: "Feature identifier" }),
      epicId: Type.Optional(Type.String({ description: "Parent epic identifier" })),
      releaseId: Type.Optional(Type.String({ description: "Parent release identifier" })),
      srcRoot: Type.Optional(Type.String({ description: "Source root directory for the project" })),
    }),
    execute: async (_toolCallId, params) => {
      const result = await daemon("run.feature", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "floe_feature_status",
    label: "Feature Run Status",
    description: "Get the status of a running feature implementation, including worker states and pending calls.",
    promptSnippet: "Use floe_feature_status to check the status of feature runs.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "Run ID to check" })),
      featureId: Type.Optional(Type.String({ description: "Feature ID to look up" })),
    }),
    execute: async (_toolCallId, params) => {
      const result = await daemon("run.get", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "floe_call_resolve",
    label: "Resolve Blocking Call",
    description: "Resolve a pending blocking call from a worker (e.g., approve or reject a review).",
    promptSnippet: "Use floe_call_resolve to resolve blocking calls (review approvals, approach decisions).",
    parameters: Type.Object({
      callId: Type.String({ description: "The blocking call ID to resolve" }),
      response: Type.String({ description: "JSON response payload" }),
      resolvedBy: Type.String({ description: "Who resolved this (e.g., 'reviewer', 'floe')" }),
    }),
    execute: async (_toolCallId, params) => {
      const result = await daemon("call.resolve", {
        callId: params.callId,
        responsePayload: JSON.parse(params.response),
        resolvedBy: params.resolvedBy,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "floe_worker_status",
    label: "Worker Status",
    description: "Get the status of a specific worker session or list all active workers.",
    promptSnippet: "Use floe_worker_status to check worker session status.",
    parameters: Type.Object({
      workerId: Type.Optional(Type.String({ description: "Specific worker ID" })),
    }),
    execute: async (_toolCallId, params) => {
      if (params.workerId) {
        const result = await daemon("worker.get", { workerId: params.workerId });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: {},
        };
      }
      const result = await daemon("runtime.status", {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "floe_events",
    label: "Replay Events",
    description: "Replay events for a specific run to see what happened.",
    promptSnippet: "Use floe_events to view event history for a feature run.",
    parameters: Type.Object({
      runId: Type.String({ description: "Run ID to replay events for" }),
      cursor: Type.Optional(Type.Number({ description: "Start from this sequence number" })),
      limit: Type.Optional(Type.Number({ description: "Max events to return" })),
    }),
    execute: async (_toolCallId, params) => {
      const result = await daemon("events.replay", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });

  // ─── Commands ────────────────────────────────────────────────────────

  pi.registerCommand("floe-status", {
    description: "Show Floe daemon and worker status",
    execute: async (ctx) => {
      const result = await daemon("runtime.status", {});
      ctx.ui.notify(JSON.stringify(result, null, 2), "info");
    },
  });

  pi.registerCommand("floe-shutdown", {
    description: "Shut down the Floe daemon",
    execute: async (ctx) => {
      if (daemonServer) {
        daemonServer.close();
        daemonServer = null;
        daemonService = null;
        ctx.ui.notify("Floe daemon shut down", "info");
      }
    },
  });
}
