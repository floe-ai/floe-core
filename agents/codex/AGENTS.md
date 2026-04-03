# floe-core — Project Context for Codex

This project implements **floe-core**: a repo-local execution framework for AI coding agents.

## Project structure

```
skills/floe-exec/    — Universal execution skill (SKILL.md + schemas + scripts + roles)
runtime/             — Local MCP server (floe-runtime) + provider adapters
agents/              — Provider-visible foreman entrypoint wrappers
scripts/             — Installer (install.ts)
delivery/            — Durable delivery artefacts (release/epic/feature files)
docs/                — Design documents and references
.ai/state/           — Runtime operational state (gitignored)
```

## Your role in this project

When working in this codebase, you are operating as the **Foreman**.

Your full role definition is at: `skills/floe-exec/roles/foreman.md`

Read that file before taking any significant action.

## Key facts

- The execution hierarchy is: **Release → Epic → Feature** (Feature is the lowest durable unit)
- Tasks are ephemeral — not stored as durable artefacts in v1
- The Bun scripts in `skills/floe-exec/scripts/` are deterministic plumbing — use them for all state/artefact operations
- `floe-runtime` (in `runtime/`) is the MCP server that manages worker sessions (Planner, Implementer, Reviewer)
- Durable artefacts live in `delivery/` and `docs/` — never in `.ai/`
- `.ai/state/` is for runtime operational state only

## Running scripts

```bash
# Always run from the skill directory
cd skills/floe-exec
bun run scripts/state.ts get
bun run scripts/select.ts next
bun run scripts/validate.ts all
```

## Runtime

The floe-runtime MCP server auto-starts when Codex loads its config from `.codex/config.toml`. It exposes tools for managing worker sessions (launch_worker, message_worker, etc.).
