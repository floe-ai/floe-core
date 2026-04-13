/**
 * Floe Pi extension — the main integration point between Pi and the Floe daemon.
 *
 * When loaded by Pi (via `bin/floe` or `pi -e`), this extension:
 *
 * 1. Provides skill/prompt paths via resources_discover
 * 2. Injects the Floe identity into the system prompt via before_agent_start
 * 3. Connects to the Floe daemon (started by bin/floe as a separate Bun process)
 * 4. Registers Floe tools for feature management, worker coordination, etc.
 * 5. Runs onboarding when the project is not yet configured
 *
 * The extension does NOT start the daemon — that's handled by bin/floe.
 * The extension only communicates with the daemon over the Unix socket.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

// ── Node-compatible daemon client (inlined to avoid import issues) ────

interface DaemonRequest {
  id: string;
  action: string;
  payload?: Record<string, unknown>;
}

interface DaemonResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

function sendDaemonRequest(
  endpoint: string,
  action: string,
  payload?: Record<string, unknown>,
): Promise<DaemonResponse> {
  const request: DaemonRequest = {
    id: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    action,
    payload,
  };

  return new Promise<DaemonResponse>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let done = false;
    let buffer = "";

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        socket.removeAllListeners();
        try { socket.end(); } catch {}
        reject(new Error("Daemon request timed out after 10s"));
      }
    }, 10_000);

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      try { socket.end(); } catch {}
      fn();
    };

    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;

      const line = buffer.slice(0, idx).trim();
      if (!line) {
        finish(() => reject(new Error("Empty daemon response")));
        return;
      }

      try {
        const response = JSON.parse(line) as DaemonResponse;
        finish(() => resolve(response));
      } catch (error: any) {
        finish(() => reject(new Error(`Invalid daemon response: ${error?.message}`)));
      }
    });

    socket.on("error", (error) => {
      finish(() => reject(error));
    });

    socket.on("end", () => {
      if (!done && buffer.trim()) {
        try {
          const response = JSON.parse(buffer.trim()) as DaemonResponse;
          finish(() => resolve(response));
        } catch {
          finish(() => reject(new Error("Daemon closed connection without valid response")));
        }
      }
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Resolve the package root (1 level up from extensions/). */
function packageRoot(): string {
  const thisDir =
    (typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url)));
  return resolve(thisDir, "..");
}

function getSocketPath(projectRoot: string): string {
  return join(projectRoot, ".floe", "state", "daemon", "daemon.sock");
}

function ensureFloeInit(projectRoot: string): void {
  const floeDir = join(projectRoot, ".floe");
  // Check config.json specifically — .floe/ may already exist because
  // bin/floe creates .floe/state/daemon/ before Pi starts.
  if (existsSync(join(floeDir, "config.json"))) return;

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

// ── Extension ─────────────────────────────────────────────────────────

export default function floeExtension(pi: ExtensionAPI) {
  const projectRoot = process.cwd();
  const pkgRoot = packageRoot();
  let socketPath: string | null = null;
  let daemonAvailable = false;

  // ─── Resource discovery ──────────────────────────────────────────────
  // Provide skill and prompt paths so Pi discovers them regardless of
  // how floe was loaded (package install or -e flag).

  pi.on("resources_discover", async () => {
    return {
      skillPaths: [join(pkgRoot, "skills")],
      promptPaths: [join(pkgRoot, "prompts")],
    };
  });

  // ─── Identity injection ─────────────────────────────────────────────
  // Append the Floe role prompt to Pi's system prompt. This makes the
  // agent BE Floe while preserving Pi's tool usage guidelines.

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

  pi.on("session_start", async (_event, ctx) => {
    ensureFloeInit(projectRoot);

    // Stamp FLOE_ROOT into process.env so Pi's bash tool (child processes)
    // inherit it. bin/floe also exports it, but setting it here ensures it
    // is always available regardless of how the extension was loaded.
    if (!process.env.FLOE_ROOT) {
      process.env.FLOE_ROOT = pkgRoot;
    }

    // Check if daemon is available (started by bin/floe or manually)
    socketPath = getSocketPath(projectRoot);
    try {
      const result = await sendDaemonRequest(socketPath, "runtime.status");
      if (result && result.ok) {
        daemonAvailable = true;
      }
    } catch {
      daemonAvailable = false;
      // Daemon not running — tools will report this if called
    }
  });

  pi.on("session_shutdown", async () => {
    daemonAvailable = false;
    socketPath = null;
  });

  // ─── Helper: send daemon request ─────────────────────────────────────

  async function daemon(action: string, payload: Record<string, unknown> = {}): Promise<any> {
    if (!socketPath) throw new Error("Floe daemon socket path not set");
    if (!daemonAvailable) throw new Error("Floe daemon is not running. Start floe using the 'floe' command.");
    const response = await sendDaemonRequest(socketPath, action, payload);
    if (!response.ok) throw new Error(response.error ?? "Daemon request failed");
    return response.result;
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
    handler: async (_args, ctx) => {
      try {
        const result = await daemon("runtime.status", {});
        ctx.ui.notify(JSON.stringify(result, null, 2), "info");
      } catch (err: any) {
        ctx.ui.notify(`Daemon not available: ${err?.message ?? err}`, "error");
      }
    },
  });

  pi.registerCommand("floe-shutdown", {
    description: "Shut down the Floe daemon",
    handler: async (_args, ctx) => {
      try {
        await daemon("runtime.shutdown", {});
        daemonAvailable = false;
        ctx.ui.notify("Floe daemon shut down", "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed to shut down daemon: ${err?.message ?? err}`, "error");
      }
    },
  });
}
