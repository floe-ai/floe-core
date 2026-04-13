# floe-core

A [Pi](https://pi.dev) package for structured AI software delivery.

**Floe** extends Pi with daemon-orchestrated multi-worker coordination — autonomous implementer ↔ reviewer cycles, blocking call resolution, and structured delivery management.

---

## Install

### Install from GitHub

```bash
npm install -g git+https://github.com/floe-ai/floe-core.git
```

> Requires [Node.js](https://nodejs.org). If [Bun](https://bun.sh) or [Pi](https://github.com/mariozechner/pi-coding-agent) are not installed, `floe` will install them automatically on first run.

This installs the `floe` command globally.

```bash
floe                        # Interactive mode — you're talking to Floe
floe "Build auth module"    # Start with an initial prompt
floe -c                     # Continue previous session
floe -p "Summarize"         # Print mode (non-interactive)
```

`floe` is a wrapper around `pi` that starts the Floe daemon and loads the Floe extension. All Pi flags work — see `pi --help`.

### Run from source

```bash
git clone https://github.com/floe-ai/floe-core.git
cd floe-core && npm install
./bin/floe
```

---

## What happens when you run Floe

1. `bin/floe` ensures Pi and Bun are installed
2. The Floe daemon starts as a background Bun process
3. Pi starts with the Floe extension loaded
4. The extension injects the Floe role into the system prompt — the agent **is** Floe
5. `.floe/` project state is auto-initialised if missing
6. The extension connects to the daemon over a Unix socket
7. If the project isn't configured yet, Floe runs onboarding automatically
8. You talk to Floe — it manages planning, implementation, and review

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
floe-core/
├── bin/floe                  Wrapper: ensures deps, starts daemon, launches Pi
├── extensions/floe.ts        Pi extension — identity, daemon client, tools
├── daemon/
│   ├── main.ts               Daemon entry point (standalone Bun process)
│   ├── service.ts            DaemonService — worker lifecycle, call coordination
│   ├── feature-workflow.ts   Feature workflow state machine
│   ├── pi-substrate.ts       Pi SDK session substrate (createAgentSession)
│   ├── store.ts              Event store and state persistence
│   ├── server.ts             Unix socket server
│   ├── client.ts             Socket client (Node-compatible, used by extension)
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
| **Floe extension** | Identity injection, daemon communication (socket client), Floe tool registration |
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
