#!/usr/bin/env bun
/**
 * floe-async-worker — background subprocess for async message dispatch.
 *
 * Launched by the main CLI when --async is used. Runs message-worker
 * (or launch-worker --message) in its own process, writing the result
 * to a result file when complete.
 *
 * Usage (internal — called by floe.ts, not directly by users):
 *   bun run .floe/bin/async-worker.ts \
 *     --session <id> --message "<msg>" --result-path <path> \
 *     [--provider <p>] [--role-content-path <p>]
 *
 * For launch+message:
 *   bun run .floe/bin/async-worker.ts \
 *     --launch --role <role> --provider <p> --feature <id> --message "<msg>" \
 *     --result-path <path> [--epic <id>] [--release <id>] [--context <ctx>]
 */

import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { SessionRegistry } from "../runtime/registry.ts";
import { ResultStore } from "../runtime/results.ts";
import type { ProviderAdapter } from "../runtime/adapters/interface.ts";
import { dirname, join } from "node:path";

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if ([".git", ".floe", ".github", ".agents", ".claude"].some(m => existsSync(join(dir, m)))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const { values: opts } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    session: { type: "string" },
    message: { type: "string" },
    "result-path": { type: "string" },
    provider: { type: "string" },
    "role-content-path": { type: "string" },
    launch: { type: "boolean" },
    role: { type: "string" },
    feature: { type: "string" },
    epic: { type: "string" },
    release: { type: "string" },
    context: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
  },
  strict: false,
});

const projectRoot = findProjectRoot();
const registry = new SessionRegistry(projectRoot);
const resultStore = new ResultStore(projectRoot);

async function loadAdapter(provider: string): Promise<ProviderAdapter> {
  switch (provider) {
    case "codex": {
      const { CodexAdapter } = await import("../runtime/adapters/codex.ts");
      return new CodexAdapter();
    }
    case "claude": {
      const { ClaudeAdapter } = await import("../runtime/adapters/claude.ts");
      return new ClaudeAdapter();
    }
    case "copilot": {
      const { CopilotAdapter } = await import("../runtime/adapters/copilot.ts");
      return new CopilotAdapter();
    }
    default:
      throw new Error(`No adapter for provider: ${provider}`);
  }
}

function readRoleContent(role: string): string | undefined {
  const candidates = [
    join(projectRoot, ".floe", "roles", `${role}.md`),
    join(projectRoot, "skills", "floe-exec", "roles", `${role}.md`),
    join(projectRoot, ".github", "skills", "floe-exec", "roles", `${role}.md`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return readFileSync(p, "utf-8"); } catch { /* skip */ }
    }
  }
  return undefined;
}

async function run() {
  const resultPath = opts["result-path"] as string;
  if (!resultPath) {
    console.error("Missing --result-path");
    process.exit(1);
  }

  const message = opts.message as string;
  if (!message) {
    resultStore.writeError(resultPath, "Missing --message");
    process.exit(1);
  }

  try {
    if (opts.launch) {
      // Launch + message in one shot
      const role = opts.role as string;
      const provider = opts.provider as string;
      const feature = opts.feature as string;
      if (!role || !provider) {
        resultStore.writeError(resultPath, "launch mode requires --role and --provider");
        process.exit(1);
      }

      const adapter = await loadAdapter(provider);
      const roleContent = readRoleContent(role);

      const session = await adapter.startSession({
        role: role as any,
        provider: provider as any,
        featureId: feature,
        epicId: opts.epic as string | undefined,
        releaseId: opts.release as string | undefined,
        roleContent,
        contextAddendum: opts.context as string | undefined,
        model: opts.model as string | undefined,
        thinking: opts.thinking as string | undefined,
      });

      registry.register(session);
      const msgResult = await adapter.sendMessage(session.id, message);
      const now = new Date().toISOString();
      const fresh = adapter.getSession(session.id);
      registry.update(session.id, { lastMessageAt: now, metadata: fresh?.metadata ?? session.metadata });

      resultStore.writeComplete(resultPath, msgResult.content, msgResult.finishReason, msgResult.usage);
    } else {
      // Message existing session
      const sessionId = opts.session as string;
      if (!sessionId) {
        resultStore.writeError(resultPath, "Missing --session");
        process.exit(1);
      }

      const stored = registry.get(sessionId);
      if (!stored) {
        resultStore.writeError(resultPath, `Session not found: ${sessionId}`);
        process.exit(1);
      }

      const adapter = await loadAdapter(stored.provider);

      // Auto-resume for cross-process
      if (!adapter.hasSession(sessionId)) {
        let roleContent: string | undefined;
        if (stored.roleContentPath && existsSync(stored.roleContentPath)) {
          try { roleContent = readFileSync(stored.roleContentPath, "utf-8"); } catch { /* skip */ }
        }
        await adapter.resumeSession(sessionId, stored, roleContent ? { roleContent } : undefined);
      }

      const msgResult = await adapter.sendMessage(sessionId, message);
      const now = new Date().toISOString();
      const fresh = adapter.getSession(sessionId);
      registry.update(sessionId, { lastMessageAt: now, metadata: fresh?.metadata });

      resultStore.writeComplete(resultPath, msgResult.content, msgResult.finishReason, msgResult.usage);
    }
  } catch (err: any) {
    resultStore.writeError(resultPath, err.message ?? String(err));
    process.exit(1);
  }
}

run();
