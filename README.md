# floe-core

A daemon-native AI execution framework with structured delivery.

Provides structured delivery (Release → Epic → Feature) with a local daemon runtime, persistent socket-based worker coordination, and durable repo artefacts as source of truth.

**Floe** is the user-facing interface agent. Planner, Implementer, and Reviewer are internal daemon-managed worker sessions.

---

## Architecture

```
floe/ (global engine)
  ├── bin/floe.ts           CLI entrypoint — dispatches to daemon runtime
  ├── roles/                Canonical role definitions (floe, planner, implementer, reviewer)
  ├── skills/               Canonical skill definitions (floe-exec, floe-preflight, sizing-heuristics)
  ├── schemas/              JSON schemas for all durable artefacts
  ├── scripts/              Deterministic Bun scripts for state/artefact operations
  ├── runtime/              Daemon runtime, session registry
  │   └── daemon/           Daemon service, event store, feature workflow engine, persistent socket transport
  └── package.json          Dependencies
```

Repository source-of-truth boundaries are defined in [docs/repo-layout-contract.md](docs/repo-layout-contract.md).

### Three layers

| Layer | Owns |
|-------|------|
| **`floe-exec`** | Workflow rules, hierarchy truth, schemas, Bun scripts, canonical roles |
| **`floe daemon`** | Feature workflow engine, worker lifecycle, blocking-call ledger, event stream, persistent socket transport |
| **`floe CLI`** | CLI entrypoint, daemon dispatch |
| **`floe-mem`** | Memory retrieval (separate repo, optional) |

### Role architecture

- **Floe** — the user-facing interface agent. Reads `roles/floe.md`.
- **Planner / Implementer / Reviewer** — internal worker sessions managed by the daemon. Canonical role content is injected at session launch.

---

## Quick start

### 1. Install

```bash
bunx github:floe-ai/floe-core
```

This single command:
- Copies the `.floe/` framework directory (scripts, schemas, roles, skills, runtime, CLI)
- Scaffolds `delivery/` and `docs/` directories
- Creates `.floe/dod.json` when missing
- Installs dependencies

Add `--validate` to run consistency checks after install. Use `--no-scaffold` to skip directory creation. Use `--force` to overwrite existing installations.

### 2. Run floe

Start floe in your project directory. Floe is the interface agent — it handles intake, planning coordination, execution, and review.

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

The primary execution model is daemon-native. Workers coordinate through blocking calls over persistent socket connections — no manual messaging or polling required.

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

- Not a cloud service — the daemon runs locally, started on demand
- Not a replacement for your coding agent — it coordinates agents
- Not a source of truth for delivery — artefacts in `delivery/` are the durable truth; runtime state is bookkeeping
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
│   │   └── daemon/          daemon service, feature workflow engine, event store, socket transport
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
└── docs/
    ├── prd/                 product requirements
    ├── architecture/        architecture documents
    └── decisions/           ADRs
```
