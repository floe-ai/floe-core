# Floe Repository Layout Contract

This document defines source-of-truth boundaries for `floe-core`.

## Canonical Install Payload

Everything under `floe/` is installable product payload.

- `floe/roles/` is the canonical role source.
- `floe/skills/` is the canonical skill source.
- `floe/schemas/`, `floe/scripts/`, `floe/runtime/`, and `floe/bin/` are canonical runtime/tooling sources.
- `floe/SKILL.md` is an entrypoint that routes to canonical skill docs under `floe/skills/`.

Installer rule: `.floe/` in consumer repos must be derived from this tree.

## Non-Canonical Project Files

Anything outside `floe/` is repository build/support context unless explicitly documented.

- `scripts/` (repo root) contains installer and packaging logic.
- `agents/` is reference material for wrapper behavior and local development support only.
- `docs/` contains design docs and operating notes.

These directories are not copied wholesale into consumer `.floe/` installs.

## Skill Installation Contract

Provider-visible skills are installed as thin pointers only.

- Source of truth: `.floe/skills/<skill-name>/SKILL.md`
- Installed pointers:
  - Codex: `.agents/skills/<skill-name>/SKILL.md`
  - Copilot: `.github/skills/<skill-name>/SKILL.md`
  - Claude: `.claude/skills/<skill-name>/SKILL.md`

## Context Memory Contract

`context-memory` / `floe-mem` is external.

- `floe-core` must not install it.
- `floe-core` may detect and integrate with it when already present.
