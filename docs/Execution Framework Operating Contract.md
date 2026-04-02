# Execution Framework Operating Contract

## Purpose

Define the minimum operating rules for a thin, repo-local execution framework that works with fresh coding agents, uses memory as an independent sidecar when available, and supports ongoing product discovery without collapsing into orchestration bloat.

This document focuses on:

* work selection
* lifecycle transitions
* stop and continue rules
* escalation classes
* role responsibilities
* integration points with memory
* machine-readable backlog and artefact structure

It does **not** define REPL, UI, or custom backend services.

---

## 1. Core principles

### 1.1 Source of truth

Repo-local artefacts are the source of truth.

Chat history is not the source of truth.
Memory summaries are not the source of truth.
Memory is a retrieval and continuity aid when present.

The system must still function without memory. In that case, it falls back to:

* structured repo-local artefacts
* file links and relationships
* direct repo search
* targeted code and document inspection

### 1.2 Breadth-first decomposition

The system must decompose only one level deeper when the parent item becomes active.

Default hierarchy:

* PRD
* Release
* Epic
* Feature

No level in the hierarchy is optional in the operating model. Every lower-level item must align upward through the chain to the release and PRD intent.

Breadth-first must be implemented as **just-in-time decomposition**, not vague intent.

That means:

* a release is decomposed into epics only when the release becomes the active delivery focus
* an epic is decomposed into features only when the epic becomes active
* a feature is refined for execution only when it becomes the active feature
* no level should be exhaustively decomposed far ahead of likely execution unless explicitly requested by the user

The purpose of just-in-time decomposition is to:

* reduce stale planning
* preserve flexibility for changing user intent
* force refinement closer to execution reality
* keep architecture and review thinking aligned with current scope rather than speculative future scope

### 1.3 Execution-ready unit

Only **features** are durable execution-ready units in version 1.

Releases and epics must never be given directly to implementers as concrete coding instructions.

A feature must be small and concrete enough to:

* execute through a bounded implementation/review loop
* survive handoff or replacement if agents die
* be validated against acceptance criteria
* be resumed from repo-local state

Any lower-level breakdown used by a coding agent should be treated as ephemeral working structure unless the framework later chooses to materialise it.

### 1.4 Foreman is a role, not a permanent agent

The visible agent the user talks to may be Codex, Copilot, Claude, or another coding agent.

This framework does **not** assume a dedicated always-on foreman agent.
It assumes that the active user-facing agent can take on the **foreman role** through skills, prompts, and repo-local operating rules.

The foreman role is responsible for routing work, choosing mode, persisting outputs, deciding whether to continue or stop, and enforcing lifecycle rules.
It is not the long-term project memory or primary implementation brain.

The foreman should understand only enough to route safely.
It should know the structure of the work and the current process state, not load deep product, architecture, or code context unless that is required to resolve routing ambiguity or detect misalignment.

### 1.5 Agent-native planning must be accounted for

Most coding agents have their own planning behaviour, plan mode, or to-do system. These plans may be stored outside the repository in tool-specific locations.

The execution framework must assume this behaviour exists and must define how it interacts with repo-local planning.

Rule:

* agent-native plans may be used as temporary working memory
* durable project planning must be persisted into repo-local, machine-readable backlog artefacts
* no critical execution state may live only in an external agent plan file

If an agent creates an external plan, the framework must either:

* convert it into repo-local backlog items and structured artefacts, or
* bypass it by using framework-defined planning skills that write directly to repo state

### 1.6 Bounded specialists

Planner, implementer, and reviewer behaviours must be bounded and narrow.

### 1.7 Feature-scoped persistent sessions

The preferred execution model is feature-scoped persistence:

* one implementer session persists for the life of the active feature
* one reviewer session persists for the life of the active feature
* they iterate until the feature passes, blocks, is replanned, or is interrupted

However, persistent sessions are not the source of truth.

If either session dies, stalls, or is replaced, the feature must still be resumable from:

* repo-local artefacts
* structured summaries
* machine-readable state
* memory, when available

### 1.8 Interruptibility

The system must support interruption, reprioritisation, and new feature intake without corrupting the backlog structure.

### 1.9 Machine-readable first

Backlog items, status records, summaries, and lifecycle artefacts must be stored in machine-readable formats suitable for future UI overlays and dashboards.

JSON should be treated as the default format unless there is a strong reason otherwise.

### 1.10 Visibility split

The framework should distinguish between:

* human/project-facing artefacts
* agent/runtime-facing state

Human/project-facing artefacts should live in visible repo folders such as `docs/` and `delivery/`.

Agent/runtime-facing state should live under `.ai/`.

Rule of thumb:

* if it matters to project history, planning, review, or human understanding, store it in `docs/` or `delivery/`
* if it is operational runtime state, active pointers, transient control data, or agent coordination state, store it under `.ai/`

---

## 2. Modes

### 2.1 Initialise

Used for:

* greenfield setup
* brownfield adoption
* missing or damaged repo-local system files

Responsibilities:

* detect repo state
* scaffold repo-local structure
* detect memory package
* create or repair project artefacts
* create an initial project map when needed
* establish machine-readable storage layout
* initialise runtime state under `.ai/`

Initialisation should occur when the workflow transitions from planning into real implementation, not merely because the user brainstormed in the repo.

### 2.2 Discover

Used when the user introduces:

* new feature ideas
* refinements
* bugs
* UX issues
* architecture concerns
* priority changes

Responsibilities:

* clarify intent
* inspect relevant artefacts and memory if available
* classify the request
* measure confidence in the classification
* split combined requests into distinct backlog items when needed
* update or create the correct backlog object
* record scope and architecture impact

No implementation should happen here except for trivial local fixes that clearly do not need backlog handling.

### 2.3 Plan

Used when an active parent item needs decomposition one level down.

Responsibilities:

* Release -> Epics
* Epic -> Features
* attach acceptance criteria, constraints, likely files, subsystem hints, and test hints
* convert any temporary agent-native plan into durable repo-local artefacts
* ensure the active feature is execution-ready
* perform the level-appropriate architecture and review considerations before allowing deeper refinement

Planning must remain just-in-time. The planner should refine only the currently active branch, not the entire future tree.

### 2.4 Execute

Used when there is an active feature.

Responsibilities:

* build or load feature context bundle
* retrieve targeted memory/context if available
* start or resume feature-scoped implementation and review sessions
* inspect code and tests
* perform bounded implementation/review iterations
* verify outcome
* write structured run summaries
* update status

### 2.5 Review

Used when:

* a feature completes
* an epic completes
* repeated failure occurs
* uncertainty or conflict appears
* a user decision is required

Responsibilities:

* summarise state
* classify blocker or completion
* decide continue vs stop
* trigger replanning when required
* perform broader holistic review at epic boundaries

---

## 3. Repo-local storage layout

### 3.1 Human/project-facing folders

Suggested visible repo structure:

* `docs/prd/`
* `docs/architecture/`
* `docs/decisions/`
* `delivery/notes/`
* `delivery/releases/`
* `delivery/epics/`
* `delivery/features/`
* `delivery/reviews/`
* `delivery/summaries/`

### 3.2 Agent/runtime-facing folders

Suggested runtime structure:

* `.ai/memory/`
* `.ai/state/`

### 3.3 File granularity

Use one file per durable object.

Examples:

* one release per file
* one epic per file
* one feature per file
* one note per file
* one review per file
* one summary per file

This is preferred over large collection files because it improves:

* smaller agent reads
* cleaner diffs
* easier partial updates
* lower merge friction
* future UI indexing

### 3.4 Runtime state

Runtime state in `.ai/state/` should include active pointers and operational state such as:

* active release
* active epic
* active feature
* current mode
* current blocker if any
* session metadata if needed

Runtime state must not become the only source of durable truth.
If the information matters to project history or review, it must also exist in `docs/` or `delivery/`.

---

## 4. Work item model

### 4.1 Level definitions

#### PRD

The product intent and overall vision for the project.

It defines what is being built, for whom, why, and what constraints or non-goals apply.

#### Release

The highest level of targeted delivery work.

A release represents what is intended to be shipped or delivered to the user as a coherent outcome. Even small projects must have at least one release, though that release may be thin.

Every epic and feature must align upward to a release. If a proposed change does not align to any release, the system must question whether the release or product vision is changing.

#### Epic

A coherent capability area or major stream of work inside a release.

An epic groups related features that together contribute to a meaningful part of the release.

#### Feature

A user-visible or system-visible capability inside an epic.

A feature is the lowest durable execution unit in version 1.
It defines a concrete behaviour or outcome that can be validated and executed through repeated implementation/review runs.

A feature should be small enough that one feature remains the active focus for a bounded implementation and review loop.

#### Task

Tasks are not durable backlog items in version 1.

A coding agent may create ephemeral internal to-dos or plan steps while executing a feature, but these do not form part of the durable repo-local backlog unless the framework later chooses to materialise them.

### 4.2 Required fields by level

#### Release

* id
* title
* status
* intent
* priority
* dependencies
* acceptance criteria

#### Epic

* id
* parent release id
* title
* status
* intent
* priority
* dependencies
* acceptance criteria
* subsystem hints

#### Feature

* id
* parent epic id
* title
* status
* behaviour
* priority
* dependencies
* acceptance criteria
* file hints
* test hints
* execution state
* review state

### 4.3 Statuses

Shared statuses should be kept simple.

Suggested baseline:

* draft
* active
* blocked
* completed
* cancelled

More granular states may exist internally if needed by tooling, but durable repo-local state should avoid unnecessary workflow clutter.

---

## 5. Intake and change classification

Every user request that could affect project behaviour must be classified as one or more of:

* bug fix
* UX refinement
* feature extension
* net-new feature
* architectural change
* research spike
* backlog correction
* priority change

Classification determines:

* where the work lands in hierarchy
* whether it can go straight to execution
* whether architecture review is required
* whether active execution must pause

### 5.1 Confidence rule

The system must attach a confidence judgement to its intake classification.

If confidence is not high enough, it must:

* ask clarifying questions
* propose multiple interpretations
* or split the request into separate candidate items

### 5.2 Mixed-request rule

If a user request contains multiple distinct concerns, such as:

* a bug report plus a feature idea
* a UX complaint plus an architectural concern
* a refinement plus a priority change

then the system must split those into distinct intake items rather than collapsing them into one vague request.

### 5.3 Intake rule

No non-trivial user request may bypass discovery and be injected straight into execution.

### 5.4 Release alignment rule

If a new request does not clearly fit within an existing release, the system must explicitly ask whether:

* the release intent is expanding
* a new release is needed
* or the request should be rejected or deferred as out of scope

---

## 6. Work selection policy

### 6.1 Goal

Select the next safest, highest-value, execution-ready unit without relying on vague judgement.

### 6.2 Selection order

The selector should choose the next item using this order:

1. only consider features in active epics within the active release
2. exclude items with unsatisfied dependencies
3. prefer continuation of the currently active feature over switching context
4. prefer highest priority among ready features
5. then prefer features in the currently active epic
6. then prefer oldest ready feature at the same priority

### 6.3 Priority bands

Priority approach remains open for discussion.

Initial working bands:

* critical
* high
* normal
* low
* parked

Numeric scoring may be introduced later if needed.

### 6.4 Hotfix rule

A confirmed user-facing bug or production issue may pre-empt normal queue order and create or activate an immediate feature.

### 6.5 Anti-thrash rule

Do not switch active feature or epic unless:

* the active feature is blocked
* the user explicitly reprioritises
* a hotfix pre-empts normal order
* the current feature has reached a review boundary

### 6.6 Single execution stream

Version 1 should support only one active execution stream by default.
Parallel implementers should not be enabled by default.

---

## 7. Level breakdown, architecture, and readiness rules

### 7.1 Level breakdown rules

#### Release -> Epic

When a release becomes active, the system should derive the minimum set of epics needed to express the main delivery streams inside that release.

Release-level breakdown should answer:

* what major capability areas must exist to deliver this release?
* what broad sequencing or dependency constraints exist?
* what system-wide architecture concerns must already be visible?

Release breakdown should not try to define implementation detail.

#### Epic -> Feature

When an epic becomes active, the system should derive only the features needed to move that epic forward.

Epic-level breakdown should answer:

* what concrete capabilities or behaviours make up this epic?
* how do these fit within the release intent and broader application architecture?
* what interfaces, subsystems, or cross-cutting concerns are likely to be affected?

Epic breakdown is where forest-for-trees thinking must be strongest.
It must ensure that feature plans reflect the broader application shape, not just local convenience.

#### Feature refinement

When a feature becomes active, the system should refine it only enough to execute safely.

Because tasks are not durable in version 1, feature refinement should produce:

* clear acceptance criteria
* execution constraints
* architecture considerations
* likely implementation surfaces
* likely verification surfaces
* any ephemeral internal steps the agent may need

Feature refinement must not silently become full-project re-planning.

### 7.2 Architecture considerations by level

#### Release architecture consideration

At the release level, the system should consider:

* overall application shape
* major subsystem boundaries
* deployment or delivery implications
* cross-cutting concerns such as auth, data flow, state, performance, security, and observability
* whether the release still aligns to the PRD vision

Release-level architecture review is broad and directional, not implementation-specific.

#### Epic architecture consideration

At the epic level, the system should consider:

* how this epic fits into the existing system architecture
* which subsystems it touches
* whether it creates tension with existing architectural decisions
* whether shared patterns or interfaces need to be respected or revised
* whether this epic introduces cross-feature coordination needs

Epic-level architecture consideration is the main place where global application coherence is protected.

#### Feature architecture consideration

At the feature level, the system should consider:

* what local parts of the system will change
* what interfaces and contracts are affected
* what existing architectural rules constrain implementation
* whether implementation pressure suggests the feature is too large or badly shaped

Feature-level architecture consideration should be concrete and execution-oriented.

### 7.3 Review styles by level

#### Feature review

Feature review asks:

* did this feature satisfy its acceptance criteria?
* does it behave correctly from a user and system perspective?
* are there obvious regressions in the touched area?
* does it still fit the architectural expectations already defined above it?

Feature review is local, concrete, and adversarial.
It should catch incomplete implementation, hidden regressions, and local mismatches.

#### Epic review

Epic review asks:

* do the completed features combine into a coherent capability?
* did we miss anything that no single feature review would have caught?
* is the user experience coherent across the epic?
* does the epic still fit the intended architecture and standards as a whole?
* are there edge cases, integration gaps, or coordination failures across features?

Epic review is holistic. It is the main forest-for-trees checkpoint.

#### Release review

Release review asks:

* did the release deliver the intended user outcome?
* does the overall system feel coherent and shippable?
* were important concerns missed because work was too locally focused?
* does the delivered release still match the PRD or approved evolution of it?

Release review is outcome- and delivery-oriented.

---

## 8. Dependency and readiness rules

### 8.1 Dependencies

Every level may declare dependencies.

A work item is not ready if any hard dependency is incomplete.

### 8.2 Readiness conditions

A feature is ready for execution when:

* it belongs to an active epic
* its behaviour and acceptance criteria are concrete
* dependencies are satisfied
* likely files, tests, or relevant surfaces are identifiable
* no unresolved product decision blocks it
* no unresolved architecture decision blocks it

An epic is ready for feature decomposition when:

* it belongs to an active release
* its intent and boundaries are clear enough
* upstream product direction is approved

A release is ready for epic decomposition when:

* its delivery outcome is clear enough
* its intent aligns with the PRD
* major scope boundaries are known

---

## 9. Stop and continue rules

### 9.1 Continue automatically when

The system may continue automatically only when all of the following hold:

* the active feature remains ready
* no new user decision is required
* no architecture conflict is present
* the previous implementation or review run ended with a structured summary
* the active feature is not classified as blocked

### 9.2 Stop and return to the user when

The system must stop when:

* a feature completes
* an epic completes
* repeated implementation/review failure threshold is reached
* a scope change is required
* a UX or product tradeoff is required
* an architecture direction decision is required
* a security, privacy, or destructive-operation concern is triggered
* the user introduces a new request
* intake confidence is too low to proceed safely

### 9.3 Failure threshold

Failure threshold should be treated as a policy, not a rigid law.

Initial working rule:

* repeated blocked or failed runs on the same feature trigger review
* repeated failure in the same epic area triggers replanning

The user may explicitly override and accept lower confidence or partial certainty if the risks are made clear.

---

## 10. Failure classification

Every blocked or failed run should classify itself as one of:

* missing context
* ambiguous requirement
* architecture conflict
* environment issue
* flaky test
* dependency not ready
* feature too large
* implementation error
* unexpected regression

This classification determines whether the system:

* retries within the active feature loop
* replans the feature
* escalates
* pauses for human input

If the classification is `feature too large`, the system should not automatically spawn durable sub-items by default. It should discuss the path forward with the user or propose options.

---

## 11. Scope protection

### 11.1 Implementer scope rule

Implementers may only change what is required to complete the active feature safely.

### 11.2 Widening rule

If broader changes are required for correctness, the implementer must:

* record the need clearly
* either escalate for replanning or create follow-up work
* avoid silently absorbing adjacent backlog

---

## 12. Testing policy

### 12.1 Execution-time testing order

Default order:

1. run the smallest relevant local verification first
2. run feature-local tests
3. run feature-local smoke or regression checks if needed
4. run broader checks only when touched surface or failures justify it

### 12.2 Avoid waste

Do not run broad full-suite tests by default on every small feature unless the repo or change type demands it.

### 12.3 Fresh-eyes effect

Fresh runs naturally provide partial review because each implementation or review pass re-orients to the feature area and validates assumptions against current reality.

This does not remove the need for broader review at major boundaries such as epic completion.

### 12.4 Persistent feature pair

The preferred v1 model is a persistent feature-scoped pair:

* one implementer session for the active feature
* one reviewer session for the active feature

They may iterate multiple times until the feature passes or is blocked.

If either session fails or is replaced, the feature must still be resumable from durable state.

---

## 13. Reviews and summaries

### 13.1 Distinct roles

Summaries and reviews are separate artefact classes.

A summary is a durable record of:

* what happened
* what changed
* what was learned
* what the next agent should know

A review is a structured evaluative record of:

* whether the work currently passes
* what findings remain
* what corrective action is required
* whether work may continue

### 13.2 Summary behaviour

Summaries are long-lived and are expected retrieval targets for future agents.

They should be used for:

* handoff
* continuity
* lessons learned
* future guidance

### 13.3 Review behaviour

Reviews are first-class artefacts, but have a shorter operational half-life than summaries.

They should be treated as:

* active judgement records while work is under review
* structured gates for pass/fail/block decisions
* inputs that may emit durable consequences such as summaries, decisions, or backlog changes

Resolved reviews should remain stored for traceability, but retrieval should heavily prefer:

* open reviews over resolved reviews when actively working a feature
* summaries over resolved reviews when seeking historical guidance

### 13.4 Review lifecycle

A review should not be treated as mere feature state.
It needs its own structured record because state alone cannot capture:

* specific findings
* repeated review loops
* what was fixed
* what is still contested
* why a feature was blocked or passed

Suggested statuses:

* open
* resolved
* superseded

### 13.5 Rolling review model

Version 1 should prefer one rolling review object per active feature rather than creating a new review artefact for every pass.

That rolling review may be updated across multiple review cycles until the feature passes, blocks, or is replanned.

This keeps noise lower while preserving explicit findings and gatekeeping.

### 13.6 Suggested review structure

Suggested machine-readable review shape:

* id
* target_type
* target_id
* status
* outcome
* findings
* required_actions
* severity
* reviewer_session_id optional
* created_at
* updated_at
* resolved_at optional
* linked_summary_ids optional

Suggested `outcome` values:

* pass
* fail
* blocked
* needs_replan

### 13.7 Relationship between reviews and summaries

Implementation or review runs should usually emit summaries.

Reviews should exist to evaluate and gate progress.
When a review raises a larger point, its durable consequence should usually be one of:

* a summary lesson
* a decision
* a backlog change
* a note

## 14. Notes inbox / pre-planning capture

### 13.1 Purpose

The framework should include a repo-local notes inbox for ideas that are not yet backlog-ready.

This inbox exists to capture:

* emerging ideas
* inconsistent or exploratory user thoughts
* concerns or contradictions
* useful references, links, screenshots, or examples
* questions worth revisiting later

Notes are distinct from backlog items.
They do not imply approval, readiness, or commitment.

### 13.2 Capture triggers

The foreman role should capture notes when:

* the user explicitly asks to remember, capture, or store something
* the user expresses an emerging idea that may matter later
* the user is exploring or contradicting themselves in a way that may be useful to revisit
* a reference, image, or example is introduced that may inform later planning

If uncertain whether a thought should be captured, the foreman may ask a lightweight question such as whether the user wants the idea stored for later.

### 13.3 Notes are not stored as raw blobs by default

The system should avoid storing notes as unstructured raw dumps when possible.

Instead, notes should be lightly structured so they remain retrievable and useful later.
The original wording or source material may still be preserved as an attachment or raw field when helpful.

### 13.4 Suggested note structure

Suggested machine-readable shape:

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

Suggested `kind` values:

* idea
* concern
* contradiction
* question
* reference
* observation

Suggested `status` values:

* captured
* reviewed
* promoted
* discarded

### 13.5 Promotion rule

A note may later be promoted into a release, epic, feature, decision, or other structured artefact when it becomes coherent enough.

Promotion should create explicit linkage between the promoted artefact and the original note.

### 13.6 Relationship and retrieval

Notes should be retrievable during planning and intake.

When memory exists, notes may be indexed separately from more formal summaries or artefacts, and linked generically to related records.

The important distinction is:

* notes are exploratory inputs
* memories are continuity and retrieval aids
* backlog artefacts are approved structured work

Relevant notes should be surfaced organically when:

* the user discusses related topics
* intake is shaping new work
* planning is breaking work down
* the user explicitly asks to revisit prior ideas

The system should not wait only for explicit recall requests if a related note is clearly useful to the current discussion.

### 13.7 Behavioural rule

The foreman should be proactive about capturing potentially important emerging ideas, but should avoid over-capturing every passing comment.

If the value of capture is unclear, the foreman may confirm with the user.

When related notes are likely to improve intake, planning, or user alignment, the foreman or planner should surface them naturally as part of the conversation.

---

## 15. Memory integration contract

The execution framework owns:

* lifecycle
* decomposition
* selection
* stop rules
* escalation

The memory system owns:

* indexed documents
* stored memories and summaries
* relationship traversal
* retrieval support

### 14.1 Optional dependency

Memory is optional.

If memory is absent, execution still functions using repo-local artefacts, structure, links, and targeted search.

### 14.2 Query pattern

When memory exists, the harness should ask memory for:

* the active feature
* parent items
* linked decisions and related artefacts
* recent summaries in the same area
* likely code or document neighbours

### 14.3 Write-back pattern

After each implementation or review run, the harness should:

* write structured run summary
* register summary with memory if memory exists
* create generic links between summary, active feature, touched artefacts, and related records when supported

---

## 16. Role responsibilities

### 15.1 Foreman role

The foreman role is the user-facing control layer of the execution framework.

It should not act as the long-term memory, implementation brain, hidden source of truth, or deep product owner. Its job is to keep the system correctly oriented, convert conversation into durable artefacts, and decide when to continue or stop.

The foreman should be explicit about confidence, assumptions, and why it is choosing a given next action.

The foreman must stay in the process lane.
It should use the minimum context required to classify, route, and enforce boundaries. Deep product, architecture, and code understanding should be delegated to downstream roles unless required to resolve routing ambiguity or detect structural misalignment.

#### 15.1.1 State and mode management

Responsibilities:

* detect current repo state
* detect whether the framework is already present
* detect current mode
* detect whether the user is continuing existing work, changing direction, or introducing new work
* verify active release, epic, and feature state before routing
* perform a first-turn startup check in every fresh chat before taking substantive action

The foreman should act as a state recogniser before acting as a planner.

##### First-turn startup behaviour

On the first substantive user turn in a chat, the foreman must:

* inspect repo/framework state
* inspect active release, epic, and feature pointers
* detect whether runtime state is missing, stale, or inconsistent
* classify the user message as continuation, intake, setup, interruption, or general brainstorming
* choose mode before taking further action

##### Startup minimalism rule

The foreman should do the minimum startup inspection needed to safely orient itself.
It should not re-analyse the whole project, broad codebase, or memory store unless that is required to route safely.

#### 15.1.2 Intake and scope control

Responsibilities:

* classify incoming requests
* split mixed requests when needed
* measure confidence in classification
* push back when a request does not align with the active release or known product direction
* prevent non-trivial work from bypassing discovery

The foreman should protect the structure from becoming muddy or contradictory.

#### 15.1.3 Artefact and note conversion

Responsibilities:

* convert conversation into durable repo-local artefacts
* decide whether input should become a note, a release update, an epic, a feature change, a review action, or a summary consequence
* prefer updating existing artefacts over creating duplicates
* proactively capture important emerging ideas into the notes inbox when appropriate

The foreman is responsible for converting messy conversation into machine-readable working state.

#### 15.1.4 Execution orchestration

Responsibilities:

* determine when a feature is ready to enter execution
* start or resume feature-scoped implementation and review sessions
* keep those sessions running while productive
* replace or reset them when they stop being productive
* decide when execution may continue automatically versus when it must stop
* ensure active execution has the minimum durable artefacts needed for resumability before handoff

The foreman controls the execution loop without becoming the implementation agent.

#### 15.1.5 Boundary and stop enforcement

Responsibilities:

* prevent mode bleed, such as discovery quietly becoming execution
* stop refinement when uncertainty is no longer decision-critical for the current level
* enforce review and replanning boundaries
* stop for user decisions when scope, UX, architecture, safety, or confidence thresholds require it
* guard against artefact sprawl and duplicate structure
* surface contradictions between the user's current request and the active release or current delivery direction

The foreman should seek sufficient clarity for the current mode, not perfect clarity.

##### Good-enough rule by mode

* discover is good enough when the next structural action is clear
* plan is good enough when the next level down is coherent enough to create durable artefacts
* execute may begin when remaining uncertainty is non-critical to safe feature execution
* review is good enough when continue, stop, block, or escalate is clear

#### 15.1.6 User-facing transparency

Responsibilities:

* keep the user oriented about mode, active item, and current direction
* be explicit about confidence and assumptions
* explain why the system is proceeding, pausing, or escalating
* surface related notes or prior context when they are clearly helpful
* keep startup and routing behaviour mostly quiet internally, while surfacing only the minimum useful orientation externally

The foreman should feel clear and trustworthy, not magical or opaque.

### 15.2 Planner role

Responsibilities:

* decompose exactly one level down
* maintain hierarchy quality
* attach constraints and hints
* avoid over-decomposition
* convert planning output into machine-readable backlog items
* ensure features are small enough to be execution-ready
* perform the deeper product and architecture shaping that the foreman intentionally avoids

### 15.3 Implementer role

Responsibilities:

* execute one active feature through bounded runs
* retrieve targeted context
* inspect code and tests
* implement safely
* verify and summarise
* persist feature-level continuity

### 16.4 Reviewer role

Responsibilities:

* evaluate acceptance criteria satisfaction
* classify blockers and regressions
* decide continue vs stop recommendation
* maintain the rolling review object for the active feature
* perform broader review at epic boundaries when invoked
* persist review continuity for the active feature

Review does not need to be a permanently separate role at every level. It should be invoked when the boundary or risk level justifies it.

---

## 17. Brownfield adoption rules

When adopting an existing repo:

* create only enough structure to support the next safe unit of work
* do not attempt full archaeology by default
* create an initial project map and minimum viable backlog slice
* defer deeper modelling until needed
* convert any useful discovered plans or notes into durable repo-local artefacts

---

## 18. Safety boundaries

The system must stop and seek confirmation before:

* destructive bulk file deletion
* risky migration or irreversible schema change
* secrets, config, or security-sensitive changes with unclear intent
* deployment-impacting changes outside the active feature scope

---

## 19. Open decisions to settle

1. Do we keep priority bands only, or add numeric scoring later?
2. What exact selector logic should apply when priorities tie across active branches?
3. What exact confidence threshold should trigger mandatory clarification at intake?
4. What exact repeated-failure threshold should trigger forced replanning?
5. What exact canonical relation verbs should the harness emit into memory?
6. What exact machine-readable file layout should backlog, summaries, and state use in the repo?
7. To what extent should framework skills override or adapt each vendor's native planning mechanism?
8. Under what exact conditions should a persistent feature session be killed and replaced?
9. Do we want note attachments and images in v1 or later?
10. Should reviews and summaries stay separate artefact types or should one subsume the other?
11. Under what exact conditions should the foreman inspect stale or inconsistent runtime state more deeply instead of routing immediately?

## 20. Proposed default answers for v1

* Release is mandatory.
* Use machine-readable repo-local artefacts by default.
* Memory is optional but supported.
* Keep a single execution stream.
* Feature is the lowest durable execution unit.
* Use feature-scoped persistent implementation and review sessions where tooling allows.
* Persistent sessions are allowed but are never the source of truth.
* Keep statuses simple: draft, active, blocked, completed, cancelled.
* Do not auto-spawn durable sub-items for `feature too large` by default.
* Use review as an invoked role at meaningful boundaries, especially epic completion.
* Keep a small canonical relation verb set later, once the memory-integration contract is defined.
* Keep notes repo-local and lightly structured.
* Keep reviews and summaries as separate artefact classes.
* Prefer one rolling review object per active feature in v1.
* Foreman should use minimal context and stay in the process lane.
* Foreman should perform a first-turn startup check in fresh chats before substantive action.
* Foreman should seek sufficient clarity for the current mode, not perfect clarity.

