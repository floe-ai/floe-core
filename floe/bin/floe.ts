#!/usr/bin/env bun
/**
 * floe CLI — dispatches to the daemon runtime for worker and feature management.
 *
 * Usage: bun run .floe/bin/floe.ts <command> [options]
 *
 * Feature execution (daemon-native — primary model):
 *   manage-feature-pair  Launch implementer + reviewer pair (daemon-native workflow)
 *   run-get              Get full run state, workers, and pending calls
 *   events-subscribe     Block until new events arrive for a run
 *   events-replay        Replay all events for a run
 *   call-blocking        Issue a blocking call (workers use this to signal dependencies)
 *   call-resolve         Resolve a pending blocking call
 *   call-detect-orphaned Detect orphaned blocking calls
 *
 * Planning (worker sessions):
 *   launch-worker        Launch a new worker session (daemon-managed, optional --message)
 *
 * Ad-hoc worker management (manual/diagnostic):
 *   message-worker       Send a message to an active worker (ad-hoc only)
 *   resume-worker        Resume an existing session
 *   get-worker-status    Get session status
 *   replace-worker       Stop and re-launch a worker
 *   stop-worker          Stop a worker session
 *   list-active-workers  List all active sessions
 *
 * Alignment:
 *   check-alignment      Check approach alignment status for a feature
 *
 * Configuration:
 *   configure            Set up model/thinking/srcRoot configuration
 *   show-config          Show current configuration
 *   update-config        Update model/thinking configuration
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
  configured?: boolean;
  srcRoot?: string;
  roles?: {
    planner?: { model?: string; thinking?: string };
    implementer?: { model?: string; thinking?: string };
    reviewer?: { model?: string; thinking?: string };
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

function srcRootContextAddendum(srcRoot: string): string {
  return [
    "## Source Root",
    `All application source code for this project lives at: \`${srcRoot}/\` (relative to the project root).`,
    "Write every generated or modified file under this directory.",
    "Never write into \`.floe/\`, framework tooling, or any other directory outside this path.",
  ].join("\n");
}

function resolveModel(role: string, args: Record<string, any>, config: FloeConfig | null): {
  model?: string;
  thinking?: string;
} {
  if (args.model) return { model: args.model, thinking: args.thinking };
  if (config?.roles) {
    const roleConfig = (config.roles as any)[role];
    if (roleConfig?.model) return { model: roleConfig.model, thinking: roleConfig.thinking };
  }
  return {};
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
    const response = await sendDaemonRequest(endpoint, "runtime.status", {});
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
  if (args["src-root"] !== undefined && payload.srcRoot === undefined) payload.srcRoot = args["src-root"];
  if (args.contextAddendum !== undefined && payload.contextAddendum === undefined) payload.contextAddendum = args.contextAddendum;

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
    // --feature <id> is a shorthand so callers don't need to JSON-encode --data
    if (payload.featureId !== undefined) {
      payload.payload = { featureId: payload.featureId, ...(payload.payload as Record<string, unknown> ?? {}) };
      delete payload.featureId;
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

async function callDaemonAction(action: string, args: Record<string, any>): Promise<Record<string, unknown>> {
  const explicitEndpoint = daemonEndpointFromArgs(args);
  const explicitTimeoutMs = parsePositiveMs(args.timeout);
  const requestOptions = explicitTimeoutMs !== null ? { timeoutMs: explicitTimeoutMs } : undefined;

  if (action === "runtime.ensure") {
    const endpoint = await ensureDaemonRunning(args);
    const status = await sendDaemonRequest(endpoint, "runtime.status", {}, requestOptions);
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
    const shutdown = await sendDaemonRequest(reachable, action, {}, requestOptions);
    if (!shutdown.ok) return { ok: false, error: shutdown.error ?? "Daemon shutdown failed" };
    return { ok: true, action, endpoint: reachable, ...(shutdown.result ?? {}) };
  }

  const endpoint = await ensureDaemonRunning(args);
  const payload = buildDaemonPayload(action, args);
  const response = await sendDaemonRequest(
    endpoint,
    action,
    payload,
    requestOptions,
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

  // Pre-flight: config must be set up before any worker can launch
  const config = loadConfig(projectRoot);
  if (config?.configured === false) {
    return { ok: false, error: "Floe not configured. Run: bun run .floe/bin/floe.ts configure" };
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

  // Inject srcRoot context for implementer sessions
  const workerArgs = { ...args };
  if (role === "implementer" && !workerArgs.contextAddendum && config?.srcRoot) {
    workerArgs.contextAddendum = srcRootContextAddendum(config.srcRoot);
  }

  const runtimeResult = await callDaemonAction("worker.start", workerArgs);
  if (!runtimeResult.ok) return runtimeResult;

  const session = (runtimeResult as any).session as Record<string, any> | undefined;
  const initial = (runtimeResult as any).initialResult as Record<string, any> | null | undefined;
  const workerId = (runtimeResult as any).workerId as string;

  return {
    ok: true,
    sessionId: workerId,
    workerId,
    role: session?.role ?? role,
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

  // Hard alignment gate: block ad-hoc implementer messages when approach not approved.
  // During daemon-native feature execution (manage-feature-pair), alignment is enforced
  // by the workflow engine via call.blocking/call.resolve — this gate only applies to
  // manual message-worker usage.
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
      id: s.id, role: s.role, status: s.status,
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

  // Pre-flight: config must be set up
  if (config?.configured === false) {
    return { ok: false, error: "Floe not configured. Run: bun run .floe/bin/floe.ts configure" };
  }

  // Resolve model config for implementer and reviewer
  const implModel = resolveModel("implementer", args, config);
  const revModel = resolveModel("reviewer", args, config);

  // Derive and set active release/epic/feature context from the feature artefact chain
  try {
    const featureFile = join(projectRoot, "delivery", "features", `${args.feature}.json`);
    if (existsSync(featureFile)) {
      const feature = JSON.parse(readFileSync(featureFile, "utf-8"));
      const epicId = feature.epic_id as string | undefined;
      const runtimeState = join(projectRoot, ".floe", "state", "current.json");
      if (existsSync(runtimeState)) {
        const rs = JSON.parse(readFileSync(runtimeState, "utf-8"));
        if (epicId) {
          const epicFile = join(projectRoot, "delivery", "epics", `${epicId}.json`);
          if (existsSync(epicFile)) {
            const epic = JSON.parse(readFileSync(epicFile, "utf-8"));
            const releaseId = epic.release_id as string | undefined;
            if (releaseId) rs.active_release_id = releaseId;
          }
          rs.active_epic_id = epicId;
        }
        rs.active_feature_id = args.feature;
        rs.updated_at = new Date().toISOString();
        writeFileSync(runtimeState, JSON.stringify(rs, null, 2) + "\n", "utf-8");
      }
    }
  } catch { /* non-fatal — don't block launch if state derivation fails */ }

  // Call the daemon's run.feature action — all orchestration happens in-process
  const result = await callDaemonAction("run.feature", {
    ...args,
    data: JSON.stringify({
      featureId: args.feature,
      implModel: implModel.model ?? null,
      revModel: revModel.model ?? null,
      epicId: args.epic ?? null,
      releaseId: args.release ?? null,
      srcRoot: config?.srcRoot ?? null,
    }),
  });

  if (!result.ok) return result;

  return {
    ok: true,
    featureId: args.feature,
    runId: (result as any).runId,
    runtimeManaged: true,
    implementer: (result as any).implementer,
    reviewer: (result as any).reviewer,
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

// ─── Legacy feature-runner commands (removed — daemon-native) ────────

async function featureRunStatus(_args: Record<string, any>) {
  return {
    ok: false,
    error: "feature-run-status is removed. Feature runs are now daemon-managed. Use: run.get --run <runId> or events.subscribe --run <runId>",
  };
}

async function waitFeatureRun(_args: Record<string, any>) {
  return {
    ok: false,
    error: "wait-feature-run is removed. Feature runs are now daemon-managed. Use: events.subscribe --run <runId> --wait-ms <ms>",
  };
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

const THINKING_LEVELS = ["low", "normal", "high"] as const;

async function configureCommand(args: Record<string, any>) {
  const configPath = join(projectRoot, ".floe", "config.json");

  const model = args.model as string | undefined;
  const thinking = args.thinking as string | undefined;
  const srcRoot = args["src-root"] as string | undefined;

  if (!model && !thinking && !srcRoot) {
    const existingConfig = loadConfig(projectRoot);
    return {
      ok: true,
      action: "choose",
      message: "Provide --model <model> and optionally --thinking <level> and --src-root <path> to configure.",
      thinkingLevels: [...THINKING_LEVELS],
      currentConfig: existingConfig ?? null,
    };
  }

  if (thinking && !THINKING_LEVELS.includes(thinking as any)) {
    return { ok: false, error: `Invalid thinking: ${thinking}. Must be: ${THINKING_LEVELS.join(", ")}` };
  }

  const config: FloeConfig = { configured: true };
  if (srcRoot) config.srcRoot = srcRoot;
  if (model || thinking) {
    config.roles = {};
    for (const role of ["planner", "implementer", "reviewer"] as const) {
      const roleConf: Record<string, string> = {};
      if (model) roleConf.model = model;
      if (thinking) roleConf.thinking = thinking;
      (config.roles as any)[role] = roleConf;
    }
  }
  mkdirSync(join(projectRoot, ".floe"), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return { ok: true, message: `Wrote ${configPath}`, config };
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
    srcRoot: config.srcRoot ?? null,
  };
}

async function updateConfig(args: Record<string, any>) {
  const configPath = join(projectRoot, ".floe", "config.json");
  const config = loadConfig(projectRoot) ?? {} as FloeConfig;

  const role = args.role as string | undefined;
  const model = args.model as string | undefined;
  const thinking = args.thinking as string | undefined;

  if (!model && !thinking && !args["src-root"]) {
    return { ok: false, error: "update-config requires at least one of: --src-root, --model, --thinking" };
  }

  const validThinking = ["low", "normal", "high"];
  if (thinking && !validThinking.includes(thinking)) {
    return { ok: false, error: `Invalid thinking: ${thinking}. Must be: ${validThinking.join(", ")}` };
  }

  if (args["src-root"] !== undefined) {
    config.srcRoot = (args["src-root"] as string) || undefined;
  }

  const targetRoles: string[] = role === "all"
    ? ["planner", "implementer", "reviewer"]
    : role ? [role] : [];

  if (targetRoles.length > 0 && (model || thinking)) {
    if (!config.roles) config.roles = {};
    for (const r of targetRoles) {
      const existing = (config.roles as any)[r] ?? {};
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

/**
 * True-blocking call-blocking implementation.
 *
 * Two transport modes:
 *
 * 1. **Persistent socket channel** (primary) — when FLOE_DAEMON_ENDPOINT is set
 *    (i.e. running inside a worker process), uses WorkerClient to establish a
 *    persistent connection, sends call.blocking, and waits for the daemon to push
 *    call.resolved over the same socket. Sub-second latency.
 *
 * 2. **CLI polling fallback** — when no persistent channel is available (admin/
 *    debug use), falls back to one-shot request + events.subscribe polling loop.
 *
 * The worker's tool-call subprocess stays running the entire time in both modes.
 */
async function callBlockingAndWait(args: Record<string, any>): Promise<Record<string, unknown>> {
  const endpoint = await ensureDaemonRunning(args);
  const payload = buildDaemonPayload("call.blocking", args);
  const waitMs = parsePositiveMs(args["wait-ms"]) ?? 1_800_000;

  // ── Primary: persistent socket channel ────────────────────────────
  // Use when FLOE_DAEMON_ENDPOINT is set (worker process context).
  const channelEndpoint = process.env.FLOE_DAEMON_ENDPOINT;
  const workerId = payload.workerId as string | undefined;
  const runId = payload.runId as string | undefined;

  if (channelEndpoint && workerId && runId) {
    try {
      const { WorkerClient } = await import("../runtime/daemon/worker-client.ts");
      const client = new WorkerClient(channelEndpoint, workerId, runId);
      await client.connect({ connectTimeoutMs: 10_000, heartbeatIntervalMs: 30_000 });

      try {
        const result = await client.callBlocking(
          {
            runId,
            workerId,
            callType: payload.callType as string,
            payload: payload.payload as Record<string, unknown> | undefined,
            dependsOn: payload.dependsOn as string[] | undefined,
            resumeStrategy: payload.resumeStrategy as any,
            timeoutAt: payload.timeoutAt as string | undefined,
          },
          { waitMs },
        );
        return result;
      } finally {
        client.close();
      }
    } catch (err: any) {
      // If persistent channel fails, fall through to polling fallback.
      // This handles cases where the daemon doesn't support the channel protocol yet.
    }
  }

  // ── Fallback: one-shot CLI polling ────────────────────────────────
  const registerResp = await sendDaemonRequest(endpoint, "call.blocking", payload);
  if (!registerResp.ok) {
    return { ok: false, action: "call.blocking", endpoint, error: registerResp.error ?? "call.blocking registration failed" };
  }

  const callId = (registerResp.result as Record<string, any>)?.call?.callId as string | undefined;
  if (!callId || !runId) {
    return { ok: false, error: "call.blocking did not return callId or runId — cannot wait for resolution" };
  }

  const pollChunkMs = 30_000;
  const start = Date.now();
  let cursor = 0;

  while (Date.now() - start < waitMs) {
    const remaining = waitMs - (Date.now() - start);
    const chunkWait = Math.min(pollChunkMs, remaining);

    const evtResp = await sendDaemonRequest(endpoint, "events.subscribe", {
      runId,
      callId,
      cursor,
      waitMs: chunkWait,
      limit: 50,
    });

    if (!evtResp.ok) {
      return { ok: false, error: evtResp.error ?? "events.subscribe failed while waiting for call resolution" };
    }

    const result = evtResp.result as Record<string, any>;
    const events: Array<Record<string, any>> = result?.events ?? [];

    for (const event of events) {
      if (event.type === "call.resolved" && event.callId === callId) {
        return {
          ok: true,
          callId,
          responsePayload: event.data?.responsePayload ?? null,
          resolvedBy: event.data?.resolvedBy ?? null,
        };
      }
    }

    cursor = (result?.nextCursor as number | undefined) ?? cursor;
  }

  return {
    ok: false,
    error: `Timed out after ${waitMs}ms waiting for call ${callId} to be resolved`,
    callId,
  };
}

// ─── CLI dispatch ────────────────────────────────────────────────────

const [command, ...rest] = Bun.argv.slice(2);

const { values: opts } = parseArgs({
  args: rest,
  options: {
    role: { type: "string" },
    feature: { type: "string" },
    epic: { type: "string" },
    release: { type: "string" },
    context: { type: "string" },
    session: { type: "string" },
    message: { type: "string" },
    reason: { type: "string" },
    scope: { type: "string" },
    target: { type: "string" },
    "force-no-alignment": { type: "boolean" },
    model: { type: "string" },
    thinking: { type: "string" },
    async: { type: "boolean" },
    "result-path": { type: "string" },
    timeout: { type: "string" },
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
    "to": { type: "string" },
    "run-state": { type: "string" },
    "src-root": { type: "string" },
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
    "wait-feature-run": waitFeatureRun,
    "show-dod": showDod,
    "edit-dod": editDod,
    "list-escalations": listEscalations,
    "resolve-escalation": resolveEscalation,
    "configure": configureCommand,
    "show-config": showConfig,
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
    "run.feature": daemonCommand("run.feature"),
    "run-start": daemonCommand("run.start"),
    "run-complete": daemonCommand("run.complete"),
    "run-escalate": daemonCommand("run.escalate"),
    "run-get": daemonCommand("run.get"),
    "run-feature": daemonCommand("run.feature"),

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
    // call-blocking truly blocks: registers the call then long-polls until resolved,
    // returning the responsePayload inline to the worker in the same turn.
    "call.blocking": callBlockingAndWait,
    "call.resolve": daemonCommand("call.resolve"),
    "call.detectOrphaned": daemonCommand("call.detectOrphaned"),
    "call-blocking": callBlockingAndWait,
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
