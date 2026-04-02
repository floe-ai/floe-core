# Provider Runtime and MCP Strategy

## Purpose

This document defines the runtime strategy for `floe-core` when launching and managing real worker agents across providers.

It exists to remove ambiguity around:

* MCP versus skills
* provider SDK usage
* adapter boundaries
* streaming and session handling
* how implementer and reviewer agents are launched and coordinated

This is a build-facing document. It should be used by the build agent to implement the runtime/tooling layer correctly.

---

## Core decision

The runtime strategy is:

* **Skills** are the behavioural layer.
* **MCP** is the runtime tool layer.
* **Bun scripts** are deterministic local state/artefact operations.
* **Provider adapters** call the official SDK/runtime interfaces for Codex, Claude, and Copilot.

Do **not** design this system around raw stdin/stdout parsing.
Do **not** build your own transport protocol around CLI output.
Do **not** rely on hidden agent-to-agent chat as the source of truth.

Use provider SDK/session/thread/stream abstractions wherever available.

---

## Separation of responsibilities

### 1. Skills

Skills define:

* when the foreman should call runtime tools
* how the foreman chooses provider, model, and effort
* when to continue, stop, replace, or escalate
* which repo artefacts must be read or updated
* process rules for foreman / planner / implementer / reviewer

Skills are universal workflow behaviour.
They are not the low-level runtime transport.

### 2. MCP server

A local MCP server should expose a small set of coarse runtime tools that the foreman can call.

The MCP server is the standardised tool plane that hides provider differences.

The foreman should not need to know provider-specific session mechanics.
It should call a stable tool interface.

### 3. Bun scripts

Bun scripts handle deterministic local work such as:

* reading/writing `.ai/state`
* creating/updating features, reviews, summaries, and notes
* schema validation
* next-feature selection
* consistency checks
* repo-local scaffold/setup

If something is a deterministic repo mutation, it belongs in Bun scripts, not as freeform agent reasoning.

### 4. Provider adapters

Provider adapters are the internal runtime implementations behind the MCP server.

Each adapter must use the official provider SDK/runtime interface, not a fragile stdout parser.

Adapters are responsible for:

* session/thread creation
* resume/continue semantics
* sending messages/instructions
* subscribing to stream events
* reporting status
* stopping/replacing sessions

---

## Recommended architecture

The architecture should be:

**Foreman skill -> local MCP runtime tools -> provider adapters -> provider SDK sessions/threads/streams**

Repo-native artefacts remain the source of truth:

* `docs/`
* `delivery/`
* `.ai/state/`
* optional `floe-mem`

The runtime layer is not the source of truth.
It is a control plane for worker sessions.

---

## MCP strategy

## Why MCP

Use MCP because it gives the foreman a standard way to call runtime tools across providers.

All target ecosystems support MCP:

* Claude Code / Claude runtime supports MCP clients and servers
* Codex supports MCP in CLI/IDE and can itself run as an MCP server
* Copilot supports MCP for chat and coding agent scenarios

This makes MCP the correct cross-provider tool abstraction.

### MCP implementation rule

Build a **local MCP server** in Bun/TypeScript.

Do not start with remote MCP as the primary deployment shape.
Local is simpler, safer, and enough for v1.

### MCP server name

Use a short, descriptive name such as:

* `floe-runtime`

### MCP tool design rule

Expose a **small number of coarse tools**.
Do not expose dozens of tiny low-level session mechanics.

Recommended tools:

* `launch_worker`
* `resume_worker`
* `message_worker`
* `get_worker_status`
* `replace_worker`
* `stop_worker`
* `list_active_workers`

Optional higher-level tool:

* `manage_feature_pair`

`manage_feature_pair` may encapsulate:

* create implementer + reviewer for a feature
* bind them to provider/model/effort
* return runtime IDs and initial status

### MCP security rule

Use least privilege.

Examples:

* reviewer should not edit code by default
* implementer may have broader write access
* foreman should not have broad repo mutation tools beyond what is necessary
* credentials should be scoped per provider and not over-shared

---

## Provider adapter contract

All provider adapters should implement the same internal interface.

Suggested interface:

* `startSession(config)`
* `resumeSession(sessionId, config?)`
* `sendMessage(sessionId, message, options?)`
* `streamEvents(sessionId, handlers)`
* `getStatus(sessionId)`
* `stopSession(sessionId)`
* `closeSession(sessionId)`

The MCP server should call these adapters.
The foreman should never call provider SDKs directly.

### Common worker config shape

A common config object should include:

* `provider`
* `model`
* `role`
* `featureId`
* `sessionKind` (`implementer` or `reviewer`)
* `resumePolicy`
* `effortLevel` if supported
* `toolPermissions`
* `workingDirectory`
* `contextBundlePath`
* `maxTurns` or equivalent guard if supported

Provider adapters can translate this into provider-specific SDK options.

---

## Provider-specific guidance

## 1. Codex

### Official docs to use

Use these official docs as the source of truth:

* Codex SDK: `https://developers.openai.com/codex/sdk`
* Codex with Agents SDK: `https://developers.openai.com/codex/guides/agents-sdk`
* Codex MCP: `https://developers.openai.com/codex/mcp`
* Codex quickstart: `https://developers.openai.com/codex/quickstart`

### What Codex should be used for

Use Codex as a callable worker runtime through the SDK abstraction.

The build agent should use the current official SDK/session interfaces and supported streaming patterns.
Do not design around CLI JSONL transport directly, even if the SDK uses the CLI under the hood.

### Codex adapter expectations

The Codex adapter must support:

* starting a worker session for implementer or reviewer
* resuming that session later
* sending follow-up instructions
* handling streaming events/status updates through the supported SDK/runtime surface
* cleanly stopping/replacing the session

### Codex design note

Codex also supports MCP. This is useful in two ways:

* `floe-runtime` can be consumed by Codex as an MCP client when the foreman is running in Codex
* Codex itself can also be used behind an adapter for launched worker sessions

The system should use the official Codex SDK/runtime capabilities first and treat lower-level transport details as implementation details hidden behind the adapter.

---

## 2. Claude

### Official docs to use

Use these official docs as the source of truth:

* Agent SDK overview: `https://platform.claude.com/docs/en/agent-sdk/overview`
* Agent SDK TypeScript reference: `https://platform.claude.com/docs/en/agent-sdk/typescript`
* Agent SDK Python reference: `https://platform.claude.com/docs/en/agent-sdk/python`
* Claude MCP docs: `https://code.claude.com/docs/en/mcp`

### What Claude should be used for

Use Claude through the Agent SDK sessions model.

The build agent should rely on the SDK’s session and streaming semantics rather than trying to emulate sessions manually.

### Claude adapter expectations

The Claude adapter must support:

* session creation for implementer/reviewer
* session resume/continue
* message sending and streaming
* status tracking
* controlled stop/replacement

### Claude design note

Claude’s SDK and Claude Code runtime are strong candidates for true persistent peer workers.

Still, repo artefacts remain the source of truth. Direct session continuity is useful, but not trusted as the only record.

---

## 3. Copilot

### Official docs to use

Use these official docs as the source of truth:

* Copilot SDK docs: `https://docs.github.com/en/copilot/how-tos/copilot-sdk`
* Getting started with Copilot SDK: `https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started`
* Copilot SDK repository/docs: `https://github.com/github/copilot-sdk`
* Copilot MCP docs: `https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/extend-copilot-chat-with-mcp`

### What Copilot should be used for

Use Copilot via the official SDK/runtime abstraction.

The build agent should implement worker sessions and streaming using the documented SDK interfaces and session event model.

### Copilot adapter expectations

The Copilot adapter must support:

* worker session start/resume
* structured message dispatch
* streaming event subscription
* status polling or equivalent
* stop/replacement

### Copilot design note

Copilot may expose runtime behaviours differently from Codex or Claude, but the adapter must normalise those differences behind the shared interface.

Do not leak Copilot-specific session details into the foreman logic.

---

## Real peer agents and communication model

The system should treat implementer and reviewer as **logical peer workers**.

Important rule:

* real peer sessions are allowed and preferred where the provider/runtime supports them well
* but canonical communication and truth still lives in repo artefacts and state

### Why

Direct agent-to-agent chat is too fragile as a source of truth.
It creates hidden state, makes replacement harder, and weakens auditability.

### Trusted communication path

Implementer and reviewer should coordinate through:

* active feature file
* rolling review file
* summaries
* `.ai/state/`
* optional `floe-mem`

Direct peer messaging may exist as an optimisation, but any important decision must be written back into repo state.

---

## Minimal runtime artefacts

To avoid file bloat, keep the runtime-facing durable artefacts lean.

For an active feature, the minimum durable set should be:

* feature file
* rolling review file
* meaningful summaries only
* `.ai/state/*` for active pointers and session metadata

Do not create extra ephemeral files for every internal plan step unless experience proves they are necessary.

The implementer’s proposed approach can live in:

* the first meaningful summary, or
* a structured field on the rolling review object

Do not create a separate approach artefact by default in v1.

---

## Execution loop with runtime tools

Recommended feature loop:

1. foreman activates feature
2. foreman calls runtime tools to create or resume implementer/reviewer sessions
3. implementer proposes execution approach
4. reviewer approves / rejects / escalates
5. if approved, implementer codes
6. implementer writes summary
7. reviewer updates rolling review
8. reviewer marks pass / fail / blocked / needs_replan
9. foreman reacts only to state transitions, blockers, or escalation

This keeps foreman thin and prevents it from becoming the implementation brain.

---

## Session persistence and replacement

### Persistence rule

Implementer and reviewer sessions may persist for the life of a feature when the provider/runtime supports that well.

### Replacement rule

Replacement is still governed by the execution framework rules, not the provider SDK.

Default v1 behaviour:

* replace the implementer/reviewer pair together
* do not treat single-role replacement as normal v1 behaviour
* session replacement decisions are made by foreman/handoff rules, not by provider adapters

Adapters only provide the mechanism to stop/close/start/resume sessions.

---

## Skills versus MCP versus Bun scripts

### Skills are for behaviour

Use skills to define:

* foreman process rules
* planner process rules
* implementer/reviewer behavioural expectations
* when to launch or resume workers
* when to stop, escalate, or replace

### MCP is for runtime actions

Use MCP tools for:

* launching workers
* resuming workers
* messaging workers
* reading worker status
* replacing workers
* stopping workers

### Bun scripts are for deterministic repo operations

Use Bun for:

* state mutation
* artefact writes
* schema validation
* selection logic
* consistency checks

This separation should be kept strict.

---

## Documentation and research instructions for the build agent

The build agent must **not** rely on stale prior assumptions about SDK or MCP behaviour.

Before implementing adapters, it must consult the current official documentation for:

### OpenAI / Codex

* `https://developers.openai.com/codex/sdk`
* `https://developers.openai.com/codex/guides/agents-sdk`
* `https://developers.openai.com/codex/mcp`
* `https://developers.openai.com/codex/quickstart`

### Anthropic / Claude

* `https://platform.claude.com/docs/en/agent-sdk/overview`
* `https://platform.claude.com/docs/en/agent-sdk/typescript`
* `https://platform.claude.com/docs/en/agent-sdk/python`
* `https://code.claude.com/docs/en/mcp`

### GitHub / Copilot

* `https://docs.github.com/en/copilot/how-tos/copilot-sdk`
* `https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started`
* `https://github.com/github/copilot-sdk`
* `https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/extend-copilot-chat-with-mcp`

### MCP core docs

* `https://modelcontextprotocol.io/docs/getting-started/intro`
* `https://modelcontextprotocol.io/specification/latest`
* `https://developers.openai.com/api/docs/mcp`

### Implementation rule for the build agent

For each provider:

* verify the current SDK/session/thread/stream model from the official docs
* verify supported auth and local usage requirements
* verify how streaming events are consumed
* implement against the SDK/runtime abstraction, not outdated mental models

Do not cargo-cult old examples or rely on model memory of earlier SDK versions.

---

## Recommended implementation order

1. Build `floe-runtime` local MCP server in Bun/TypeScript
2. Define the shared provider adapter interface
3. Implement a minimal local session registry under `.ai/state/`
4. Implement one provider adapter end-to-end first
5. Add the other provider adapters behind the same interface
6. Wire runtime tools into foreman skills
7. Prove feature-scoped implementer/reviewer loop works against repo artefacts

---

## Non-goals

Do not build:

* a new source of truth outside repo artefacts
* raw stdout parsing as the integration model
* a direct agent-to-agent chat bus as canonical coordination
* a huge set of tiny MCP tools
* a heavyweight orchestration backend in v1

---

## Bottom line

The correct architecture is:

* **Skills** define behaviour and process
* **MCP** exposes the runtime tool plane
* **Bun scripts** perform deterministic local operations
* **Provider adapters** use official SDK/runtime interfaces for sessions, threads, streaming, and resume
* **Repo artefacts** remain the source of truth

This is the recommended runtime strategy for `floe-core`.

