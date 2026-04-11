# Floe Repository Layout Contract

This document defines source-of-truth boundaries for `floe-core`.

## Canonical Product Payload

Everything under `floe/` is the product engine — globally installed.

- `floe/roles/` is the canonical role source (floe, planner, implementer, reviewer).
- `floe/skills/` is the canonical skill source.
- `floe/schemas/`, `floe/scripts/`, `floe/runtime/`, and `floe/bin/` are canonical runtime/tooling sources.

These are loaded by the Floe runtime as part of its global config. They are not copied into each project.

## Non-Canonical Project Files

Anything outside `floe/` is repository build/support context unless explicitly documented.

- `scripts/` (repo root) contains installer and packaging logic.
- `docs/` contains design docs and operating notes.

## Skill Loading Model

Canonical Floe skills are part of the global Floe runtime. They are loaded by the runtime and available to agents automatically.

- Canonical skills: `floe-exec`, `floe-preflight`, `sizing-heuristics`
- Project-local overrides: `.floe/skills/<skill-name>/SKILL.md` — opt-in, completely replaces the global version for that project

Scripts and executables referenced by skills are part of the Floe runtime and are never duplicated per-project.

## Session ID Contract

Worker session IDs include the role as a prefix for log readability:

- Format: `<role>-<timestamp>-<random>`
- Example: `implementer-m5x8k2-a7b3c9`

## Context Memory Contract

`context-memory` / `floe-mem` is external.

- `floe-core` must not install it.
- `floe-core` may detect and integrate with it when already present.
