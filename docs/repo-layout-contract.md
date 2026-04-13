# Floe Repository Layout Contract

This document defines source-of-truth boundaries for `floe-core`.

## Global Engine (`floe/`)

Everything under `floe/` is the product engine — globally installed.

| Path | Owns |
|------|------|
| `floe/bin/` | CLI entrypoint (`floe.ts`), daemon process (`floe-daemon.ts`) |
| `floe/roles/` | Canonical role definitions (floe, planner, implementer, reviewer) |
| `floe/skills/` | Canonical skill definitions (floe-exec, floe-preflight, sizing-heuristics) |
| `floe/schemas/` | JSON schemas for all durable artefact types |
| `floe/scripts/` | Deterministic Bun scripts for state/artefact operations |
| `floe/runtime/daemon/` | Daemon service, event store, feature workflow engine, persistent socket transport |
| `floe/runtime/substrate/` | Pi session substrate — sole session host for all worker sessions |
| `floe/runtime/registry.ts` | Session registry (in-memory + persistent) |

These are loaded by the Floe runtime from the global install location. They are **not** copied into each project.

## Project-Local State (`.floe/`)

Running `floe init` (or first `floe` run) creates minimal project-local state:

| Path | Purpose | VCS |
|------|---------|-----|
| `.floe/config.json` | Project configuration (model settings, srcRoot, overrides) | Committed |
| `.floe/dod.json` | Project-level definition of done | Committed |
| `.floe/state/` | Runtime state (sessions, daemon, events) | Gitignored |
| `.floe/roles/` | (optional) Project-local role overrides | Committed |
| `.floe/skills/` | (optional) Project-local skill overrides | Committed |

**No framework code is copied.** The `.floe/` directory holds configuration and state only.

## Role & Skill Loading

Canonical roles and skills are part of the global Floe runtime. The daemon loads them automatically from the global install location.

- **Project-local override** (`.floe/roles/planner.md`) completely replaces the global version for that project.
- **No resolution chain** — global skills are loaded as part of the runtime's own config; project-local overrides are a full replacement, not a fallback.
- **No per-project script copies** — scripts and executables are part of the global engine.

## Pi Session Substrate

The Pi substrate (`floe/runtime/substrate/pi.ts`) is the sole session host:

- All worker sessions (floe, planner, implementer, reviewer) are Pi-hosted
- Pi manages in-memory sessions with conversation history
- Pi routes model API calls based on model identifier (Anthropic, OpenAI)
- There is no adapter pattern — Pi is the substrate, not one of many backends

## Session ID Contract

Worker session IDs include the role as a prefix:

- Format: `<role>-<timestamp>-<random>`
- Example: `implementer-m5x8k2-a7b3c9`

## Non-Canonical Files

Anything outside `floe/` is repository build/support context:

- `scripts/` (repo root) — installer and project initialisation
- `docs/` — design docs and operating notes

## Context Memory Contract

`context-memory` / `floe-mem` is external.

- `floe-core` must not install it.
- `floe-core` may detect and integrate with it when already present.
