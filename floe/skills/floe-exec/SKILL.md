---
name: floe-exec
description: >
  Execution framework for structured delivery. Manages releases, epics, features,
  reviews, summaries, and notes as repo-local artefacts. Provides deterministic
  Bun scripts for state management, work selection, artefact creation, validation,
  and consistency checks. Coordinates Planner, Implementer, and Reviewer worker
  sessions via the floe CLI. Use when the agent needs to read or
  write delivery state, create or update backlog items, select next work, manage
  reviews, launch workers, or write summaries.
  Keywords: delivery, execution, backlog, release, epic, feature, review, summary,
  note, state, selection, planning, lifecycle, workers, floe, planner, implementer, reviewer.
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

All commands run from the **project root** using Bun:

```bash
floe exec <command> <subcommand> [args]
```

## Commands

### Initialise / Scaffold

```bash
floe exec init
```

Scaffolds the full delivery structure (`delivery/`, `docs/prd|architecture|decisions`, `.floe/state/`),
creates initial runtime state, and detects external `context-memory` availability.

### State Management

```bash
floe exec state get                         # read full runtime state
floe exec state get mode                    # read one field
floe exec state set-mode execute            # set mode
floe exec state set-active release rel-v1   # set active release
floe exec state set-active epic epic-auth   # set active epic
floe exec state set-active feature feat-login  # set active feature
floe exec state set-blocker missing_context "Need API spec"
floe exec state clear-blocker
```

Valid modes: `initialise`, `discover`, `plan`, `execute`, `review`, `idle`

### Artefact Management (Releases, Epics, Features)

```bash
# Create
floe exec artefact create release --data '{"title":"MVP v1","intent":"First usable version","priority":"high"}'
floe exec artefact create epic --data '{"title":"Auth Flow","release_id":"rel-mvp-v1","intent":"User authentication"}'
floe exec artefact create feature --data '{"title":"Login Form","epic_id":"epic-auth-flow","behaviour":"User can log in with email/password"}'

# Read
floe exec artefact get release rel-mvp-v1
floe exec artefact list feature --status draft --parent epic-auth-flow

# Update
floe exec artefact update feature feat-login-form --data '{"status":"active","acceptance_criteria":["Form validates email format","Shows error on wrong password"]}'
```

### Work Selection

```bash
floe exec select next    # select next feature per policy
floe exec select ready   # list all ready features
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
floe exec review create feature feat-login-form
floe exec review get-for feat-login-form       # get open review
floe exec review add-finding rev-xxx --severity major --description "Missing password validation"
floe exec review resolve-finding rev-xxx f-xxx
floe exec review set-outcome rev-xxx pass
floe exec review resolve rev-xxx
floe exec review list --status open
```

### Summaries

```bash
floe exec summary create --data '{"target_type":"feature","target_id":"feat-login","kind":"run","content":"Implemented login form with validation","what_happened":"Added LoginForm component with email/password fields"}'
floe exec summary list --target feat-login
```

If external `context-memory` is available, summaries are automatically registered with memory.

### Notes Inbox

```bash
floe exec note create --data '{"source":"user-chat","kind":"idea","summary":"Consider OAuth support later","confidence":0.7}'
floe exec note list --kind idea --status captured
floe exec note search "oauth"
floe exec note promote note-xxx feature feat-oauth
```

### Validation

```bash
floe exec validate all               # full consistency check
floe exec validate artefact feature feat-login  # validate one item
floe exec validate state             # validate runtime state
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
| Runtime State | — | `.floe/state/current.json` | `schemas/runtime-state.json` |

## Status Values

**Backlog items** (release, epic, feature): `draft`, `active`, `blocked`, `completed`, `cancelled`

**Reviews**: `open`, `resolved`, `superseded`

**Review outcomes**: `pass`, `fail`, `blocked`, `needs_replan`, `pending`

**Notes**: `captured`, `reviewed`, `promoted`, `discarded`

## Priority Bands

`critical` > `high` > `normal` > `low` > `parked`

## Related Skills

- `skills/sizing-heuristics/SKILL.md` — canonical sizing rules shared across roles
- `skills/floe-preflight/SKILL.md` — setup, readiness checks, model configuration, git/remote setup

## External Memory Integration

`floe-core` does not install `context-memory`. If a `context-memory` skill is already installed in the project environment, summaries are automatically registered with memory on creation.

Use `context-memory` directly for:
- Retrieving related summaries and context before implementation
- Linking artefacts with relationship types
- Building context bundles for feature execution

## Guidelines

- All output is JSON for machine readability
- One file per durable object — never large collection files
- Runtime state under `.floe/state/` is operational only, not the durable source of truth
- Delivery artefacts under `delivery/` are the durable source of truth
- Scripts are deterministic plumbing — agents call them, users generally do not

## Canonical Role Definitions

The full behavioural definitions for all four roles live in `roles/`:

| Role | File | Description |
|------|------|-------------|
| Floe | `roles/floe.md` | The user-facing interface agent |
| Planner | `roles/planner.md` | Injected by runtime at session launch |
| Implementer | `roles/implementer.md` | Injected by runtime at session launch |
| Reviewer | `roles/reviewer.md` | Injected by runtime at session launch |

**Floe** is the user-facing interface agent. It reads `roles/floe.md` for its process rules.

The **Planner, Implementer, and Reviewer** are worker sessions launched and coordinated by floe through the runtime. Their canonical role content is injected at session launch time.

## Worker Management (floe CLI)

The floe CLI manages worker sessions. Run from the project root:

```bash
floe <command> [options]
```

Available commands:

| Command | When to use |
|---------|-------------|
| `manage-feature-pair` | Launch Implementer + Reviewer pair — daemon handles full workflow autonomously |
| `run-get` | Check run state (implementing, awaiting_code_review, completed, escalated) |
| `events-subscribe` | Stream live events from a run (workflow.progress, call.pending, run.completed) |
| `events-replay` | Replay past events for a run |
| `call-blocking` | (Used by workers) Signal a dependency — establishes persistent socket connection and waits for push-based resolution |
| `call-resolve` | (Used by workers/floe) Resolve a blocking call — pushes responsePayload to the waiting worker over persistent channel |
| `call-detect-orphaned` | Scan for timed-out or orphaned blocking calls |
| `launch-worker` | Start a Planner, Implementer, or Reviewer session (manual use) |
| `message-worker` | Send ad-hoc instructions to a running worker (not needed during feature execution) |
| `get-worker-status` | Check if a worker is active, waiting, idle, stopped, or failed |
| `replace-worker` | Stop a stuck or failing worker and launch a fresh replacement |
| `stop-worker` | Stop a worker cleanly when done |

Workers are identified by a `sessionId` returned when launched. All session state is persisted to `.floe/state/sessions.json`.

### Floe workflow with CLI

```
1. Launch: floe manage-feature-pair --feature <id>
   → Returns { ok: true, runId, implementer, reviewer }
   → Daemon bootstraps implementer and subscribes to events autonomously

2. Observe: floe events-subscribe --run <runId> --wait-ms 300000
   → Watch for: workflow.progress, call.pending, call.resolved, run.completed, run.escalated

3. Check state: floe run-get --run <runId>

4. Intervene only on escalation or floe clarification requests.

No manual worker messaging is needed during autonomous feature execution.
The daemon drives alignment → implementation → review via blocking calls over persistent socket channels.
Workers establish persistent connections to the daemon; call-blocking waits for push-based resolution directly over the live channel.
The resolved call delivers responsePayload to the waiting worker inline — no polling, no separate resume.
worker.continue exists as a manual recovery fallback for crash/orphan/disconnect scenarios, not the normal happy path.
```

## Pre-Code Alignment Protocol

This step is **mandatory** before substantial coding begins on any feature.

1. **Implementer** proposes execution approach via:
   ```bash
   floe exec review set-approach <rev_id> '<proposal>'
   ```
2. **Reviewer** reads and evaluates the proposal:
   ```bash
   floe exec review approve-approach <rev_id> '<rationale>'
   # or
   floe exec review reject-approach <rev_id> '<rationale>'
   ```
3. If rejected or escalated, **floe** surfaces to the user before proceeding.

The `approach_proposal` field lives on the rolling review object — no separate file is created.

## Worker Session Registry

Active and historical worker sessions are tracked in:
- **`.floe/state/sessions.json`** — full session registry (written by floe CLI)
- **`.floe/state/current.json`** — active pointers only (release/epic/feature IDs, mode, blocker)

To inspect active sessions:
```bash
floe exec sessions active
floe exec sessions list --feature <id>
```
