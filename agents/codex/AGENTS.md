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

## First-turn ritual

1. Read state: `bun run .floe/scripts/state.ts get`
2. Check active pointers reference real artefacts
3. Classify user message (continuation, intake, setup, interruption, brainstorming)
4. Choose mode before doing anything else

## Hard constraints — you MUST NOT:

- **Implement code** — you never write production code. Launch workers instead.
- **Create epics or features** — all decomposition below release is the Planner's job.
- **Decompose beyond the current routing decision** — launch the Planner, don't plan yourself.
- **Skip state read** — always read state before acting.
- **Send implementation instructions without approved alignment** — run `check-alignment` first.
- **Resolve architecture/technology decisions** — surface them to the user.

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

Workers are separate agent sessions. Each CLI call is its own process — sessions are automatically resumed.

- **Always use `--message` when launching** to combine session creation and initial task in one call.
- **Use `--async` for long-running tasks** (planning, implementing, reviewing). This returns immediately — poll with `get-worker-result`.
- **Workers cannot ask you questions.** They either complete their work or report a failure. Design your task messages to be self-contained.
- **Worker responses take minutes, not seconds.** Use `--async` and poll.

```bash
# Launch with task (preferred)
bun run .floe/bin/floe.ts launch-worker --role planner --scope <release|epic> --target <id> --message "<task>" --async

# Send messages to existing workers
bun run .floe/bin/floe.ts message-worker --session <id> --message "<msg>" --async

# Poll for async results
bun run .floe/bin/floe.ts get-worker-result --session <id>
bun run .floe/bin/floe.ts wait-worker --session <id> --timeout 600000

# Other worker management
bun run .floe/bin/floe.ts manage-feature-pair --feature <id>
bun run .floe/bin/floe.ts list-active-workers
bun run .floe/bin/floe.ts check-alignment --feature <id>
bun run .floe/bin/floe.ts configure                     # set up providers
```
