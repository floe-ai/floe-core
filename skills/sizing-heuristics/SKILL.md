---
name: sizing-heuristics
description: Canonical sizing heuristics for release, epic, and feature decomposition in Floe.
license: MIT
compatibility: Works with Codex, Copilot, and Claude Code.
---

# Floe Sizing Heuristics

Use this reference whenever you size or split work in Floe.

## Core Principles

- Prefer fewer, larger slices unless there is clear independent value.
- Size for ownership: one implementer/reviewer pair should own one feature end-to-end.
- Keep decomposition one level at a time.
- Avoid technical-layer splits (backend/frontend/infrastructure) as top-level units.

## Unit Definitions

### Release

A release is a top-level deliverable that can be explained in one sentence.

Good release signal:
- clear user or business outcome
- meaningful completion boundary

### Epic

An epic is an independently deployable, independently valuable vertical slice.

Create a separate epic only when at least one is true:
- it can ship and deliver value without the other epics
- it has materially different sequencing constraints
- it is too large to be safely executed as one slice

Do not create standalone epics for pure scaffolding or internal setup.

### Feature

A feature is one coherent outcome a single implementer/reviewer pair can deliver end-to-end, including review loops.

Feature should include:
- clear behaviour statement
- concrete acceptance criteria
- enough implementation hints to execute safely

## Split/Merge Heuristics

Split when:
- acceptance criteria represent distinct user outcomes
- dependencies force clearly separate sequencing
- delivery risk is too high for one bounded run

Merge when:
- one slice has no demonstrable value without another
- criteria are mostly overlapping
- split exists only to mirror code layers

## Guardrails

- If unsure, start with one epic and one feature, then split only when execution evidence demands it.
- Planner should stop after the requested decomposition scope.
- Floe should escalate ambiguous sizing decisions instead of guessing.
