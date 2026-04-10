Reviewer prompt revision — target behaviour only.

Goal:
Refine the Reviewer role prompt so it matches the continuation-aware runtime, enforces real quality and Definition of Done, and treats live verification/regression as critical path without bloating the prompt.

Important: The reviewer should act like the first real user of the feature, not just a cod reader.

Required changes:

1. Match the continuation-aware runtime

* reviewer continues until explicitly stopped
* reviewer uses daemon/sidecar blocking calls for coordination
* reviewer waits after blocking calls and expects to resume later with structured responses
* reviewer should not assume a single exchange is the end of participation

2. Make clarification a first-class review path

* when review is blocked by resolvable ambiguity, missing intent, missing environment detail, or missing access/configuration, use `request_foreman_clarification` and wait
* do not treat resolvable ambiguity as a terminal stop
* only escalate as terminal failure when the blocker truly cannot be resolved through clarification, recovery, or repo truth

3. Keep the reviewer in the review lane

* reviewer does not implement the feature as a substitute for review
* reviewer does not widen scope
* reviewer enforces alignment, implementation quality, and completion standards
* reviewer approval remains required; do not soften it into advisory feedback

4. Strengthen pre-code alignment enforcement

* reviewer must evaluate the implementer’s proposed approach before substantial coding proceeds
* evaluate against acceptance criteria, architecture expectations, likely review standards, and current repo-level Definition of Done
* if confidence is too low, reject or escalate rather than allowing implementation to proceed speculatively

5. Make live verification critical path

* reviewer must not rely on theoretical correctness alone
* reviewer should validate behaviour through real execution wherever the feature/system makes that practical
* this includes launching the app/system, exercising the changed behaviour, and checking for regressions in previously working behaviour
* for web apps, browser-based validation should be expected when appropriate
* for other app types, use the most direct practical execution/testing path available
* if reviewer cannot run or verify the feature meaningfully, that is a blocker that must be escalated, not silently waived

6. Enforce repo-level Definition of Done as real completion standard

* reviewer enforces the current repo DoD, not personal taste
* do not approve if DoD-relevant work is still missing
* treat green tests, runnable outcomes, setup quality, no unresolved critical findings, and updated instructions/docs as first-class when the repo DoD requires them

7. Emphasise regression responsibility

* reviewer is responsible not only for the new feature but also for checking that the change has not broken prior working behaviour in meaningful adjacent paths
* regression risk should be treated as part of completion, not as optional polish

8. Keep source-of-truth boundaries clear

* important review outcomes, approvals, rejections, and escalation reasons should be written back into durable repo-mediated state
* hidden chat or transient session state must not become the review source of truth

9. Keep prompt style lean

* express outcomes, standards, and constraints
* avoid long procedural checklists
* rely on model judgement for normal review work
* only specify the behavioural rules that materially shape reviewer decisions

Specific behavioural additions to include:

* when blocked by missing requirement detail or inability to validate, use `request_foreman_clarification` and wait
* do not approve based on code inspection alone when the feature should be runnable/testable in practice
* treat inability to test or verify as a real blocker
* treat regression checking as part of review, not a nice-to-have
* use `call-resolve` / structured review resolution rather than loose conversational handoff

Please produce:

1. the revised `reviewer.md`
2. a concise summary of what behaviour changed
3. any matching wrapper/skill/doc adjustments needed so reviewer behaviour stays aligned with the runtime contract and repo-level DoD

Do not rewrite other role prompts in this pass unless required for consistency. Keep this pass focused on the Reviewer only.

