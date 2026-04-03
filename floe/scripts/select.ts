#!/usr/bin/env bun
/**
 * floe-exec select — choose the next feature to work on.
 *
 * Implements the selection policy from the handoff:
 * 1. Only features in active epics within the active release
 * 2. Exclude items with unsatisfied dependencies
 * 3. Prefer continuation of currently active feature
 * 4. Prefer highest priority among ready features
 * 5. Prefer features in the currently active epic
 * 6. Prefer oldest ready feature at same priority
 *
 * Usage:
 *   bun run scripts/select.ts next     # select next feature
 *   bun run scripts/select.ts ready    # list all ready features
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths, readJson, listArtefacts, output, fail } from "./helpers.ts";

const PRIORITY_ORDER = ["critical", "high", "normal", "low", "parked"];

const p = paths();
const stateFile = join(p.state, "current.json");

if (!existsSync(stateFile)) fail("Runtime state not found. Run init first.");

const state = readJson(stateFile);
const [cmd] = Bun.argv.slice(2);

// Load all artefacts
const allEpics = listArtefacts(p.epics);
const allFeatures = listArtefacts(p.features);

// Find active epics within the active release
const activeEpics = allEpics.filter(
  (e) => e.release_id === state.active_release_id && e.status === "active"
);
const activeEpicIds = new Set(activeEpics.map((e) => e.id));

// Find candidate features: in active epics, not completed/cancelled
const candidates = allFeatures.filter(
  (f) =>
    activeEpicIds.has(f.epic_id) &&
    !["completed", "cancelled", "blocked"].includes(f.status) &&
    f.priority !== "parked"
);

// Check dependency satisfaction
const completedIds = new Set(
  allFeatures.filter((f) => f.status === "completed").map((f) => f.id)
);

function depsReady(feature: any): boolean {
  if (!feature.dependencies || feature.dependencies.length === 0) return true;
  return feature.dependencies.every((d: string) => completedIds.has(d));
}

const ready = candidates.filter(depsReady);

if (cmd === "ready") {
  output({
    ok: true,
    active_release_id: state.active_release_id,
    active_epic_ids: [...activeEpicIds],
    count: ready.length,
    features: ready.map((f) => ({
      id: f.id,
      title: f.title,
      epic_id: f.epic_id,
      priority: f.priority,
      status: f.status,
    })),
  });
  process.exit(0);
}

if (cmd !== "next") {
  fail("Usage: select <next|ready>");
}

// Selection logic
if (ready.length === 0) {
  output({
    ok: true,
    selected: null,
    reason: "No ready features found",
    active_release_id: state.active_release_id,
    candidates_total: candidates.length,
    blocked_by_deps: candidates.length - ready.length,
  });
  process.exit(0);
}

// 3. Prefer continuation of currently active feature
const activeFeature = ready.find((f) => f.id === state.active_feature_id);
if (activeFeature) {
  output({
    ok: true,
    selected: activeFeature.id,
    title: activeFeature.title,
    reason: "Continuing active feature",
  });
  process.exit(0);
}

// 4-6. Sort by priority, then active epic preference, then creation date
ready.sort((a, b) => {
  const pa = PRIORITY_ORDER.indexOf(a.priority);
  const pb = PRIORITY_ORDER.indexOf(b.priority);
  if (pa !== pb) return pa - pb;

  // Prefer features in the currently active epic
  const aInActive = a.epic_id === state.active_epic_id ? 0 : 1;
  const bInActive = b.epic_id === state.active_epic_id ? 0 : 1;
  if (aInActive !== bInActive) return aInActive - bInActive;

  // Oldest first
  return (a.created_at ?? "").localeCompare(b.created_at ?? "");
});

const selected = ready[0];
output({
  ok: true,
  selected: selected.id,
  title: selected.title,
  epic_id: selected.epic_id,
  priority: selected.priority,
  reason: "Highest priority ready feature",
});
