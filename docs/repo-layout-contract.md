# Floe Repository Layout Contract

This document defines source-of-truth boundaries for `floe-core`.

## Canonical Install Payload

Everything under `floe/` is installable product payload.

- `floe/roles/` is the canonical role source.
- `floe/skills/` is the canonical skill source.
- `floe/schemas/`, `floe/scripts/`, `floe/runtime/`, and `floe/bin/` are canonical runtime/tooling sources.

Installer rule: `.floe/` in consumer repos must be derived from this tree.

## Non-Canonical Project Files

Anything outside `floe/` is repository build/support context unless explicitly documented.

- `scripts/` (repo root) contains installer and packaging logic.
- `docs/` contains design docs and operating notes.

These directories are not copied wholesale into consumer `.floe/` installs.

## Skill Installation Contract

Provider-visible skills are installed as **full text copies** of the canonical SKILL.md.

- Source of truth: `.floe/skills/<skill-name>/SKILL.md`
- Installed copies (full content, not pointer stubs):
  - Codex: `.agents/skills/<skill-name>/SKILL.md`
  - Copilot: `.github/skills/<skill-name>/SKILL.md`
  - Claude: `.claude/skills/<skill-name>/SKILL.md`

Installable skills: `floe-exec`, `floe-preflight`, `sizing-heuristics`.

Scripts and executables referenced by skills remain canonical under `.floe/` and are **not** duplicated into provider folders.

## Agent Wrapper Contract

Provider agent wrappers are **thin headers only** — they identify the Foreman role and point to `.floe/roles/foreman.md`. All behavioural content lives in the canonical role file.

## Session ID Contract

Worker session IDs include the role as a prefix for log readability:

- Format: `<role>-<provider>-<timestamp>-<random>`
- Example: `implementer-copilot-m5x8k2-a7b3c9`

## Context Memory Contract

`context-memory` / `floe-mem` is external.

- `floe-core` must not install it.
- `floe-core` may detect and integrate with it when already present.
