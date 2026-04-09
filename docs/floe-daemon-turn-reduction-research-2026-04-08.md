# Floe Spike Findings: Reducing Agent Turns, Cost, and Timeout Risk

**Date:** 2026-04-08  
**Project:** `floe-core` (`sticky-notes` flow context)  
**Scope requested:** Determine a clear way to reduce Foreman turns and cost, handle long-running workers/timeouts, and allow implementer/reviewer back-and-forth while Foreman remains the user interface.

---

## 1. Executive Answer

If Floe must stay multi-provider (Copilot + Codex + Claude), the most robust path is:

1. Introduce a persistent **`floe-daemon`** process that owns warm worker sessions and streams status/events back to Foreman.
2. Keep Foreman as the only user-facing agent; Foreman sends intent to daemon, daemon performs continuation-aware blocking sidecar coordination across workers.
3. Use provider-native streaming and session resume inside daemon; eliminate Foreman polling loops.
4. For Copilot specifically, use `customAgents` delegation when possible to compress multi-agent work into fewer user-visible turns.

This gives the biggest reduction in wasted turns from waiting/polling while preserving your current Foreman interface contract.

---

## 2. What Is Happening Today in Floe

Current Floe behavior is already designed around subprocesses + disk polling:

- `message-worker --async` launches `async-worker.ts` as a detached subprocess and writes pending/completed/error JSON files (`.floe/state/results`) for polling/waiting.
- `wait-worker` polls every 2s until timeout.
- Every CLI invocation is a fresh process, so adapter in-memory state is empty and must be resumed each call.
- `feature-runner` loops every 5s and calls `message-worker` repeatedly.

Evidence in repo:

- `dispatchAsync` + resume comment: `floe/bin/floe.ts:248-309`
- polling loop (`wait-worker`): `floe/bin/floe.ts:539-572`
- async worker behavior: `floe/bin/async-worker.ts:3-177`
- result-file store: `floe/runtime/results.ts:1-125`
- feature runner tick/poll cadence: `floe/scripts/feature-runner.ts:42`, `:655-660`

**Observed consequence:** Foreman spends turns checking state rather than doing useful work.

---

## 3. SDK Capability Findings (Validated)

## 3.1 GitHub Copilot SDK

### Proven primitives

- Persistent sessions with disk-backed state and resume.
- Independent sub-agent definitions via `customAgents`.
- Streaming event bus with tool/subagent/session lifecycle events.
- Delivery modes: `immediate` (steer current turn) and `enqueue` (FIFO future turns).
- Session-level premium usage summary (`session.shutdown.totalPremiumRequests`) in type definitions.

### Direct evidence

- Session persistence patterns, 30-minute idle timeout, deployment pattern "one CLI server per user (recommended)":  
  https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-sdk/use-copilot-sdk/session-persistence
- Custom agents in isolated context with lifecycle events back to parent session:  
  https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-sdk/use-copilot-sdk/custom-agents
- Streaming events include ephemeral vs persisted, `assistant.usage`, `session.idle`, `subagent.*`:  
  https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-sdk/use-copilot-sdk/streaming-events
- Steering/queueing semantics (`mode: immediate|enqueue`):  
  https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-sdk/use-copilot-sdk/steering-and-queueing

### Runtime experiments (local, 2026-04-08)

#### Experiment A: plain turn vs custom-agent turn metering

- Plain prompt (`gpt-5.4`): 1 `assistant.usage` event, no subagent events.
- Custom-agent prompt (`gpt-5.4`): multiple `assistant.usage` events, `subagent.started` + `subagent.completed` present.
- In controlled run:
  - plain: `usageEventCount=1`, premium snapshot stable (`253` only)
  - custom: `usageEventCount=5`, premium snapshot range `254 -> 255`, subagent events present

Inference from observed event stream (not explicitly documented by GitHub billing docs):

- Sub-agent orchestration can trigger additional internal billed interactions during one top-level send.
- It still removes Foreman polling turns because progress arrives as pushed events.

#### Experiment B: long-running observability without polling

- Prompt requested bash sleep flow; session emitted `tool.execution_start`, `tool.execution_complete`, `assistant.usage`, and `session.idle` over ~37s.
- Foreman/daemon can stay event-driven and responsive without issuing “are you done?” requests.

---

## 3.2 OpenAI Codex SDK + Codex App Server + Background/WebSocket Modes

### Codex SDK (package used by Floe)

- `startThread()`, `resumeThread()`, `run()`, `runStreamed()`.
- Threads persist under `~/.codex/sessions`.
- SDK wraps/spawns Codex CLI and streams JSONL over stdio.

Evidence:

- SDK README in OpenAI codex repo:  
  https://github.com/openai/codex/tree/main/sdk/typescript

### Codex App Server (important for daemon-style architecture)

- Persistent JSON-RPC/WebSocket server with native thread and turn lifecycle:
  - `thread/start`, `thread/resume`, `thread/fork`
  - `turn/start`, `turn/steer`, `turn/interrupt`
  - notification-driven streaming

Evidence:

- App Server API overview and thread/turn methods:  
  https://developers.openai.com/codex/app-server

### OpenAI Responses Background/WebSocket patterns (timeout mitigation)

- `background: true` for async long-running tasks.
- Poll terminal statuses (`queued`, `in_progress` -> terminal) or stream.
- `background + stream` supports reconnect via `sequence_number` cursor.
- WebSocket mode reduces continuation overhead for long tool-heavy loops.

Evidence:

- Background mode guide:  
  https://developers.openai.com/api/docs/guides/background
- WebSocket mode guide:  
  https://developers.openai.com/api/docs/guides/websocket-mode

---

## 3.3 Anthropic Claude Agent SDK

### Proven primitives

- V1 `query()` returns async generator (streamed events/messages).
- Resume/session controls exist (`resume`, `sessionId`, `resumeSessionAt`) in SDK type surface.
- V2 preview introduces persistent session model: `createSession/resumeSession`, `send()/stream()`.

Evidence:

- V1 TypeScript reference (`query()` async generator):  
  https://platform.claude.com/docs/en/agent-sdk/typescript
- V2 preview (`createSession`, `resumeSession`, `send`, `stream`):  
  https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview
- Installed SDK type surface in repo (`sdk.d.ts`) confirms `resume` + `unstable_v2_*` methods.

---

## 4. Subprocess vs Daemon Tradeoff for Floe

## 4.1 Current subprocess model (today)

Pros:

- Simple isolation.
- Crash containment.

Cons:

- Polling architecture burns orchestration turns.
- Foreman learns failures late (result-file read later).
- Repeated resume/re-injection overhead.
- Streaming exists in adapters but is mostly unused in CLI paths.

## 4.2 `floe-daemon` model

Pros:

- Warm sessions per worker (no per-message rehydrate tax).
- Push streaming to Foreman (SSE/WS), no polling loops.
- Immediate error visibility (permission errors, tool failures, timeout states).
- Internal worker-to-worker dialogue can run without each step requiring a new Foreman turn.

Cons:

- Requires daemon lifecycle, health checks, and state management.
- Concurrency and locking need explicit design.

### Startup-overhead measurement (local)

Measured on this machine (20 runs):

- `bun -e ""`: mean ~1.8ms
- `bun run floe/bin/floe.ts list-active-workers`: mean ~33.6ms
- `bun run floe/bin/async-worker.ts ...` (argument-error path): mean ~24.9ms

Interpretation:

- Process spawn overhead exists but is not the dominant cost driver. The larger savings come from eliminating polling turns and keeping sessions warm.

---

## 5. What Reduces Turns and Cost Most

## 5.1 Biggest waste to remove first

- Foreman status polling (`wait-worker`, periodic check-ins).
- Stepwise implementer/reviewer orchestration where each intermediate step requires Foreman re-entry.

## 5.2 Best multi-provider strategy

- Use `floe-daemon` as a durable orchestrator process.
- Keep implementer and reviewer attached as warm sessions.
- Coordinate their review/revision flow through blocking sidecar calls and resumptions; stream progress outward.
- Foreman only emits milestone updates to user.

## 5.3 Copilot-specific turn compression

- Use one parent session with `customAgents` (`implementer`, `reviewer`), scoped tools, and sub-agent events.
- Let runtime delegate and reconcile within one top-level session flow.

Important nuance from experiment:

- This can reduce user-visible turn churn, but may still consume multiple premium interactions internally for one complex delegated turn.

---

## 6. Timeout and Long-Run Handling Patterns

Implement these in `floe-daemon` regardless of provider:

1. Event stream first: every worker run emits heartbeat/progress/failure/completion.
2. Run IDs and resumable subscriptions: Foreman can reconnect to active run stream by `runId`.
3. Hard cancellation path:
   - Copilot: `session.abort()` / session controls
   - Codex App Server: `turn/interrupt`
   - OpenAI Responses background: cancel endpoint
4. Session TTL + keepalive policy to avoid stale warm sessions.
5. Persistent run ledger (`.floe/state/daemon/runs.db` or JSONL) for restart recovery.

Provider-specific timeout posture:

- OpenAI: background mode + streaming cursor replay is strongest for multi-minute work.
- Copilot: long-lived SDK session + `session.idle` and streaming events.
- Claude: streaming query/V2 session model with explicit resume.

---

## 7. Implementation Blueprint (Scoped to Current Floe)

This is scoped so Foreman stays the interface agent.
This section is migration context only. The authoritative build contract is Section 10.

## 7.1 New component

- **Process:** `floe-daemon`
- **Transport:** local Unix socket (or TCP localhost fallback)
- **Foreman integration:** `floe.ts` adds client commands that proxy to daemon.

## 7.2 Minimal daemon API

Superseded by Section 10 contract. If kept for migration compatibility, map legacy commands to:

1. `runtime.ensure()`
2. `run.start({ type, objective, participants, budgets })`
3. `worker.start({ role, provider, model, scope, runId })`
4. `worker.resume({ workerId | sessionRef })`
5. `call.blocking({ runId, workerId, callType, payload, dependsOn, timeoutAt })`
6. `call.resolve({ callId, responsePayload, resolvedBy })`
7. `worker.continue({ workerId, callId, continuation })`
8. `worker.interrupt({ workerId })`
9. `worker.stop({ workerId, reason })`
10. `call.detectOrphaned({ runId? })`
11. `worker.recover({ workerId, strategy })`
12. `run.get({ runId })`
13. `worker.get({ workerId })`
14. `events.subscribe({ runId })`

## 7.3 Event model (single schema across providers)

Superseded by Section 10.15 (normalized runtime events). Use Section 10.15 as the authoritative event contract.

## 7.4 Foreman behavior change

Before:

- Foreman dispatches work and repeatedly polls.

After:

- Foreman submits one daemon run request.
- Foreman streams state updates and only responds to user at meaningful milestones.

## 7.5 Worker back-and-forth strategy by provider

- Copilot path:
  - Prefer parent session + `customAgents` (`implementer`, `reviewer`), exploit sub-agent orchestration and lifecycle events.
- Codex/Claude path:
  - Keep warm sessions and coordinate via continuation-aware blocking calls:
    - implementer emits blocking call -> reviewer resolves -> sidecar resumes implementer.

## 7.6 Rollout phases

1. Add daemon and socket protocol with run/event persistence.
2. Route existing `launch-worker`/`message-worker` through daemon (no behavior change yet).
3. Replace `wait-worker` polling with event subscription.
4. Add pending-call ledger and `call.blocking`/`call.resolve`/`worker.continue` lifecycle.
5. Enable Copilot custom-agent optimization path behind feature flag.
6. Add metrics dashboards: turn count, premium interactions (when available), wall-time, failure classes.

---

## 8. Risks and Constraints

1. Copilot SDK is public preview; event/types may change.
2. Session locking is app responsibility in shared-daemon setups.
3. Tool state persistence differs by provider and often requires explicit app-level state.
4. Billing semantics for sub-agent delegation are not fully documented in one place; treat current metering observations as empirical and re-validate per release.

---

## 9. Decision Shape (Concise)

- If you want one architecture that works across all installed providers and removes polling-turn waste: **build `floe-daemon`**.
- If you also want maximum turn compression on Copilot: **use `customAgents` inside daemon-managed sessions**.
- If you later choose OpenAI-only orchestration for some workloads: evaluate **Codex App Server** as a provider-native daemon-like control plane.
- Build implementation should follow Section 10 primitives, not Section 1-9 research-era API sketches.

---

## 10. Alignment Update (2026-04-09): Continuation-Aware Sidecar Runtime

This section is the authoritative implementation contract.
Sections 1-9 are retained as research context, evidence, and migration rationale.

### 10.1 Core runtime model (explicit)

Default worker mode is continuation-oriented:

1. Receive work.
2. Reason and act.
3. When cross-worker coordination is required, issue a sidecar call.
4. Enter wait state.
5. Sidecar resolves dependency and returns a structured response.
6. Worker resumes in same session where possible.
7. Repeat until explicit termination or terminal run state.

**Important:** workers should not assume a single send/response is the end of participation.

### 10.2 Sidecar role and non-role

The sidecar is:

- A local long-lived runtime (`floe-daemon`) behind Foreman.
- Continuation-aware orchestration and resume control.
- Worker lifecycle and pending-dependency manager.
- Event-stream source for Foreman.

The sidecar is not:

- Canonical project truth.
- A replacement for repo artefacts as durable state.
- A reason to hide critical workflow state only in provider sessions.

### 10.3 State model (three classes)

1. **Durable project truth (repo artefacts):**
   - plans, task/feature state, review outcomes, decisions, summaries, escalations.
2. **Runtime operational state (sidecar):**
   - active workers/runs, pending calls, cursors, resume handles, heartbeats, retries, wait graph.
3. **Provider/session state (adapter/provider):**
   - session/thread IDs, provider resume tokens, stream item IDs, provider metadata.

Provider state is useful but non-authoritative; recovery must be possible from (1) + (2).

### 10.4 Required primitives

Runtime lifecycle:

- `runtime.ensure()`
- `runtime.shutdown()`
- `runtime.status()`

Worker lifecycle:

- `worker.start({ role, provider, model, scope, runId })`
- `worker.resume({ workerId | sessionRef })`
- `worker.continue({ workerId, callId, continuation })`
- `worker.stop({ workerId, reason })`
- `worker.interrupt({ workerId })`
- `worker.recover({ workerId, strategy })`

Lifecycle ownership rule:

- `worker.continue(...)`, `call.detectOrphaned(...)`, and `worker.recover(...)` are sidecar-driven lifecycle actions by default. They are not general external orchestration commands unless intentionally exposed through a controlled interface.

Run lifecycle:

- `run.start({ type, objective, participants, budgets })`
- `run.complete({ runId })`
- `run.escalate({ runId, reason })`
- `run.get({ runId })`

Continuation call lifecycle:

- `call.blocking({ runId, workerId, callType, payload, dependsOn, timeoutAt })`
- `call.resolve({ callId, responsePayload, resolvedBy })`
- `call.detectOrphaned({ runId? })`

Routing (non-blocking and reply path):

- `route.send({ to, message, context })`
- `route.reply({ callId, response })`

Observation:

- `events.subscribe({ runId })`
- `events.replay({ runId, cursor })`
- `worker.get({ workerId })`

### 10.5 Continuation-aware blocking call contract

Representative blocking call types:

- `request_plan_review`
- `request_code_review`
- `request_foreman_clarification`
- `handoff_to_reviewer`
- `handoff_to_implementer`
- `handoff_to_planner`
- `report_complete_and_wait`
- `escalate_and_wait`

Blocking call requirements:

- Register pending dependency.
- Suspend requester progress logically (alive + waiting, not completed).
- Allow other participants to act.
- Return structured result later.
- Resume requester via warm/session/artefact recovery strategy.

Blocking vs non-blocking rule:

- Use `call.blocking(...)` when the requester must enter wait state and later resume with structured dependency resolution.
- Use `route.send(...)` only for non-blocking routing/notification where no pending dependency or requester suspension is created.

### 10.6 Pending-call ledger (first-class runtime object)

Each pending call tracks:

- `callId`
- `runId`
- `workerId`
- `role`
- `callType`
- `status`
- `payload`
- `responsePayload`
- `createdAt`
- `updatedAt`
- `resolvedAt`
- `dependsOn`
- `resumeStrategy`
- `timeoutAt`
- `retryCount`

Statuses:

- `pending`
- `resolved`
- `timed_out`
- `cancelled`
- `failed`
- `orphaned`

This ledger is the center of continuation correctness.

### 10.7 Worker contract

Workers are expected to:

- Continue until explicitly stopped.
- Use sidecar calls for all cross-worker handoffs.
- Wait after blocking sidecar calls.
- Emit structured outcomes (not ambiguous conversational endings).
- Treat repo artefacts as durable truth.
- Be resumable after interruption.
- Tolerate compact continuation context when warm state is unavailable.

Provider-native capabilities (tools, sub-agents, fan-out) are internal execution details; cross-worker coordination still goes through sidecar contract.

### 10.8 Runtime behavior rules

Default routing rule:

- All cross-worker handoffs route through sidecar.

Continuation rule:

- Blocking call => requester remains logically alive in waiting state.

Completion rule:

- Return control to Foreman only on: completed workflow, required escalation, budget/time exhaustion, failure, interrupt/cancel, explicit termination.

Termination rule:

- Workers do not auto-terminate after successful sidecar call.
- Worker stop only on terminal run outcome or explicit stop/failure.

### 10.9 Loop and cost controls

Enforce policy limits per run:

- `maxPlanRounds`
- `maxReviewRounds`
- `maxWorkerMessages`
- `maxBlockingCalls`
- `maxResumes`
- `maxRetries`
- `maxWallClockMs`
- `maxToolCalls`
- token budget (when provider exposes reliable usage)
- repeated-feedback detection
- inactivity timeout + stall detection

Escalate instead of unbounded internal loops.

### 10.10 Workflow state machine

Suggested explicit states:

- `initialising`
- `planning`
- `awaiting_plan_review`
- `plan_revision`
- `implementing`
- `awaiting_code_review`
- `code_revision`
- `awaiting_foreman`
- `completed`
- `escalated`
- `cancelled`
- `failed`

Worker termination should only occur from terminal states or explicit interrupt/stop.

### 10.11 Premature-stop detection and recovery

Suspicious conditions:

- Worker session ended with unresolved blocking call.
- Worker stopped in non-terminal run state.
- Ambiguous worker output without structured completion.
- Missing heartbeat/progress for timeout window.
- Repeated provider disconnects.
- Response channel closed while dependencies remain pending.

Recovery order:

1. Resume same worker/session if safe.
2. Recreate worker with compact continuation package.
3. Escalate to Foreman when retry budget or safety checks fail.

### 10.12 Resume model (three levels)

1. Warm continuation: same live provider session.
2. Provider session resume: native thread/session restore.
3. Artefact-based recovery: rebuild from repo truth + run state + pending obligations.

This reinforces why durable artefacts cannot be optional.

### 10.13 Provider posture (contract first)

- Copilot: use persistence + streaming + steering; leverage `customAgents` where useful, but do not make architecture depend on custom-agent semantics matching peer worker model.
- Codex: use thread/session resume and active turn steering; strong fit for continuation-heavy orchestration.
- Claude: use resumed sessions where available; assume repeated send/stream cycles may still be needed within one run.

Guarantee a shared runtime contract, not identical provider behavior.

### 10.14 Feature boundary guidance

Default boundary:

- New feature => new run.
- Usually new implementer/reviewer pair per feature.
- Prior sessions can remain resumable for debugging/audit.
- Avoid "clear context and reuse forever" as primary strategy.

Planner reuse may be beneficial but should remain policy-driven.

### 10.15 Event model (normalized runtime events)

- `runtime.started`
- `run.started`
- `run.progress`
- `run.awaiting_foreman`
- `run.escalated`
- `run.completed`
- `run.failed`
- `worker.started`
- `worker.resumed`
- `worker.waiting`
- `worker.resolved`
- `worker.stalled`
- `worker.interrupted`
- `worker.stopped`
- `tool.started`
- `tool.completed`
- `provider.disconnected`
- `provider.resumed`
- `call.pending`
- `call.resolved`
- `call.timed_out`
- `call.orphaned`

Foreman consumes these and decides what becomes user-visible; this is how we reduce "question every turn" behavior.

### 10.16 MVP rollout (aligned)

1. Introduce sidecar runtime and client interface.
2. Route existing start/send/wait flows through sidecar (minimal behavioral change).
3. Add blocking sidecar calls + pending-call ledger.
4. Add bounded implementer/reviewer pair-run workflow.
5. Add planner handoff + Foreman escalation/resume path.
6. Add recovery logic, stall detection, artefact-based resume.
7. Add provider-specific optimizations behind adapter boundary.

### 10.17 Build-time success criteria

- Foreman remains the only user-facing agent.
- Workers issue blocking sidecar calls and resume from structured responses.
- Internal loops no longer require repeated Foreman relay churn.
- Warm sessions are used when possible, with robust fallback.
- Premature stop is detected and managed.
- Repo artefacts are sufficient for recovery after session loss.
- Internal churn remains bounded by explicit policy.
- Provider adapters remain implementation-specific under a stable runtime contract.

---

## Sources

- Copilot SDK custom agents: https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-sdk/use-copilot-sdk/custom-agents
- Copilot SDK session persistence: https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-sdk/use-copilot-sdk/session-persistence
- Copilot SDK streaming events: https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-sdk/use-copilot-sdk/streaming-events
- Copilot SDK steering/queueing: https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-sdk/use-copilot-sdk/steering-and-queueing
- Copilot CLI customization overview (custom agents context-window statement): https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/overview
- OpenAI Codex SDK (TypeScript README): https://github.com/openai/codex/tree/main/sdk/typescript
- OpenAI Codex App Server: https://developers.openai.com/codex/app-server
- OpenAI Background mode: https://developers.openai.com/api/docs/guides/background
- OpenAI WebSocket mode: https://developers.openai.com/api/docs/guides/websocket-mode
- Anthropic Agent SDK TypeScript reference: https://platform.claude.com/docs/en/agent-sdk/typescript
- Anthropic Agent SDK TypeScript V2 preview: https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview

### Local evidence files used

- `floe/bin/floe.ts`
- `floe/bin/async-worker.ts`
- `floe/runtime/results.ts`
- `floe/scripts/feature-runner.ts`
- `floe/runtime/adapters/copilot.ts`
- `floe/runtime/adapters/codex.ts`
- `floe/runtime/adapters/claude.ts`
- `floe/node_modules/@github/copilot-sdk/dist/types.d.ts`
- `floe/node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts`
- `floe/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- `floe/node_modules/@openai/codex-sdk/dist/index.d.ts`
