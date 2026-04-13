# floe-core

A [Pi](https://pi.dev) package for structured AI software delivery.

**Floe** extends Pi with daemon-orchestrated multi-worker coordination — autonomous implementer ↔ reviewer cycles, blocking call resolution, and structured delivery management.

---

## Install

### Option 1: Pi package (recommended)

```bash
pi install git:github.com/floe-ai/floe-core
```

This registers Floe's extension, skills, and prompt templates globally in Pi. Then run `pi` — the Floe extension loads automatically, injects the Floe identity, and starts the daemon.

### Option 2: Global npm install

```bash
npm install -g floe-core
```

This gives you the `floe` command:

```bash
floe                        # Interactive mode — you're talking to Floe
floe "Build auth module"    # Start with an initial prompt
floe -c                     # Continue previous session
floe -p "Summarize"         # Print mode (non-interactive)
```

`floe` is a thin wrapper around `pi` that loads the Floe extension. All Pi flags work — see `pi --help`.

### Option 3: Run from source

```bash
git clone https://github.com/floe-ai/floe-core.git
cd floe-core && npm install
./bin/floe
```

---

## What happens when you run Floe

1. Pi starts with the Floe extension loaded
2. The extension injects the Floe role into the system prompt — the agent **is** Floe
3. `.floe/` project state is auto-initialised if missing
4. The Floe daemon starts (background worker orchestration)
5. If the project isn't configured yet, Floe runs onboarding automatically
6. You talk to Floe — it manages planning, implementation, and review

---

## Tools

The Floe extension registers these tools in your Pi session:

| Tool | Purpose |
|------|---------|
| `floe_manage_feature` | Start a feature workflow (implementer + reviewer pair) |
| `floe_feature_status` | Check run/feature status |
| `floe_call_resolve` | Resolve a worker's blocking call (approve/reject review) |
| `floe_worker_status` | Check worker session status |
| `floe_events` | Replay run event history |

### Commands

| Command | Purpose |
|---------|---------|
| `/floe-status` | Show daemon and worker status |
| `/floe-shutdown` | Shut down the Floe daemon |

---

## Skills

Floe ships with these Pi skills (auto-loaded when relevant):

- **floe-exec** — Structured delivery: state, artefacts, reviews, summaries, validation
- **floe-preflight** — Setup, readiness checks, model configuration
- **sizing-heuristics** — Work decomposition and sizing rules

---

## Architecture

```
floe-core/                    Pi package
├── bin/floe                  Wrapper: launches pi with Floe extension
├── extensions/floe.ts        Pi extension — identity, daemon lifecycle, tools
├── daemon/
│   ├── service.ts            DaemonService — worker lifecycle, call coordination
│   ├── feature-workflow.ts   Feature workflow state machine
│   ├── pi-substrate.ts       Pi SDK session substrate (createAgentSession)
│   ├── store.ts              Event store and state persistence
│   ├── server.ts             Unix socket server
│   ├── worker-channel.ts     Persistent socket transport
│   └── __tests__/            45 tests
├── skills/                   Pi skills
├── prompts/                  Pi prompt templates (role definitions)
├── scripts/                  Bun scripts for state/artefact management
└── docs/
```

### Layers

| Layer | Owns |
|-------|------|
| **Pi** | Session hosting, model routing, tools, context, compaction |
| **Floe extension** | Identity injection, daemon lifecycle, Floe tool registration |
| **Daemon** | Worker lifecycle, feature workflow engine, blocking-call ledger, events |
| **Pi SDK substrate** | Spawns worker sessions via `createAgentSession()` |

### How a feature workflow runs

```
User → "Implement auth"
  → Floe (interface agent) calls floe_manage_feature
    → Daemon creates run + starts implementer + reviewer sessions
    → FeatureWorkflowEngine sends bootstrap message to implementer
    → Implementer proposes approach → blocking call → Daemon routes to reviewer
    → Reviewer approves/rejects → Daemon resolves call → Implementer continues
    → Implementation complete → blocking call → Reviewer does code review
    → Review pass → workflow complete
    → Review fail → revision cycle → re-review → pass
```

### Project-local state (per repo)

```
your-project/
  ├── .floe/
  │   ├── config.json         Project configuration
  │   ├── dod.json            Definition of Done
  │   ├── state/              Runtime state (gitignored)
  │   └── .gitignore
  └── delivery/               Delivery artefacts (committed)
      ├── releases/
      ├── epics/
      ├── features/
      ├── reviews/
      ├── summaries/
      └── notes/
```

---

## Development

```bash
bun test daemon/     # Run all 45 tests
```

---

## What Floe is NOT

- Not a replacement for Pi — it extends Pi with structured delivery orchestration
- Not a cloud service — the daemon runs locally, on demand
- Not a coding agent — it coordinates agents (implementer, reviewer, planner)
