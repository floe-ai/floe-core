/**
 * FeatureWorkflowEngine — daemon-native feature lifecycle orchestrator.
 *
 * Replaces the external feature-runner.ts background process. Runs inside the
 * daemon process and drives the alignment → resolution → implementation → review
 * loop using call.blocking / call.resolve and daemon-owned state.
 *
 * Workers never need an external orchestrator sending them timed ticks. Instead:
 * 1. Engine sends initial message to implementer (propose approach)
 * 2. Engine polls artefact files on a schedule to detect phase transitions
 * 3. On transition, engine sends the next message or issues a blocking call
 * 4. Workers are auto-resumed when blocking calls are resolved
 * 5. Terminal states (complete/escalated) update run record and emit events
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { DaemonStore } from "./store.ts";
import type { RunRecord, WorkerRuntimeRecord, PendingCallRecord } from "./types.ts";

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
const TICK_INTERVAL_MS = 5_000;

// ── Artefact helpers (file I/O, no daemon dependency) ────────────────

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, ".floe"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

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

function updateArtefact(dir: string, type: string, id: string, data: Record<string, any>): void {
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
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  // Artefact paths
  private featuresDir: string;
  private reviewsDir: string;
  private epicsDir: string;

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
    this.epicsDir = join(projectRoot, "delivery", "epics");
  }

  /**
   * Start a new feature workflow. Creates the state, sends the first
   * message to the implementer, and begins the tick loop.
   */
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
      round: 0,
      maxRounds: 3,
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

    // Kick off the first tick (async, don't await — runs in background)
    this.scheduleTick(runId);

    return state;
  }

  /** Get workflow state for a run. */
  getState(runId: string): FeatureWorkflowState | undefined {
    return this.activeWorkflows.get(runId);
  }

  /** Stop tracking a workflow (cleanup). */
  stop(runId: string): void {
    this.activeWorkflows.delete(runId);
    const timer = this.timers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(runId);
    }
  }

  /** Manually trigger a tick for testing. Await this to ensure the tick completes. */
  async triggerTick(runId: string): Promise<void> {
    await this.executeTick(runId);
  }

  // ── Tick loop ────────────────────────────────────────────────────

  private scheduleTick(runId: string): void {
    // Clear any existing timer
    const existing = this.timers.get(runId);
    if (existing) clearTimeout(existing);

    const state = this.activeWorkflows.get(runId);
    if (!state || TERMINAL_PHASES.includes(state.phase)) {
      this.timers.delete(runId);
      return;
    }

    // Execute tick immediately for the first one, then schedule next
    this.executeTick(runId).catch((err) => {
      const s = this.activeWorkflows.get(runId);
      if (s) {
        s.lastActionResult = `tick error: ${err?.message ?? String(err)}`;
        s.updatedAt = new Date().toISOString();
      }
    }).finally(() => {
      const s = this.activeWorkflows.get(runId);
      if (s && !TERMINAL_PHASES.includes(s.phase)) {
        const timer = setTimeout(() => this.scheduleTick(runId), TICK_INTERVAL_MS);
        this.timers.set(runId, timer);
      } else {
        this.timers.delete(runId);
      }
    });
  }

  private async executeTick(runId: string): Promise<void> {
    const state = this.activeWorkflows.get(runId);
    if (!state || TERMINAL_PHASES.includes(state.phase)) return;

    switch (state.phase) {
      case "alignment":
        await this.tickAlignment(state);
        break;
      case "resolution":
        await this.tickResolution(state);
        break;
      case "implementation":
        await this.tickImplementation(state);
        break;
      case "review":
        await this.tickReview(state);
        break;
    }

    state.updatedAt = new Date().toISOString();

    // Check for terminal transition
    if (TERMINAL_PHASES.includes(state.phase)) {
      await this.onTerminal(state);
    }
  }

  // ── Phase handlers ───────────────────────────────────────────────

  private async tickAlignment(state: FeatureWorkflowState): Promise<void> {
    if (state.lastAction === "") {
      const msg = [
        "Read the feature artefact and the project Definition of Done.",
        "Propose your execution approach via:",
        `bun run .floe/scripts/review.ts set-approach <rev_id> '<proposal>'.`,
        `Read the feature first: bun run .floe/scripts/artefact.ts get feature ${state.featureId}.`,
        `Read or create the review: bun run .floe/scripts/review.ts get-for ${state.featureId}.`,
      ].join(" ");

      const result = await this.sendMessage(state.implWorkerId, msg);
      state.lastAction = "messaged-implementer-propose";
      state.lastActionResult = result.ok
        ? "implementer messaged to propose approach"
        : `message failed: ${result.error}`;

      this.emitProgress(state, "alignment.propose_sent");
      return;
    }

    if (state.lastAction === "messaged-implementer-propose") {
      const review = this.getReviewForFeature(state.featureId);
      if (!review) {
        state.lastActionResult = "no review artefact found yet — will retry";
        return;
      }

      const ap = review.approach_proposal;
      if (!ap || ap.verdict !== "pending") {
        state.lastActionResult = "approach proposal not found or not pending — will retry";
        return;
      }

      const msg = [
        "The implementer has proposed an execution approach.",
        "Read the review and evaluate.",
        `Approve via: bun run .floe/scripts/review.ts approve-approach ${review.id} '<rationale>'.`,
        `Reject via: bun run .floe/scripts/review.ts reject-approach ${review.id} '<rationale>'.`,
      ].join(" ");

      const result = await this.sendMessage(state.revWorkerId, msg);
      state.lastAction = "messaged-reviewer-evaluate";
      state.lastActionResult = result.ok
        ? "reviewer messaged to evaluate approach"
        : `message failed: ${result.error}`;

      this.emitProgress(state, "alignment.evaluate_sent");
      return;
    }

    if (state.lastAction === "messaged-reviewer-evaluate") {
      const review = this.getReviewForFeature(state.featureId);
      if (!review?.approach_proposal) {
        state.lastActionResult = "review or approach proposal missing — will retry";
        return;
      }

      const verdict = review.approach_proposal.verdict;
      if (verdict === "pending") {
        state.lastActionResult = "verdict still pending — will retry";
        return;
      }

      if (verdict === "approved") {
        state.phase = "implementation";
        state.round = 1;
        state.lastAction = "";
        state.lastActionResult = "approach approved — moving to implementation";
        this.transitionRun(state, "implementing");
      } else if (verdict === "rejected") {
        state.phase = "resolution";
        state.round = 1;
        state.lastAction = "read-verdict";
        state.lastActionResult = "approach rejected — entering resolution";
        this.transitionRun(state, "code_revision");
      } else if (verdict === "escalated") {
        this.escalate(state, "approach_deadlock",
          review.approach_proposal.verdict_rationale ?? "approach escalated by reviewer", review.id);
      }
      return;
    }
  }

  private async tickResolution(state: FeatureWorkflowState): Promise<void> {
    if (state.lastAction === "read-verdict" || state.lastAction === "messaged-reviewer-evaluate") {
      const review = this.getReviewForFeature(state.featureId);
      if (!review) {
        state.lastActionResult = "no review found — will retry";
        return;
      }

      const msg = [
        "Your approach was rejected.",
        "Read the resolution thread and the reviewer's rationale.",
        "Revise your approach via:",
        `bun run .floe/scripts/review.ts add-resolution ${review.id} --from implementer --kind revised_approach '<revised approach>'.`,
      ].join(" ");

      const result = await this.sendMessage(state.implWorkerId, msg);
      state.lastAction = "messaged-implementer-revise";
      state.lastActionResult = result.ok
        ? "implementer messaged to revise approach"
        : `message failed: ${result.error}`;

      this.emitProgress(state, "resolution.revise_sent");
      return;
    }

    if (state.lastAction === "messaged-implementer-revise") {
      const review = this.getReviewForFeature(state.featureId);
      if (!review) {
        state.lastActionResult = "no review found — will retry";
        return;
      }

      const msg = [
        "The implementer has responded on the resolution thread. Read it and re-evaluate.",
        `If the revised approach is acceptable, approve via: bun run .floe/scripts/review.ts approve-approach ${review.id} '<rationale>'.`,
        `If still unacceptable and you want to continue resolution, add your response via:`,
        `bun run .floe/scripts/review.ts add-resolution ${review.id} --from reviewer --kind objection '<rationale>'.`,
        `If fundamentally unresolvable, set verdict to escalated.`,
      ].join(" ");

      const result = await this.sendMessage(state.revWorkerId, msg);
      state.lastAction = "messaged-reviewer-reevaluate";
      state.lastActionResult = result.ok
        ? "reviewer messaged to re-evaluate"
        : `message failed: ${result.error}`;

      this.emitProgress(state, "resolution.reevaluate_sent");
      return;
    }

    if (state.lastAction === "messaged-reviewer-reevaluate") {
      const review = this.getReviewForFeature(state.featureId);
      if (!review?.approach_proposal) {
        state.lastActionResult = "review or approach proposal missing — will retry";
        return;
      }

      const verdict = review.approach_proposal.verdict;
      if (verdict === "pending") {
        state.lastActionResult = "verdict still pending — will retry";
        return;
      }

      if (verdict === "approved") {
        state.phase = "implementation";
        state.round = 1;
        state.lastAction = "";
        state.lastActionResult = "approach approved after resolution — moving to implementation";
        this.transitionRun(state, "implementing");
      } else if (verdict === "rejected") {
        if (state.round < state.maxRounds) {
          state.round++;
          state.lastAction = "read-verdict";
          state.lastActionResult = `rejection round ${state.round - 1} — retrying resolution`;
        } else {
          this.escalate(state, "approach_deadlock", "max resolution rounds exhausted");
        }
      } else if (verdict === "escalated") {
        this.escalate(state, "approach_deadlock",
          review.approach_proposal.verdict_rationale ?? "escalated during resolution");
      }
      return;
    }
  }

  private async tickImplementation(state: FeatureWorkflowState): Promise<void> {
    if (state.lastAction !== "messaged-implementer-implement" && state.lastAction !== "messaged-implementer-status-check") {
      const msg = [
        "Your approach is approved. Implement the feature now.",
        "When done:",
        `1) Write a run summary via bun run .floe/scripts/summary.ts create --data '...'.`,
        `2) Update feature state: bun run .floe/scripts/artefact.ts update feature ${state.featureId}`,
        `--data '{"execution_state":{"last_run_outcome":"ready_for_review"}}'.`,
        "Take all the time you need.",
      ].join(" ");

      const result = await this.sendMessage(state.implWorkerId, msg);
      state.lastAction = "messaged-implementer-implement";
      state.lastActionResult = result.ok
        ? "implementer messaged to implement"
        : `message failed: ${result.error}`;

      this.emitProgress(state, "implementation.implement_sent");
      return;
    }

    const feature = findArtefact(this.featuresDir, state.featureId);
    const execState = feature?.execution_state;
    const lastOutcome = execState?.last_run_outcome;

    if (lastOutcome === "ready_for_review") {
      state.phase = "review";
      state.round = 1;
      state.lastAction = "";
      state.lastActionResult = "implementer signaled ready_for_review — moving to review";
      this.transitionRun(state, "awaiting_code_review");
      return;
    }

    if (lastOutcome === "fail") {
      this.escalate(state, "repeated_failure",
        execState?.last_failure_class
          ? `implementation_failure: ${execState.last_failure_class}`
          : "implementation_failure: implementer reported failure");
      return;
    }

    // No signal yet
    if (state.lastAction === "messaged-implementer-status-check") {
      this.escalate(state, "missing_context", "no completion signal from implementer");
      return;
    }

    // First check — ask for status
    const msg = "What is your implementation status? If done, remember to update the feature execution_state to ready_for_review.";
    const result = await this.sendMessage(state.implWorkerId, msg);
    state.lastAction = "messaged-implementer-status-check";
    state.lastActionResult = result.ok
      ? "asked implementer for completion status"
      : `status check message failed: ${result.error}`;

    this.emitProgress(state, "implementation.status_check_sent");
  }

  private async tickReview(state: FeatureWorkflowState): Promise<void> {
    if (state.lastAction !== "messaged-reviewer-review" && state.lastAction !== "messaged-implementer-fix") {
      const review = this.getReviewForFeature(state.featureId);
      if (!review) {
        state.lastActionResult = "no review found — will retry";
        return;
      }

      const msg = [
        "The implementer has completed implementation.",
        "Review the changes against the feature acceptance criteria and the project Definition of Done.",
        `Record findings via: bun run .floe/scripts/review.ts add-finding ${review.id} --severity <sev> --description '<text>'.`,
        `Set outcome via: bun run .floe/scripts/review.ts set-outcome ${review.id} <pass|fail|blocked|needs_replan>.`,
      ].join(" ");

      const result = await this.sendMessage(state.revWorkerId, msg);
      state.lastAction = "messaged-reviewer-review";
      state.lastActionResult = result.ok
        ? "reviewer messaged to review implementation"
        : `message failed: ${result.error}`;

      this.emitProgress(state, "review.review_sent");
      return;
    }

    if (state.lastAction === "messaged-reviewer-review") {
      const review = this.getReviewForFeature(state.featureId);
      if (!review) {
        state.lastActionResult = "no review found — will retry";
        return;
      }

      const outcome = review.outcome;
      if (outcome === "pending") {
        state.lastActionResult = "review outcome still pending — will retry";
        return;
      }

      if (outcome === "pass") {
        state.phase = "complete";
        state.outcome = "pass";
        state.lastAction = "verified-completion";
        state.lastActionResult = "review passed — feature complete";
        return;
      }

      if (outcome === "fail") {
        if (state.round < state.maxRounds) {
          const findings = (review.findings ?? [])
            .filter((f: any) => f.status === "open")
            .map((f: any) => `- [${f.severity}] ${f.description}`)
            .join("\n");

          const msg = [
            "The reviewer found issues with your implementation.",
            findings ? `Findings:\n${findings}` : "",
            "Fix these issues and signal completion by updating execution_state to ready_for_review again.",
          ].filter(Boolean).join(" ");

          const sendResult = await this.sendMessage(state.implWorkerId, msg);
          state.round++;
          state.lastAction = "messaged-implementer-fix";
          state.lastActionResult = sendResult.ok
            ? `sent findings to implementer (round ${state.round})`
            : `message failed: ${sendResult.error}`;

          this.emitProgress(state, "review.fix_sent");
        } else {
          this.escalate(state, "repeated_failure",
            `Max review rounds exhausted for feature ${state.featureId}`, review.id);
        }
        return;
      }

      if (outcome === "blocked") {
        state.phase = "escalated";
        state.outcome = "blocked";
        state.escalationReason = "blocked";
        state.lastActionResult = "reviewer marked feature as blocked — escalating";
        createEscalation(this.projectRoot, state.featureId, "external_dependency",
          `Reviewer marked feature as blocked: ${state.featureId}`, review.id);
        return;
      }

      if (outcome === "needs_replan") {
        state.phase = "escalated";
        state.outcome = "needs_replan";
        state.escalationReason = "needs_replan";
        state.lastActionResult = "reviewer says feature needs replanning — escalating";
        createEscalation(this.projectRoot, state.featureId, "scope_change",
          `Feature needs replanning: ${state.featureId}`, review.id);
        return;
      }
    }

    if (state.lastAction === "messaged-implementer-fix") {
      const feature = findArtefact(this.featuresDir, state.featureId);
      const lastOutcome = feature?.execution_state?.last_run_outcome;

      if (lastOutcome === "ready_for_review") {
        state.lastAction = "";
        state.lastActionResult = "implementer signaled ready_for_review after fix — back to review";
        return;
      }

      state.lastActionResult = "waiting for implementer to signal ready_for_review after fix";
    }
  }

  // ── Terminal handling ────────────────────────────────────────────

  private async onTerminal(state: FeatureWorkflowState): Promise<void> {
    const run = this.store.getRun(state.runId);
    if (!run) return;

    if (state.outcome === "pass") {
      // Auto-complete feature artefact
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

    // Cleanup
    this.stop(state.runId);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private getReviewForFeature(featureId: string): any | null {
    const reviews = listArtefacts(this.reviewsDir);
    return reviews.find((r) => r.target_id === featureId && r.status === "open") ?? null;
  }

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
