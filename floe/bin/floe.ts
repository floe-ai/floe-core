#!/usr/bin/env bun
/**
 * floe CLI — worker session management for the floe execution framework.
 *
 * Usage: bun run .floe/bin/floe.ts <command> [options]
 *
 * Commands:
 *   launch-worker        Launch a new worker session
 *   resume-worker        Resume an existing session
 *   message-worker       Send a message to an active worker
 *   get-worker-status    Get session status
 *   replace-worker       Stop and re-launch a worker
 *   stop-worker          Stop a worker session
 *   list-active-workers  List all active sessions
 *   manage-feature-pair  Launch implementer + reviewer pair
 *   check-alignment      Check approach alignment status for a feature
 *
 * Provider env vars:
 *   ANTHROPIC_API_KEY   — required for Claude adapter
 *   OPENAI_API_KEY      — optional for Codex (falls back to local sign-in)
 *   FLOE_PROVIDER       — default provider: codex|claude|copilot|mock (default: mock)
 */

import { parseArgs } from "node:util";
import { SessionRegistry } from "../runtime/registry.ts";
import type { ProviderAdapter } from "../runtime/adapters/interface.ts";
import { MockAdapter } from "../runtime/adapters/mock.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── Adapter registry ────────────────────────────────────────────────

const adapters = new Map<string, ProviderAdapter>();
adapters.set("mock", new MockAdapter());

async function loadLiveAdapters(): Promise<void> {
  try {
    // @ts-ignore — optional peer dependency
    const { CodexAdapter } = await import("../runtime/adapters/codex.ts");
    adapters.set("codex", new CodexAdapter());
  } catch {}

  try {
    // @ts-ignore — optional peer dependency
    const { ClaudeAdapter } = await import("../runtime/adapters/claude.ts");
    adapters.set("claude", new ClaudeAdapter());
  } catch {}

  try {
    // @ts-ignore — optional peer dependency
    const { CopilotAdapter } = await import("../runtime/adapters/copilot.ts");
    adapters.set("copilot", new CopilotAdapter());
  } catch {}
}

// ─── Project root detection ──────────────────────────────────────────

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

// ─── Role content loading ────────────────────────────────────────────

function readRoleContent(role: string, projectRoot: string): { content: string | undefined; path: string | undefined } {
  const candidates = [
    join(projectRoot, ".floe", "roles", `${role}.md`),
    join(projectRoot, "skills", "floe-exec", "roles", `${role}.md`),
    join(projectRoot, ".github", "skills", "floe-exec", "roles", `${role}.md`),
    join(projectRoot, ".agents", "skills", "floe-exec", "roles", `${role}.md`),
    join(projectRoot, ".claude", "skills", "floe-exec", "roles", `${role}.md`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return { content: readFileSync(p, "utf-8"), path: p };
    }
  }
  return { content: undefined, path: undefined };
}

// ─── Validation helpers ──────────────────────────────────────────────

function featureArtefactExists(featureId: string, projectRoot: string): boolean {
  const featuresDir = join(projectRoot, "delivery", "features");
  if (!existsSync(featuresDir)) return false;
  return existsSync(join(featuresDir, `${featureId}.json`));
}

function artefactExists(type: string, id: string, projectRoot: string): boolean {
  const dir = join(projectRoot, "delivery", `${type}s`);
  if (!existsSync(dir)) return false;
  return existsSync(join(dir, `${id}.json`));
}

function getAlignmentStatus(featureId: string, projectRoot: string): {
  hasReview: boolean;
  approachStatus: string | null;
  reviewId: string | null;
} {
  const reviewsDir = join(projectRoot, "delivery", "reviews");
  if (!existsSync(reviewsDir)) return { hasReview: false, approachStatus: null, reviewId: null };

  const files = readdirSync(reviewsDir).filter(f => f.endsWith(".json"));
  for (const f of files) {
    try {
      const review = JSON.parse(readFileSync(join(reviewsDir, f), "utf-8"));
      if (review.target_id === featureId && review.status === "open") {
        const status = review.approach_proposal?.verdict ?? null;
        return { hasReview: true, approachStatus: status, reviewId: review.id };
      }
    } catch {}
  }
  return { hasReview: false, approachStatus: null, reviewId: null };
}

// ─── Commands ────────────────────────────────────────────────────────

const projectRoot = findProjectRoot();
const registry = new SessionRegistry(projectRoot);

async function launchWorker(args: Record<string, any>) {
  const role = args.role;
  if (!role) return { ok: false, error: "Missing required flag: --role" };

  const provider = args.provider ?? process.env.FLOE_PROVIDER ?? "mock";
  const adapter = adapters.get(provider);
  if (!adapter) return { ok: false, error: `No adapter for provider: ${provider}` };

  // Planner scope validation
  if (role === "planner") {
    const scope = args.scope;
    const target = args.target;
    if (!scope || !target) {
      return { ok: false, error: "launch-worker --role planner requires --scope <release|epic> and --target <id>" };
    }
    if (scope !== "release" && scope !== "epic") {
      return { ok: false, error: `Invalid --scope: ${scope}. Must be 'release' or 'epic'.` };
    }
    if (!artefactExists(scope, target, projectRoot)) {
      return { ok: false, error: `${scope} artefact not found: ${target}` };
    }
  }

  // Implementer/reviewer require feature
  if ((role === "implementer" || role === "reviewer") && !args.feature) {
    return { ok: false, error: `launch-worker --role ${role} requires --feature <id>` };
  }

  // Validate feature exists if provided
  if (args.feature && !featureArtefactExists(args.feature, projectRoot)) {
    return { ok: false, error: `Feature artefact not found: ${args.feature}. Create the feature via the Planner first.` };
  }

  const { content: roleContent, path: roleContentPath } = readRoleContent(role, projectRoot);

  const session = await adapter.startSession({
    role,
    provider,
    featureId: args.feature,
    epicId: args.epic,
    releaseId: args.release,
    roleContent,
    roleContentPath,
    contextAddendum: args.context,
  });

  registry.register(session);
  return { ok: true, sessionId: session.id, role: session.role, provider: session.provider, status: session.status };
}

async function resumeWorker(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const adapter = adapters.get(stored.provider);
  if (!adapter) return { ok: false, error: `No adapter for provider: ${stored.provider}` };

  let roleContent: string | undefined;
  if (stored.roleContentPath && existsSync(stored.roleContentPath)) {
    try { roleContent = readFileSync(stored.roleContentPath, "utf-8"); } catch {}
  }

  const session = await adapter.resumeSession(
    args.session,
    stored,
    roleContent ? { roleContent } : undefined
  );

  registry.update(args.session, { status: session.status, updatedAt: session.updatedAt });
  return { ok: true, sessionId: session.id, status: session.status };
}

async function messageWorker(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const adapter = adapters.get(stored.provider);
  if (!adapter) return { ok: false, error: `No adapter for provider: ${stored.provider}` };

  // Hard alignment gate: block implementer messages when approach not approved
  if (stored.role === "implementer" && stored.featureId && !args["force-no-alignment"]) {
    const alignment = getAlignmentStatus(stored.featureId, projectRoot);
    if (!alignment.hasReview || alignment.approachStatus !== "approved") {
      return {
        ok: false,
        error: "Approach not approved — implementer messages are blocked until the reviewer approves the execution approach.",
        featureId: stored.featureId,
        hasReview: alignment.hasReview,
        approachStatus: alignment.approachStatus,
        hint: "Use --force-no-alignment to override (visible, intentional override only).",
      };
    }
  }

  const result = await adapter.sendMessage(args.session, args.message);
  const now = new Date().toISOString();

  const updated = registry.get(args.session);
  registry.update(args.session, { lastMessageAt: now, metadata: updated?.metadata });

  return { ok: true, sessionId: args.session, content: result.content, finishReason: result.finishReason, usage: result.usage };
}

async function getWorkerStatus(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const adapter = adapters.get(stored.provider);
  if (!adapter) return { ok: false, error: `No adapter for provider: ${stored.provider}` };

  const status = await adapter.getStatus(args.session);
  return { ok: true, sessionId: args.session, role: stored.role, provider: stored.provider, status, featureId: stored.featureId };
}

async function replaceWorker(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const adapter = adapters.get(stored.provider);
  if (adapter) {
    await adapter.stopSession(args.session).catch(() => {});
    await adapter.closeSession(args.session).catch(() => {});
  }
  registry.setStatus(args.session, "stopped");

  const newSession = await launchWorker({
    role: stored.role,
    provider: stored.provider,
    feature: stored.featureId,
    epic: stored.epicId,
    release: stored.releaseId,
  });

  return { ok: true, replacedSessionId: args.session, newSessionId: (newSession as any).sessionId, reason: args.reason };
}

async function stopWorker(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const adapter = adapters.get(stored.provider);
  if (adapter) {
    await adapter.stopSession(args.session).catch(() => {});
    await adapter.closeSession(args.session).catch(() => {});
  }
  registry.setStatus(args.session, "stopped");

  return { ok: true, sessionId: args.session, stopped: true };
}

async function listActiveWorkers(args: Record<string, any>) {
  let sessions = registry.listActive();
  if (args.feature) sessions = sessions.filter(s => s.featureId === args.feature);

  return {
    ok: true,
    count: sessions.length,
    workers: sessions.map(s => ({
      id: s.id, role: s.role, provider: s.provider, status: s.status,
      featureId: s.featureId, createdAt: s.createdAt, lastMessageAt: s.lastMessageAt,
    })),
  };
}

async function manageFeaturePair(args: Record<string, any>) {
  if (!args.feature) return { ok: false, error: "manage-feature-pair requires --feature <id>" };

  // Validate feature artefact exists
  if (!featureArtefactExists(args.feature, projectRoot)) {
    return { ok: false, error: `Feature artefact not found: ${args.feature}. The Planner must create the feature before execution can begin.` };
  }

  const implProvider = args["implementer-provider"] ?? process.env.FLOE_PROVIDER ?? "mock";
  const revProvider = args["reviewer-provider"] ?? process.env.FLOE_PROVIDER ?? "mock";

  const [implementer, reviewer] = await Promise.all([
    launchWorker({ role: "implementer", provider: implProvider, feature: args.feature, epic: args.epic, release: args.release }),
    launchWorker({ role: "reviewer", provider: revProvider, feature: args.feature, epic: args.epic, release: args.release }),
  ]);

  return {
    ok: true,
    featureId: args.feature,
    implementer: { sessionId: (implementer as any).sessionId, provider: implProvider },
    reviewer: { sessionId: (reviewer as any).sessionId, provider: revProvider },
  };
}

async function checkAlignment(args: Record<string, any>) {
  if (!args.feature) return { ok: false, error: "check-alignment requires --feature <id>" };

  const alignment = getAlignmentStatus(args.feature, projectRoot);
  return {
    ok: true,
    featureId: args.feature,
    hasReview: alignment.hasReview,
    approachStatus: alignment.approachStatus,
    reviewId: alignment.reviewId,
    approved: alignment.approachStatus === "approved",
  };
}

// ─── CLI dispatch ────────────────────────────────────────────────────

const [command, ...rest] = Bun.argv.slice(2);

const { values: opts } = parseArgs({
  args: rest,
  options: {
    role: { type: "string" },
    provider: { type: "string" },
    feature: { type: "string" },
    epic: { type: "string" },
    release: { type: "string" },
    context: { type: "string" },
    session: { type: "string" },
    message: { type: "string" },
    reason: { type: "string" },
    scope: { type: "string" },
    target: { type: "string" },
    "implementer-provider": { type: "string" },
    "reviewer-provider": { type: "string" },
    "force-no-alignment": { type: "boolean" },
  },
  strict: false,
});

async function main() {
  await loadLiveAdapters();

  const commands: Record<string, (args: Record<string, any>) => Promise<any>> = {
    "launch-worker": launchWorker,
    "resume-worker": resumeWorker,
    "message-worker": messageWorker,
    "get-worker-status": getWorkerStatus,
    "replace-worker": replaceWorker,
    "stop-worker": stopWorker,
    "list-active-workers": listActiveWorkers,
    "manage-feature-pair": manageFeaturePair,
    "check-alignment": checkAlignment,
  };

  const handler = commands[command];
  if (!handler) {
    const available = Object.keys(commands).join(", ");
    console.log(JSON.stringify({ ok: false, error: `Unknown command: ${command}. Available: ${available}` }, null, 2));
    process.exit(1);
  }

  try {
    const result = await handler(opts);
    console.log(JSON.stringify(result, null, 2));
    if (!(result as any).ok) process.exit(1);
  } catch (err: any) {
    console.log(JSON.stringify({ ok: false, error: err.message ?? String(err) }, null, 2));
    process.exit(1);
  }
}

main();
