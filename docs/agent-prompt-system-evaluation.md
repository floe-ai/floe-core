# Agent Prompt + Runtime Evaluation

Date: 2026-04-08  
Scope: Prompt files for Foreman/Planner/Implementer/Reviewer and the runtime/CLI code paths that inject/enforce those prompts.

## Executive Summary

The system has a strong role architecture and clear canonical prompt definitions, but several high-impact controls are currently prompt-dependent or inconsistent with runtime behavior. The most important risks are:

1. Alignment gate bypass on launch-time messaging.
2. Async launch path dropping DoD-injected context.
3. Schema/prompt/runtime drift around `ready_for_review`.
4. Feature runner escalation timing that is too aggressive for expected worker durations.

The highest leverage improvement is to move critical controls from prompt guidance into deterministic runtime checks, then add contract tests to prevent drift.

## Files Reviewed

- `floe/roles/foreman.md`
- `floe/roles/planner.md`
- `floe/roles/implementer.md`
- `floe/roles/reviewer.md`
- `agents/codex/AGENTS.md`
- `agents/claude/foreman.md`
- `agents/copilot/foreman.agent.md`
- `floe/bin/floe.ts`
- `floe/bin/async-worker.ts`
- `floe/scripts/feature-runner.ts`
- `floe/scripts/review.ts`
- `floe/scripts/artefact.ts`
- `floe/scripts/validate.ts`
- `floe/scripts/helpers.ts`
- `floe/runtime/adapters/*.ts`
- `floe/schemas/feature.json`
- `floe/schemas/review.json`
- `floe/SKILL.md`
- `README.md`

## Findings (Prioritized)

### 1) Critical: Alignment gate can be bypassed on launch with `--message`

`message-worker` blocks implementer messages until approach approval, but `launch-worker --message` sends directly through adapter without that gate.

Evidence:
- `floe/bin/floe.ts:425` (alignment gate in `messageWorker`)
- `floe/bin/floe.ts:393` (launch path sends message directly)
- `agents/codex/AGENTS.md:61` (wrapper strongly encourages launch+message)

Impact:
- Implementer can begin coding before reviewer approval depending on how Foreman routes commands.
- Violates the intended pre-code alignment contract.

Recommendation:
- Apply the same alignment gate logic to launch+message for implementer sessions.
- Optionally disallow launch+message for implementer entirely unless `--force-no-alignment`.

### 2) Critical: Async launch path drops DoD-enriched context

DoD is appended into `contextWithDod` in `launchWorker`, but async dispatch forwards raw `args.context`, so reviewer/implementer launched asynchronously may miss DoD injection.

Evidence:
- `floe/bin/floe.ts:355` to `:361` (DoD assembly)
- `floe/bin/floe.ts:365` to `:366` (dispatch async using raw args)
- `floe/bin/floe.ts:293` (raw context passed into subprocess args)
- `floe/bin/async-worker.ts:131` (uses forwarded context)

Impact:
- Behavior differs between sync and async launch for the same role.
- Reviewer/implementer quality checks become non-deterministic.

Recommendation:
- Dispatch async with resolved context (`contextWithDod`) rather than original args.
- Add parity tests that compare sync and async launch context payloads.

### 3) High: Prompt/runtime/schema contract drift on `ready_for_review`

Implementer prompt and feature runner require `execution_state.last_run_outcome = "ready_for_review"`, but this value is not allowed by the feature schema enum.

Evidence:
- `floe/roles/implementer.md:144` (required completion signal)
- `floe/scripts/feature-runner.ts:332` (transition condition)
- `floe/schemas/feature.json:67` to `:70` (enum missing `ready_for_review`)

Related issue:
- Validator is lightweight and only checks top-level required/enums, so this mismatch is not reliably caught.
- `floe/scripts/helpers.ts:81` to `:105`

Impact:
- Either agent behavior violates schema, or schema blocks expected lifecycle states.
- Silent drift accumulates and only surfaces at runtime edge cases.

Recommendation:
- Add `ready_for_review` to schema enum (if this lifecycle state is canonical).
- Replace lightweight validation with full JSON Schema validation (Ajv/Zod).
- Add contract tests that verify every state referenced in prompts is schema-valid.

### 4) High: Feature-runner escalation timing is too aggressive

Runner tick interval is 5 seconds and implementation phase escalates after one status check if completion signal is absent.

Evidence:
- `floe/scripts/feature-runner.ts:42` (5s tick)
- `floe/scripts/feature-runner.ts:354` to `:361` (escalates after second check)

Impact:
- Normal long-running worker runs can be escalated as failures prematurely.
- Increases false positives and orchestration thrash.

Recommendation:
- Gate escalation by elapsed duration and attempt counts, not 1-2 ticks.
- Suggested minimums: multi-minute grace windows consistent with prompt-stated durations.

### 5) Medium: Planner intake contract is internally inconsistent

Planner says `--scope intake` refines release and identifies epics, but also instructs creating release. Runtime requires intake target release to already exist.

Evidence:
- `floe/roles/planner.md:25` and `:31` (intake framing)
- `floe/roles/planner.md:47` (create release instruction)
- `floe/bin/floe.ts:337` (intake target must exist as release artefact)

Impact:
- Ambiguous worker behavior in intake flow.
- Foreman/Planner responsibilities can drift per run.

Recommendation:
- Pick one contract and enforce it:
  - Option A: Foreman creates release shell; planner intake only refines + creates epics.
  - Option B: planner intake can create release, and launch validation supports note targets.
- Update role docs + CLI validation together.

### 6) Medium: Field name mismatch in planner guidance

Planner quality check references `depends_on`, but feature schema and scripts use `dependencies`.

Evidence:
- `floe/roles/planner.md:171`
- `floe/schemas/feature.json:35`

Impact:
- Worker may output fields ignored by tooling, reducing dependency integrity.

Recommendation:
- Standardize on `dependencies` across prompt text, schema, and examples.

### 7) Medium: Prompt wrapper duplication increases drift risk

Foreman wrapper behavior is repeated manually across providers.

Evidence:
- `agents/claude/foreman.md`
- `agents/copilot/foreman.agent.md`
- `agents/codex/AGENTS.md`

Impact:
- Any policy update can desync wrappers.
- Different providers may receive different operational constraints over time.

Recommendation:
- Generate wrappers from one source template in install/build step.
- Add a drift check in CI to assert wrappers match generated output.

### 8) Low/Medium: Prompt payload size and precedence strategy can be tightened

Role prompts are large (`foreman.md` ~390 lines; total role+wrapper corpus >1000 lines). This can reduce reliability under provider token pressure.

Evidence:
- `floe/roles/foreman.md` length and wrapper duplication

Impact:
- Higher chance of truncation or partial instruction adherence in long sessions.

Recommendation:
- Introduce layered prompt composition:
  - Core invariant contract (short, strict)
  - Mode-specific guidance (loaded as needed)
  - Optional heuristics
- Keep hard safety/process gates in runtime, not in long-form prose.

## Positive Observations

- Strong canonical role separation and explicit role files.
- Runtime/provider abstraction is clear and supports session resume.
- Alignment concept is well designed and close to robust once launch-path parity is fixed.
- DoD injection architecture is directionally good.

## Recommended Implementation Plan

### Phase 1 (Immediate hardening)

1. Enforce alignment gate on implementer `launch-worker --message`.
2. Fix async launch to pass DoD-enriched context.
3. Align feature schema with `ready_for_review` (or revise runner/prompt to remove it).

### Phase 2 (Reliability)

1. Replace lightweight validator with full JSON Schema validation.
2. Add prompt/schema/runtime contract tests:
   - lifecycle states
   - required fields
   - CLI command examples
3. Rework feature-runner escalation windows to duration-based thresholds.

### Phase 3 (Maintainability)

1. Template-generate provider wrappers.
2. Split long role prompts into core + mode overlays.
3. Add CI drift checks for generated wrappers and role-command references.

## Suggested Research Questions (for next step)

1. What is the smallest deterministic state machine that can enforce all critical workflow guarantees without prompt dependence?
2. Which provider adapter constraints (Codex/Claude/Copilot) require different prompt injection strategies to preserve role invariants?
3. What contract-test suite should run in CI to guarantee prompt/schema/runtime coherence?
4. What escalation timing model best fits observed worker completion distributions in real projects?

## Implementation Specification (Execution-Ready)

This section is structured so a future agent can implement the hardening work in one pass.

### Implementation Objective

Close the highest-risk prompt/runtime gaps by enforcing workflow-critical rules in code, aligning schema contracts, and adding regression checks.

### Scope (Must Implement)

1. Enforce alignment gate parity for launch-time implementer messaging.
2. Ensure async launch receives the same context payload (including DoD) as sync launch.
3. Align `execution_state.last_run_outcome` schema with runner/prompt usage of `ready_for_review`.
4. Make feature-runner escalation timing duration-based, not two-tick based.
5. Replace lightweight schema validation with full JSON Schema validation.
6. Fix planner prompt field mismatch (`depends_on` -> `dependencies`) and intake wording drift.

### Out of Scope (Do Not Implement in this pass)

1. Full role prompt redesign/splitting.
2. Provider-wrapper templating/generation pipeline.
3. New workflow modes or architecture-level state machine redesign.

### Concrete File Changes

1. `floe/bin/floe.ts`
- Add launch-path alignment gate for implementer when `--message` is present.
- Enforce same gate before async dispatch for launch path.
- Dispatch async using resolved `contextWithDod`, not raw `args.context`.
- Pass `roleContentPath` into async launch payload.

2. `floe/bin/async-worker.ts`
- Accept/use forwarded `--role-content-path` on launch path.
- Prefer reading role content from forwarded path.
- Set `roleContentPath` on `startSession` config when launching async.
- Keep behavior compatible when path is absent.

3. `floe/schemas/feature.json`
- Add `ready_for_review` to `execution_state.last_run_outcome` enum.

4. `floe/scripts/feature-runner.ts`
- Add explicit implementation grace controls:
  - minimum elapsed time before escalation for missing completion signal.
  - multiple status checks before escalation.
- Persist required counters/timestamps in run state (for restart-safe behavior).
- Keep current terminal outcomes and escalation creation logic.

5. `floe/scripts/helpers.ts`
- Replace `validateArtefact` lightweight checker with full JSON Schema validation.
- Use Ajv (draft 2020-12) with schema cache + compiled validator cache.
- Preserve existing function signature (`{ valid, errors }`).

6. `floe/roles/planner.md`
- Replace `depends_on` reference with `dependencies`.
- Clarify intake contract to match runtime behavior:
  - if intake target release must exist, planner intake should refine existing release and create epics only.
  - remove conflicting instruction to create release in intake mode.

### Suggested Defaults for Runner Timing

1. `TICK_SLEEP_MS`: keep 5000ms or increase to 10000ms.
2. `IMPLEMENTATION_MIN_WAIT_MS`: 10 minutes.
3. `IMPLEMENTATION_MAX_STATUS_CHECKS`: 3 checks before escalation after min wait elapsed.

These values should be constants near current tick constants.

### Verification Checklist (Must Pass)

1. Validation still runs:
```bash
bun run floe/scripts/validate.ts all
```

2. Launch-path alignment gate behavior:
- `launch-worker --role implementer --feature <id> --message "..."` fails when approach is not approved.
- Same command succeeds only after approach is approved (or with explicit override if implemented).

3. Async/sync DoD parity:
- Start implementer/reviewer with sync and async launch paths.
- Confirm both receive DoD content in effective role context.

4. Schema contract:
- Updating feature with `{"execution_state":{"last_run_outcome":"ready_for_review"}}` must validate.

5. Runner timing:
- Feature runner should not escalate within first short interval when implementer is still working.
- Escalation should occur only after configured wait/check thresholds.

6. Prompt/schema wording:
- `floe/roles/planner.md` contains `dependencies` (not `depends_on`).
- Intake instructions no longer conflict with runtime launch contract.

### Regression Tests to Add (Minimum)

1. Unit test for launch alignment gate parity (sync + async launch).
2. Unit test for async context propagation (`contextWithDod` forwarded).
3. Unit test for schema allowing `ready_for_review`.
4. Unit/integration test for feature-runner no-signal escalation thresholds.
5. Unit test for nested schema validation failures (proves Ajv replacement works).

If no test harness exists yet, add a minimal `bun test` setup under `.floe/` and cover the above with focused tests.

### One-Prompt Execution Text (Copy/Paste)

Use this in the next prompt to execute implementation in one shot:

```text
Implement the execution plan in docs/agent-prompt-system-evaluation.md under “Implementation Specification (Execution-Ready)”.
Constraints:
1) Complete all “Scope (Must Implement)” items.
2) Make the concrete file changes exactly as specified.
3) Add/adjust tests for the listed regression cases.
4) Run verification commands and report results.
5) If a requirement conflicts with current code, keep runtime behavior deterministic and update docs accordingly.
6) Provide a final summary grouped by: code changes, tests, verification output, and follow-up risks.
```
