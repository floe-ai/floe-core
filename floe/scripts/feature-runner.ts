#!/usr/bin/env bun
/**
 * floe-exec feature-runner — autonomous state-machine that drives the
 * implement → review → resolve loop for a single feature.
 *
 * Usage:
 *   bun run scripts/feature-runner.ts start   --feature <id> --impl-session <id> --rev-session <id>
 *   bun run scripts/feature-runner.ts tick     --feature <id>
 *   bun run scripts/feature-runner.ts resume   --feature <id>   (alias for tick)
 *   bun run scripts/feature-runner.ts status   --feature <id>
 *   bun run scripts/feature-runner.ts run      --feature <id>   (loop until terminal)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  paths, readJson, writeJson, findArtefact,
  listArtefacts, output, ok, fail, timestamp,
} from "./helpers.ts";
import { sendDaemonRequest } from "../runtime/daemon/client.ts";

// ── Types ────────────────────────────────────────────────────────────

interface FeatureRunState {
  featureId: string;
  implSessionId: string;
  revSessionId: string;
  phase: "alignment" | "resolution" | "implementation" | "review" | "complete" | "escalated";
  round: number;
  maxRounds: number;
  lastAction: string;
  lastActionResult?: string;
  startedAt: string;
  updatedAt: string;
  outcome: null | "pass" | "escalated" | "blocked" | "needs_replan";
  escalationReason?: string;
}

type Phase = FeatureRunState["phase"];

const TERMINAL_PHASES: Phase[] = ["complete", "escalated"];
const TICK_SLEEP_MS = 5_000;

// ── Paths & helpers ──────────────────────────────────────────────────

const p = paths();
const stateDir = join(p.root, ".floe", "state", "feature-runs");
const daemonEndpointFile = join(p.root, ".floe", "state", "daemon", "endpoint.json");

function statePath(featureId: string): string {
  return join(stateDir, `${featureId}.json`);
}

function loadState(featureId: string): FeatureRunState {
  const fp = statePath(featureId);
  if (!existsSync(fp)) fail(`No run state for feature: ${featureId}`);
  return readJson<FeatureRunState>(fp);
}

function saveState(state: FeatureRunState): void {
  state.updatedAt = timestamp();
  writeJson(statePath(state.featureId), state);
}

// ── Worker messaging ─────────────────────────────────────────────────

function createEscalation(state: FeatureRunState, reasonClass: string, description: string, reviewId?: string): void {
  const escScript = join(import.meta.dir, "escalation.ts");
  const args = [
    "run", escScript, "create",
    "--from", "feature-runner",
    "--feature", state.featureId,
    "--reason", reasonClass,
  ];
  if (reviewId) args.push("--review", reviewId);
  args.push(description);
  Bun.spawnSync(["bun", ...args], {
    cwd: p.root,
    stdout: "ignore",
    stderr: "ignore",
  });
}

function getDaemonEndpoint(): string {
  try {
    if (existsSync(daemonEndpointFile)) {
      const data = JSON.parse(readFileSync(daemonEndpointFile, "utf-8"));
      if (data.endpoint) return data.endpoint as string;
    }
  } catch {}
  return join(p.root, ".floe", "state", "daemon", "floe-daemon.sock");
}

async function sendToWorker(
  sessionId: string,
  message: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  const endpoint = getDaemonEndpoint();
  try {
    const response = await sendDaemonRequest(endpoint, "route.send", { to: sessionId, message });
    if (!response.ok) return { ok: false, error: (response as any).error ?? "daemon returned not-ok" };
    const result = (response as any).result as Record<string, any> | undefined;
    return { ok: true, content: result?.content ?? "" };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "daemon call failed" };
  }
}

// ── Review helpers ───────────────────────────────────────────────────

function getReviewForFeature(featureId: string): any | null {
  const reviews = listArtefacts(p.reviews);
  return reviews.find((r) => r.target_id === featureId && r.status === "open") ?? null;
}

function getFeatureArtefact(featureId: string): any | null {
  return findArtefact(p.features, featureId);
}

// ── Epic auto-transition ─────────────────────────────────────────────

/**
 * After a feature passes review, check if all features in its parent epic
 * are now completed. If so, mark the epic as completed too.
 */
function tryCompleteEpic(featureId: string): void {
  const feature = getFeatureArtefact(featureId);
  if (!feature?.epic_id) return;

  const epicId = feature.epic_id as string;
  const epicFeatures = listArtefacts(p.features).filter((f: any) => f.epic_id === epicId);
  if (epicFeatures.length === 0) return;

  const allDone = epicFeatures.every((f: any) => f.status === "completed");
  if (!allDone) return;

  const artefactScript = join(import.meta.dir, "artefact.ts");
  Bun.spawnSync(
    ["bun", "run", artefactScript, "update", "epic", epicId, "--data", '{"status":"completed"}'],
    { cwd: p.root, stdout: "ignore", stderr: "ignore" },
  );
}

// ── Git helpers ──────────────────────────────────────────────────────

/**
 * Stage all changes, commit with the given message, and push if a remote
 * is configured. Non-fatal — git errors are silently ignored so they never
 * block the feature runner.
 */
function gitCommitAndPush(message: string): void {
  // Stage everything
  const addResult = Bun.spawnSync(["git", "add", "-A"], { cwd: p.root, stdout: "ignore", stderr: "ignore" });
  if (addResult.exitCode !== 0) return;

  // Only commit if there are staged changes
  const statusResult = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: p.root, stdout: "pipe", stderr: "ignore" });
  if (!statusResult.stdout.toString().trim()) return;

  Bun.spawnSync(
    ["git", "commit", "-m", message],
    { cwd: p.root, stdout: "ignore", stderr: "ignore", env: { ...process.env } },
  );

  // Push only if a remote is configured
  const remoteCheck = Bun.spawnSync(["git", "remote"], { cwd: p.root, stdout: "pipe", stderr: "ignore" });
  if (remoteCheck.stdout.toString().trim()) {
    Bun.spawnSync(["git", "push"], { cwd: p.root, stdout: "ignore", stderr: "ignore", env: { ...process.env } });
  }
}

// ── Phase handlers (each tick does ONE action) ───────────────────────

async function tickAlignment(state: FeatureRunState): Promise<void> {
  if (state.lastAction === "") {
    // Ask implementer to read the feature and propose approach
    const msg = [
      "Read the feature artefact and the project Definition of Done.",
      "Propose your execution approach via:",
      `bun run .floe/scripts/review.ts set-approach <rev_id> '<proposal>'.`,
      `Read the feature first: bun run .floe/scripts/artefact.ts get feature ${state.featureId}.`,
      `Read or create the review: bun run .floe/scripts/review.ts get-for ${state.featureId}.`,
    ].join(" ");

    const result = await sendToWorker(state.implSessionId, msg);
    state.lastAction = "messaged-implementer-propose";
    state.lastActionResult = result.ok
      ? "implementer messaged to propose approach"
      : `message failed: ${result.error}`;
    saveState(state);
    return;
  }

  if (state.lastAction === "messaged-implementer-propose") {
    const review = getReviewForFeature(state.featureId);
    if (!review) {
      state.lastActionResult = "no review artefact found yet — will retry";
      saveState(state);
      return;
    }

    const ap = review.approach_proposal;
    if (!ap || ap.verdict !== "pending") {
      // No proposal yet — stay here and retry next tick
      state.lastActionResult = "approach proposal not found or not pending — will retry";
      saveState(state);
      return;
    }

    // Proposal exists and is pending — ask reviewer to evaluate
    const msg = [
      "The implementer has proposed an execution approach.",
      "Read the review and evaluate.",
      `Approve via: bun run .floe/scripts/review.ts approve-approach ${review.id} '<rationale>'.`,
      `Reject via: bun run .floe/scripts/review.ts reject-approach ${review.id} '<rationale>'.`,
    ].join(" ");

    const result = await sendToWorker(state.revSessionId, msg);
    state.lastAction = "messaged-reviewer-evaluate";
    state.lastActionResult = result.ok
      ? "reviewer messaged to evaluate approach"
      : `message failed: ${result.error}`;
    saveState(state);
    return;
  }

  if (state.lastAction === "messaged-reviewer-evaluate") {
    const review = getReviewForFeature(state.featureId);
    if (!review?.approach_proposal) {
      state.lastActionResult = "review or approach proposal missing — will retry";
      saveState(state);
      return;
    }

    const verdict = review.approach_proposal.verdict;
    if (verdict === "pending") {
      state.lastActionResult = "verdict still pending — will retry";
      saveState(state);
      return;
    }

    if (verdict === "approved") {
      state.phase = "implementation";
      state.round = 1;
      state.lastAction = "";
      state.lastActionResult = "approach approved — moving to implementation";
    } else if (verdict === "rejected") {
      state.phase = "resolution";
      state.round = 1;
      state.lastAction = "read-verdict";
      state.lastActionResult = "approach rejected — entering resolution";
    } else if (verdict === "escalated") {
      state.phase = "escalated";
      state.outcome = "escalated";
      state.escalationReason = review.approach_proposal.verdict_rationale ?? "approach escalated by reviewer";
      state.lastAction = "read-verdict";
      state.lastActionResult = "approach escalated by reviewer";
      createEscalation(state, "approach_deadlock", state.escalationReason, review.id);
    }
    saveState(state);
    return;
  }
}

async function tickResolution(state: FeatureRunState): Promise<void> {
  if (state.lastAction === "read-verdict" || state.lastAction === "messaged-reviewer-evaluate") {
    const review = getReviewForFeature(state.featureId);
    if (!review) {
      state.lastActionResult = "no review found — will retry";
      saveState(state);
      return;
    }

    const msg = [
      "Your approach was rejected.",
      "Read the resolution thread and the reviewer's rationale.",
      "Revise your approach via:",
      `bun run .floe/scripts/review.ts add-resolution ${review.id} --from implementer --kind revised_approach '<revised approach>'.`,
    ].join(" ");

    const result = await sendToWorker(state.implSessionId, msg);
    state.lastAction = "messaged-implementer-revise";
    state.lastActionResult = result.ok
      ? "implementer messaged to revise approach"
      : `message failed: ${result.error}`;
    saveState(state);
    return;
  }

  if (state.lastAction === "messaged-implementer-revise") {
    const review = getReviewForFeature(state.featureId);
    if (!review) {
      state.lastActionResult = "no review found — will retry";
      saveState(state);
      return;
    }

    const msg = [
      "The implementer has responded on the resolution thread. Read it and re-evaluate.",
      `If the revised approach is acceptable, approve via: bun run .floe/scripts/review.ts approve-approach ${review.id} '<rationale>'.`,
      `If still unacceptable and you want to continue resolution, add your response via:`,
      `bun run .floe/scripts/review.ts add-resolution ${review.id} --from reviewer --kind objection '<rationale>'.`,
      `If fundamentally unresolvable, set verdict to escalated.`,
    ].join(" ");

    const result = await sendToWorker(state.revSessionId, msg);
    state.lastAction = "messaged-reviewer-reevaluate";
    state.lastActionResult = result.ok
      ? "reviewer messaged to re-evaluate"
      : `message failed: ${result.error}`;
    saveState(state);
    return;
  }

  if (state.lastAction === "messaged-reviewer-reevaluate") {
    const review = getReviewForFeature(state.featureId);
    if (!review?.approach_proposal) {
      state.lastActionResult = "review or approach proposal missing — will retry";
      saveState(state);
      return;
    }

    const verdict = review.approach_proposal.verdict;
    if (verdict === "pending") {
      state.lastActionResult = "verdict still pending — will retry";
      saveState(state);
      return;
    }

    if (verdict === "approved") {
      state.phase = "implementation";
      state.round = 1;
      state.lastAction = "";
      state.lastActionResult = "approach approved after resolution — moving to implementation";
    } else if (verdict === "rejected") {
      if (state.round < state.maxRounds) {
        state.round++;
        state.lastAction = "read-verdict";
        state.lastActionResult = `rejection round ${state.round - 1} — retrying resolution`;
      } else {
        state.phase = "escalated";
        state.outcome = "escalated";
        state.escalationReason = "approach_deadlock: max resolution rounds exhausted";
        state.lastActionResult = "max resolution rounds exhausted — escalating";
        createEscalation(state, "approach_deadlock", state.escalationReason, review.id);
      }
    } else if (verdict === "escalated") {
      state.phase = "escalated";
      state.outcome = "escalated";
      state.escalationReason = review.approach_proposal.verdict_rationale ?? "escalated during resolution";
      state.lastActionResult = "escalated by reviewer during resolution";
      createEscalation(state, "approach_deadlock", state.escalationReason, review.id);
    }
    saveState(state);
    return;
  }
}

async function tickImplementation(state: FeatureRunState): Promise<void> {
  if (state.lastAction !== "messaged-implementer-implement" && state.lastAction !== "messaged-implementer-status-check") {
    const msg = [
      "Your approach is approved. Implement the feature now.",
      "When done:",
      `1) Write a run summary via bun run .floe/scripts/summary.ts create --data '...'.`,
      `2) Update feature state: bun run .floe/scripts/artefact.ts update feature ${state.featureId}`,
      `--data '{"execution_state":{"last_run_outcome":"ready_for_review"}}'.`,
      "Take all the time you need.",
    ].join(" ");

    const result = await sendToWorker(state.implSessionId, msg);
    state.lastAction = "messaged-implementer-implement";
    state.lastActionResult = result.ok
      ? "implementer messaged to implement"
      : `message failed: ${result.error}`;
    saveState(state);
    return;
  }

  if (state.lastAction === "messaged-implementer-implement" || state.lastAction === "messaged-implementer-status-check") {
    const feature = getFeatureArtefact(state.featureId);
    const execState = feature?.execution_state;
    const lastOutcome = execState?.last_run_outcome;

    if (lastOutcome === "ready_for_review") {
      state.phase = "review";
      state.round = 1;
      state.lastAction = "";
      state.lastActionResult = "implementer signaled ready_for_review — moving to review";
      saveState(state);
      return;
    }

    if (lastOutcome === "fail") {
      state.phase = "escalated";
      state.outcome = "escalated";
      state.escalationReason = execState?.last_failure_class
        ? `implementation_failure: ${execState.last_failure_class}`
        : "implementation_failure: implementer reported failure";
      state.lastActionResult = "implementer reported failure — escalating";
      createEscalation(state, "repeated_failure", state.escalationReason);
      saveState(state);
      return;
    }

    // No signal yet
    if (state.lastAction === "messaged-implementer-status-check") {
      // Second check with no signal — escalate
      state.phase = "escalated";
      state.outcome = "escalated";
      state.escalationReason = "no completion signal from implementer";
      state.lastActionResult = "no completion signal after status check — escalating";
      createEscalation(state, "missing_context", state.escalationReason);
      saveState(state);
      return;
    }

    // First check — ask for status
    const msg = "What is your implementation status? If done, remember to update the feature execution_state to ready_for_review.";
    const result = await sendToWorker(state.implSessionId, msg);
    state.lastAction = "messaged-implementer-status-check";
    state.lastActionResult = result.ok
      ? "asked implementer for completion status"
      : `status check message failed: ${result.error}`;
    saveState(state);
    return;
  }
}

async function tickReview(state: FeatureRunState): Promise<void> {
  if (state.lastAction !== "messaged-reviewer-review" && state.lastAction !== "messaged-implementer-fix") {
    const review = getReviewForFeature(state.featureId);
    if (!review) {
      state.lastActionResult = "no review found — will retry";
      saveState(state);
      return;
    }

    const msg = [
      "The implementer has completed implementation.",
      "Review the changes against the feature acceptance criteria and the project Definition of Done.",
      `Record findings via: bun run .floe/scripts/review.ts add-finding ${review.id} --severity <sev> --description '<text>'.`,
      `Set outcome via: bun run .floe/scripts/review.ts set-outcome ${review.id} <pass|fail|blocked|needs_replan>.`,
    ].join(" ");

    const result = await sendToWorker(state.revSessionId, msg);
    state.lastAction = "messaged-reviewer-review";
    state.lastActionResult = result.ok
      ? "reviewer messaged to review implementation"
      : `message failed: ${result.error}`;
    saveState(state);
    return;
  }

  if (state.lastAction === "messaged-reviewer-review") {
    const review = getReviewForFeature(state.featureId);
    if (!review) {
      state.lastActionResult = "no review found — will retry";
      saveState(state);
      return;
    }

    const outcome = review.outcome;
    if (outcome === "pending") {
      state.lastActionResult = "review outcome still pending — will retry";
      saveState(state);
      return;
    }

    if (outcome === "pass") {
      state.phase = "complete";
      state.outcome = "pass";
      state.lastAction = "verified-completion";
      state.lastActionResult = "review passed — feature complete";
      saveState(state);
      return;
    }

    if (outcome === "fail") {
      if (state.round < state.maxRounds) {
        // Send findings to implementer
        const findings = (review.findings ?? [])
          .filter((f: any) => f.status === "open")
          .map((f: any) => `- [${f.severity}] ${f.description}`)
          .join("\n");

        const msg = [
          "The reviewer found issues with your implementation.",
          findings ? `Findings:\n${findings}` : "",
          "Fix these issues and signal completion by updating execution_state to ready_for_review again.",
        ].filter(Boolean).join(" ");

        const result = await sendToWorker(state.implSessionId, msg);
        state.round++;
        state.lastAction = "messaged-implementer-fix";
        state.lastActionResult = result.ok
          ? `sent findings to implementer (round ${state.round})`
          : `message failed: ${result.error}`;
      } else {
        state.phase = "escalated";
        state.outcome = "escalated";
        state.escalationReason = "repeated_failure";
        state.lastActionResult = "max review rounds exhausted — escalating";
        createEscalation(state, "repeated_failure", "Max review rounds exhausted for feature " + state.featureId, review.id);
      }
      saveState(state);
      return;
    }

    if (outcome === "blocked") {
      state.phase = "escalated";
      state.outcome = "blocked";
      state.escalationReason = "blocked";
      state.lastActionResult = "reviewer marked feature as blocked — escalating";
      createEscalation(state, "external_dependency", "Reviewer marked feature as blocked: " + state.featureId, review.id);
      saveState(state);
      return;
    }

    if (outcome === "needs_replan") {
      state.phase = "escalated";
      state.outcome = "needs_replan";
      state.escalationReason = "needs_replan";
      state.lastActionResult = "reviewer says feature needs replanning — escalating";
      createEscalation(state, "scope_change", "Feature needs replanning: " + state.featureId, review.id);
      saveState(state);
      return;
    }
  }

  if (state.lastAction === "messaged-implementer-fix") {
    // Check if implementer signaled ready_for_review again
    const feature = getFeatureArtefact(state.featureId);
    const lastOutcome = feature?.execution_state?.last_run_outcome;

    if (lastOutcome === "ready_for_review") {
      state.lastAction = "";
      state.lastActionResult = "implementer signaled ready_for_review after fix — back to review";
      saveState(state);
      return;
    }

    // Not ready yet — stay here and retry
    state.lastActionResult = "waiting for implementer to signal ready_for_review after fix";
    saveState(state);
    return;
  }
}

// ── Tick dispatcher ──────────────────────────────────────────────────

async function tick(state: FeatureRunState): Promise<FeatureRunState> {
  if (TERMINAL_PHASES.includes(state.phase)) return state;

  switch (state.phase) {
    case "alignment":
      await tickAlignment(state);
      break;
    case "resolution":
      await tickResolution(state);
      break;
    case "implementation":
      await tickImplementation(state);
      break;
    case "review":
      await tickReview(state);
      break;
  }

  return state;
}

// ── CLI ──────────────────────────────────────────────────────────────

const { values: args, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    feature: { type: "string" },
    "impl-session": { type: "string" },
    "rev-session": { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

const [cmd] = positionals;

switch (cmd) {
  case "start": {
    const featureId = args.feature as string;
    const implSessionId = args["impl-session"] as string;
    const revSessionId = args["rev-session"] as string;
    if (!featureId || !implSessionId || !revSessionId) {
      fail("Usage: feature-runner start --feature <id> --impl-session <id> --rev-session <id>");
    }

    if (existsSync(statePath(featureId))) {
      fail(`Run state already exists for ${featureId}. Use tick/resume to continue.`);
    }

    const feature = getFeatureArtefact(featureId);
    if (!feature) fail(`Feature artefact not found: ${featureId}`);

    const now = timestamp();
    const state: FeatureRunState = {
      featureId,
      implSessionId,
      revSessionId,
      phase: "alignment",
      round: 0,
      maxRounds: 3,
      lastAction: "",
      startedAt: now,
      updatedAt: now,
      outcome: null,
    };

    saveState(state);

    // Run first tick
    const updated = await tick(state);
    ok(`Feature run started: ${featureId}`, {
      phase: updated.phase,
      lastAction: updated.lastAction,
    });
    break;
  }

  case "tick":
  case "resume": {
    const featureId = args.feature as string;
    if (!featureId) fail(`Usage: feature-runner ${cmd} --feature <id>`);

    const state = loadState(featureId);
    if (TERMINAL_PHASES.includes(state.phase)) {
      ok(`Feature run already terminal`, {
        featureId,
        phase: state.phase,
        outcome: state.outcome,
        escalationReason: state.escalationReason,
      });
      break;
    }

    const updated = await tick(state);
    ok(`Tick complete`, {
      featureId,
      phase: updated.phase,
      round: updated.round,
      lastAction: updated.lastAction,
      lastActionResult: updated.lastActionResult,
    });
    break;
  }

  case "status": {
    const featureId = args.feature as string;
    if (!featureId) fail("Usage: feature-runner status --feature <id>");

    const state = loadState(featureId);
    output({
      ok: true,
      featureId: state.featureId,
      phase: state.phase,
      round: state.round,
      maxRounds: state.maxRounds,
      lastAction: state.lastAction,
      lastActionResult: state.lastActionResult,
      outcome: state.outcome,
      escalationReason: state.escalationReason,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      terminal: TERMINAL_PHASES.includes(state.phase),
    });
    break;
  }

  case "run": {
    const featureId = args.feature as string;
    if (!featureId) fail("Usage: feature-runner run --feature <id>");

    // If state doesn't exist yet but session IDs were provided, initialise first
    if (!existsSync(statePath(featureId))) {
      const implSessionId = args["impl-session"] as string;
      const revSessionId = args["rev-session"] as string;
      if (!implSessionId || !revSessionId) {
        fail("No run state found and --impl-session / --rev-session not provided. Use 'start' first.");
      }
      const feature = getFeatureArtefact(featureId);
      if (!feature) fail(`Feature artefact not found: ${featureId}`);
      const now = timestamp();
      const initial: FeatureRunState = {
        featureId,
        implSessionId,
        revSessionId,
        phase: "alignment",
        round: 0,
        maxRounds: 3,
        lastAction: "",
        startedAt: now,
        updatedAt: now,
        outcome: null,
      };
      saveState(initial);
    }

    let state = loadState(featureId);
    while (!TERMINAL_PHASES.includes(state.phase)) {
      state = await tick(state);
      if (TERMINAL_PHASES.includes(state.phase)) break;
      await new Promise((resolve) => setTimeout(resolve, TICK_SLEEP_MS));
      // Re-read state from disk for restart safety
      state = loadState(featureId);
    }

    // Auto-complete artefact and trigger epic transition on pass
    if (state.outcome === "pass") {
      const artefactScript = join(import.meta.dir, "artefact.ts");
      Bun.spawnSync(
        ["bun", "run", artefactScript, "update", "feature", state.featureId, "--data", '{"status":"completed"}'],
        { cwd: p.root, stdout: "ignore", stderr: "ignore" },
      );
      tryCompleteEpic(state.featureId);
      gitCommitAndPush(`feat(${state.featureId}): implementation complete and reviewed`);
    }

    ok(`Feature run finished`, {
      featureId: state.featureId,
      phase: state.phase,
      outcome: state.outcome,
      escalationReason: state.escalationReason,
    });
    break;
  }

  default:
    fail("Usage: feature-runner <start|tick|resume|status|run> --feature <id> [options]");
}
