/**
 * Floe Pi extension — the main integration point between Pi and the Floe daemon.
 *
 * When loaded by Pi (via `pi install` or global ~/.pi/agent/extensions/),
 * this extension:
 *
 * 1. Starts or connects to the Floe daemon on session_start
 * 2. Registers Floe-specific tools so the agent can manage features, workers, etc.
 * 3. Registers /floe commands for user interaction
 * 4. Shuts down the daemon cleanly on session_shutdown
 *
 * The user-facing agent IS Pi with this extension loaded. The "floe" identity
 * comes from the role prompt loaded as a Pi skill or AGENTS.md.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DaemonService } from "../daemon/service.ts";
import { DaemonServer } from "../daemon/server.ts";
import { PiSubstrate } from "../daemon/pi-substrate.ts";
import { sendDaemonRequest } from "../daemon/client.ts";

let daemonService: DaemonService | null = null;
let daemonServer: DaemonServer | null = null;

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

async function ensureDaemon(projectRoot: string): Promise<string> {
  const socketPath = getSocketPath(projectRoot);

  // Already running in this process?
  if (daemonService) return socketPath;

  // Try connecting to existing daemon
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
  let projectRoot = process.cwd();
  let socketPath: string | null = null;

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
    promptSnippet: "floe_manage_feature - Start a feature implementation workflow",
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
    promptSnippet: "floe_feature_status - Check feature run status",
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
    promptSnippet: "floe_call_resolve - Resolve a worker's blocking call",
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
    promptSnippet: "floe_worker_status - Check worker status",
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
      // List all workers
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
    promptSnippet: "floe_events - View run event history",
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
