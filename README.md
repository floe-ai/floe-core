# floe-core

A repo-local execution framework for AI coding agents.

Provides structured delivery (Release → Epic → Feature) with rolling reviews, summaries, notes, and a local MCP server for worker session management — all driven by machine-readable JSON files in the repo.

Works with **Codex**, **Copilot CLI**, and **Claude Code** as the foreman (user-facing) agent. Planner, Implementer, and Reviewer are launched as worker sessions through `floe-runtime`.

---

## Architecture

```
floe-exec (skill + core)
  ├── SKILL.md              Universal skill behavioural rules
  ├── roles/                Canonical role definitions (foreman, planner, implementer, reviewer)
  ├── schemas/              JSON schemas for all durable artefacts
  └── scripts/              Deterministic Bun scripts for state/artefact operations

floe-runtime (MCP server)
  └── runtime/
      ├── src/server.ts     Local MCP server (stdio transport)
      ├── src/adapters/     Provider adapters (Codex, Claude, Copilot, Mock)
      └── src/registry.ts   Session registry → .ai/state/sessions.json

floe-mem (optional, separate)
  └── Retrieval-augmented memory for context continuity across sessions
```

### Three layers

| Layer | Owns |
|-------|------|
| **`floe-exec`** | Workflow rules, hierarchy truth, schemas, Bun scripts, canonical roles, installer |
| **`floe-runtime`** | MCP server, provider adapters, session lifecycle, worker registry |
| **`floe-mem`** | Memory retrieval (separate repo, optional) |

### Role architecture

- **Foreman** — the user-facing agent. Runs in the user's CLI tool (Claude/Codex/Copilot). Reads `roles/foreman.md`.
- **Planner / Implementer / Reviewer** — worker sessions launched by the Foreman via `floe-runtime`. No provider-visible wrapper files — canonical role content is injected at session launch.

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
# Clone and install into your project
git clone https://github.com/floe-ai/floe-core.git
cd floe-core
bun run scripts/install.ts --project-root /path/to/your/project --scaffold
```

Or run directly:
```bash
bunx github:floe-ai/floe-core --scaffold
```

### 2. Start the runtime MCP server

```bash
cd floe-core/runtime
bun install
bun run src/server.ts
```

The server communicates over stdio. Connect it to your agent's MCP config (auto-configured for Copilot and Claude by the installer; manual setup required for Codex).

### 3. Initialise delivery structure

```bash
cd your-project
# If not already scaffolded by installer:
cd path/to/floe-core/skills/floe-exec
bun run scripts/init.ts
```

### 4. Open your agent

Start `claude`, `codex`, or Copilot CLI in your project. The Foreman agent definition will be loaded automatically.

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

Run from `skills/floe-exec/`:

```bash
bun run scripts/state.ts get                          # current state
bun run scripts/state.ts set-mode execute             # change mode
bun run scripts/select.ts next                        # select next feature
bun run scripts/artefact.ts list feature              # list all features
bun run scripts/review.ts get-for <feature_id>        # get active review
bun run scripts/review.ts set-approach <rev_id> '<proposal>'
bun run scripts/review.ts approve-approach <rev_id>
bun run scripts/validate.ts all                       # consistency check
bun run scripts/sessions.ts active                    # list active workers
```

---

## What floe-exec is NOT

- Not a daemon or separate runtime product
- Not a replacement for your coding agent — it runs inside it
- Not a source of truth — `.ai/state/sessions.json` is runtime bookkeeping only; delivery artefacts are the durable truth
- Not a workflow database

---

## Optional: floe-mem integration

If [`floe-mem`](https://github.com/floe-ai/floe-mem) (context-memory skill) is installed in the project, `floe-exec` will automatically register summaries with memory after creation.

Detect availability:
```bash
bun run scripts/init.ts  # reports floe-mem status during init
```

---

## File layout after install

```
your-project/
├── delivery/
│   ├── releases/          release artefacts
│   ├── epics/             epic artefacts
│   ├── features/          feature artefacts
│   ├── reviews/           rolling review objects
│   ├── summaries/         run and handoff summaries
│   └── notes/             pre-planning notes inbox
├── docs/
│   ├── prd/               product requirements
│   ├── architecture/      architecture documents
│   └── decisions/         ADRs
├── .ai/
│   └── state/
│       ├── current.json   active pointers only (gitignored)
│       └── sessions.json  worker session registry (gitignored)
├── .github/
│   ├── skills/floe-exec/  skill installation (Copilot)
│   ├── agents/foreman.agent.md
│   └── copilot-mcp.json   MCP server registration
└── .claude/
    ├── skills/floe-exec/  skill installation (Claude)
    ├── agents/foreman.md
    └── settings.json      MCP server registration
```
