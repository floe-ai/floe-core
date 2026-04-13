/**
 * Integration tests for the continuation-driven daemon workflow.
 *
 * Tests the DaemonStore (including event subscription), blocking call lifecycle,
 * FeatureWorkflowEngine event reactor, and CLI migration stubs.
 *
 * Run: bun test daemon/__tests__/daemon-workflow.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DaemonStore } from "../store.ts";
import { FeatureWorkflowEngine, CALL_TYPES } from "../feature-workflow.ts";
import type { RunRecord, WorkerRuntimeRecord, PendingCallRecord, RuntimeEvent } from "../types.ts";

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
    state: "initialising",
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
  writeFileSync(join(dir, `${featureId}.json`), JSON.stringify({
    id: featureId,
    title: `Test feature ${featureId}`,
    status: "in_progress",
    epic_id: "epic-001",
    ...data,
  }, null, 2));
}

// ── DaemonStore Tests ────────────────────────────────────────────────

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
    makeWorker(store, { workerId: "w-001" });
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
    expect(store.listPendingCalls().length).toBe(1);

    store.upsertCall({ ...call, status: "resolved", resolvedAt: nowIso() });
    expect(store.listPendingCalls().length).toBe(0);
  });

  test("event emission and retrieval", () => {
    const e1 = store.emitEvent({ type: "run.started", runId: "run-001" });
    const e2 = store.emitEvent({ type: "run.completed", runId: "run-001" });
    store.emitEvent({ type: "run.started", runId: "run-002" });

    expect(store.listEvents({}).length).toBe(3);
    expect(store.listEvents({ runId: "run-001" }).length).toBe(2);
    expect(store.listEvents({ cursor: e1.seq }).length).toBe(2);
    expect(store.listEvents({ cursor: e1.seq })[0]!.seq).toBe(e2.seq);
  });

  test("event subscription delivers events to listeners", () => {
    const received: RuntimeEvent[] = [];
    const unsub = store.onEvent((event) => received.push(event));

    store.emitEvent({ type: "run.started", runId: "run-001" });
    store.emitEvent({ type: "run.completed", runId: "run-001" });

    expect(received.length).toBe(2);
    expect(received[0]!.type).toBe("run.started");
    expect(received[1]!.type).toBe("run.completed");

    unsub();
    store.emitEvent({ type: "run.started", runId: "run-002" });
    expect(received.length).toBe(2); // no new events after unsubscribe
  });

  test("store rehydrates from JSONL on restart", () => {
    makeRun(store, { runId: "run-persist" });
    makeWorker(store, { workerId: "w-persist" });
    store.emitEvent({ type: "run.started", runId: "run-persist" });

    const store2 = new DaemonStore(projectRoot);
    expect(store2.getRun("run-persist")).toBeDefined();
    expect(store2.getWorker("w-persist")).toBeDefined();
    expect(store2.listEvents({}).length).toBeGreaterThanOrEqual(1);
  });
});

// ── Blocking Call Lifecycle Tests ────────────────────────────────────

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
      callType: CALL_TYPES.CODE_REVIEW,
      status: "pending",
      payload: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
    };
    store.upsertCall(call);
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
      callType: CALL_TYPES.CODE_REVIEW,
      status: "pending",
      payload: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
    };
    store.upsertCall(call);

    store.upsertCall({
      ...call,
      status: "resolved",
      responsePayload: { outcome: "pass", continuation: "Approved" },
      resolvedBy: "reviewer",
      resolvedAt: nowIso(),
    });
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
      callType: CALL_TYPES.CODE_REVIEW,
      status: "pending",
      payload: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
    };
    store.upsertCall(call);

    const pending = store.listPendingCalls(run.runId);
    for (const c of pending) {
      const w = store.getWorker(c.workerId);
      if (!w || w.state === "stopped" || w.state === "failed") {
        store.upsertCall({ ...c, status: "orphaned" as any, updatedAt: nowIso() });
      }
    }

    expect(store.getCall(call.callId)!.status).toBe("orphaned");
  });

  test("timed-out call detection", () => {
    const run = makeRun(store);
    makeWorker(store, { runId: run.runId, state: "waiting" });

    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const call: PendingCallRecord = {
      callId: "call-timeout-001",
      runId: run.runId,
      workerId: "w-x",
      role: "implementer",
      callType: CALL_TYPES.CODE_REVIEW,
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

    const pending = store.listPendingCalls(run.runId);
    const now = Date.now();
    for (const c of pending) {
      if (c.timeoutAt && Date.parse(c.timeoutAt) < now) {
        store.upsertCall({ ...c, status: "timed_out", updatedAt: nowIso() });
      }
    }

    expect(store.getCall(call.callId)!.status).toBe("timed_out");
  });
});

// ── FeatureWorkflowEngine Tests (event-driven) ──────────────────────

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
    engine.stop("run-test"); // cleanup any active workflows
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("start sends bootstrap message to implementer", async () => {
    const run = makeRun(store);
    const state = await engine.start("feat-001", run.runId, "impl-w", "rev-w");

    expect(state.featureId).toBe("feat-001");
    expect(state.phase).toBe("alignment");
    expect(state.lastAction).toBe("bootstrap-sent");

    const implMessages = sentMessages.filter(m => m.workerId === "impl-w");
    expect(implMessages.length).toBe(1);
    expect(implMessages[0]!.message).toContain("floe_call_blocking");
    expect(implMessages[0]!.message).toContain(CALL_TYPES.APPROACH_REVIEW);

    const events = store.listEvents({ runId: run.runId });
    expect(events.find(e => e.type === "workflow.started")).toBeDefined();
  });

  test("getState and stop", async () => {
    const run = makeRun(store);
    await engine.start("feat-002", run.runId, "impl-w", "rev-w");

    expect(engine.getState(run.runId)).toBeDefined();
    engine.stop(run.runId);
    expect(engine.getState(run.runId)).toBeUndefined();
  });

  test("reacts to call.pending (approach review) — dispatches reviewer", async () => {
    const run = makeRun(store);
    await engine.start("feat-003", run.runId, "impl-w", "rev-w");
    sentMessages.length = 0; // clear bootstrap message

    // Simulate: implementer issued call.blocking → daemon emits call.pending
    await engine.injectEvent(run.runId, {
      type: "call.pending",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-001",
      data: { callType: CALL_TYPES.APPROACH_REVIEW },
      seq: 100,
      timestamp: nowIso(),
    });

    const revMessages = sentMessages.filter(m => m.workerId === "rev-w");
    expect(revMessages.length).toBe(1);
    expect(revMessages[0]!.message).toContain("floe_call_resolve");
    expect(revMessages[0]!.message).toContain("call-001");
    expect(revMessages[0]!.message).toContain("verdict");

    const state = engine.getState(run.runId)!;
    expect(state.lastAction).toBe("dispatched-approach-review");
  });

  test("reacts to call.resolved (approach approved) — advances to implementation", async () => {
    const run = makeRun(store);
    await engine.start("feat-004", run.runId, "impl-w", "rev-w");

    // Store the resolved call so the engine can read it
    const call: PendingCallRecord = {
      callId: "call-002",
      runId: run.runId,
      workerId: "impl-w",
      role: "implementer",
      callType: CALL_TYPES.APPROACH_REVIEW,
      status: "resolved",
      payload: {},
      responsePayload: { verdict: "approved", continuation: "Go ahead" },
      resolvedBy: "reviewer",
      resolvedAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
    };
    store.upsertCall(call);

    await engine.injectEvent(run.runId, {
      type: "call.resolved",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-002",
      data: { resolvedBy: "reviewer" },
      seq: 101,
      timestamp: nowIso(),
    });

    const state = engine.getState(run.runId)!;
    expect(state.phase).toBe("implementation");
    expect(state.lastAction).toBe("approach-approved");
  });

  test("reacts to call.resolved (approach rejected) — enters resolution", async () => {
    const run = makeRun(store);
    await engine.start("feat-005", run.runId, "impl-w", "rev-w");

    const call: PendingCallRecord = {
      callId: "call-003",
      runId: run.runId,
      workerId: "impl-w",
      role: "implementer",
      callType: CALL_TYPES.APPROACH_REVIEW,
      status: "resolved",
      payload: {},
      responsePayload: { verdict: "rejected", continuation: "Rethink" },
      resolvedBy: "reviewer",
      resolvedAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
    };
    store.upsertCall(call);

    await engine.injectEvent(run.runId, {
      type: "call.resolved",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-003",
      data: { resolvedBy: "reviewer" },
      seq: 102,
      timestamp: nowIso(),
    });

    const state = engine.getState(run.runId)!;
    expect(state.phase).toBe("resolution");
    expect(state.lastAction).toBe("approach-rejected");
  });

  test("reacts to call.pending (code review) — dispatches reviewer for review", async () => {
    const run = makeRun(store);
    await engine.start("feat-006", run.runId, "impl-w", "rev-w");
    sentMessages.length = 0;

    await engine.injectEvent(run.runId, {
      type: "call.pending",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-004",
      data: { callType: CALL_TYPES.CODE_REVIEW },
      seq: 103,
      timestamp: nowIso(),
    });

    const state = engine.getState(run.runId)!;
    expect(state.phase).toBe("review");
    expect(state.lastAction).toBe("dispatched-code-review");

    const revMessages = sentMessages.filter(m => m.workerId === "rev-w");
    expect(revMessages.length).toBe(1);
    expect(revMessages[0]!.message).toContain("outcome");
    expect(revMessages[0]!.message).toContain("pass");
  });

  test("full happy path: bootstrap → approach review → implementation → code review → pass", async () => {
    const featureId = "feat-happy";
    writeFeature(projectRoot, featureId);

    const run = makeRun(store);
    await engine.start(featureId, run.runId, "impl-w", "rev-w");

    // 1. Bootstrap sent to implementer ✓
    expect(engine.getState(run.runId)!.lastAction).toBe("bootstrap-sent");

    // 2. Implementer calls call.blocking (request_approach_review)
    await engine.injectEvent(run.runId, {
      type: "call.pending",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-approach",
      data: { callType: CALL_TYPES.APPROACH_REVIEW },
      seq: 10,
      timestamp: nowIso(),
    });
    expect(engine.getState(run.runId)!.lastAction).toBe("dispatched-approach-review");

    // 3. Reviewer resolves with approved verdict
    store.upsertCall({
      callId: "call-approach",
      runId: run.runId,
      workerId: "impl-w",
      role: "implementer",
      callType: CALL_TYPES.APPROACH_REVIEW,
      status: "resolved",
      payload: {},
      responsePayload: { verdict: "approved", continuation: "Approved. Implement now." },
      resolvedBy: "reviewer",
      resolvedAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
    });

    await engine.injectEvent(run.runId, {
      type: "call.resolved",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-approach",
      data: { resolvedBy: "reviewer" },
      seq: 11,
      timestamp: nowIso(),
    });
    expect(engine.getState(run.runId)!.phase).toBe("implementation");
    expect(engine.getState(run.runId)!.lastAction).toBe("approach-approved");

    // 4. Implementer finishes, calls call.blocking (request_code_review)
    await engine.injectEvent(run.runId, {
      type: "call.pending",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-review",
      data: { callType: CALL_TYPES.CODE_REVIEW },
      seq: 12,
      timestamp: nowIso(),
    });
    expect(engine.getState(run.runId)!.phase).toBe("review");
    expect(engine.getState(run.runId)!.lastAction).toBe("dispatched-code-review");

    // 5. Reviewer resolves with pass
    store.upsertCall({
      callId: "call-review",
      runId: run.runId,
      workerId: "impl-w",
      role: "implementer",
      callType: CALL_TYPES.CODE_REVIEW,
      status: "resolved",
      payload: {},
      responsePayload: { outcome: "pass", continuation: "Feature complete." },
      resolvedBy: "reviewer",
      resolvedAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
    });

    await engine.injectEvent(run.runId, {
      type: "call.resolved",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-review",
      data: { resolvedBy: "reviewer" },
      seq: 13,
      timestamp: nowIso(),
    });

    // Workflow should be cleaned up (terminal)
    expect(engine.getState(run.runId)).toBeUndefined();

    // Run should be completed
    const finalRun = store.getRun(run.runId);
    expect(finalRun!.state).toBe("completed");

    // Feature artefact should be marked completed
    const feat = JSON.parse(readFileSync(join(projectRoot, "delivery", "features", `${featureId}.json`), "utf-8"));
    expect(feat.status).toBe("completed");
  });

  test("review failure → revision_ready → re-review → pass", async () => {
    const featureId = "feat-revise";
    writeFeature(projectRoot, featureId);

    const run = makeRun(store);
    await engine.start(featureId, run.runId, "impl-w", "rev-w");

    // Skip to code review phase
    await engine.injectEvent(run.runId, {
      type: "call.pending",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-cr1",
      data: { callType: CALL_TYPES.CODE_REVIEW },
      seq: 20,
      timestamp: nowIso(),
    });

    // Reviewer fails the review
    store.upsertCall({
      callId: "call-cr1",
      runId: run.runId,
      workerId: "impl-w",
      role: "implementer",
      callType: CALL_TYPES.CODE_REVIEW,
      status: "resolved",
      payload: {},
      responsePayload: { outcome: "fail", continuation: "Fix the tests.", findings: "tests broken" },
      resolvedBy: "reviewer",
      resolvedAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
    });

    await engine.injectEvent(run.runId, {
      type: "call.resolved",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-cr1",
      data: { resolvedBy: "reviewer" },
      seq: 21,
      timestamp: nowIso(),
    });

    expect(engine.getState(run.runId)!.lastAction).toBe("review-failed");
    expect(engine.getState(run.runId)!.phase).toBe("review");

    // Implementer fixes and signals revision_ready
    sentMessages.length = 0;
    await engine.injectEvent(run.runId, {
      type: "call.pending",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-rev1",
      data: { callType: CALL_TYPES.REVISION_READY },
      seq: 22,
      timestamp: nowIso(),
    });

    expect(engine.getState(run.runId)!.lastAction).toBe("dispatched-re-review");
    expect(engine.getState(run.runId)!.round).toBe(2);

    // Reviewer passes on re-review
    store.upsertCall({
      callId: "call-rev1",
      runId: run.runId,
      workerId: "impl-w",
      role: "implementer",
      callType: CALL_TYPES.REVISION_READY,
      status: "resolved",
      payload: {},
      responsePayload: { outcome: "pass", continuation: "Looks good now." },
      resolvedBy: "reviewer",
      resolvedAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dependsOn: [],
      resumeStrategy: "session",
      retryCount: 0,
    });

    await engine.injectEvent(run.runId, {
      type: "call.resolved",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-rev1",
      data: { resolvedBy: "reviewer" },
      seq: 23,
      timestamp: nowIso(),
    });

    expect(engine.getState(run.runId)).toBeUndefined(); // terminal
    expect(store.getRun(run.runId)!.state).toBe("completed");
  });

  test("call.timed_out triggers escalation", async () => {
    const run = makeRun(store);
    await engine.start("feat-timeout", run.runId, "impl-w", "rev-w");

    await engine.injectEvent(run.runId, {
      type: "call.timed_out",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-timeout",
      data: {},
      seq: 30,
      timestamp: nowIso(),
    });

    expect(engine.getState(run.runId)).toBeUndefined(); // terminal
    expect(store.getRun(run.runId)!.state).toBe("escalated");
  });

  test("call.orphaned triggers escalation", async () => {
    const run = makeRun(store);
    await engine.start("feat-orphan", run.runId, "impl-w", "rev-w");

    await engine.injectEvent(run.runId, {
      type: "call.orphaned",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-orphan",
      data: {},
      seq: 31,
      timestamp: nowIso(),
    });

    expect(engine.getState(run.runId)).toBeUndefined();
    expect(store.getRun(run.runId)!.state).toBe("escalated");
  });

  test("worker.stalled triggers escalation", async () => {
    const run = makeRun(store);
    await engine.start("feat-stall", run.runId, "impl-w", "rev-w");

    await engine.injectEvent(run.runId, {
      type: "worker.stalled",
      runId: run.runId,
      workerId: "impl-w",
      data: { reason: "auto-resume failed" },
      seq: 32,
      timestamp: nowIso(),
    });

    expect(engine.getState(run.runId)).toBeUndefined();
    expect(store.getRun(run.runId)!.state).toBe("escalated");
  });

  test("events from store.onEvent trigger engine reactions (live subscription)", async () => {
    const run = makeRun(store);
    await engine.start("feat-live", run.runId, "impl-w", "rev-w");
    sentMessages.length = 0;

    // Emit event through the store — should be picked up by the engine's subscription
    store.emitEvent({
      type: "call.pending",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-live-001",
      data: { callType: CALL_TYPES.APPROACH_REVIEW },
    });

    // Give the async handler a moment to run
    await Bun.sleep(50);

    // Engine should have reacted to the event
    const state = engine.getState(run.runId)!;
    expect(state.lastAction).toBe("dispatched-approach-review");

    const revMessages = sentMessages.filter(m => m.workerId === "rev-w");
    expect(revMessages.length).toBe(1);
  });

  test("max rounds exceeded triggers escalation", async () => {
    const run = makeRun(store);
    await engine.start("feat-rounds", run.runId, "impl-w", "rev-w");

    // Force the round counter to maxRounds
    const state = engine.getState(run.runId)!;
    state.round = state.maxRounds;

    // revision_ready should now trigger max_rounds_exceeded
    await engine.injectEvent(run.runId, {
      type: "call.pending",
      runId: run.runId,
      workerId: "impl-w",
      callId: "call-maxround",
      data: { callType: CALL_TYPES.REVISION_READY },
      seq: 40,
      timestamp: nowIso(),
    });

    expect(engine.getState(run.runId)).toBeUndefined();
    expect(store.getRun(run.runId)!.state).toBe("escalated");
  });
});
