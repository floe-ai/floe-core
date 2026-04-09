---
name: floe
description: Entry point for floe-core installed skills. Read this file first, then load the canonical skill docs in .floe/skills/.
---

# Floe Skill Entry Point

This file is the orchestration entry point for installed Floe skills.

Canonical skill definitions live under `.floe/skills/`:

- `.floe/skills/floe-exec/SKILL.md` — execution framework behaviour, scripts, artefacts, worker lifecycle
- `.floe/skills/sizing-heuristics/SKILL.md` — sizing heuristics shared across Foreman, Planner, Implementer, and Reviewer

Provider-visible skill wrappers installed by `scripts/install.ts` should point to the relevant file under `.floe/skills/<skill-name>/SKILL.md`.
