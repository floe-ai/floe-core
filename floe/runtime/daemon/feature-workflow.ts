/**
 * FeatureWorkflowEngine — continuation-driven feature lifecycle reactor.
 *
 * Runs inside the daemon process. Instead of polling artefact files on a timer,
 * it subscribes to daemon events and reacts to the call lifecycle:
 *
 *   1. Engine bootstraps: sends initial message to implementer
 *   2. Implementer works, then issues call.blocking (request_approach_review)
 *      call.blocking is a true blocking command — the implementer's subprocess
 *      long-polls events.subscribe and stays running until call.resolved fires.
 *   3. Engine reacts to call.pending → dispatches reviewer
 *   4. Reviewer evaluates, issues call.resolve with verdict
 *   5. call.resolved event fires; implementer's call.blocking subprocess returns
 *      responsePayload inline — the implementer reads it and continues in the
 *      same turn. No separate wake-up or workerContinue is needed.
 *   6. Engine reacts to call.resolved → advances workflow state
 *   7. Repeat for implementation/review phases
 *   8. Terminal states trigger bookkeeping (git commit, feature status, epic cascade)
 *
 * Primary coordination: call.blocking (inline wait) / call.resolve
 * worker.continue is a manual/recovery fallback only — not the happy path.
 * Artefact files: durable truth for validation — not the live signalling bus
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonStore } from "./store.ts";
import type { RunRecord, RuntimeEvent } from "./types.ts";

// ── Types ────────────────────────────────────────────────────────────

export type FeaturePhase =
  | "alignment"
  | "resolution"
  | "implementation"
  | "review"
  | "complete"
  | "escalated";

export interface FeatureWorkflowState {
  featureId: string;
  runId: string;
  implWorkerId: string;
  revWorkerId: string;
  phase: FeaturePhase;
  round: number;
  maxRounds: number;
  lastAction: string;
  lastActionResult?: string;
  outcome: null | "pass" | "escalated" | "blocked" | "needs_replan";
  escalationReason?: string;
  startedAt: string;
  updatedAt: string;
}

const TERMINAL_PHASES: FeaturePhase[] = ["complete", "escalated"];

/** Call types that workers issue to signal phase transitions. */
export const CALL_TYPES = {
  APPROACH_REVIEW: "request_approach_review",
  CODE_REVIEW: "request_code_review",
  REVISION_READY: "revision_ready",
  FOREMAN_CLARIFICATION: "request_foreman_clarification",
} as const;

// ── Artefact helpers (file I/O, no daemon dependency) ────────────────

function listArtefacts(dir: string): any[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), "utf-8")); }
      catch { return null; }
    })
    .filter(Boolean);
}

function findArtefact(dir: string, id: string): any | null {
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf-8")); }
  catch { return null; }
}

function updateArtefact(dir: string, _type: string, id: string, data: Record<string, any>): void {
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return;
  try {
    const existing = JSON.parse(readFileSync(file, "utf-8"));
    const merged = { ...existing, ...data, updated_at: new Date().toISOString() };
    writeFileSync(file, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

// ── Git helpers ──────────────────────────────────────────────────────

function gitCommitAndPush(projectRoot: string, message: string): void {
  try {
    const addResult = Bun.spawnSync(["git", "add", "-A"], { cwd: projectRoot, stdout: "ignore", stderr: "ignore" });
    if (addResult.exitCode !== 0) return;

    const statusResult = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: projectRoot, stdout: "pipe", stderr: "ignore" });
    if (!statusResult.stdout.toString().trim()) return;

    Bun.spawnSync(["git", "commit", "-m", message], { cwd: projectRoot, stdout: "ignore", stderr: "ignore", env: { ...process.env } });

    const remoteCheck = Bun.spawnSync(["git", "remote"], { cwd: projectRoot, stdout: "pipe", stderr: "ignore" });
    if (remoteCheck.stdout.toString().trim()) {
      Bun.spawnSync(["git", "push"], { cwd: projectRoot, stdout: "ignore", stderr: "ignore", env: { ...process.env } });
    }
  } catch { /* non-fatal */ }
}

// ── Escalation helper ────────────────────────────────────────────────

function createEscalation(
  projectRoot: string,
  featureId: string,
  reasonClass: string,
  description: string,
  reviewId?: string,
): void {
  try {
    const escScript = join(projectRoot, ".floe", "scripts", "escalation.ts");
    if (!existsSync(escScript)) return;
    const args = ["run", escScript, "create", "--from", "daemon", "--feature", featureId, "--reason", reasonClass];
    if (reviewId) args.push("--review", reviewId);
    args.push(description);
    Bun.spawnSync(["bun", ...args], { cwd: projectRoot, stdout: "ignore", stderr: "ignore" });
  } catch { /* non-fatal */ }
}

// ── Epic auto-transition ─────────────────────────────────────────────

function tryCompleteEpic(projectRoot: string, featureId: string): void {
  const featuresDir = join(projectRoot, "delivery", "features");
  const feature = findArtefact(featuresDir, featureId);
  if (!feature?.epic_id) return;

  const epicId = feature.epic_id as string;
  const epicFeatures = listArtefacts(featuresDir).filter((f: any) => f.epic_id === epicId);
  if (epicFeatures.length === 0) return;

  const allDone = epicFeatures.every((f: any) => f.status === "completed");
  if (!allDone) return;

  const epicsDir = join(projectRoot, "delivery", "epics");
  updateArtefact(epicsDir, "epic", epicId, { status: "completed" });
}

// ── Engine ───────────────────────────────────────────────────────────

type SendMessageFn = (workerId: string, message: string) => Promise<{ ok: boolean; content?: string; error?: string }>;

export class FeatureWorkflowEngine {
  private projectRoot: string;
  private store: DaemonStore;
  private sendMessage: SendMessageFn;
  private activeWorkflows = new Map<string, FeatureWorkflowState>();
  private unsubscribers = new Map<string, () => void>();

  private featuresDir: string;
  private reviewsDir: string;

  constructor(
    projectRoot: string,
    store: DaemonStore,
    sendMessage: SendMessageFn,
  ) {
    this.projectRoot = projectRoot;
    this.store = store;
    this.sendMessage = sendMessage;
    this.featuresDir = join(projectRoot, "delivery", "features");
    this.reviewsDir = join(projectRoot, "delivery", "reviews");
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Start a feature workflow. Bootstraps implementer and subscribes to events. */
  async start(
    featureId: string,
    runId: string,
    implWorkerId: string,
    revWorkerId: string,
  ): Promise<FeatureWorkflowState> {
    const now = new Date().toISOString();
    const state: FeatureWorkflowState = {
      featureId,
      runId,
      implWorkerId,
      revWorkerId,
      phase: "alignment",
      round: 1,
      maxRounds: 6,
      lastAction: "",
      outcome: null,
      startedAt: now,
      updatedAt: now,
    };

    this.activeWorkflows.set(runId, state);

    this.store.emitEvent({
      type: "workflow.started",
      runId,
      data: { featureId, phase: "alignment" },
    });

    // Subscribe to events for this run
    const unsub = this.store.onEvent((event) => {
      if (event.runId !== runId) return;
      this.handleEvent(runId, event).catch((err) => {
        const s = this.activeWorkflows.get(runId);
        if (s) {
          s.lastActionResult = `event handler error: ${err?.message ?? String(err)}`;
          s.updatedAt = new Date().toISOString();
        }
      });
    });
    this.unsubscribers.set(runId, unsub);

    // Bootstrap: send initial message to implementer
    await this.bootstrap(state);

    return state;
  }

  /** Get workflow state for a run. */
  getState(runId: string): FeatureWorkflowState | undefined {
    return this.activeWorkflows.get(runId);
  }

  /** Stop tracking a workflow (cleanup). */
  stop(runId: string): void {
    this.activeWorkflows.delete(runId);
    const unsub = this.unsubscribers.get(runId);
    if (unsub) {
      unsub();
      this.unsubscribers.delete(runId);
    }
  }

  /** Inject an event for testing (bypasses store.emitEvent, calls handleEvent directly). */
  async injectEvent(runId: string, event: RuntimeEvent): Promise<void> {
    await this.handleEvent(runId, event);
  }

  // ── Bootstrap ──────────────────────────────────────────────────────

  private async bootstrap(state: FeatureWorkflowState): Promise<void> {
    const msg = [
      `You are working on feature "${state.featureId}".`,
      `Your run ID is "${state.runId}" and your worker ID is "${state.implWorkerId}".`,
      "",
      "Read the feature artefact and the project Definition of Done:",
      `  bun run .floe/scripts/artefact.ts get feature ${state.featureId}`,
      `  bun run .floe/scripts/review.ts get-for ${state.featureId}`,
      "",
      "Propose your execution approach. When ready, signal via blocking call:",
      `  bun run .floe/bin/floe.ts call-blocking --run ${state.runId} --worker ${state.implWorkerId} --type ${CALL_TYPES.APPROACH_REVIEW} --data '{"featureId":"${state.featureId}"}'`,
      "",
      "This will pause your session until the reviewer responds.",
    ].join("\n");

    const result = await this.sendMessage(state.implWorkerId, msg);
    state.lastAction = "bootstrap-sent";
    state.lastActionResult = result.ok
      ? "implementer bootstrapped — waiting for call.blocking"
      : `bootstrap failed: ${result.error}`;
    state.updatedAt = new Date().toISOString();

    this.emitProgress(state, "alignment.bootstrap_sent");
  }

  // ── Event reactor ──────────────────────────────────────────────────

  private async handleEvent(runId: string, event: RuntimeEvent): Promise<void> {
    const state = this.activeWorkflows.get(runId);
    if (!state || TERMINAL_PHASES.includes(state.phase)) return;

    switch (event.type) {
      case "call.pending":
        await this.onCallPending(state, event);
        break;
      case "call.resolved":
        await this.onCallResolved(state, event);
        break;
      case "call.timed_out":
        await this.onCallTimedOut(state, event);
        break;
      case "call.orphaned":
        await this.onCallOrphaned(state, event);
        break;
      case "worker.stalled":
      case "worker.failed":
        await this.onWorkerFailure(state, event);
        break;
    }

    state.updatedAt = new Date().toISOString();

    if (TERMINAL_PHASES.includes(state.phase)) {
      await this.onTerminal(state);
    }
  }

  // ── call.pending handlers ──────────────────────────────────────────

  private async onCallPending(state: FeatureWorkflowState, event: RuntimeEvent): Promise<void> {
    const callType = event.data?.callType as string | undefined;
    if (!callType) return;

    const callId = event.callId as string | undefined;

    switch (callType) {
      case CALL_TYPES.APPROACH_REVIEW:
        await this.dispatchApproachReview(state, callId);
        break;
      case CALL_TYPES.CODE_REVIEW:
        await this.dispatchCodeReview(state, callId);
        break;
      case CALL_TYPES.REVISION_READY:
        await this.dispatchRevisionReady(state, callId);
        break;
      case CALL_TYPES.FOREMAN_CLARIFICATION:
        // run.awaiting_foreman event already emitted by service.ts callBlocking()
        state.lastAction = "awaiting-foreman";
        state.lastActionResult = "waiting for foreman to resolve clarification";
        this.emitProgress(state, "awaiting_foreman");
        break;
    }
  }

  /**
   * Implementer signalled request_approach_review — dispatch to reviewer.
   * The implementer is now in "waiting" state (set by call.blocking in service.ts).
   */
  private async dispatchApproachReview(state: FeatureWorkflowState, callId?: string): Promise<void> {
    const implNextCmd = `bun run .floe/bin/floe.ts call-blocking --run ${state.runId} --worker ${state.implWorkerId} --type request_code_review --feature ${state.featureId}`;
    const implResubmitCmd = `bun run .floe/bin/floe.ts call-blocking --run ${state.runId} --worker ${state.implWorkerId} --type request_approach_review --feature ${state.featureId}`;

    const approvedContinuation = [
      "Approach approved. Proceed with full implementation now.",
      "",
      "When implementation is complete and verified, issue this call — do not stop without it:",
      `  ${implNextCmd}`,
    ].join("\n");

    const rejectedContinuation = [
      "Approach rejected. Revise your approach based on the review feedback.",
      "",
      "When you have a revised approach, re-signal for review:",
      `  ${implResubmitCmd}`,
    ].join("\n");

    const approvedResponse = JSON.stringify({ verdict: "approved", continuation: approvedContinuation });
    const rejectedResponse = JSON.stringify({ verdict: "rejected", continuation: rejectedContinuation, rationale: "<reason>" });

    const msg = [
      `The implementer has proposed an execution approach for feature "${state.featureId}".`,
      `Your run ID is "${state.runId}" and your worker ID is "${state.revWorkerId}".`,
      "",
      "Read the feature and review artefacts:",
      `  bun run .floe/scripts/artefact.ts get feature ${state.featureId}`,
      `  bun run .floe/scripts/review.ts get-for ${state.featureId}`,
      "",
      "Evaluate the approach. When done, resolve the blocking call:",
      `  Approve: bun run .floe/bin/floe.ts call-resolve --call ${callId ?? "<call_id>"} --response '${approvedResponse}' --resolved-by reviewer`,
      `  Reject:  bun run .floe/bin/floe.ts call-resolve --call ${callId ?? "<call_id>"} --response '${rejectedResponse}' --resolved-by reviewer`,
      "",
      "The implementer's call-blocking command is waiting for this resolution and will receive your verdict inline.",
    ].join("\n");

    const result = await this.sendMessage(state.revWorkerId, msg);
    state.lastAction = "dispatched-approach-review";
    state.lastActionResult = result.ok
      ? "reviewer dispatched to evaluate approach"
      : `dispatch failed: ${result.error}`;

    this.emitProgress(state, "alignment.review_dispatched");
  }

  /** Implementer signalled request_code_review — dispatch to reviewer. */
  private async dispatchCodeReview(state: FeatureWorkflowState, callId?: string): Promise<void> {
    state.phase = "review";

    const implRevisionCmd = `bun run .floe/bin/floe.ts call-blocking --run ${state.runId} --worker ${state.implWorkerId} --type revision_ready --feature ${state.featureId}`;

    const failContinuation = [
      "Review failed. Address all findings, then signal revision complete:",
      `  ${implRevisionCmd}`,
      "Do not stop without issuing this call.",
    ].join("\n");

    const passResponse = JSON.stringify({ outcome: "pass", continuation: "Review passed. Feature complete — your work is done." });
    const failResponse = JSON.stringify({ outcome: "fail", continuation: failContinuation, findings: "<details>" });

    const msg = [
      `The implementer has completed work on feature "${state.featureId}" and requests code review.`,
      `Your run ID is "${state.runId}" and your worker ID is "${state.revWorkerId}".`,
      "",
      "Review the implementation against the feature requirements and DoD:",
      `  bun run .floe/scripts/artefact.ts get feature ${state.featureId}`,
      `  bun run .floe/scripts/review.ts get-for ${state.featureId}`,
      "",
      "When done, resolve the blocking call:",
      `  Pass: bun run .floe/bin/floe.ts call-resolve --call ${callId ?? "<call_id>"} --response '${passResponse}' --resolved-by reviewer`,
      `  Fail: bun run .floe/bin/floe.ts call-resolve --call ${callId ?? "<call_id>"} --response '${failResponse}' --resolved-by reviewer`,
      "",
      "The implementer's call-blocking command is waiting for this resolution and will receive your verdict inline.",
    ].join("\n");

    const result = await this.sendMessage(state.revWorkerId, msg);
    state.lastAction = "dispatched-code-review";
    state.lastActionResult = result.ok
      ? "reviewer dispatched for code review"
      : `dispatch failed: ${result.error}`;

    this.transitionRun(state, "awaiting_code_review");
    this.emitProgress(state, "review.dispatched");
  }

  /**
   * After a failed review, implementer revised and signals readiness.
   * Dispatch reviewer to re-evaluate.
   */
  private async dispatchRevisionReady(state: FeatureWorkflowState, callId?: string): Promise<void> {
    state.round++;
    if (state.round > state.maxRounds) {
      this.escalate(state, "max_rounds_exceeded", `Exceeded ${state.maxRounds} review rounds`);
      return;
    }

    const implRevisionCmd = `bun run .floe/bin/floe.ts call-blocking --run ${state.runId} --worker ${state.implWorkerId} --type revision_ready --feature ${state.featureId}`;

    const failContinuation = [
      `Review failed again (round ${state.round}). Address all findings, then re-signal:`,
      `  ${implRevisionCmd}`,
      "Do not stop without issuing this call.",
    ].join("\n");

    const passResponse = JSON.stringify({ outcome: "pass", continuation: "Review passed. Feature complete — your work is done." });
    const failResponse = JSON.stringify({ outcome: "fail", continuation: failContinuation, findings: "<details>" });

    const msg = [
      `The implementer has revised feature "${state.featureId}" (round ${state.round}).`,
      "",
      "Re-review the implementation:",
      `  bun run .floe/scripts/artefact.ts get feature ${state.featureId}`,
      `  bun run .floe/scripts/review.ts get-for ${state.featureId}`,
      "",
      "Resolve the blocking call:",
      `  Pass: bun run .floe/bin/floe.ts call-resolve --call ${callId ?? "<call_id>"} --response '${passResponse}' --resolved-by reviewer`,
      `  Fail: bun run .floe/bin/floe.ts call-resolve --call ${callId ?? "<call_id>"} --response '${failResponse}' --resolved-by reviewer`,
    ].join("\n");

    const result = await this.sendMessage(state.revWorkerId, msg);
    state.lastAction = "dispatched-re-review";
    state.lastActionResult = result.ok
      ? `reviewer dispatched for re-review (round ${state.round})`
      : `dispatch failed: ${result.error}`;

    this.transitionRun(state, "awaiting_code_review");
    this.emitProgress(state, "review.re_review_dispatched");
  }

  // ── call.resolved handlers ─────────────────────────────────────────

  private async onCallResolved(state: FeatureWorkflowState, event: RuntimeEvent): Promise<void> {
    const callId = event.callId as string | undefined;
    if (!callId) return;

    const call = this.store.getCall(callId);
    if (!call) return;

    const response = call.responsePayload ?? {};

    switch (call.callType) {
      case CALL_TYPES.APPROACH_REVIEW:
        await this.onApproachVerdictResolved(state, response);
        break;
      case CALL_TYPES.CODE_REVIEW:
      case CALL_TYPES.REVISION_READY:
        await this.onCodeReviewResolved(state, response);
        break;
      case CALL_TYPES.FOREMAN_CLARIFICATION:
        state.lastAction = "foreman-responded";
        state.lastActionResult = "foreman clarification resolved — call.blocking returned inline to worker";
        this.emitProgress(state, "foreman_clarification_resolved");
        break;
    }
  }

  private async onApproachVerdictResolved(
    state: FeatureWorkflowState,
    response: Record<string, unknown>,
  ): Promise<void> {
    const verdict = response.verdict as string | undefined;

    if (verdict === "approved") {
      state.phase = "implementation";
      state.lastAction = "approach-approved";
      state.lastActionResult = "approach approved — call.blocking returned inline, implementer continues in same turn";
      this.transitionRun(state, "implementing");
      this.emitProgress(state, "alignment.approved");
      // Implementer's call.blocking received responsePayload inline.
      // It reads the verdict and continues — no separate resume needed.
      // After implementing, implementer issues call.blocking(request_code_review).
    } else if (verdict === "rejected") {
      state.phase = "resolution";
      state.lastAction = "approach-rejected";
      state.lastActionResult = "approach rejected — call.blocking returned inline with feedback";
      this.transitionRun(state, "plan_revision");
      this.emitProgress(state, "alignment.rejected");
      // Implementer reads rejection via call.blocking responsePayload inline.
      // After revising, implementer re-issues call.blocking(request_approach_review).
    } else {
      this.escalate(state, "approach_deadlock",
        `unexpected verdict: ${verdict ?? "none"}`);
    }
  }

  private async onCodeReviewResolved(
    state: FeatureWorkflowState,
    response: Record<string, unknown>,
  ): Promise<void> {
    const outcome = response.outcome as string | undefined;

    if (outcome === "pass") {
      state.phase = "complete";
      state.outcome = "pass";
      state.lastAction = "review-passed";
      state.lastActionResult = "code review passed — feature complete";
      this.emitProgress(state, "review.passed");
      // Terminal handler will do bookkeeping (git commit, epic cascade, etc.)
    } else if (outcome === "fail") {
      state.phase = "review"; // stay in review cycle
      state.lastAction = "review-failed";
      state.lastActionResult = "code review failed — call.blocking returned inline with findings";
      this.transitionRun(state, "code_revision");
      this.emitProgress(state, "review.failed");
      // Implementer reads findings via call.blocking responsePayload inline.
      // After fixing, implementer issues call.blocking(revision_ready).
    } else {
      this.escalate(state, "review_deadlock",
        `unexpected review outcome: ${outcome ?? "none"}`);
    }
  }

  // ── Failure / timeout handlers ─────────────────────────────────────

  private async onCallTimedOut(state: FeatureWorkflowState, event: RuntimeEvent): Promise<void> {
    const callId = event.callId as string | undefined;
    this.escalate(state, "call_timeout",
      `blocking call ${callId ?? "unknown"} timed out`);
  }

  private async onCallOrphaned(state: FeatureWorkflowState, event: RuntimeEvent): Promise<void> {
    const callId = event.callId as string | undefined;
    this.escalate(state, "call_orphaned",
      `blocking call ${callId ?? "unknown"} orphaned (worker dead)`);
  }

  private async onWorkerFailure(state: FeatureWorkflowState, event: RuntimeEvent): Promise<void> {
    const workerId = event.workerId as string | undefined;
    const reason = event.data?.reason as string | undefined;
    this.escalate(state, "worker_failure",
      `worker ${workerId ?? "unknown"} failed: ${reason ?? "unknown"}`);
  }

  // ── Terminal bookkeeping ───────────────────────────────────────────

  private async onTerminal(state: FeatureWorkflowState): Promise<void> {
    const run = this.store.getRun(state.runId);
    if (!run) return;

    if (state.outcome === "pass") {
      updateArtefact(this.featuresDir, "feature", state.featureId, { status: "completed" });
      tryCompleteEpic(this.projectRoot, state.featureId);
      gitCommitAndPush(this.projectRoot, `feat(${state.featureId}): implementation complete and reviewed`);

      this.store.upsertRun({
        ...run,
        state: "completed",
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        terminalReason: "feature_passed_review",
      });

      this.store.emitEvent({
        type: "run.completed",
        runId: state.runId,
        data: {
          featureId: state.featureId,
          outcome: "pass",
          phase: state.phase,
          rounds: state.round,
        },
      });
    } else {
      this.store.upsertRun({
        ...run,
        state: "escalated",
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        escalationReason: state.escalationReason,
        terminalReason: state.escalationReason,
      });

      this.store.emitEvent({
        type: "run.escalated",
        runId: state.runId,
        data: {
          featureId: state.featureId,
          outcome: state.outcome,
          escalationReason: state.escalationReason,
          phase: state.phase,
          rounds: state.round,
        },
      });
    }

    this.stop(state.runId);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private escalate(state: FeatureWorkflowState, reasonClass: string, description: string, reviewId?: string): void {
    state.phase = "escalated";
    state.outcome = "escalated";
    state.escalationReason = `${reasonClass}: ${description}`;
    state.lastActionResult = `escalated: ${reasonClass}`;
    createEscalation(this.projectRoot, state.featureId, reasonClass, description, reviewId);
  }

  private transitionRun(state: FeatureWorkflowState, runState: RunRecord["state"]): void {
    const run = this.store.getRun(state.runId);
    if (run) {
      this.store.upsertRun({ ...run, state: runState, updatedAt: new Date().toISOString() });
    }
  }

  private emitProgress(state: FeatureWorkflowState, event: string): void {
    this.store.emitEvent({
      type: "workflow.progress",
      runId: state.runId,
      data: {
        featureId: state.featureId,
        phase: state.phase,
        round: state.round,
        lastAction: state.lastAction,
        event,
      },
    });
  }
}
