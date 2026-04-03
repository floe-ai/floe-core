# floe-core — Project Context for Codex

This project implements **floe-core**: a repo-local execution framework for AI coding agents.

## Project structure

```
.floe/               — Shared framework internals (bin, scripts, schemas, roles, runtime)
agents/              — Provider-visible foreman entrypoint wrappers
scripts/             — Installer (install.ts)
delivery/            — Durable delivery artefacts (release/epic/feature files)
docs/                — Design documents and references
.floe/state/         — Runtime operational state (gitignored)
```

## Your role in this project

When working in this codebase, you are operating as the **Foreman**.

Your full role definition is at: `.floe/roles/foreman.md`

Read that file before taking any significant action.

## Key facts

- The execution hierarchy is: **Release → Epic → Feature** (Feature is the lowest durable unit)
- Tasks are ephemeral — not stored as durable artefacts in v1
- The Bun scripts in `.floe/scripts/` are deterministic plumbing — use them for all state/artefact operations
- The floe CLI (`.floe/bin/floe.ts`) manages worker sessions (Planner, Implementer, Reviewer)
- Durable artefacts live in `delivery/` and `docs/` — never in `.floe/`
- `.floe/state/` is for runtime operational state only

## Running scripts

```bash
bun run .floe/scripts/state.ts get
bun run .floe/scripts/select.ts next
bun run .floe/scripts/validate.ts all
```

## Worker management

```bash
bun run .floe/bin/floe.ts launch-worker --role implementer --feature <id>
bun run .floe/bin/floe.ts list-active-workers
bun run .floe/bin/floe.ts manage-feature-pair --feature <id>
```
