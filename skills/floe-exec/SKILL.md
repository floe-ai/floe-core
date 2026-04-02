---
name: floe-exec
description: >
  Execution framework for structured delivery. Manages releases, epics, features,
  reviews, summaries, and notes as repo-local artefacts. Provides deterministic
  Bun scripts for state management, work selection, artefact creation, validation,
  and consistency checks. Coordinates Planner, Implementer, and Reviewer worker
  sessions via the floe-runtime MCP server. Use when the agent needs to read or
  write delivery state, create or update backlog items, select next work, manage
  reviews, launch workers, or write summaries.
  Keywords: delivery, execution, backlog, release, epic, feature, review, summary,
  note, state, selection, planning, lifecycle, workers, foreman, planner, implementer, reviewer.
license: MIT
compatibility: Requires Bun (https://bun.sh). Works with Codex, Copilot, and Claude Code.
---

# Floe Execution Framework Skill

## When to use this skill

Use this skill whenever you need to interact with the structured delivery framework:

- **Reading state**: what is the current mode, active release/epic/feature, blockers
- **Creating artefacts**: releases, epics, features, notes, reviews, summaries
- **Updating artefacts**: changing status, adding acceptance criteria, updating reviews
- **Selecting work**: finding the next ready feature to implement
- **Validation**: checking consistency of the delivery structure
- **Writing summaries**: recording what happened after implementation or review runs
- **Managing reviews**: creating, updating, and resolving rolling feature reviews
- **Capturing notes**: storing emerging ideas in the pre-planning inbox

## How to invoke

All commands run from **this skill's directory** using Bun:

```bash
bun run scripts/<command>.ts <subcommand> [args]
```

## Commands

### Initialise / Scaffold

```bash
bun run scripts/init.ts
```

Scaffolds the full delivery structure (`delivery/`, `docs/prd|architecture|decisions`, `.ai/state/`),
creates initial runtime state, and detects `floe-mem` availability.

### State Management

```bash
bun run scripts/state.ts get                         # read full runtime state
bun run scripts/state.ts get mode                    # read one field
bun run scripts/state.ts set-mode execute            # set mode
bun run scripts/state.ts set-active release rel-v1   # set active release
bun run scripts/state.ts set-active epic epic-auth   # set active epic
bun run scripts/state.ts set-active feature feat-login  # set active feature
bun run scripts/state.ts set-blocker missing_context "Need API spec"
bun run scripts/state.ts clear-blocker
```

Valid modes: `initialise`, `discover`, `plan`, `execute`, `review`, `idle`

### Artefact Management (Releases, Epics, Features)

```bash
# Create
bun run scripts/artefact.ts create release --data '{"title":"MVP v1","intent":"First usable version","priority":"high"}'
bun run scripts/artefact.ts create epic --data '{"title":"Auth Flow","release_id":"rel-mvp-v1","intent":"User authentication"}'
bun run scripts/artefact.ts create feature --data '{"title":"Login Form","epic_id":"epic-auth-flow","behaviour":"User can log in with email/password"}'

# Read
bun run scripts/artefact.ts get release rel-mvp-v1
bun run scripts/artefact.ts list feature --status draft --parent epic-auth-flow

# Update
bun run scripts/artefact.ts update feature feat-login-form --data '{"status":"active","acceptance_criteria":["Form validates email format","Shows error on wrong password"]}'
```

### Work Selection

```bash
bun run scripts/select.ts next    # select next feature per policy
bun run scripts/select.ts ready   # list all ready features
```

Selection policy:
1. Only features in active epics within the active release
2. Exclude items with unsatisfied dependencies
3. Prefer continuation of currently active feature
4. Prefer highest priority ready feature
5. Prefer features in the currently active epic
6. Prefer oldest ready feature at same priority

### Reviews (Rolling)

```bash
bun run scripts/review.ts create feature feat-login-form
bun run scripts/review.ts get-for feat-login-form       # get open review
bun run scripts/review.ts add-finding rev-xxx --severity major --description "Missing password validation"
bun run scripts/review.ts resolve-finding rev-xxx f-xxx
bun run scripts/review.ts set-outcome rev-xxx pass
bun run scripts/review.ts resolve rev-xxx
bun run scripts/review.ts list --status open
```

### Summaries

```bash
bun run scripts/summary.ts create --data '{"target_type":"feature","target_id":"feat-login","kind":"run","content":"Implemented login form with validation","what_happened":"Added LoginForm component with email/password fields"}'
bun run scripts/summary.ts list --target feat-login
```

If `floe-mem` is available, summaries are automatically registered with memory.

### Notes Inbox

```bash
bun run scripts/note.ts create --data '{"source":"user-chat","kind":"idea","summary":"Consider OAuth support later","confidence":0.7}'
bun run scripts/note.ts list --kind idea --status captured
bun run scripts/note.ts search "oauth"
bun run scripts/note.ts promote note-xxx feature feat-oauth
```

### Validation

```bash
bun run scripts/validate.ts all               # full consistency check
bun run scripts/validate.ts artefact feature feat-login  # validate one item
bun run scripts/validate.ts state             # validate runtime state
```

## Artefact Types

| Type | Prefix | Location | Schema |
|------|--------|----------|--------|
| Release | `rel-` | `delivery/releases/` | `schemas/release.json` |
| Epic | `epic-` | `delivery/epics/` | `schemas/epic.json` |
| Feature | `feat-` | `delivery/features/` | `schemas/feature.json` |
| Review | `rev-` | `delivery/reviews/` | `schemas/review.json` |
| Summary | `sum-` | `delivery/summaries/` | `schemas/summary.json` |
| Note | `note-` | `delivery/notes/` | `schemas/note.json` |
| Runtime State | — | `.ai/state/current.json` | `schemas/runtime-state.json` |

## Status Values

**Backlog items** (release, epic, feature): `draft`, `active`, `blocked`, `completed`, `cancelled`

**Reviews**: `open`, `resolved`, `superseded`

**Review outcomes**: `pass`, `fail`, `blocked`, `needs_replan`, `pending`

**Notes**: `captured`, `reviewed`, `promoted`, `discarded`

## Priority Bands

`critical` > `high` > `normal` > `low` > `parked`

## floe-mem Integration

If `floe-mem` (context-memory skill) is installed, summaries are automatically registered with memory on creation. The framework detects floe-mem by checking for the context-memory skill in standard locations.

Use floe-mem directly for:
- Retrieving related summaries and context before implementation
- Linking artefacts with relationship types
- Building context bundles for feature execution

## Guidelines

- All output is JSON for machine readability
- One file per durable object — never large collection files
- Runtime state under `.ai/state/` is operational only, not the durable source of truth
- Delivery artefacts under `delivery/` are the durable source of truth
- Scripts are deterministic plumbing — agents call them, users generally do not

## Canonical Role Definitions

The full behavioural definitions for all four roles live in `roles/`:

| Role | File | Provider wrapper |
|------|------|-----------------|
| Foreman | `roles/foreman.md` | Provider-visible wrapper installed by `scripts/install.ts` |
| Planner | `roles/planner.md` | No provider wrapper — injected by floe-runtime at launch |
| Implementer | `roles/implementer.md` | No provider wrapper — injected by floe-runtime at launch |
| Reviewer | `roles/reviewer.md` | No provider wrapper — injected by floe-runtime at launch |

The **Foreman** is the user-facing agent. It reads `roles/foreman.md` for its process rules.

The **Planner, Implementer, and Reviewer** are worker sessions launched and coordinated by the Foreman through `floe-runtime`. Their canonical role content is injected at session launch time.

## MCP Runtime Tools (floe-runtime)

When `floe-runtime` is running as a local MCP server, the Foreman can use these tools to manage worker sessions.

Start the runtime:
```bash
cd runtime && bun run src/server.ts
```

Available tools:

| Tool | When to use |
|------|-------------|
| `launch_worker` | Start a Planner, Implementer, or Reviewer session |
| `resume_worker` | Resume an existing session that is paused or was rehydrated from registry |
| `message_worker` | Send instructions to a running worker |
| `get_worker_status` | Check if a worker is active, idle, stopped, or failed |
| `replace_worker` | Stop a stuck or failing worker and launch a fresh replacement |
| `stop_worker` | Stop a worker cleanly when done |
| `list_active_workers` | List all running workers (optionally filter by feature) |
| `manage_feature_pair` | Launch an Implementer + Reviewer pair for a feature in one call |

Workers are identified by a `sessionId` returned when launched. All session state is persisted to `.ai/state/sessions.json`.

### Foreman workflow with runtime tools

```
1. Start: manage_feature_pair { featureId, implementerProvider, reviewerProvider }
2. Implementer proposes approach: message_worker { sessionId: implementerId, message: "Propose your execution approach for feature <id>" }
3. Reviewer evaluates: message_worker { sessionId: reviewerId, message: "Review the approach proposal on review <rev_id>" }
4. If approved: message_worker { sessionId: implementerId, message: "Approach approved. Begin implementation." }
5. Monitor: get_worker_status { sessionId }
6. If stuck: replace_worker { sessionId }
7. Completion: stop_worker for both after feature review passes
```

## Pre-Code Alignment Protocol

This step is **mandatory** before substantial coding begins on any feature.

1. **Implementer** proposes execution approach via:
   ```bash
   bun run scripts/review.ts set-approach <rev_id> '<proposal>'
   ```
2. **Reviewer** reads and evaluates the proposal:
   ```bash
   bun run scripts/review.ts approve-approach <rev_id> '<rationale>'
   # or
   bun run scripts/review.ts reject-approach <rev_id> '<rationale>'
   ```
3. If rejected or escalated, **Foreman** surfaces to the user before proceeding.

The `approach_proposal` field lives on the rolling review object — no separate file is created.

## Worker Session Registry

Active and historical worker sessions are tracked in:
- **`.ai/state/sessions.json`** — full session registry (written by floe-runtime)
- **`.ai/state/current.json`** — active pointers only (release/epic/feature IDs, mode, blocker)

To inspect active sessions without the MCP server:
```bash
bun run scripts/sessions.ts active
bun run scripts/sessions.ts list --feature <id>
```
