# Execution Framework Build Agent Handoff

## Purpose

Build a thin, repo-local execution framework for coding agents that:

* works in normal Codex, Copilot, and Claude Code CLI environments
* uses Bun for deterministic scripts
* keeps repo-local artefacts as source of truth
* optionally integrates with `floe-mem` for memory and relationship-aware retrieval
* stays conversational at the user level
* avoids a heavy custom harness, daemon, or separate runtime product

This framework is not a replacement coding agent. It is a repo-local execution layer that defines how work is shaped, progressed, reviewed, and resumed.

---

## Core design intent

### User experience

The user should be able to open a normal coding agent CLI in the repo and talk naturally.

The system should:

* detect whether the repo is already using the framework
* detect whether the user is brainstorming, refining, continuing work, or asking for new work
* route into the correct mode
* quietly use scripts and repo state underneath
* stop only at meaningful boundaries or when user decisions are needed

The user should not need to run special framework commands in normal usage.

### Architectural intent

The framework should be:

* skills-first
* repo-local
* file-driven
* machine-readable
* light and fast
* Bun-powered for deterministic file/state operations
* portable across supported coding agents

Do not build:

* a daemon
* a separate wrapper runtime users must launch instead of their normal agent
* a database for execution state
* a giant orchestration app

---

## High-level model

### Source of truth

Source of truth is repo-local artefacts.

Not source of truth:

* chat history
* hidden agent plans
* persistent agent sessions
* memory summaries alone

### Hierarchy

Durable hierarchy:

* PRD
* Release
* Epic
* Feature

In version 1:

* **Feature is the lowest durable execution unit**
* tasks are **ephemeral working structure only** and are not stored as durable backlog items by default

### Decomposition style

Decomposition must be:

* breadth-first
* just-in-time

That means:

* release -> epics only when release is active
* epic -> features only when epic is active
* feature is refined only when it becomes the active execution unit
* do not decompose the whole tree ahead of likely execution unless explicitly requested

### Execution style

Execution is feature-scoped.

Preferred model:

* one persistent implementer session per active feature
* one persistent reviewer session per active feature
* both iterate until the feature passes, blocks, is replanned, or is interrupted

The implementation/review loop should include a pre-code alignment step:

* the implementer proposes an execution approach for the active feature
* the reviewer checks whether that approach appears aligned with acceptance criteria, current architecture expectations, and likely review standards before substantial coding begins
* if reviewer confidence is too low or there is a meaningful disagreement, the issue may escalate upward through the process or back to the user as a tie-breaker

Important rule: Persistent sessions are useful, but they are never the source of truth. If a session dies or is replaced, the feature must still be resumable from durable repo state and summaries.

---

## Repo structure

### Visible project-facing structure

Use visible repo folders for human-auditable artefacts:

```text
/docs/
  prd/
  architecture/
  decisions/

/delivery/
  notes/
  releases/
  epics/
  features/
  reviews/
  summaries/
```

### Agent/runtime-facing structure

Use `.ai/` for internal operational state:

```text
/.ai/
  memory/
  state/
```

### File granularity

Use one file per durable object.

Examples:

* one release per file
* one epic per file
* one feature per file
* one note per file
* one rolling review per active feature
* one summary per meaningful run or handoff

Do not use large collection JSON files as the primary durable structure.

### Runtime state

Runtime state under `.ai/state/` should include current operational pointers such as:

* active release id
* active epic id
* active feature id
* current mode
* current blocker if any
* session metadata if needed

Runtime state must not become the only durable truth for anything historically important.

---

## Modes

### 1. Initialise

Used for:

* first adoption in a repo
* greenfield setup
* brownfield adoption
* repair of missing framework files

Initialisation should happen when the workflow crosses from planning into actual implementation, not merely because the user brainstormed.

Responsibilities:

* detect repo/framework state
* scaffold required repo structure
* create baseline runtime state under `.ai/state/`
* detect `floe-mem` if present
* create any minimum viable artefacts needed to proceed safely

### 2. Discover

Used when the user introduces:

* new ideas
* refinements
* bugs
* UX concerns
* architecture concerns
* priority changes

Responsibilities:

* clarify intent
* classify the request
* measure confidence in classification
* split mixed requests into distinct items when needed
* align the request to current release/epic/feature structure or identify misalignment
* create/update notes or backlog artefacts as appropriate

No non-trivial request should bypass discovery and jump straight into execution.

### 3. Plan

Used when the active branch needs refinement one level deeper.

Responsibilities:

* decompose release -> epics
* decompose epic -> features
* refine active feature enough for safe execution
* attach acceptance criteria, constraints, likely file hints, likely verification hints, and architecture considerations
* convert any temporary external/agent-native planning into durable repo-local artefacts

Planning must stay just-in-time. Do not refine the entire future tree.

### 4. Execute

Used when there is an active feature.

Responsibilities:

* prepare or load the feature context bundle
* retrieve memory/context if available
* start or resume implementer and reviewer feature sessions
* perform bounded implementation/review loops
* update summaries, rolling review, and state

### 5. Review

Used when:

* a feature completes
* an epic completes
* repeated failure occurs
* a blocker appears
* a significant contradiction or uncertainty appears
* the user must decide something

Responsibilities:

* summarise state
* classify outcome
* decide continue / block / escalate / replan
* perform broader review at epic boundaries

---

## Foreman role

The foreman is a **role**, not a permanently special agent process. The visible user-facing agent may be Codex, Copilot, Claude Code, or another supported tool, and it should take on the foreman role through skills/prompts.

The foreman must stay in the **process lane**. It is not the product owner, architecture brain, implementation agent, or long-term memory.

### Foreman core responsibilities

#### 1. State and mode management

* detect repo/framework state
* detect active release/epic/feature pointers
* detect whether user intent is continuation, intake, setup, interruption, or brainstorming
* choose mode before substantive action

#### 2. Intake and scope control

* classify incoming requests
* split mixed requests when needed
* measure confidence in classification
* push back when a request conflicts with active release intent or current delivery direction
* prevent non-trivial work from bypassing discovery

#### 3. Artefact and note conversion

* convert conversation into durable repo-local artefacts
* decide whether input should become a note, release change, epic, feature change, summary consequence, or review action
* prefer updating existing artefacts over creating duplicates
* proactively capture important emerging ideas into notes when appropriate

#### 4. Execution orchestration

* determine when a feature is ready to enter execution
* start or resume feature-scoped implementation and review sessions
* keep them running while productive
* replace or reset them when no longer productive
* stop when boundaries require it

#### 5. Boundary and stop enforcement

* prevent mode bleed
* stop refinement when uncertainty is no longer decision-critical for the current level
* enforce review and replanning boundaries
* surface contradictions
* guard against artefact sprawl

#### 6. User-facing transparency

* be explicit about confidence and assumptions
* explain why the system is proceeding, pausing, or escalating
* keep the user oriented without drowning them in process narration

### Foreman minimal-context rule

The foreman must use the minimum context required to classify, route, and enforce boundaries.

It should not load deep product, architecture, memory, or code context unless needed to resolve routing ambiguity or detect structural misalignment.

### First-turn startup behaviour

On the first substantive user turn in a fresh chat, the foreman must:

* inspect repo/framework state
* inspect active release/epic/feature pointers
* detect whether runtime state is missing, stale, or inconsistent
* classify the user message as continuation, intake, setup, interruption, or brainstorming
* choose mode before taking further substantive action

A deeper stale-state check is required when:

* active pointers reference missing artefacts
* repo changes appear in the active area without corresponding summary/review updates
* runtime state and durable artefacts disagree materially
* a human appears to have edited durable artefacts directly in ways that invalidate current runtime assumptions

### Startup minimalism rule

Startup inspection should be fast and minimal. Do not perform a broad project re-analysis just because a fresh chat opened.

### Good-enough rule by mode

The foreman must stop refining when remaining uncertainty is no longer decision-critical for the current mode.

Interpretation:

* discover is good enough when the next structural action is clear
* plan is good enough when the next level down is coherent enough to create durable artefacts
* execute may begin when remaining uncertainty is non-critical to safe feature execution
* review is good enough when continue / stop / block / escalate is clear

---

## Planner, implementer, reviewer roles

### Planner role

Responsibilities:

* decompose exactly one level down
* maintain hierarchy quality
* perform deeper product and architecture shaping that the foreman avoids
* ensure features are small enough to be execution-ready
* attach acceptance criteria, constraints, file hints, verification hints, and architecture considerations
* convert planning output into machine-readable artefacts

### Implementer role

Responsibilities:

* execute one active feature through bounded runs
* retrieve targeted context
* inspect code and tests
* implement safely
* verify and summarise
* reduce user setup friction wherever practical
* push the project toward a runnable first version when applicable
* propose a concrete execution approach before significant coding begins when appropriate

### Reviewer role

Responsibilities:

* evaluate whether the active feature actually satisfies its acceptance criteria
* classify blockers and regressions
* maintain the rolling review object for the active feature
* decide continue / fail / blocked / needs replan
* review the implementer's proposed approach before significant coding begins when appropriate
* escalate when confidence is too low to approve the current direction
* perform broader review at epic boundaries when invoked

---

## Review and summary model

### Summaries

Summaries are durable artefacts. They are long-lived retrieval targets used for:

* handoff
* continuity
* lessons learned
* future guidance

### Reviews

Reviews are separate first-class artefacts with a shorter operational half-life. They are not just state.

Use reviews for:

* structured pass/fail/block judgements
* explicit findings and required actions
* gating progress on the active feature

Resolved reviews remain for traceability, but summaries should be the primary historical retrieval target.

### Rolling review model

Use one rolling review object per active feature in v1. Do not create a brand-new review artefact for every small pass unless a later version proves that necessary.

Suggested review statuses:

* open
* resolved
* superseded

Suggested review outcomes:

* pass
* fail
* blocked
* needs_replan

---

## Notes inbox

The framework should include a repo-local notes inbox for ideas that are not yet backlog-ready.

Use it to capture:

* emerging ideas
* messy or inconsistent user thoughts
* concerns or contradictions
* references, examples, screenshots, links
* questions worth revisiting

Notes are not backlog items and do not imply approval.

### Capture behaviour

Capture notes when:

* the user explicitly asks to remember/store something
* the user expresses an emerging idea likely to matter later
* the user is exploratory or contradictory in a way that may matter later
* a reference appears that may help future planning

If unsure, the foreman may ask whether the user wants the idea stored.

### Retrieval behaviour

Relevant notes should surface organically during:

* intake
* planning
* related discussion
* explicit recall requests

Do not wait only for explicit retrieval commands if a related note is clearly helpful.

For v1, notes should prefer references, paths, URLs, and lightweight metadata over full attachment handling. Rich attachment workflows can come later.

### Suggested note shape

Suggested fields:

* id
* created_at
* updated_at
* source
* kind
* summary
* raw_content optional
* confidence
* related_release_id optional
* related_epic_id optional
* related_feature_id optional
* tags optional
* references optional
* status

Suggested kinds:

* idea
* concern
* contradiction
* question
* reference
* observation

Suggested statuses:

* captured
* reviewed
* promoted
* discarded

---

## Runnable-first behaviour

Whenever the framework is producing something runnable, it should bias toward the lowest-friction path to first successful run.

Runnable outputs include:

* web apps
* servers/APIs
* CLIs
* scripts
* desktop apps
* local tools/services

### Principles

* reduce setup friction as part of delivery quality
* prefer zero-command or one-command startup when realistic
* bring the first meaningful runnable version into existence as early as practical
* do as much setup as the agent can safely do
* when user action is required, guide the user precisely

### Expected outputs

Runnable slices should ideally include:

* start scripts or equivalent
* dependency setup
* generated env/config templates where appropriate
* a README or equivalent with prerequisites, run steps, env requirements, and likely first-run expectations

---

## Level-specific architecture and review thinking

### Release level

Release planning/review should consider:

* overall application shape
* major subsystem boundaries
* cross-cutting concerns
* PRD alignment
* delivery coherence

Release review is outcome- and delivery-oriented.

### Epic level

Epic planning/review should consider:

* how features combine into a coherent capability
* whether architecture remains globally coherent
* cross-feature integration gaps
* UX coherence across the epic

Epic review is the main forest-for-trees checkpoint.

### Feature level

Feature planning/review should consider:

* local system surfaces being changed
* affected interfaces/contracts
* whether implementation pressure suggests the feature is too large or badly shaped
* whether the result actually satisfies acceptance criteria without local regressions

Feature review is local, concrete, and adversarial.

---

## Selection and continuation

### Selection policy

Choose the next work by:

1. considering only features in active epics within the active release
2. excluding items with unsatisfied dependencies
3. preferring continuation of the currently active feature
4. then preferring highest priority ready feature
5. then oldest ready feature at that priority

Priority bands for v1:

* critical
* high
* normal
* low
* parked

### Hotfix rule

A confirmed user-facing critical bug or production issue may pre-empt normal queue order and interrupt active work immediately.

For less critical issues, the default is to finish the current implementation/review pass first, then switch.

### Anti-thrash rule

Do not switch active feature or epic unless:

* the active feature is blocked
* the user explicitly reprioritises
* a hotfix pre-empts normal order
* the current feature has reached a review boundary

### Automatic continuation

The system may continue automatically only when:

* the active feature remains ready
* no new user decision is required
* no architecture conflict is present
* the previous run ended with a structured summary
* the active feature is not classified as blocked

Default continuation preference:

* continue within the active epic by default
* stop at epic boundaries unless the user has explicitly asked for a broader build-through mode
* stop early whenever a blocker or decision boundary requires it

User-adjustable continuation preferences should be supported, for example:

* stop after every feature so the user can assess
* continue until the epic is complete
* continue until the release is complete unless blocked

### Stop conditions

Stop and return to the user when:

* a feature completes and the user's chosen continuation preference requires a stop there
* an epic completes and no broader continuation preference is active
* repeated implementation/review failure threshold is reached
* a scope change is required
* a UX or product tradeoff is required
* an architecture direction decision is required
* a security/privacy/destructive-operation concern is triggered
* the user introduces a new request
* intake confidence is too low

### User override rule

The user may explicitly override confidence-based hesitation and instruct the system to proceed with known assumptions.

This override should not apply to safety, security, privacy, or destructive-operation boundaries.
The foreman must be explicit about what is uncertain before accepting the override.

---

## Replacing a persistent feature pair

Default rule:

* replace the implementer/reviewer pair together, not singly

Reason:

* one-sided replacement often preserves stale interaction patterns
* pair replacement is cleaner when stagnation, drift, or quality plateau occurs

Single-role replacement is out of scope for v1 except in obvious crash/failure cases where one side is simply unavailable.

### Replacement triggers

Replacement should be considered when:

* repeated review cycles produce no meaningful improvement
* outcome quality remains poor despite nominal progress
* the pair drifts from feature intent or current repo state
* the feature is materially replanned
* a session/tool fails
* the user explicitly asks for fresh eyes

Default thresholds for v1:

* 2 failed review loops with no meaningful improvement -> pair replacement recommended
* 3 failed loops, or clear `feature too large` / wrong-shape evidence -> mandatory replan and user discussion

Replacement should be recommended by the foreman, not purely automatic.

---

## Memory boundary

The execution framework owns:

* lifecycle
* decomposition
* selection
* stop rules
* escalation
* notes/backlog/review/summary artefacts

`floe-mem` owns:

* optional indexed retrieval
* relationships/links
* memory continuity support

### If memory exists

Use it for:

* related summaries
* linked artefacts
* adjacent notes
* likely relevant context neighbours

Starter relation verbs for v1:

* `relates_to`
* `derived_from`
* `blocks`
* `supersedes`
* `promoted_to`
* `reviews`
* `summarises`

These should be treated as a small controlled starting set, not an invitation for freeform sprawl.

### If memory does not exist

The framework must still work using:

* repo structure
* delivery artefacts
* docs
* direct file/code search

---

## Implementation target

### Use native agent capabilities where possible

Do not build a heavy custom harness if normal coding agents plus Bun are enough.

Assume:

* the user can open a normal Codex / Copilot / Claude Code CLI
* Bun can be called from the repo

Use native capabilities for:

* agent/session spawning where available
* custom role prompts/skills
* model selection where supported
* permission/sandbox controls where supported

### Use Bun for deterministic operations

Use Bun scripts for:

* state reads/writes
* schema validation
* next-feature selection
* artefact creation/update
* summary/review/note writes
* consistency checks
* any deterministic repo mutation that should not depend on prompt quality

### Keep scripts invisible to normal users

Scripts should usually be called by skills/prompts, not by end users directly. The normal user experience should remain conversational.

---

## Build requirements

Build this as a drop-in repo package that can be adopted in a workspace/project and used from a normal coding agent CLI.

### Required outputs

At minimum, create:

* repo-local skills/prompts for foreman / planner / implementer / reviewer behaviour
* Bun scripts for deterministic state and artefact operations
* machine-readable schemas for release / epic / feature / note / review / summary / runtime state
* scaffold logic for the required repo structure
* integration points for optional `floe-mem`
* clear README/operator guidance for using the system from a normal agent CLI

### Non-goals

Do not build:

* a separate GUI here
* a daemon
* a custom long-running controller service
* a workflow database
* a replacement for the underlying coding agent CLIs

---

## Open questions to leave explicit

These should remain visible and not be silently decided by implementation:

* exact confidence thresholds
* exact JSON schema details
* exact runtime policy controls per tool
* exact future conditions for single-role replacement exceptions
* exact escalation path details for reviewer/implementer disagreement beyond the default tie-break to user

---

## Default v1 decisions

* Release is mandatory.
* Feature is the lowest durable execution unit.
* Tasks are ephemeral only in v1.
* Use feature-scoped persistent implementer/reviewer sessions where tooling allows.
* Persistent sessions are useful but never the source of truth.
* Use one file per durable object.
* Use `docs/`, `delivery/`, and `.ai/` as the main repo structure split.
* Use notes as a repo-local pre-planning inbox.
* Keep summaries and reviews separate.
* Use one rolling review object per active feature.
* Keep the foreman minimal-context and process-lane only.
* Default to epic-boundary stopping unless the user chooses a different continuation preference.
* Use simple priority bands only in v1.
* Use the default replacement thresholds of 2 no-improvement loops -> replacement recommended, 3 loops or clear wrong-shape evidence -> mandatory replan/user discussion.
* Allow user override of confidence-based hesitation except on safety/security/privacy/destructive boundaries.
* Treat note attachments as references/paths/URLs only in v1.
* Use the starter memory relation verbs defined in this handoff.
* Use Bun scripts as invisible deterministic plumbing beneath conversational agent behaviour.

