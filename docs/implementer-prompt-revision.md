Implementer prompt revision — target behaviour only.

Goal:
Refine the Implementer role prompt so it matches the continuation-aware runtime, reduces contradictory behaviour, and optimises for complete, runnable, testable outcomes without bloating the prompt.

Required changes:

1. Replace any “stop when blocked” framing with:

* continue until explicitly stopped
* when blocked by resolvable ambiguity, escalate through the daemon/sidecar clarification path and wait
* only treat something as terminal failure when it truly cannot be unblocked through clarification, recovery, or repo truth

2. Make the sidecar contract explicit in the role:

* use blocking sidecar calls for cross-worker coordination
* wait after blocking calls
* expect to resume later with structured responses
* do not assume one send/response ends participation

3. Keep the implementer in the execution lane:

* do not widen scope
* do not decompose beyond the assigned unit
* do not bypass pre-code alignment
* do not treat reviewer approval as optional

4. Strengthen outcome expectations:

* build for runnable end-user outcomes, not just code changes
* default toward the simplest executable path for the user
* reduce setup friction wherever reasonable
* prefer flows that let a user get running with minimal commands and guided setup when external configuration is needed
* treat developer experience and end-user operability as part of feature quality, not polish

5. Make live verification part of implementation intent:

* implementation is not complete just because code was written
* implementer should prepare the feature to be run and verified in practice
* when practical, leave the system in a state where reviewer can execute and validate behaviour directly
* do not rely on theoretical correctness

6. Keep source-of-truth boundaries clear:

* important coordination must be written back into repo artefacts / durable state
* do not rely on hidden chat as the project truth
* summaries, implementation state, and meaningful decisions should be durable

7. Align with repo-level Definition of Done:

* implement against the current DoD, not personal assumptions
* treat testability, runnability, and setup quality as first-class when the repo DoD requires them
* do not claim completion if DoD-relevant work is still missing

8. Keep prompt style lean:

* express desired outcomes and invariants
* avoid turning the prompt into a step-by-step checklist
* rely on model capability for normal engineering judgement
* only state the constraints that materially shape behaviour

Specific behavioural additions to include:

* when missing information is resolvable, use `request_foreman_clarification` and wait
* when handing work to reviewer, use the blocking review path rather than ad hoc conversational messaging
* after reviewer feedback, resume and continue rather than treating feedback as a stop condition
* if the feature depends on runnable setup, minimise user friction and make the setup flow clear and practical

Please produce:

1. the revised `implementer.md`
2. a concise summary of what behaviour changed
3. any matching wrapper/skill adjustments needed so the runtime and prompt stay aligned

Do not rewrite other role prompts in this pass unless required for consistency. Keep this pass focused on the Implementer only.

