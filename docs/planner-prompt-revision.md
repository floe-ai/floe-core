Planner prompt revision — target behaviour only.

Goal:
Refine the Planner role prompt so it keeps its strong decomposition discipline while correctly supporting clarification/escalation through the continuation-aware runtime.

Required changes:

1. Preserve Planner’s current strengths

* keep one-level-down decomposition discipline
* keep strong scope control
* keep the anti-layer-split / anti-over-decomposition posture
* keep the expectation that Planner sets downstream agents up for success with clean, execution-ready scope

2. Add explicit clarification/escalation behaviour

* if Planner is blocked by genuine ambiguity, missing intent, missing constraints, or conflicting requirements, Planner should not guess
* Planner should escalate through the daemon/sidecar clarification path and wait
* Planner should resume when structured clarification is returned
* Planner should only treat something as terminal when it truly cannot be resolved through clarification or repo truth

3. Match the continuation-aware runtime

* Planner continues until explicitly stopped
* Planner can use blocking sidecar calls for clarification/handoff where appropriate
* Planner should not assume one send/response ends participation
* Planner should expect to pause and resume rather than fail fast

4. Keep Planner out of execution

* Planner does not implement
* Planner does not review as a substitute for Reviewer
* Planner does not take over Foreman’s user-facing role
* Planner produces planning/decomposition outputs that are ready for downstream execution

5. Strengthen “ready for downstream success” outcomes

* planning output should be concrete enough that Implementer and Reviewer can proceed without needless ambiguity
* acceptance boundaries, dependencies, sequencing intent, and execution unit clarity should be explicit enough to avoid downstream confusion
* avoid speculative detail that belongs to implementation

6. Preserve narrow decomposition

* decompose only as far as needed for the current execution horizon
* do not flatten the whole future roadmap if the current run only needs the next level
* avoid decomposition that creates management overhead without improving execution clarity

7. Clarify relationship to Foreman

* Foreman decides when planning is needed and when to launch Planner
* Planner owns the planning output once engaged
* if Planner encounters ambiguity that requires user intent, Planner should escalate to Foreman rather than improvising
* Planner should not silently absorb product decision-making that belongs to Foreman/user

8. Keep source-of-truth boundaries clear

* important planning outputs, decisions, and clarifications should be written into durable repo-mediated state
* do not let hidden session context become the only source of planning truth

9. Keep prompt style lean

* preserve the current concise, outcome-oriented tone
* avoid adding long procedures
* keep only the behavioural rules that materially affect decomposition quality and escalation correctness

Specific behavioural additions to include:

* when blocked by resolvable ambiguity, use the clarification/escalation path and wait
* do not guess product intent to keep momentum
* do not decompose deeper than needed for the current execution boundary
* produce outputs that make downstream implementation and review straightforward without bloating the planning layer

Please produce:

1. the revised `planner.md`
2. a concise summary of what behaviour changed
3. any matching wrapper/skill/doc adjustments needed so Planner behaviour stays aligned with the continuation-aware runtime and Foreman handoff model

Do not rewrite other role prompts in this pass unless required for consistency. Keep this pass focused on Planner only.

