# Sizing Heuristics — Shared Reference

This is the canonical sizing reference for all Floe roles (Foreman, Planner, Implementer, Reviewer).

---

## Hierarchy

```
Release
  └── Epic
        └── Feature (lowest durable execution unit)
                └── Tasks (ephemeral — not stored as durable artefacts)
```

---

## Sizing Table

| Level | Size | Example |
|-------|------|---------|
| **Release** | The whole deliverable | "Sticky Notes MVP", "Producer Brain Cache" |
| **Epic** | One independently deployable vertical slice — must be demonstrable and valuable on its own | "Working sticky-note app with semantic relatedness" |
| **Feature** | One coherent outcome that one implementer/reviewer pair can own end-to-end — may require multiple implementation/review loops | "Full note CRUD with canvas placement", "Embedding engine with opacity visualisation" |
| **Tasks** | Ephemeral steps within a feature — not stored | "scaffold Electron app", "add MiniLM dependency" |

---

## Rules

### 1. Default to fewer, larger units

Most small-to-medium releases are **1 epic**. Do not inflate epic count for "separation of concerns" or "modularity." Split only when you have a concrete reason: independent deployability, different sequencing needs, or scope genuinely too large for one pair.

### 2. Anti-layer-split

**Do not create epics that map to technical layers.** "Backend", "Frontend", "Infrastructure", "Foundation", "Integration" are not epics. Epics are vertical slices of user-facing value. If the release has one user-facing outcome delivered across multiple technical layers, that is one epic.

### 3. Independent deployability test

An epic is independently deployable only if:
- It can be demonstrated to a user without the other epics existing
- It delivers value on its own
- It is not purely scaffolding or setup for another epic

If epic A has no demonstrable value without epic B, they should be one epic.

### 4. Feature sizing

Do not split features purely because they contain several internal coding steps. A feature is too large only when a single implementer/reviewer pair cannot own the outcome end-to-end.

If an item feels like a setup step or a single UI component, it is a task within a feature, not a standalone feature.

### 5. Consolidation check

Before finalising any decomposition:
- For each pair of epics: if one has no value without the other, merge them
- If an epic's acceptance criteria are a subset of another's, merge them
- If total epic count exceeds 3, re-examine whether the release genuinely has that many independent vertical slices

---

## Correct vs Over-Split Examples

### ❌ Over-split (4 epics for a small MVP)

Release: "Sticky note app with zoomable canvas and semantic relatedness"

- Epic 1: Desktop Shell & Project Foundation ← scaffolding, not an epic
- Epic 2: Canvas & Note Creation ← no value without embeddings
- Epic 3: Local Embedding Engine ← no value without visualisation
- Epic 4: Semantic Relatedness Visualization ← no value without canvas

**Problem:** None of these epics are independently deployable. Epic 1 is pure scaffolding. Epics 2–4 form one inseparable outcome.

### ✅ Correct (1 epic)

Release: "Sticky note app with zoomable canvas and semantic relatedness"

- Epic 1: Sticky Notes MVP — desktop app with canvas, note creation, local embeddings, and opacity-based relatedness
  - Feature 1: Canvas with note CRUD — Electron shell, zoomable canvas, create/edit/delete/drag notes
  - Feature 2: Semantic relatedness — MiniLM embeddings, pairwise similarity, opacity visualisation

**Why correct:** One epic because it's one deliverable outcome. Two features because they represent two coherent outcomes that could each be owned by a single pair, and Feature 1 is demonstrable on its own (a working note app, even without embeddings).

---

### ❌ Over-split (features as tasks)

- Feature 1: Scaffold Electron app
- Feature 2: Add zoomable canvas library
- Feature 3: Implement note data model
- Feature 4: Build note creation UI

**Problem:** These are implementation steps (tasks), not coherent outcomes.

### ✅ Correct (one feature)

- Feature 1: Canvas with note CRUD — Electron shell, zoomable canvas, create/edit/delete/drag notes

**Why correct:** One coherent outcome, one pair can own it end-to-end.
