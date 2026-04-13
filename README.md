# floe-core

A Pi package for structured AI software delivery.

**Floe** extends [Pi](https://pi.dev) with daemon-orchestrated multi-worker coordination — feature workflows with autonomous implementer ↔ reviewer cycles, blocking call resolution, and structured delivery management.

---

## Install

```bash
pi install git:github.com/floe-ai/floe-core
```

This installs the Floe extension, skills, and prompt templates into Pi globally.

---

## Usage

```bash
pi
```

When Pi loads with the Floe extension active, it:
1. Auto-initialises `.floe/` project state if missing
2. Starts the Floe daemon (background worker orchestration)
3. Registers Floe tools for feature management, worker coordination, and delivery state

The Floe extension registers these tools in your Pi session:

| Tool | Purpose |
|------|---------|
| `floe_manage_feature` | Start a feature implementation workflow (implementer + reviewer pair) |
| `floe_feature_status` | Check run/feature status |
| `floe_call_resolve` | Resolve a worker's blocking call (approve/reject review) |
| `floe_worker_status` | Check worker session status |
| `floe_events` | Replay run event history |

### Skills

Floe ships with these Pi skills (loaded automatically):

- **floe-exec** — Structured delivery: state, artefacts, reviews, summaries, validation
- **floe-preflight** — Setup, readiness checks, model configuration
- **sizing-heuristics** — Work decomposition and sizing rules

### Prompt templates

Floe provides prompt templates for internal worker roles:

- `/floe` — Interface agent role (governance, routing, escalation)
- `/implementer` — Code implementation worker
- `/reviewer` — Code review worker
- `/planner` — Planning and decomposition worker

---

## Architecture

```
floe-core/                    # Pi package
├── extensions/
│   └── floe.ts               Pi extension — daemon lifecycle, tool registration
├── daemon/
│   ├── service.ts             DaemonService — worker lifecycle, call coordination
│   ├── feature-workflow.ts    Feature workflow state machine
│   ├── pi-substrate.ts        Pi SDK session substrate — spawns worker sessions
│   ├── store.ts               Event store and state persistence
│   ├── server.ts              Unix socket server
│   ├── worker-channel.ts      Persistent socket transport (push-based resolution)
│   ├── worker-client.ts       Worker-side socket client
│   ├── types.ts               Protocol types
│   └── __tests__/             45 tests
├── skills/                    Pi skills
├── prompts/                   Pi prompt templates (role definitions)
├── scripts/                   Bun scripts for state/artefact management
└── docs/
```

### Layers

| Layer | Owns |
|-------|------|
| **Pi** | Session hosting, model routing, tools, context management |
| **Floe extension** | Daemon lifecycle, Floe tool registration |
| **Daemon** | Worker lifecycle, feature workflow engine, blocking-call ledger, event stream |
| **Pi SDK substrate** | Spawns worker sessions as Pi SDK `createAgentSession()` instances |

### Project-local state (per repo)

```
your-project/
  ├── .floe/
  │   ├── config.json         Project-specific configuration
  │   ├── dod.json            Project Definition of Done
  │   ├── state/              Runtime state (gitignored)
  │   └── .gitignore
  ├── delivery/               Durable delivery artefacts (committed)
  │   ├── releases/
  │   ├── epics/
  │   ├── features/
  │   ├── reviews/
  │   ├── summaries/
  │   └── notes/
  └── docs/
```

---

## Delivery hierarchy

```
Release
  └── Epic
        └── Feature    ← lowest durable execution unit
                └── Tasks (ephemeral, not stored)
```

---

## Development

```bash
# Run tests
bun test daemon/

# All 45 tests should pass
```

---

## What Floe is NOT

- Not a replacement for Pi — it extends Pi with structured delivery
- Not a cloud service — the daemon runs locally, started on demand
- Not a coding agent — it coordinates agents (implementer, reviewer, planner)
