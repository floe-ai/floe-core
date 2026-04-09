#!/usr/bin/env bun
/**
 * floe CLI — worker session management for the floe execution framework.
 *
 * Usage: bun run .floe/bin/floe.ts <command> [options]
 *
 * Commands:
 *   launch-worker        Launch a new worker session (daemon-managed, optional --message)
 *   resume-worker        Resume an existing session
 *   message-worker       Send a message to an active worker (daemon-managed)
 *   get-worker-status    Get session status
 *   get-worker-result    Deprecated (legacy async polling removed)
 *   wait-worker          Deprecated (legacy async polling removed)
 *   replace-worker       Stop and re-launch a worker
 *   stop-worker          Stop a worker session
 *   list-active-workers  List all active sessions
 *   manage-feature-pair  Launch implementer + reviewer pair in daemon runtime
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


import { SessionRegistry } from "../runtime/registry.ts";
import { loadDod, formatDodForPrompt } from "../runtime/dod.ts";
import { sendDaemonRequest } from "../runtime/daemon/client.ts";
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

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
const daemonDir = join(projectRoot, ".floe", "state", "daemon");
const defaultDaemonSocketPath = join(daemonDir, "floe-daemon.sock");
const daemonEndpointFile = join(daemonDir, "endpoint.json");

function stableProjectPort(root: string): number {
  let hash = 0;
  for (let i = 0; i < root.length; i++) {
    hash = (hash * 31 + root.charCodeAt(i)) % 10000;
  }
  return 42000 + (hash % 1000);
}

const defaultDaemonTcpEndpoint = `tcp://127.0.0.1:${stableProjectPort(projectRoot)}`;

function parseJsonObject(raw: string | undefined, flagName: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${flagName} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error: any) {
    throw new Error(`Invalid ${flagName} JSON: ${error?.message ?? String(error)}`);
  }
}

function uniqueEndpoints(list: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const endpoints: string[] = [];
  for (const value of list) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    endpoints.push(value);
  }
  return endpoints;
}

function readPersistedDaemonEndpoint(): string | null {
  if (!existsSync(daemonEndpointFile)) return null;
  try {
    const data = JSON.parse(readFileSync(daemonEndpointFile, "utf-8")) as { endpoint?: string };
    if (!data.endpoint || typeof data.endpoint !== "string") return null;
    return data.endpoint;
  } catch {
    return null;
  }
}

function persistDaemonEndpoint(endpoint: string): void {
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(daemonEndpointFile, JSON.stringify({ endpoint, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf-8");
}

function daemonEndpointFromArgs(args: Record<string, any>): string | undefined {
  return (args.endpoint as string | undefined) ?? (args.socket as string | undefined);
}

async function isDaemonReachable(endpoint: string): Promise<boolean> {
  try {
    const response = await sendDaemonRequest(endpoint, "runtime.status", {}, { timeoutMs: 300 });
    return response.ok;
  } catch {
    return false;
  }
}

async function startDaemonAt(endpoint: string): Promise<boolean> {
  if (await isDaemonReachable(endpoint)) return true;

  mkdirSync(daemonDir, { recursive: true });

  const daemonPath = join(dirname(new URL(import.meta.url).pathname), "floe-daemon.ts");
  const spawnArgs = ["bun", "run", daemonPath];
  if (endpoint.startsWith("tcp://")) {
    const url = new URL(endpoint);
    spawnArgs.push("--tcp-host", url.hostname, "--tcp-port", url.port);
  } else {
    spawnArgs.push("--socket", endpoint);
  }

  const child = Bun.spawn(spawnArgs, {
    cwd: projectRoot,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();

  const startedAt = Date.now();
  const timeoutMs = 20_000;
  while (Date.now() - startedAt < timeoutMs) {
    if (await isDaemonReachable(endpoint)) {
      persistDaemonEndpoint(endpoint);
      return true;
    }
    await Bun.sleep(100);
  }

  return false;
}

async function findReachableEndpoint(candidates: string[]): Promise<string | null> {
  for (const endpoint of candidates) {
    if (await isDaemonReachable(endpoint)) {
      persistDaemonEndpoint(endpoint);
      return endpoint;
    }
  }
  return null;
}

async function ensureDaemonRunning(args: Record<string, any>): Promise<string> {
  const explicitEndpoint = daemonEndpointFromArgs(args);
  const persistedEndpoint = readPersistedDaemonEndpoint();

  const reachable = await findReachableEndpoint(
    uniqueEndpoints([
      explicitEndpoint,
      persistedEndpoint,
      defaultDaemonSocketPath,
      defaultDaemonTcpEndpoint,
    ]),
  );
  if (reachable) return reachable;

  // Start with unix socket first, then local-only TCP fallback.
  const startOrder = uniqueEndpoints([
    explicitEndpoint,
    defaultDaemonSocketPath,
    defaultDaemonTcpEndpoint,
  ]);

  for (const endpoint of startOrder) {
    if (await startDaemonAt(endpoint)) return endpoint;
  }

  throw new Error(
    `Timed out starting floe-daemon. Tried endpoints: ${startOrder.join(", ")}`,
  );
}

function buildDaemonPayload(action: string, args: Record<string, any>): Record<string, unknown> {
  const payload: Record<string, unknown> = parseJsonObject(args.data as string | undefined, "--data");

  if (args.run !== undefined && payload.runId === undefined) payload.runId = args.run;
  if (args.worker !== undefined && payload.workerId === undefined) payload.workerId = args.worker;
  if (args.call !== undefined && payload.callId === undefined) payload.callId = args.call;
  if (args.role !== undefined && payload.role === undefined) payload.role = args.role;
  if (args.provider !== undefined && payload.provider === undefined) payload.provider = args.provider;
  if (args.feature !== undefined && payload.featureId === undefined) payload.featureId = args.feature;
  if (args.epic !== undefined && payload.epicId === undefined) payload.epicId = args.epic;
  if (args.release !== undefined && payload.releaseId === undefined) payload.releaseId = args.release;
  if (args.scope !== undefined && payload.scope === undefined) payload.scope = args.scope;
  if (args.target !== undefined && payload.target === undefined) payload.target = args.target;
  if (args.session !== undefined && payload.sessionRef === undefined) payload.sessionRef = args.session;
  if (args.model !== undefined && payload.model === undefined) payload.model = args.model;
  if (args.thinking !== undefined && payload.thinking === undefined) payload.thinking = args.thinking;
  if (args.message !== undefined && payload.message === undefined) payload.message = args.message;
  if (args.reason !== undefined && payload.reason === undefined) payload.reason = args.reason;
  if (args.type !== undefined && payload.type === undefined) payload.type = args.type;
  if (args.objective !== undefined && payload.objective === undefined) payload.objective = args.objective;
  if (args["run-state"] !== undefined && payload.state === undefined) payload.state = args["run-state"];
  if (args.to !== undefined && payload.to === undefined) payload.to = args.to;
  if (args.cursor !== undefined && payload.cursor === undefined) payload.cursor = Number(args.cursor);
  if (args.limit !== undefined && payload.limit === undefined) payload.limit = Number(args.limit);
  if (args["wait-ms"] !== undefined && payload.waitMs === undefined) payload.waitMs = Number(args["wait-ms"]);

  if (args.participants !== undefined && payload.participants === undefined) {
    payload.participants = String(args.participants).split(",").map((part) => part.trim()).filter(Boolean);
  }
  if (args.budgets !== undefined && payload.budgets === undefined) {
    payload.budgets = parseJsonObject(String(args.budgets), "--budgets");
  }
  if (args.payload !== undefined && payload.payload === undefined) {
    payload.payload = parseJsonObject(String(args.payload), "--payload");
  }
  if (args.response !== undefined && payload.responsePayload === undefined) {
    payload.responsePayload = parseJsonObject(String(args.response), "--response");
  }
  if (args.context !== undefined && payload.context === undefined) {
    try {
      payload.context = parseJsonObject(String(args.context), "--context");
    } catch {
      payload.context = { text: String(args.context) };
    }
  }

  if (action === "worker.start" && payload.initialMessage === undefined && args.message) {
    payload.initialMessage = args.message;
    delete payload.message;
  }

  if (action === "worker.continue") {
    if (payload.continuation === undefined && payload.message !== undefined) {
      payload.continuation = payload.message;
      delete payload.message;
    }
  }

  if (action === "call.blocking") {
    if (payload.callType === undefined && payload.type !== undefined) {
      payload.callType = payload.type;
    }
  }

  if (action === "route.reply") {
    if (payload.response === undefined && payload.responsePayload !== undefined) {
      payload.response = payload.responsePayload;
      delete payload.responsePayload;
    }
  }

  return payload;
}

function parsePositiveMs(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 100) return null;
  return Math.floor(parsed);
}

function daemonActionTimeoutMs(
  action: string,
  args: Record<string, any>,
  payload: Record<string, unknown>,
): number {
  const explicitTimeout = parsePositiveMs(args.timeout);
  if (explicitTimeout !== null) return explicitTimeout;

  const defaultTimeoutMs = 15_000;
  const longRunningTimeoutMs = 30 * 60_000; // 30 minutes
  const eventsSubscribeMinTimeoutMs = 70_000;
  const eventsSubscribeBufferMs = 10_000;

  const waitMs = Math.max(
    0,
    Number(payload.waitMs ?? args["wait-ms"] ?? 0) || 0,
  );

  if (action === "events.subscribe") {
    return Math.max(eventsSubscribeMinTimeoutMs, waitMs + eventsSubscribeBufferMs);
  }

  const longRunningActions = new Set([
    "route.send",
    "route.reply",
    "worker.continue",
    "call.resolve",
  ]);

  if (longRunningActions.has(action)) return longRunningTimeoutMs;
  if (action === "worker.start" && typeof payload.initialMessage === "string" && payload.initialMessage.trim()) {
    return longRunningTimeoutMs;
  }

  return defaultTimeoutMs;
}

async function callDaemonAction(action: string, args: Record<string, any>): Promise<Record<string, unknown>> {
  const explicitEndpoint = daemonEndpointFromArgs(args);

  if (action === "runtime.ensure") {
    const endpoint = await ensureDaemonRunning(args);
    const status = await sendDaemonRequest(endpoint, "runtime.status", {}, { timeoutMs: 2000 });
    if (!status.ok) return { ok: false, error: status.error ?? "Daemon status failed" };
    return { ok: true, action, endpoint, ...(status.result ?? {}) };
  }

  if (action === "runtime.shutdown") {
    const reachable = await findReachableEndpoint(
      uniqueEndpoints([
        explicitEndpoint,
        readPersistedDaemonEndpoint(),
        defaultDaemonSocketPath,
        defaultDaemonTcpEndpoint,
      ]),
    );
    if (!reachable) {
      return { ok: true, action, endpoint: explicitEndpoint ?? null, stopped: true, alreadyStopped: true };
    }
    const shutdown = await sendDaemonRequest(reachable, action, {}, { timeoutMs: 5000 });
    if (!shutdown.ok) return { ok: false, error: shutdown.error ?? "Daemon shutdown failed" };
    return { ok: true, action, endpoint: reachable, ...(shutdown.result ?? {}) };
  }

  const endpoint = await ensureDaemonRunning(args);
  const payload = buildDaemonPayload(action, args);
  const timeoutMs = daemonActionTimeoutMs(action, args, payload);
  const response = await sendDaemonRequest(
    endpoint,
    action,
    payload,
    { timeoutMs },
  );

  if (!response.ok) {
    return {
      ok: false,
      action,
      endpoint,
      payload,
      error: response.error ?? "Daemon action failed",
    };
  }

  return {
    ok: true,
    action,
    endpoint,
    ...(response.result ?? {}),
  };
}

async function launchWorker(args: Record<string, any>) {
  const role = args.role;
  if (!role) return { ok: false, error: "Missing required flag: --role" };
  if (args.async) {
    return {
      ok: false,
      error: "Legacy async subprocess path removed. Use daemon events: events.subscribe / events.replay.",
    };
  }

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

  const runtimeResult = await callDaemonAction("worker.start", args);
  if (!runtimeResult.ok) return runtimeResult;

  const session = (runtimeResult as any).session as Record<string, any> | undefined;
  const initial = (runtimeResult as any).initialResult as Record<string, any> | null | undefined;
  const workerId = (runtimeResult as any).workerId as string;

  return {
    ok: true,
    sessionId: workerId,
    workerId,
    role: session?.role ?? role,
    provider: session?.provider ?? args.provider ?? null,
    status: session?.status ?? "active",
    ...(initial
      ? {
          content: initial.content,
          finishReason: initial.finishReason,
          usage: initial.usage,
        }
      : {}),
  };
}

async function resumeWorker(args: Record<string, any>) {
  if (!args.session) return { ok: false, error: "resume-worker requires --session <id>" };
  const runtimeResult = await callDaemonAction("worker.resume", { ...args, worker: args.session });
  if (!runtimeResult.ok) return runtimeResult;
  const worker = (runtimeResult as any).worker as Record<string, any> | undefined;
  return { ok: true, sessionId: args.session, status: worker?.state ?? "active", worker };
}

async function messageWorker(args: Record<string, any>) {
  if (!args.session) return { ok: false, error: "message-worker requires --session <id>" };
  if (!args.message) return { ok: false, error: "message-worker requires --message '<text>'" };

  if (args.async) {
    return {
      ok: false,
      error: "Legacy async subprocess path removed. Use daemon events: events.subscribe / events.replay.",
    };
  }

  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

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

  const runtimeResult = await callDaemonAction("route.send", {
    ...args,
    to: args.session,
  });
  if (!runtimeResult.ok) return runtimeResult;

  const result = (runtimeResult as any).result as Record<string, any> | undefined;
  return {
    ok: true,
    sessionId: args.session,
    content: result?.content ?? "",
    finishReason: result?.finishReason,
    usage: result?.usage,
  };
}

async function getWorkerStatus(args: Record<string, any>) {
  if (!args.session) return { ok: false, error: "get-worker-status requires --session <id>" };
  const runtimeResult = await callDaemonAction("worker.get", { ...args, worker: args.session });
  if (!runtimeResult.ok) return runtimeResult;
  const worker = (runtimeResult as any).worker as Record<string, any> | undefined;
  const session = (runtimeResult as any).session as Record<string, any> | undefined;
  return {
    ok: true,
    sessionId: args.session,
    role: session?.role ?? worker?.role ?? null,
    provider: session?.provider ?? worker?.provider ?? null,
    status: worker?.state ?? session?.status ?? "unknown",
    featureId: session?.featureId ?? worker?.metadata?.featureId ?? null,
  };
}

async function replaceWorker(args: Record<string, any>) {
  if (!args.session) return { ok: false, error: "replace-worker requires --session <id>" };
  const info = await callDaemonAction("worker.get", { ...args, worker: args.session });
  if (!info.ok) return info;

  const session = (info as any).session as Record<string, any> | undefined;
  if (!session) return { ok: false, error: `Session not found: ${args.session}` };

  const stopped = await callDaemonAction("worker.stop", { ...args, worker: args.session, reason: args.reason ?? "replace-worker" });
  if (!stopped.ok) return stopped;

  const started = await callDaemonAction("worker.start", {
    ...args,
    role: session.role,
    provider: session.provider,
    feature: session.featureId,
    epic: session.epicId,
    release: session.releaseId,
  });
  if (!started.ok) return started;

  return {
    ok: true,
    replacedSessionId: args.session,
    newSessionId: (started as any).workerId,
    reason: args.reason ?? null,
  };
}

async function stopWorker(args: Record<string, any>) {
  if (!args.session) return { ok: false, error: "stop-worker requires --session <id>" };
  const runtimeResult = await callDaemonAction("worker.stop", { ...args, worker: args.session });
  if (!runtimeResult.ok) return runtimeResult;
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
  return {
    ok: false,
    error: "get-worker-result is removed in daemon runtime mode. Use events.replay or events.subscribe.",
  };
}

async function waitWorker(args: Record<string, any>) {
  return {
    ok: false,
    error: "wait-worker is removed in daemon runtime mode. Use events.subscribe --wait-ms <ms>.",
  };
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

  const runStart = await callDaemonAction("run.start", {
    ...args,
    type: "feature_execution",
    objective: `Execute feature ${args.feature}`,
    data: JSON.stringify({
      participants: [],
      metadata: {
        featureId: args.feature,
        epicId: args.epic ?? null,
        releaseId: args.release ?? null,
      },
    }),
  });
  if (!runStart.ok) return runStart;
  const runId = (runStart as any).run?.runId as string | undefined;
  if (!runId) return { ok: false, error: "Daemon did not return runId from run.start" };

  const implementer = await callDaemonAction("worker.start", {
    ...args,
    run: runId,
    role: "implementer",
    provider: implResolved.provider,
    feature: args.feature,
    epic: args.epic,
    release: args.release,
  });
  if (!implementer.ok) {
    await callDaemonAction("run.escalate", { ...args, run: runId, reason: `Implementer launch failed: ${(implementer as any).error ?? "unknown error"}` });
    return { ok: false, error: `Implementer launch failed: ${(implementer as any).error ?? "unknown error"}`, runId };
  }

  const reviewer = await callDaemonAction("worker.start", {
    ...args,
    run: runId,
    role: "reviewer",
    provider: revResolved.provider,
    feature: args.feature,
    epic: args.epic,
    release: args.release,
  });
  if (!reviewer.ok) {
    await callDaemonAction("run.escalate", { ...args, run: runId, reason: `Reviewer launch failed: ${(reviewer as any).error ?? "unknown error"}` });
    return { ok: false, error: `Reviewer launch failed: ${(reviewer as any).error ?? "unknown error"}`, runId };
  }

  return {
    ok: true,
    featureId: args.feature,
    runId,
    runtimeManaged: true,
    implementer: { sessionId: (implementer as any).workerId, provider: implResolved.provider },
    reviewer: { sessionId: (reviewer as any).workerId, provider: revResolved.provider },
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
  claude: "requires ANTHROPIC_API_KEY + @anthropic-ai/claude-agent-sdk",
  codex: "@openai/codex-sdk (API key or local ChatGPT sign-in)",
  copilot: "@github/copilot-sdk (uses GitHub CLI credentials)",
};

interface ModelChoice { id: string; label: string }

const THINKING_LEVELS: ModelChoice[] = [
  { id: "normal", label: "normal (default)" },
  { id: "low", label: "low" },
  { id: "high", label: "high (extended thinking)" },
];

// ── SDK availability detection ───────────────────────────────────────

async function isSdkAvailable(pkg: string): Promise<boolean> {
  try {
    await import(pkg);
    return true;
  } catch {
    return false;
  }
}

interface ProviderDetection {
  sdkInstalled: boolean;
  credentialsDetected: boolean;
  hint: string;
}

async function detectProviders(): Promise<Record<string, ProviderDetection>> {
  const [copilotSdk, codexSdk, claudeSdk] = await Promise.all([
    isSdkAvailable("@github/copilot-sdk"),
    isSdkAvailable("@openai/codex-sdk"),
    isSdkAvailable("@anthropic-ai/claude-agent-sdk"),
  ]);

  return {
    copilot: {
      sdkInstalled: copilotSdk,
      credentialsDetected: copilotSdk, // Copilot SDK uses gh CLI creds automatically
      hint: PROVIDER_HINTS.copilot,
    },
    codex: {
      sdkInstalled: codexSdk,
      credentialsDetected: codexSdk || !!process.env.OPENAI_API_KEY,
      hint: PROVIDER_HINTS.codex,
    },
    claude: {
      sdkInstalled: claudeSdk,
      credentialsDetected: !!process.env.ANTHROPIC_API_KEY,
      hint: PROVIDER_HINTS.claude,
    },
  };
}

// ── API model listing (bonus — used by list-models if credentials exist) ─────

async function fetchClaudeModels(): Promise<ModelChoice[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string; display_name?: string }[] };
    return (data.data ?? [])
      .filter(m => m.id && !m.id.includes("embed"))
      .map(m => ({ id: m.id, label: m.display_name ?? m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

async function fetchOpenAIModels(): Promise<ModelChoice[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data ?? [])
      .filter(m => m.id)
      .map(m => ({ id: m.id, label: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
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
  // Returns SDK availability + any API-fetchable models.
  // The Foreman (which IS running inside a provider) should present
  // its own visible models to the user and make a recommendation.

  const providers = await detectProviders();
  const existingConfig = loadConfig(projectRoot);

  return {
    ok: true,
    action: "choose",
    message: [
      "Provider detection complete. Review the results below.",
      "You (the Foreman) can see your own available models — present those to the user.",
      "The user can type any model name as free text. The provider SDK validates at session creation.",
      "Once decided, call: configure --default-provider <provider> [--enabled-providers <csv>] [--model <model>] [--thinking <level>]",
    ].join(" "),
    providers,
    thinkingLevels: THINKING_LEVELS.map(t => t.id),
    currentConfig: existingConfig ?? null,
    note: "Model names are free text. The Foreman should present its own visible models and recommend one. Do NOT present hardcoded model lists.",
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
    return {
      ok: true,
      provider,
      source: "sdk",
      models: [],
      note: "Copilot model selection is handled by the SDK. The Foreman can see its own available models — ask it what's available.",
    };
  }

  let models: ModelChoice[] = [];
  let source = "unavailable";

  if (provider === "claude") {
    models = await fetchClaudeModels();
    source = models.length > 0 ? "api" : "unavailable";
  } else if (provider === "codex") {
    models = await fetchOpenAIModels();
    source = models.length > 0 ? "api" : "unavailable";
  }

  return {
    ok: true,
    provider,
    source,
    models,
    note: models.length === 0
      ? "Could not fetch models from API. Type any valid model name — the SDK validates at session creation."
      : undefined,
  };
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

function daemonCommand(action: string) {
  return async (args: Record<string, any>) => callDaemonAction(action, args);
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
    socket: { type: "string" },
    endpoint: { type: "string" },
    data: { type: "string" },
    run: { type: "string" },
    worker: { type: "string" },
    call: { type: "string" },
    type: { type: "string" },
    objective: { type: "string" },
    participants: { type: "string" },
    budgets: { type: "string" },
    payload: { type: "string" },
    response: { type: "string" },
    cursor: { type: "string" },
    limit: { type: "string" },
    "wait-ms": { type: "string" },
    to: { type: "string" },
    "run-state": { type: "string" },
  },
  strict: false,
});

async function main() {
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

    // Daemon runtime control
    "runtime.ensure": daemonCommand("runtime.ensure"),
    "runtime.status": daemonCommand("runtime.status"),
    "runtime.shutdown": daemonCommand("runtime.shutdown"),
    "runtime-ensure": daemonCommand("runtime.ensure"),
    "runtime-status": daemonCommand("runtime.status"),
    "runtime-shutdown": daemonCommand("runtime.shutdown"),

    // Run lifecycle
    "run.start": daemonCommand("run.start"),
    "run.complete": daemonCommand("run.complete"),
    "run.escalate": daemonCommand("run.escalate"),
    "run.get": daemonCommand("run.get"),
    "run-start": daemonCommand("run.start"),
    "run-complete": daemonCommand("run.complete"),
    "run-escalate": daemonCommand("run.escalate"),
    "run-get": daemonCommand("run.get"),

    // Worker lifecycle
    "worker.start": daemonCommand("worker.start"),
    "worker.resume": daemonCommand("worker.resume"),
    "worker.continue": daemonCommand("worker.continue"),
    "worker.interrupt": daemonCommand("worker.interrupt"),
    "worker.stop": daemonCommand("worker.stop"),
    "worker.recover": daemonCommand("worker.recover"),
    "worker.get": daemonCommand("worker.get"),
    "worker-start": daemonCommand("worker.start"),
    "worker-resume": daemonCommand("worker.resume"),
    "worker-continue": daemonCommand("worker.continue"),
    "worker-interrupt": daemonCommand("worker.interrupt"),
    "worker-stop": daemonCommand("worker.stop"),
    "worker-recover": daemonCommand("worker.recover"),
    "worker-get": daemonCommand("worker.get"),

    // Continuation call lifecycle
    "call.blocking": daemonCommand("call.blocking"),
    "call.resolve": daemonCommand("call.resolve"),
    "call.detectOrphaned": daemonCommand("call.detectOrphaned"),
    "call-blocking": daemonCommand("call.blocking"),
    "call-resolve": daemonCommand("call.resolve"),
    "call-detect-orphaned": daemonCommand("call.detectOrphaned"),

    // Routing and events
    "route.send": daemonCommand("route.send"),
    "route.reply": daemonCommand("route.reply"),
    "events.subscribe": daemonCommand("events.subscribe"),
    "events.replay": daemonCommand("events.replay"),
    "route-send": daemonCommand("route.send"),
    "route-reply": daemonCommand("route.reply"),
    "events-subscribe": daemonCommand("events.subscribe"),
    "events-replay": daemonCommand("events.replay"),
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
