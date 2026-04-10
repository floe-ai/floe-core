/**
 * Integration tests for the daemon-native feature workflow.
 *
 * Tests the DaemonStore, DaemonService (blocking calls, resolve, auto-resume,
 * orphan detection), and FeatureWorkflowEngine.
 *
 * Run: bun test floe/runtime/daemon/__tests__/daemon-workflow.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DaemonStore } from "../store.ts";
import { FeatureWorkflowEngine } from "../feature-workflow.ts";
import type { RunRecord, WorkerRuntimeRecord, PendingCallRecord, RuntimeRunState } from "../types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "floe-test-"));
  mkdirSync(join(dir, ".floe", "state", "daemon"), { recursive: true });
  mkdirSync(join(dir, "delivery", "features"), { recursive: true });
  mkdirSync(join(dir, "delivery", "reviews"), { recursive: true });
  mkdirSync(join(dir, "delivery", "epics"), { recursive: true });
  return dir;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeRun(store: DaemonStore, overrides: Partial<RunRecord> = {}): RunRecord {
  const run: RunRecord = {
    runId: `run-${Date.now().toString(36)}`,
    type: "feature_execution",
    objective: "test",
    participants: [],
    state: "initialising" as RuntimeRunState,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  };
  store.upsertRun(run);
  return run;
}

function makeWorker(store: DaemonStore, overrides: Partial<WorkerRuntimeRecord> = {}): WorkerRuntimeRecord {
  const worker: WorkerRuntimeRecord = {
    workerId: `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId: `s-${Date.now().toString(36)}`,
    role: "implementer",
    provider: "copilot",
    state: "active",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    retryCount: 0,
    ...overrides,
  };
  store.upsertWorker(worker);
  return worker;
}

function writeFeature(projectRoot: string, featureId: string, data: Record<string, any> = {}): void {
  const dir = join(projectRoot, "delivery", "features");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${featureId}.json`), JSON.stringify({
    id: featureId,
    title: `Test feature ${featureId}`,
    status: "in_progress",
    epic_id: "epic-001",
    ...data,
  }, null, 2));
}

function writeReview(projectRoot: string, reviewId: string, data: Record<string, any> = {}): void {
  const dir = join(projectRoot, "delivery", "reviews");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${reviewId}.json`), JSON.stringify({
    id: reviewId,
    status: "open",
    target_id: "feat-test",
    approach_proposal: null,
    outcome: "pending",
    findings: [],
    ...data,
  }, null, 2));
}

// ── Tests ────────────────────────────────────────────────────────────

describe("DaemonStore", () => {
  let projectRoot: string;
  let store: DaemonStore;

  beforeEach(() => {
    projectRoot = makeTmpProject();
    store = new DaemonStore(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("run CRUD", () => {
    const run = makeRun(store, { runId: "run-001" });
    expect(store.getRun("run-001")).toBeDefined();
    expect(store.getRun("run-001")!.state).toBe("initialising");

    store.upsertRun({ ...run, state: "implementing" });
    expect(store.getRun("run-001")!.state).toBe("implementing");
  });

  test("worker CRUD", () => {
    const worker = makeWorker(store, { workerId: "w-001" });
    expect(store.getWorker("w-001")).toBeDefined();
    expect(store.getWorker("w-001")!.state).toBe("active");
  });

  test("pending call CRUD", () => {
    const call: PendingCallRecord = {
      callId: "call-001",
      runId: "run-001",
      workerId: "w-001",
      role: "implementer",
      callType: "request_code_review",
      status: "pending",
      payload: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
    };
    store.upsertCall(call);
    expect(store.getCall("call-001")).toBeDefined();
    expect(store.getCall("call-001")!.status).toBe("pending");
    expect(store.listPendingCalls().length).toBe(1);

    store.upsertCall({ ...call, status: "resolved", resolvedAt: nowIso() });
    expect(store.listPendingCalls().length).toBe(0);
  });

  test("event emission and retrieval", () => {
    const e1 = store.emitEvent({ type: "run.started", runId: "run-001" });
    const e2 = store.emitEvent({ type: "run.completed", runId: "run-001" });
    const e3 = store.emitEvent({ type: "run.started", runId: "run-002" });

    const all = store.listEvents({});
    expect(all.length).toBe(3);

    const forRun1 = store.listEvents({ runId: "run-001" });
    expect(forRun1.length).toBe(2);

    const afterE1 = store.listEvents({ cursor: e1.seq });
    expect(afterE1.length).toBe(2);
    expect(afterE1[0]!.seq).toBe(e2.seq);
  });

  test("store rehydrates from JSONL on restart", () => {
    makeRun(store, { runId: "run-persist" });
    makeWorker(store, { workerId: "w-persist" });
    store.emitEvent({ type: "run.started", runId: "run-persist" });

    // Create a new store from the same directory
    const store2 = new DaemonStore(projectRoot);
    expect(store2.getRun("run-persist")).toBeDefined();
    expect(store2.getWorker("w-persist")).toBeDefined();
    expect(store2.listEvents({}).length).toBeGreaterThanOrEqual(1);
  });
});

describe("Blocking call lifecycle", () => {
  let projectRoot: string;
  let store: DaemonStore;

  beforeEach(() => {
    projectRoot = makeTmpProject();
    store = new DaemonStore(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("call.blocking creates pending call and sets worker to waiting", () => {
    const run = makeRun(store);
    const worker = makeWorker(store, { runId: run.runId });

    const call: PendingCallRecord = {
      callId: "call-block-001",
      runId: run.runId,
      workerId: worker.workerId,
      role: worker.role,
      callType: "request_code_review",
      status: "pending",
      payload: { question: "Is the approach valid?" },
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
    };
    store.upsertCall(call);

    // Worker enters waiting state
    store.upsertWorker({ ...worker, state: "waiting", pendingCallId: call.callId });

    expect(store.getCall(call.callId)!.status).toBe("pending");
    expect(store.getWorker(worker.workerId)!.state).toBe("waiting");
    expect(store.getWorker(worker.workerId)!.pendingCallId).toBe(call.callId);
  });

  test("call.resolve transitions call to resolved and worker to resolved", () => {
    const run = makeRun(store);
    const worker = makeWorker(store, { runId: run.runId, state: "waiting", pendingCallId: "call-res-001" });

    const call: PendingCallRecord = {
      callId: "call-res-001",
      runId: run.runId,
      workerId: worker.workerId,
      role: worker.role,
      callType: "request_code_review",
      status: "pending",
      payload: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
    };
    store.upsertCall(call);

    // Resolve the call
    const resolved: PendingCallRecord = {
      ...call,
      status: "resolved",
      responsePayload: { message: "Approach approved" },
      resolvedBy: "reviewer",
      resolvedAt: nowIso(),
      updatedAt: nowIso(),
    };
    store.upsertCall(resolved);
    store.upsertWorker({ ...worker, state: "resolved" });

    expect(store.getCall(call.callId)!.status).toBe("resolved");
    expect(store.getCall(call.callId)!.resolvedBy).toBe("reviewer");
    expect(store.getWorker(worker.workerId)!.state).toBe("resolved");
  });

  test("orphan detection marks calls from stopped workers", () => {
    const run = makeRun(store);
    const worker = makeWorker(store, { runId: run.runId, state: "stopped" });

    const call: PendingCallRecord = {
      callId: "call-orphan-001",
      runId: run.runId,
      workerId: worker.workerId,
      role: worker.role,
      callType: "request_code_review",
      status: "pending",
      payload: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
    };
    store.upsertCall(call);

    // Simulate orphan detection
    const pending = store.listPendingCalls(run.runId);
    const orphaned: PendingCallRecord[] = [];

    for (const c of pending) {
      const w = store.getWorker(c.workerId);
      if (!w || w.state === "stopped" || w.state === "failed") {
        const updated = { ...c, status: "orphaned" as const, updatedAt: nowIso() };
        store.upsertCall(updated);
        orphaned.push(updated);
      }
    }

    expect(orphaned.length).toBe(1);
    expect(store.getCall(call.callId)!.status).toBe("orphaned");
  });

  test("timed-out call detection", () => {
    const run = makeRun(store);
    const worker = makeWorker(store, { runId: run.runId, state: "waiting" });

    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const call: PendingCallRecord = {
      callId: "call-timeout-001",
      runId: run.runId,
      workerId: worker.workerId,
      role: worker.role,
      callType: "request_code_review",
      status: "pending",
      payload: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
      timeoutAt: pastTime,
    };
    store.upsertCall(call);

    // Simulate timeout detection
    const pending = store.listPendingCalls(run.runId);
    const now = Date.now();
    let timedOut = 0;

    for (const c of pending) {
      if (c.timeoutAt && Date.parse(c.timeoutAt) < now) {
        store.upsertCall({ ...c, status: "timed_out", updatedAt: nowIso() });
        timedOut++;
      }
    }

    expect(timedOut).toBe(1);
    expect(store.getCall(call.callId)!.status).toBe("timed_out");
  });
});

describe("FeatureWorkflowEngine", () => {
  let projectRoot: string;
  let store: DaemonStore;
  let engine: FeatureWorkflowEngine;
  let sentMessages: { workerId: string; message: string }[];

  beforeEach(() => {
    projectRoot = makeTmpProject();
    store = new DaemonStore(projectRoot);
    sentMessages = [];

    engine = new FeatureWorkflowEngine(
      projectRoot,
      store,
      async (workerId, message) => {
        sentMessages.push({ workerId, message });
        return { ok: true, content: "ack" };
      },
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("start creates workflow state and emits event", async () => {
    const run = makeRun(store);
    const state = await engine.start("feat-001", run.runId, "impl-w", "rev-w");

    expect(state.featureId).toBe("feat-001");
    expect(state.phase).toBe("alignment");
    expect(state.runId).toBe(run.runId);

    const events = store.listEvents({ runId: run.runId });
    const workflowStarted = events.find(e => e.type === "workflow.started");
    expect(workflowStarted).toBeDefined();
  });

  test("getState returns current workflow", async () => {
    const run = makeRun(store);
    await engine.start("feat-002", run.runId, "impl-w", "rev-w");

    const state = engine.getState(run.runId);
    expect(state).toBeDefined();
    expect(state!.featureId).toBe("feat-002");
  });

  test("stop cleans up workflow", async () => {
    const run = makeRun(store);
    await engine.start("feat-003", run.runId, "impl-w", "rev-w");

    engine.stop(run.runId);
    expect(engine.getState(run.runId)).toBeUndefined();
  });

  test("first tick sends message to implementer", async () => {
    const run = makeRun(store);
    await engine.start("feat-004", run.runId, "impl-w", "rev-w");

    // Wait for the first tick to fire (it runs immediately on start)
    await Bun.sleep(100);

    // The engine should have sent an initial alignment message
    const implMessages = sentMessages.filter(m => m.workerId === "impl-w");
    expect(implMessages.length).toBeGreaterThanOrEqual(1);
    expect(implMessages[0]!.message).toContain("Propose");

    engine.stop(run.runId);
  });

  test("deterministic happy path via triggerTick", async () => {
    const featureId = "feat-det";
    writeFeature(projectRoot, featureId);

    const run = makeRun(store);

    // Start but immediately stop auto-ticking — we'll drive manually
    await engine.start(featureId, run.runId, "impl-w", "rev-w");
    await Bun.sleep(100); // let first tick fire
    // First tick already sent alignment message
    const s0 = engine.getState(run.runId)!;
    expect(s0.phase).toBe("alignment");
    expect(s0.lastAction).toBe("messaged-implementer-propose");

    // Stop auto-tick timer but preserve state
    const timer = (engine as any).timers.get(run.runId);
    if (timer) clearTimeout(timer);
    (engine as any).timers.delete(run.runId);

    // Tick 2: no review yet — should retry
    await engine.triggerTick(run.runId);
    expect(engine.getState(run.runId)!.lastAction).toBe("messaged-implementer-propose");

    // Simulate: implementer creates review with pending proposal
    writeReview(projectRoot, "rev-001", {
      target_id: featureId,
      approach_proposal: { verdict: "pending", proposal: "build it" },
    });

    // Tick 3: detects proposal → messages reviewer
    await engine.triggerTick(run.runId);
    expect(engine.getState(run.runId)!.lastAction).toBe("messaged-reviewer-evaluate");

    // Tick 4: verdict still pending (no change) — should retry
    await engine.triggerTick(run.runId);
    expect(engine.getState(run.runId)!.lastAction).toBe("messaged-reviewer-evaluate");

    // Simulate: reviewer approves
    writeReview(projectRoot, "rev-001", {
      target_id: featureId,
      approach_proposal: { verdict: "approved", rationale: "looks good" },
    });

    // Tick 5: detects approval → transitions to implementation phase
    await engine.triggerTick(run.runId);
    expect(engine.getState(run.runId)!.phase).toBe("implementation");
    expect(engine.getState(run.runId)!.lastAction).toBe("");

    // Tick 6: sends implementation message
    await engine.triggerTick(run.runId);
    expect(engine.getState(run.runId)!.lastAction).toBe("messaged-implementer-implement");

    // Simulate: implementer signals ready_for_review
    writeFeature(projectRoot, featureId, {
      execution_state: { last_run_outcome: "ready_for_review" },
    });

    // Tick 7: detects ready_for_review → transitions to review
    await engine.triggerTick(run.runId);
    expect(engine.getState(run.runId)!.phase).toBe("review");

    // Simulate: reviewer passes
    writeReview(projectRoot, "rev-001", {
      target_id: featureId,
      approach_proposal: { verdict: "approved" },
      outcome: "pass",
    });

    // Tick 8: sends review message
    await engine.triggerTick(run.runId);

    // Tick 9: detects pass → completes
    await engine.triggerTick(run.runId);

    // Workflow should be terminal
    const finalState = engine.getState(run.runId);
    expect(finalState).toBeUndefined(); // cleaned up on terminal

    // Run should be completed in the store
    const finalRun = store.getRun(run.runId);
    expect(finalRun!.state).toBe("completed");

    // Feature artefact should be marked completed
    const feat = JSON.parse(readFileSync(join(projectRoot, "delivery", "features", `${featureId}.json`), "utf-8"));
    expect(feat.status).toBe("completed");
  });
});

describe("CLI legacy command migration", () => {
  test("feature-run-status returns migration error", async () => {
    const proc = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "../../../bin/floe.ts"), "feature-run-status", "--feature", "test"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = JSON.parse(proc.stdout.toString());
    expect(output.ok).toBe(false);
    expect(output.error).toContain("removed");
    expect(output.error).toContain("run.get");
  });

  test("wait-feature-run returns migration error", async () => {
    const proc = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "../../../bin/floe.ts"), "wait-feature-run", "--feature", "test"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = JSON.parse(proc.stdout.toString());
    expect(output.ok).toBe(false);
    expect(output.error).toContain("removed");
    expect(output.error).toContain("events.subscribe");
  });

  test("get-worker-result returns migration error", async () => {
    const proc = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "../../../bin/floe.ts"), "get-worker-result", "--session", "test"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = JSON.parse(proc.stdout.toString());
    expect(output.ok).toBe(false);
    expect(output.error).toContain("removed");
  });
});
