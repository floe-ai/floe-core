#!/usr/bin/env bun
/**
 * floe CLI — worker session management for the floe execution framework.
 *
 * Usage: bun run .floe/bin/floe.ts <command> [options]
 *
 * Commands:
 *   launch-worker        Launch a new worker session (optional --message, --async)
 *   resume-worker        Resume an existing session
 *   message-worker       Send a message to an active worker (optional --async)
 *   get-worker-status    Get session status
 *   get-worker-result    Get async worker result (--session or --result-path)
 *   wait-worker          Block until async worker completes (--session or --result-path, --timeout)
 *   replace-worker       Stop and re-launch a worker
 *   stop-worker          Stop a worker session
 *   list-active-workers  List all active sessions
 *   manage-feature-pair  Launch implementer + reviewer pair (starts autonomous feature runner)
 *   check-alignment      Check approach alignment status for a feature
 *   feature-run-status   Get status of an autonomous feature run
 *   show-dod             Show the project Definition of Done
 *   edit-dod             Open the DoD file in $EDITOR
 *   list-escalations     List escalation records (optional --status)
 *   resolve-escalation   Resolve an escalation (--escalation <id> --resolution '<text>')
 *   configure            Set up provider defaults (flags or discovery mode)
 *   show-config          Show current provider configuration
 *   list-models          List available models for a provider
 *   update-config        Update provider/model/thinking configuration
 *
 * Provider resolution order:
 *   1. --provider flag
 *   2. FLOE_PROVIDER env var
 *   3. .floe/config.json role-specific override
 *   4. .floe/config.json defaultProvider
 *   5. Error (no provider configured)
 *
 * Provider env vars:
 *   ANTHROPIC_API_KEY   — required for Claude adapter
 *   OPENAI_API_KEY      — optional for Codex (falls back to local sign-in)
 *   FLOE_PROVIDER       — override provider for all roles
 */

import { parseArgs } from "node:util";
import { createInterface } from "node:readline";

import { SessionRegistry } from "../runtime/registry.ts";
import { ResultStore } from "../runtime/results.ts";
import { loadDod, formatDodForPrompt } from "../runtime/dod.ts";
import type { ProviderAdapter } from "../runtime/adapters/interface.ts";
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── Adapter registry ────────────────────────────────────────────────

const adapters = new Map<string, ProviderAdapter>();

const adapterLoadErrors = new Map<string, string>();

async function loadLiveAdapters(): Promise<void> {
  try {
    // @ts-ignore — optional peer dependency
    const { CodexAdapter } = await import("../runtime/adapters/codex.ts");
    adapters.set("codex", new CodexAdapter());
  } catch (e: any) {
    adapterLoadErrors.set("codex", e.message ?? String(e));
  }

  try {
    // @ts-ignore — optional peer dependency
    const { ClaudeAdapter } = await import("../runtime/adapters/claude.ts");
    adapters.set("claude", new ClaudeAdapter());
  } catch (e: any) {
    adapterLoadErrors.set("claude", e.message ?? String(e));
  }

  try {
    // @ts-ignore — optional peer dependency
    const { CopilotAdapter } = await import("../runtime/adapters/copilot.ts");
    adapters.set("copilot", new CopilotAdapter());
  } catch (e: any) {
    adapterLoadErrors.set("copilot", e.message ?? String(e));
  }
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

// ─── Configuration ───────────────────────────────────────────────────

interface FloeConfig {
  defaultProvider: string;
  enabledProviders?: string[];
  configured?: boolean;
  roles?: {
    planner?: { provider?: string; model?: string; thinking?: string };
    implementer?: { provider?: string; model?: string; thinking?: string };
    reviewer?: { provider?: string; model?: string; thinking?: string };
  };
}

function loadConfig(projectRoot: string): FloeConfig | null {
  const configPath = join(projectRoot, ".floe", "config.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
}

function resolveProvider(role: string, args: Record<string, any>, config: FloeConfig | null): {
  provider: string;
  model?: string;
  thinking?: string;
  error?: string;
} {
  // 1. CLI flag
  if (args.provider) return validateEnabledProvider({ provider: args.provider }, config);

  // 2. Environment variable
  if (process.env.FLOE_PROVIDER) return validateEnabledProvider({ provider: process.env.FLOE_PROVIDER }, config);

  // 3. Config role-specific
  if (config?.roles) {
    const roleConfig = (config.roles as any)[role];
    if (roleConfig?.provider) {
      return validateEnabledProvider({ provider: roleConfig.provider, model: roleConfig.model, thinking: roleConfig.thinking }, config);
    }
  }

  // 4. Config default
  if (config?.defaultProvider) {
    const roleConfig = config.roles ? (config.roles as any)[role] : undefined;
    return validateEnabledProvider({
      provider: config.defaultProvider,
      model: roleConfig?.model,
      thinking: roleConfig?.thinking,
    }, config);
  }

  // 5. No provider configured
  return { provider: "" };
}

function validateEnabledProvider(
  resolved: { provider: string; model?: string; thinking?: string },
  config: FloeConfig | null,
): { provider: string; model?: string; thinking?: string; error?: string } {
  if (config?.enabledProviders && resolved.provider) {
    if (!config.enabledProviders.includes(resolved.provider)) {
      return {
        provider: "",
        error: `Provider '${resolved.provider}' is not enabled for this repo. Enabled: [${config.enabledProviders.join(", ")}]. Update .floe/config.json or run: bun run .floe/bin/floe.ts configure`,
      };
    }
  }
  return resolved;
}

function getAdapter(provider: string): { adapter: ProviderAdapter | null; error: string | null } {
  if (!provider) {
    return {
      adapter: null,
      error: "No provider configured. Run: bun run .floe/bin/floe.ts configure",
    };
  }
  const adapter = adapters.get(provider);
  if (!adapter) {
    const loadError = adapterLoadErrors.get(provider);
    const hint = loadError
      ? `Adapter for '${provider}' failed to load: ${loadError}`
      : `No adapter for provider: ${provider}`;
    return { adapter: null, error: hint };
  }
  return { adapter, error: null };
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
const resultStore = new ResultStore(projectRoot);

/**
 * Ensure a session is loaded in the adapter's in-memory map.
 * Each CLI invocation is a fresh process — the adapter's Map is empty.
 * This transparently resumes the session from the registry so callers
 * (message-worker, get-worker-status, etc.) don't need to worry about it.
 */
async function ensureResumed(
  adapter: ProviderAdapter,
  sessionId: string,
  stored: import("../runtime/types.ts").WorkerSession
): Promise<void> {
  if (adapter.hasSession(sessionId)) return;

  let roleContent: string | undefined;
  if (stored.roleContentPath && existsSync(stored.roleContentPath)) {
    try { roleContent = readFileSync(stored.roleContentPath, "utf-8"); } catch {}
  }

  const session = await adapter.resumeSession(
    sessionId,
    stored,
    roleContent ? { roleContent } : undefined
  );
  registry.update(sessionId, { status: session.status, updatedAt: session.updatedAt, metadata: session.metadata });
}

/**
 * Dispatch a message (or launch+message) in a background subprocess.
 * Returns immediately with the result file path for polling.
 */
function dispatchAsync(args: Record<string, any>): { ok: true; dispatched: true; sessionId?: string; resultPath: string } {
  const sessionId = args.session as string | undefined;
  const resultPath = resultStore.writePending(sessionId ?? "launch");

  const asyncWorkerPath = join(dirname(new URL(import.meta.url).pathname), "async-worker.ts");

  const subArgs: string[] = ["run", asyncWorkerPath, "--result-path", resultPath];

  if (args._launch) {
    subArgs.push("--launch");
    if (args.role) subArgs.push("--role", args.role);
    if (args.provider) subArgs.push("--provider", args.provider);
    if (args.feature) subArgs.push("--feature", args.feature);
    if (args.epic) subArgs.push("--epic", args.epic);
    if (args.release) subArgs.push("--release", args.release);
    if (args.context) subArgs.push("--context", args.context);
    if (args.model) subArgs.push("--model", args.model);
    if (args.thinking) subArgs.push("--thinking", args.thinking);
  } else {
    if (sessionId) subArgs.push("--session", sessionId);
  }

  if (args.message) subArgs.push("--message", args.message);

  const child = Bun.spawn(["bun", ...subArgs], {
    cwd: projectRoot,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();

  return { ok: true, dispatched: true, sessionId, resultPath };
}

async function launchWorker(args: Record<string, any>) {
  const role = args.role;
  if (!role) return { ok: false, error: "Missing required flag: --role" };

  const config = loadConfig(projectRoot);

  // Pre-flight: enabledProviders must be set
  if (!config?.enabledProviders) {
    return { ok: false, error: "Provider allowlist not set. Run: bun run .floe/bin/floe.ts configure" };
  }

  const resolved = resolveProvider(role, args, config);
  if (resolved.error) return { ok: false, error: resolved.error };
  const { adapter, error } = getAdapter(resolved.provider);
  if (!adapter) return { ok: false, error };

  // Planner scope validation
  if (role === "planner") {
    const scope = args.scope;
    const target = args.target;
    if (!scope || !target) {
      return { ok: false, error: "launch-worker --role planner requires --scope <intake|release|epic> and --target <id>" };
    }
    if (scope !== "intake" && scope !== "release" && scope !== "epic") {
      return { ok: false, error: `Invalid --scope: ${scope}. Must be 'intake', 'release', or 'epic'.` };
    }
    if (!artefactExists(scope === "intake" ? "release" : scope, target, projectRoot)) {
      return { ok: false, error: `${scope === "intake" ? "release" : scope} artefact not found: ${target}` };
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

  // Inject Definition of Done for reviewer and implementer roles
  let contextWithDod = args.context as string | undefined;
  if (role === "reviewer" || role === "implementer") {
    const dod = loadDod(projectRoot);
    if (dod) {
      const dodText = formatDodForPrompt(dod);
      contextWithDod = contextWithDod ? `${contextWithDod}\n\n${dodText}` : dodText;
    }
  }

  // Async dispatch: fork a background subprocess and return immediately
  if (args.async && args.message) {
    return dispatchAsync({ ...args, _launch: true, provider: resolved.provider, model: resolved.model, thinking: resolved.thinking });
  }

  const session = await adapter.startSession({
    role,
    provider: resolved.provider as any,
    featureId: args.feature,
    epicId: args.epic,
    releaseId: args.release,
    roleContent,
    roleContentPath,
    contextAddendum: contextWithDod,
    model: resolved.model,
    thinking: resolved.thinking,
  });

  registry.register(session);

  // If --message provided, send the initial task in the same process
  const result: Record<string, any> = {
    ok: true,
    sessionId: session.id,
    role: session.role,
    provider: session.provider,
    status: session.status,
  };

  if (args.message) {
    const msgResult = await adapter.sendMessage(session.id, args.message);
    const now = new Date().toISOString();
    const fresh = adapter.getSession(session.id);
    registry.update(session.id, { lastMessageAt: now, metadata: fresh?.metadata ?? session.metadata });
    result.content = msgResult.content;
    result.finishReason = msgResult.finishReason;
    result.usage = msgResult.usage;
  }

  return result;
}

async function resumeWorker(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const { adapter, error } = getAdapter(stored.provider);
  if (!adapter) return { ok: false, error };

  await ensureResumed(adapter, args.session, stored);
  const updated = registry.get(args.session);
  return { ok: true, sessionId: updated?.id ?? args.session, status: updated?.status ?? "active" };
}

async function messageWorker(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const { adapter, error } = getAdapter(stored.provider);
  if (!adapter) return { ok: false, error };

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

  // Async dispatch: fork a background subprocess and return immediately
  if (args.async) {
    return dispatchAsync(args);
  }

  // Auto-resume: each CLI invocation is a fresh process with empty adapter state
  await ensureResumed(adapter, args.session, stored);

  const result = await adapter.sendMessage(args.session, args.message);
  const now = new Date().toISOString();

  const fresh = adapter.getSession(args.session);
  registry.update(args.session, { lastMessageAt: now, metadata: fresh?.metadata });

  return { ok: true, sessionId: args.session, content: result.content, finishReason: result.finishReason, usage: result.usage };
}

async function getWorkerStatus(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const { adapter, error } = getAdapter(stored.provider);
  if (!adapter) return { ok: false, error };

  await ensureResumed(adapter, args.session, stored);
  const status = await adapter.getStatus(args.session);
  return { ok: true, sessionId: args.session, role: stored.role, provider: stored.provider, status, featureId: stored.featureId };
}

async function replaceWorker(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const { adapter, error } = getAdapter(stored.provider);
  if (adapter) {
    // Best-effort resume so stop/close can clean up provider resources
    await ensureResumed(adapter, args.session, stored).catch(() => {});
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

  const { adapter, error } = getAdapter(stored.provider);
  if (adapter) {
    await ensureResumed(adapter, args.session, stored).catch(() => {});
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

async function getWorkerResult(args: Record<string, any>) {
  const sessionId = args.session as string;
  const resultPath = args["result-path"] as string;

  if (resultPath) {
    const result = resultStore.read(resultPath);
    if (!result) return { ok: false, error: `Result file not found: ${resultPath}` };
    return { ok: true, ...result };
  }

  if (!sessionId) return { ok: false, error: "get-worker-result requires --session <id> or --result-path <path>" };

  const latest = resultStore.latest(sessionId);
  if (!latest) return { ok: false, error: `No results found for session: ${sessionId}` };
  return { ok: true, resultPath: latest.path, ...latest.result };
}

async function waitWorker(args: Record<string, any>) {
  const sessionId = args.session as string;
  const resultPath = args["result-path"] as string;
  const timeoutMs = parseInt(args.timeout ?? "300000", 10); // default 5 minutes
  const pollIntervalMs = 2000;

  if (!sessionId && !resultPath) {
    return { ok: false, error: "wait-worker requires --session <id> or --result-path <path>" };
  }

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    let result: import("../runtime/results.ts").WorkerResult | null = null;
    let rPath = resultPath;

    if (resultPath) {
      result = resultStore.read(resultPath);
    } else {
      const latest = resultStore.latest(sessionId);
      if (latest) {
        result = latest.result;
        rPath = latest.path;
      }
    }

    if (result && result.status !== "pending") {
      return { ok: true, resultPath: rPath, ...result };
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  return { ok: false, error: "Timed out waiting for worker result", timeoutMs };
}

async function manageFeaturePair(args: Record<string, any>) {
  if (!args.feature) return { ok: false, error: "manage-feature-pair requires --feature <id>" };

  if (!featureArtefactExists(args.feature, projectRoot)) {
    return { ok: false, error: `Feature artefact not found: ${args.feature}. The Planner must create the feature before execution can begin.` };
  }

  const config = loadConfig(projectRoot);

  // Pre-flight: enabledProviders must be set
  if (!config?.enabledProviders) {
    return { ok: false, error: "Provider allowlist not set. Run: bun run .floe/bin/floe.ts configure" };
  }

  // Resolve providers for implementer and reviewer independently
  const implResolved = args["implementer-provider"]
    ? validateEnabledProvider({ provider: args["implementer-provider"] }, config)
    : resolveProvider("implementer", args, config);
  const revResolved = args["reviewer-provider"]
    ? validateEnabledProvider({ provider: args["reviewer-provider"] }, config)
    : resolveProvider("reviewer", args, config);

  if (implResolved.error) return { ok: false, error: implResolved.error };
  if (revResolved.error) return { ok: false, error: revResolved.error };

  const [implementer, reviewer] = await Promise.all([
    launchWorker({ role: "implementer", provider: implResolved.provider, feature: args.feature, epic: args.epic, release: args.release }),
    launchWorker({ role: "reviewer", provider: revResolved.provider, feature: args.feature, epic: args.epic, release: args.release }),
  ]);

  // Check both workers launched successfully before spawning runner
  if (!(implementer as any).ok) return { ok: false, error: `Implementer launch failed: ${(implementer as any).error ?? "unknown error"}` };
  if (!(reviewer as any).ok) return { ok: false, error: `Reviewer launch failed: ${(reviewer as any).error ?? "unknown error"}` };

  // Spawn feature runner in background — "run" will initialise state if needed, then loop to completion
  const featureRunnerPath = join(dirname(import.meta.dir), "scripts", "feature-runner.ts");
  const child = Bun.spawn(["bun", "run", featureRunnerPath, "run",
    "--feature", args.feature,
    "--impl-session", (implementer as any).sessionId,
    "--rev-session", (reviewer as any).sessionId,
  ], {
    cwd: projectRoot,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();

  return {
    ok: true,
    featureId: args.feature,
    featureRunnerStarted: true,
    implementer: { sessionId: (implementer as any).sessionId, provider: implResolved.provider },
    reviewer: { sessionId: (reviewer as any).sessionId, provider: revResolved.provider },
  };
}

async function checkAlignment(args: Record<string, any>) {
  if (!args.feature) return { ok: false, error: "check-alignment requires --feature <id>" };

  const alignment = getAlignmentStatus(args.feature, projectRoot);
  const dod = loadDod(projectRoot);
  return {
    ok: true,
    featureId: args.feature,
    hasReview: alignment.hasReview,
    approachStatus: alignment.approachStatus,
    reviewId: alignment.reviewId,
    approved: alignment.approachStatus === "approved",
    dod: dod ? { version: dod.version, criteriaCount: dod.criteria.length, criteria: dod.criteria } : null,
  };
}

// ─── DoD commands ────────────────────────────────────────────────────

async function showDod(_args: Record<string, any>) {
  const dod = loadDod(projectRoot);
  if (!dod) return { ok: false, error: "No .floe/dod.json found. Create one or run: bun run .floe/scripts/init.ts" };
  return { ok: true, version: dod.version, criteria: dod.criteria, notes: dod.notes, formatted: formatDodForPrompt(dod) };
}

async function editDod(_args: Record<string, any>) {
  const dodPath = join(projectRoot, ".floe", "dod.json");
  if (!existsSync(dodPath)) return { ok: false, error: "No .floe/dod.json found. Create one or run: bun run .floe/scripts/init.ts" };
  const editor = process.env.EDITOR || "vi";
  const { spawnSync } = await import("node:child_process");
  spawnSync(editor, [dodPath], { stdio: "inherit" });
  const dod = loadDod(projectRoot);
  if (!dod) return { ok: false, error: "dod.json is invalid after editing" };
  return { ok: true, message: `DoD updated (${dod.criteria.length} criteria)` };
}

// ─── Feature runner status ───────────────────────────────────────────

async function featureRunStatus(args: Record<string, any>) {
  if (!args.feature) return { ok: false, error: "feature-run-status requires --feature <id>" };
  const statePath = join(projectRoot, ".floe", "state", "feature-runs", `${args.feature}.json`);
  if (!existsSync(statePath)) return { ok: false, error: `No feature run found for: ${args.feature}` };
  try {
    return { ok: true, ...JSON.parse(readFileSync(statePath, "utf-8")) };
  } catch (e: any) {
    return { ok: false, error: `Failed to read feature run state: ${e.message}` };
  }
}

// ─── Escalation commands ─────────────────────────────────────────────

async function listEscalations(args: Record<string, any>) {
  const proc = Bun.spawnSync(
    ["bun", "run", join(dirname(import.meta.dir), "scripts", "escalation.ts"), "list", ...(args.status ? ["--status", args.status] : [])],
    { cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
  );
  try { return JSON.parse(proc.stdout.toString()); } catch { return { ok: false, error: proc.stderr.toString() || "Failed to list escalations" }; }
}

async function resolveEscalation(args: Record<string, any>) {
  if (!args.escalation) return { ok: false, error: "resolve-escalation requires --escalation <id>" };
  if (!args.resolution) return { ok: false, error: "resolve-escalation requires --resolution '<text>'" };
  const proc = Bun.spawnSync(
    ["bun", "run", join(dirname(import.meta.dir), "scripts", "escalation.ts"), "resolve", args.escalation, args.resolution],
    { cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
  );
  try { return JSON.parse(proc.stdout.toString()); } catch { return { ok: false, error: proc.stderr.toString() || "Failed to resolve escalation" }; }
}

// ─── Configure command ───────────────────────────────────────────────

const PROVIDERS = ["claude", "codex", "copilot"] as const;
const PROVIDER_HINTS: Record<string, string> = {
  claude: "requires ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY or local sign-in",
  copilot: "uses GitHub CLI credentials",
};

interface ModelChoice { id: string; label: string }

const CURATED_MODELS: Record<string, ModelChoice[]> = {
  claude: [
    { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", label: "Claude Opus 4" },
    { id: "claude-haiku-4-20250514", label: "Claude Haiku 4" },
  ],
  codex: [
    { id: "o3-mini", label: "o3-mini" },
    { id: "o4-mini", label: "o4-mini" },
    { id: "gpt-4.1", label: "GPT-4.1" },
  ],
  copilot: [
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
    { id: "o3-mini", label: "o3-mini" },
    { id: "gpt-4.1", label: "GPT-4.1" },
  ],
};

const THINKING_LEVELS: ModelChoice[] = [
  { id: "normal", label: "normal (default)" },
  { id: "low", label: "low" },
  { id: "high", label: "high (extended thinking)" },
];

const modelCache = new Map<string, ModelChoice[]>();

async function fetchClaudeModels(): Promise<ModelChoice[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return CURATED_MODELS.claude;
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) return CURATED_MODELS.claude;
    const data = (await res.json()) as { data?: { id: string; display_name?: string }[] };
    const models = (data.data ?? [])
      .filter(m => m.id && !m.id.includes("embed"))
      .map(m => ({ id: m.id, label: m.display_name ?? m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return models.length > 0 ? models : CURATED_MODELS.claude;
  } catch {
    return CURATED_MODELS.claude;
  }
}

async function fetchOpenAIModels(): Promise<ModelChoice[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return CURATED_MODELS.codex;
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return CURATED_MODELS.codex;
    const data = (await res.json()) as { data?: { id: string }[] };
    const relevant = new Set(["o3-mini", "o4-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini", "o3", "o4"]);
    const models = (data.data ?? [])
      .filter(m => m.id && relevant.has(m.id))
      .map(m => ({ id: m.id, label: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return models.length > 0 ? models : CURATED_MODELS.codex;
  } catch {
    return CURATED_MODELS.codex;
  }
}

async function fetchModelsForProvider(provider: string): Promise<ModelChoice[]> {
  if (modelCache.has(provider)) return modelCache.get(provider)!;
  let models: ModelChoice[];
  if (provider === "claude") models = await fetchClaudeModels();
  else if (provider === "codex") models = await fetchOpenAIModels();
  else models = CURATED_MODELS[provider] ?? [];
  modelCache.set(provider, models);
  return models;
}

function askLine(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}


/** Fuzzy-match user text against model list. Returns best match or null. */
function fuzzyMatchModel(input: string, items: ModelChoice[]): ModelChoice | null {
  const q = input.toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (!q) return null;
  // Exact id match
  const exact = items.find(m => m.id.toLowerCase() === input.toLowerCase());
  if (exact) return exact;
  // Substring match on id or label
  const matches = items.filter(m =>
    m.id.toLowerCase().includes(q) || m.label.toLowerCase().replace(/[^a-z0-9.]/g, "").includes(q)
  );
  if (matches.length === 1) return matches[0];
  // Partial token match (e.g. "sonnet 4.6" matches "claude-sonnet-4.6-...")
  const tokens = input.toLowerCase().split(/[\s\-_]+/).filter(Boolean);
  if (tokens.length > 0) {
    const tokenMatches = items.filter(m => {
      const haystack = `${m.id} ${m.label}`.toLowerCase();
      return tokens.every(t => haystack.includes(t));
    });
    if (tokenMatches.length === 1) return tokenMatches[0];
    if (tokenMatches.length > 1) return null; // ambiguous
  }
  return null;
}


async function configureCommand(args: Record<string, any>) {
  const configPath = join(projectRoot, ".floe", "config.json");

  // ── Direct write mode (flags provided) ──────────────────────────
  const defaultProvider = args["default-provider"] as string | undefined;
  if (defaultProvider) {
    if (!PROVIDERS.includes(defaultProvider as any)) {
      return { ok: false, error: `Invalid provider: ${defaultProvider}. Must be: ${PROVIDERS.join(", ")}` };
    }

    const rawEnabled = args["enabled-providers"] as string | undefined;
    const enabledProviders = rawEnabled
      ? rawEnabled.split(",").map((s: string) => s.trim()).filter(Boolean)
      : [defaultProvider];
    for (const ep of enabledProviders) {
      if (!PROVIDERS.includes(ep as any)) return { ok: false, error: `Invalid enabled provider: ${ep}. Must be: ${PROVIDERS.join(", ")}` };
    }
    if (!enabledProviders.includes(defaultProvider)) {
      return { ok: false, error: `Default provider '${defaultProvider}' must be in enabledProviders [${enabledProviders.join(", ")}]` };
    }

    const config: FloeConfig = { defaultProvider, enabledProviders, configured: true };
    if (args.model || args.thinking) {
      config.roles = {};
      for (const role of ["planner", "implementer", "reviewer"] as const) {
        const roleConf: Record<string, string> = {};
        if (args.model) roleConf.model = args.model;
        if (args.thinking) roleConf.thinking = args.thinking;
        (config.roles as any)[role] = roleConf;
      }
    }
    mkdirSync(join(projectRoot, ".floe"), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return { ok: true, message: `Wrote ${configPath}`, config };
  }

  // ── Discovery mode (no flags) ──────────────────────────────────
  // Returns available providers + models so the caller (foreman) can
  // make an informed choice, then call configure again with flags.

  const available: Record<string, { hint: string; envDetected: boolean; models: ModelChoice[] }> = {};

  for (const prov of PROVIDERS) {
    const envDetected =
      prov === "claude" ? !!process.env.ANTHROPIC_API_KEY :
      prov === "codex" ? !!process.env.OPENAI_API_KEY :
      true; // copilot always available via gh CLI
    const models = await fetchModelsForProvider(prov);
    available[prov] = {
      hint: PROVIDER_HINTS[prov],
      envDetected,
      models,
    };
  }

  const existingConfig = loadConfig(projectRoot);

  return {
    ok: true,
    action: "choose",
    message: "No flags provided. Use the information below to choose, then call: configure --default-provider <provider> [--enabled-providers <csv>] [--model <model>] [--thinking <level>]",
    providers: available,
    thinkingLevels: THINKING_LEVELS.map(t => t.id),
    currentConfig: existingConfig ?? null,
  };
}

// ─── Config management commands ──────────────────────────────────────

async function showConfig(_args: Record<string, any>) {
  const config = loadConfig(projectRoot);
  if (!config) {
    return { ok: false, error: "No .floe/config.json found. Run: bun run .floe/bin/floe.ts configure" };
  }
  return {
    ok: true,
    config,
    enabledProviders: config.enabledProviders ?? "NOT SET (run configure)",
  };
}

async function listModels(args: Record<string, any>) {
  const provider = args.provider;
  if (!provider) return { ok: false, error: "list-models requires --provider <claude|codex|copilot>" };
  if (!PROVIDERS.includes(provider as any)) {
    return { ok: false, error: `Invalid provider: ${provider}. Must be: ${PROVIDERS.join(", ")}` };
  }
  if (provider === "copilot") {
    return { ok: true, provider, source: "curated", models: CURATED_MODELS.copilot, note: "Copilot supports multiple models via SDK — type any model name if not listed" };
  }
  const models = await fetchModelsForProvider(provider);
  const source = (provider === "claude" && process.env.ANTHROPIC_API_KEY)
    || (provider === "codex" && process.env.OPENAI_API_KEY) ? "api" : "curated";
  return { ok: true, provider, source, models };
}

async function updateConfig(args: Record<string, any>) {
  const configPath = join(projectRoot, ".floe", "config.json");
  const config = loadConfig(projectRoot) ?? { defaultProvider: "" } as FloeConfig;

  const role = args.role as string | undefined;
  const provider = args.provider as string | undefined;
  const model = args.model as string | undefined;
  const thinking = args.thinking as string | undefined;

  if (!provider && !model && !thinking && !args["default-provider"]) {
    return { ok: false, error: "update-config requires at least one of: --default-provider, --provider, --model, --thinking" };
  }

  // Validate provider if given
  if (provider && !PROVIDERS.includes(provider as any)) {
    return { ok: false, error: `Invalid provider: ${provider}. Must be: ${PROVIDERS.join(", ")}` };
  }

  // Validate thinking if given
  const validThinking = ["low", "normal", "high"];
  if (thinking && !validThinking.includes(thinking)) {
    return { ok: false, error: `Invalid thinking: ${thinking}. Must be: ${validThinking.join(", ")}` };
  }

  // Update default provider
  if (args["default-provider"]) {
    if (!PROVIDERS.includes(args["default-provider"] as any)) {
      return { ok: false, error: `Invalid default provider: ${args["default-provider"]}` };
    }
    config.defaultProvider = args["default-provider"];
  }

  // Determine which roles to update
  const targetRoles: string[] = role === "all"
    ? ["planner", "implementer", "reviewer"]
    : role ? [role] : [];

  if (targetRoles.length > 0 && (provider || model || thinking)) {
    if (!config.roles) config.roles = {};
    for (const r of targetRoles) {
      const existing = (config.roles as any)[r] ?? {};
      if (provider) existing.provider = provider;
      if (model) existing.model = model;
      if (thinking) existing.thinking = thinking;
      (config.roles as any)[r] = existing;
    }
  }

  mkdirSync(join(projectRoot, ".floe"), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return { ok: true, message: `Updated ${configPath}`, config };
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
    "default-provider": { type: "string" },
    "non-interactive": { type: "boolean" },
    model: { type: "string" },
    thinking: { type: "string" },
    async: { type: "boolean" },
    "result-path": { type: "string" },
    timeout: { type: "string" },
    "enabled-providers": { type: "string" },
    escalation: { type: "string" },
    resolution: { type: "string" },
    status: { type: "string" },
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
    "get-worker-result": getWorkerResult,
    "wait-worker": waitWorker,
    "manage-feature-pair": manageFeaturePair,
    "check-alignment": checkAlignment,
    "feature-run-status": featureRunStatus,
    "show-dod": showDod,
    "edit-dod": editDod,
    "list-escalations": listEscalations,
    "resolve-escalation": resolveEscalation,
    "configure": configureCommand,
    "show-config": showConfig,
    "list-models": listModels,
    "update-config": updateConfig,
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
