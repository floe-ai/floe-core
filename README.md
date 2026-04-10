# floe-core

A repo-local execution framework for AI coding agents.

Provides structured delivery (Release → Epic → Feature) with a local daemon runtime, continuation-driven worker coordination, and durable repo artefacts as source of truth.

Works with **Codex**, **Copilot CLI**, and **Claude Code** as the foreman (user-facing) agent. Planner, Implementer, and Reviewer run as daemon-managed worker sessions coordinated through blocking calls and auto-resume.

---

## Architecture

```
.floe/ (installed into your project)
  ├── bin/floe.ts           CLI entrypoint — dispatches to daemon runtime
  ├── roles/                Canonical role definitions (foreman, planner, implementer, reviewer)
  ├── skills/               Canonical skill definitions (floe-exec, sizing-heuristics)
  ├── schemas/              JSON schemas for all durable artefacts
  ├── scripts/              Deterministic Bun scripts for state/artefact operations
  ├── runtime/              Daemon runtime, provider adapters, session registry
  │   ├── daemon/           Daemon service, event store, feature workflow engine
  │   ├── adapters/         Codex, Claude, Copilot, Mock
  │   └── registry.ts      Session registry → .floe/state/sessions.json
  └── package.json          Dependencies (zod + optional provider SDKs)

floe-mem (optional, separate)
  └── Retrieval-augmented memory for context continuity across sessions
```

Repository source-of-truth boundaries are defined in [docs/repo-layout-contract.md](docs/repo-layout-contract.md).

### Three layers

| Layer | Owns |
|-------|------|
| **`floe-exec`** | Workflow rules, hierarchy truth, schemas, Bun scripts, canonical roles, installer |
| **`floe daemon`** | Feature workflow engine, worker lifecycle, blocking-call ledger, event stream |
| **`floe CLI`** | CLI entrypoint, provider adapters, daemon dispatch |
| **`floe-mem`** | Memory retrieval (separate repo, optional) |

### Role architecture

- **Foreman** — the user-facing agent. Runs in the user's CLI tool (Claude/Codex/Copilot). Reads `.floe/roles/foreman.md`.
- **Planner / Implementer / Reviewer** — worker sessions launched by the Foreman via the floe CLI. No provider-visible wrapper files — canonical role content is injected at session launch.

---

## Auth requirements per provider

| Provider | Auth |
|----------|------|
| **Codex** | `OPENAI_API_KEY` env var, or local ChatGPT sign-in (both officially supported) |
| **Copilot** | Existing GitHub/Copilot CLI credentials (picked up automatically) |
| **Claude** | `ANTHROPIC_API_KEY` required. Anthropic does not allow third-party products to reuse claude.ai interactive login for SDK use. |

---

## Quick start

### 1. Install

```bash
bunx github:floe-ai/floe-core
```

This single command:
- Copies the `.floe/` framework directory (scripts, schemas, roles, skills, runtime, CLI)
- Installs thin skill pointers for each provider (`floe-exec`, `sizing-heuristics`)
- Generates provider foreman wrapper files
- Scaffolds `delivery/` and `docs/` directories
- Creates `.floe/dod.json` when missing
- Installs dependencies

Add `--validate` to run consistency checks after install. Use `--no-scaffold` to skip directory creation. Use `--target codex,claude` to install for specific providers only. Use `--force` to overwrite existing installations.

### 2. Open your agent

Start `claude`, `codex`, or Copilot CLI in your project. The Foreman is loaded automatically from the provider-specific agent wrapper.

---

## Delivery hierarchy

```
Release
  └── Epic
        └── Feature    ← lowest durable execution unit
                └── Tasks (ephemeral, not stored as files in v1)
```

---

## Key scripts

Run from the project root:

```bash
bun run .floe/scripts/state.ts get                          # current state
bun run .floe/scripts/state.ts set-mode execute             # change mode
bun run .floe/scripts/select.ts next                        # select next feature
bun run .floe/scripts/artefact.ts list feature              # list all features
bun run .floe/scripts/review.ts get-for <feature_id>        # get active review
bun run .floe/scripts/review.ts set-approach <rev_id> '<proposal>'
bun run .floe/scripts/review.ts approve-approach <rev_id>
bun run .floe/scripts/validate.ts all                       # consistency check
bun run .floe/scripts/sessions.ts active                    # list active workers
```

## Feature execution (daemon-native)

The primary execution model is daemon-native. Workers coordinate through blocking calls and auto-resume — no manual messaging or polling required.

```bash
# Start a feature run — daemon manages the full lifecycle
bun run .floe/bin/floe.ts manage-feature-pair --feature <id>

# Observe progress via event stream (blocks until new events)
bun run .floe/bin/floe.ts events-subscribe --run <runId> --wait-ms 60000

# Check run state at any time
bun run .floe/bin/floe.ts run-get --run <runId>

# Replay all events for a run
bun run .floe/bin/floe.ts events-replay --run <runId>

# Check daemon health
bun run .floe/bin/floe.ts runtime-status

# Detect orphaned blocking calls
bun run .floe/bin/floe.ts call-detect-orphaned --run <runId>
```

## Planning (worker sessions)

```bash
bun run .floe/bin/floe.ts launch-worker --role planner --scope <intake|release|epic> --target <id>
bun run .floe/bin/floe.ts launch-worker --role planner --scope release --target <id> --message "<task>"
```

## Ad-hoc worker management

These commands are for manual/diagnostic use — not needed during normal feature execution.

```bash
bun run .floe/bin/floe.ts launch-worker --role implementer --feature <id>
bun run .floe/bin/floe.ts message-worker --session <id> --message "<msg>"
bun run .floe/bin/floe.ts get-worker-status --session <id>
bun run .floe/bin/floe.ts resume-worker --session <id>
bun run .floe/bin/floe.ts replace-worker --session <id>
bun run .floe/bin/floe.ts stop-worker --session <id>
bun run .floe/bin/floe.ts list-active-workers
```

---

## What floe-core is NOT

- Not a cloud service — the daemon runs locally in your project, started on demand
- Not a replacement for your coding agent — it runs inside it
- Not a source of truth — `.floe/state/sessions.json` is runtime bookkeeping only; delivery artefacts are the durable truth
- Not a workflow database

---

## Optional: floe-mem integration

`floe-core` does not install `context-memory`. If an external [`floe-mem`](https://github.com/floe-ai/floe-mem) / `context-memory` skill is already installed in the project environment, `floe-exec` will automatically register summaries with memory after creation.

---

## File layout after install

```
your-project/
├── .floe/
│   ├── bin/floe.ts          CLI entrypoint — dispatches to daemon
│   ├── scripts/             deterministic Bun scripts
│   ├── schemas/             JSON schemas for artefacts
│   ├── roles/               canonical role definitions
│   ├── skills/              canonical skill definitions
│   ├── runtime/
│   │   ├── daemon/          daemon service, feature workflow engine, event store
│   │   └── adapters/        provider adapters (Codex, Claude, Copilot)
│   ├── dod.json             project Definition of Done
│   ├── state/
│   │   ├── current.json     active pointers only (gitignored)
│   │   ├── sessions.json    worker session registry (gitignored)
│   │   └── events/          run event journals (gitignored)
│   └── package.json         dependencies
├── delivery/
│   ├── releases/            release artefacts
│   ├── epics/               epic artefacts
│   ├── features/            feature artefacts
│   ├── reviews/             rolling review objects
│   ├── summaries/           run and handoff summaries
│   └── notes/               pre-planning notes inbox
├── docs/
│   ├── prd/                 product requirements
│   ├── architecture/        architecture documents
│   └── decisions/           ADRs
├── .github/
│   ├── skills/floe-exec/SKILL.md          thin pointer → .floe/skills/floe-exec/SKILL.md
│   ├── skills/sizing-heuristics/SKILL.md  thin pointer → .floe/skills/sizing-heuristics/SKILL.md
│   └── agents/foreman.agent.md
├── .claude/
│   ├── skills/floe-exec/SKILL.md          thin pointer → .floe/skills/floe-exec/SKILL.md
│   ├── skills/sizing-heuristics/SKILL.md  thin pointer → .floe/skills/sizing-heuristics/SKILL.md
│   └── agents/foreman.md
├── .agents/
│   ├── skills/floe-exec/SKILL.md          thin pointer → .floe/skills/floe-exec/SKILL.md
│   └── skills/sizing-heuristics/SKILL.md  thin pointer → .floe/skills/sizing-heuristics/SKILL.md
└── AGENTS.md                        Codex foreman agent definition
```
