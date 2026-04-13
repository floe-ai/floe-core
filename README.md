# floe-core

A daemon-native AI execution framework with structured delivery.

**Floe** is the user-facing interface agent. The daemon runtime manages Planner, Implementer, and Reviewer as internal worker sessions via the Pi session substrate.

---

## Architecture

### Global engine (ships with Floe install)

```
floe/
  ├── bin/
  │   ├── floe.ts             CLI entrypoint — user runs `floe`
  │   └── floe-daemon.ts      Daemon process — manages worker lifecycle
  ├── roles/                  Canonical role definitions (floe, planner, implementer, reviewer)
  ├── skills/                 Canonical skill definitions (floe-exec, floe-preflight, sizing-heuristics)
  ├── schemas/                JSON schemas for all durable artefacts
  ├── scripts/                Deterministic Bun scripts for state/artefact operations
  ├── runtime/
  │   ├── daemon/             Daemon service, event store, feature workflow engine, persistent socket transport
  │   └── substrate/pi.ts     Pi session substrate — sole session host for all worker sessions
  └── package.json            Dependencies
```

### Project-local state (per repo)

```
your-project/
  ├── .floe/
  │   ├── config.json         Project-specific configuration (model settings, srcRoot, etc.)
  │   ├── dod.json            Project Definition of Done
  │   ├── state/              Runtime state (gitignored)
  │   │   ├── current.json    Active pointers
  │   │   ├── sessions.json   Worker session registry
  │   │   └── daemon/         Daemon state and event journals
  │   ├── roles/              (optional) Project-local role overrides — completely replace global
  │   ├── skills/             (optional) Project-local skill overrides — completely replace global
  │   └── .gitignore          Keeps state/ out of version control
  ├── delivery/               Durable delivery artefacts (committed)
  │   ├── releases/
  │   ├── epics/
  │   ├── features/
  │   ├── reviews/
  │   ├── summaries/
  │   └── notes/
  └── docs/
```

### Layers

| Layer | Owns |
|-------|------|
| **Pi substrate** | Session hosting — starts, manages, and messages AI worker sessions |
| **Daemon** | Worker lifecycle, feature workflow engine, blocking-call ledger, event stream, persistent socket transport |
| **`floe` CLI** | User entrypoint — starts daemon, dispatches commands |
| **`floe-exec`** | Workflow rules, hierarchy truth, schemas, Bun scripts, canonical roles |

### Role architecture

- **Floe** — the user-facing interface agent. Reads `roles/floe.md`.
- **Planner / Implementer / Reviewer** — internal worker sessions managed by the daemon, hosted by the Pi substrate.

---

## Quick start

### 1. Install Floe globally

```bash
# Install floe-core globally
bun install -g github:floe-ai/floe-core
```

### 2. Initialise a project

```bash
cd your-project
floe init
```

This creates project-local state only:
- `.floe/config.json` — project configuration
- `.floe/dod.json` — definition of done
- `.floe/state/` — runtime state (gitignored)
- `delivery/` and `docs/` — durable artefact directories

No framework code is copied into the project.

### 3. Configure

```bash
floe configure
```

Set model configuration for your project. Models are configured per-role in `.floe/config.json`.

### 4. Run floe

```bash
floe
```

Floe is the interface agent — it handles intake, planning coordination, execution, and review.

---

## Delivery hierarchy

```
Release
  └── Epic
        └── Feature    ← lowest durable execution unit
                └── Tasks (ephemeral, not stored as files)
```

---

## Key scripts

Run from the project root (scripts are part of the global Floe install):

```bash
floe manage-feature-pair --feature <id>       # Start daemon-native feature execution
floe events-subscribe --run <runId>           # Observe progress via event stream
floe run-get --run <runId>                    # Check run state
floe runtime-status                           # Check daemon health
```

### Ad-hoc worker management

For manual/diagnostic use — not needed during normal feature execution.

```bash
floe launch-worker --role planner --scope release --target <id>
floe message-worker --session <id> --message "<msg>"
floe get-worker-status --session <id>
floe list-active-workers
```

---

## Global vs project-local

| Concern | Location | Notes |
|---------|----------|-------|
| Runtime, scripts, schemas | Global install | Ships with `floe` |
| Canonical roles & skills | Global install | Loaded by runtime automatically |
| Project config & DoD | `.floe/config.json`, `.floe/dod.json` | Project-specific, committed |
| Runtime state | `.floe/state/` | Gitignored |
| Role overrides | `.floe/roles/` (optional) | Completely replaces global role for this project |
| Skill overrides | `.floe/skills/` (optional) | Completely replaces global skill for this project |
| Delivery artefacts | `delivery/` | Durable source of truth, committed |

---

## What floe-core is NOT

- Not a cloud service — the daemon runs locally, started on demand
- Not a replacement for your coding agent — it coordinates agents
- Not a source of truth for delivery — artefacts in `delivery/` are the durable truth; runtime state is bookkeeping

---

## Optional: floe-mem integration

`floe-core` does not install `context-memory`. If an external [`floe-mem`](https://github.com/floe-ai/floe-mem) / `context-memory` skill is already installed in the project environment, `floe-exec` will automatically register summaries with memory after creation.
