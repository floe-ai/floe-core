#!/usr/bin/env bun
/**
 * floe-exec validate — consistency checks across the framework.
 *
 * Usage:
 *   bun run scripts/validate.ts all          # full consistency check
 *   bun run scripts/validate.ts artefact <type> <id>  # validate one artefact
 *   bun run scripts/validate.ts state        # validate runtime state consistency
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  paths, readJson, listArtefacts, validateArtefact, findArtefact,
  output, fail,
} from "./helpers.ts";

const p = paths();
const [cmd, arg1, arg2] = Bun.argv.slice(2);

interface Issue {
  severity: "error" | "warning";
  type: string;
  id?: string;
  message: string;
}

function validateAll(): Issue[] {
  const issues: Issue[] = [];

  // Check directory structure exists
  const requiredDirs = [
    p.releases, p.epics, p.features, p.reviews, p.summaries, p.notes,
    p.state,
  ];
  for (const dir of requiredDirs) {
    if (!existsSync(dir)) {
      issues.push({ severity: "error", type: "structure", message: `Missing directory: ${dir.replace(p.root + "/", "")}` });
    }
  }

  // Validate all artefacts against schemas
  const types = [
    { name: "release", dir: p.releases, schema: "release" },
    { name: "epic", dir: p.epics, schema: "epic" },
    { name: "feature", dir: p.features, schema: "feature" },
    { name: "review", dir: p.reviews, schema: "review" },
    { name: "summary", dir: p.summaries, schema: "summary" },
    { name: "note", dir: p.notes, schema: "note" },
  ];

  for (const t of types) {
    const items = listArtefacts(t.dir);
    for (const item of items) {
      const validation = validateArtefact(item, t.schema);
      if (!validation.valid) {
        for (const err of validation.errors) {
          issues.push({ severity: "error", type: t.name, id: item.id, message: err });
        }
      }
    }
  }

  // Check hierarchy integrity
  const releases = listArtefacts(p.releases);
  const epics = listArtefacts(p.epics);
  const features = listArtefacts(p.features);

  const releaseIds = new Set(releases.map((r) => r.id));
  const epicIds = new Set(epics.map((e) => e.id));

  // Every epic must reference a valid release
  for (const epic of epics) {
    if (!releaseIds.has(epic.release_id)) {
      issues.push({
        severity: "error", type: "epic", id: epic.id,
        message: `References non-existent release: ${epic.release_id}`,
      });
    }
  }

  // Every feature must reference a valid epic
  for (const feature of features) {
    if (!epicIds.has(feature.epic_id)) {
      issues.push({
        severity: "error", type: "feature", id: feature.id,
        message: `References non-existent epic: ${feature.epic_id}`,
      });
    }
  }

  // Check dependency references
  const featureIds = new Set(features.map((f) => f.id));
  for (const feature of features) {
    for (const dep of feature.dependencies ?? []) {
      if (!featureIds.has(dep)) {
        issues.push({
          severity: "warning", type: "feature", id: feature.id,
          message: `Depends on non-existent feature: ${dep}`,
        });
      }
    }
  }

  // Check runtime state consistency
  const stateFile = join(p.state, "current.json");
  if (existsSync(stateFile)) {
    const state = readJson(stateFile);

    if (state.active_release_id && !releaseIds.has(state.active_release_id)) {
      issues.push({
        severity: "error", type: "state",
        message: `Active release points to non-existent: ${state.active_release_id}`,
      });
    }
    if (state.active_epic_id && !epicIds.has(state.active_epic_id)) {
      issues.push({
        severity: "error", type: "state",
        message: `Active epic points to non-existent: ${state.active_epic_id}`,
      });
    }
    if (state.active_feature_id && !featureIds.has(state.active_feature_id)) {
      issues.push({
        severity: "error", type: "state",
        message: `Active feature points to non-existent: ${state.active_feature_id}`,
      });
    }
  }

  // Check reviews reference valid targets
  const reviews = listArtefacts(p.reviews);
  const allIds = new Set([...releaseIds, ...epicIds, ...featureIds]);
  for (const review of reviews) {
    if (!allIds.has(review.target_id)) {
      issues.push({
        severity: "warning", type: "review", id: review.id,
        message: `References non-existent target: ${review.target_id}`,
      });
    }
  }

  return issues;
}

switch (cmd) {
  case "all": {
    const issues = validateAll();
    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warning");
    output({
      ok: errors.length === 0,
      errors: errors.length,
      warnings: warnings.length,
      issues,
    });
    if (errors.length > 0) process.exit(1);
    break;
  }

  case "artefact": {
    if (!arg1 || !arg2) fail("Usage: validate artefact <type> <id>");
    const typeMap: Record<string, string> = {
      release: "releases", epic: "epics", feature: "features",
      review: "reviews", summary: "summaries", note: "notes",
    };
    const dir = (p as any)[typeMap[arg1]];
    if (!dir) fail(`Unknown type: ${arg1}`);
    const item = findArtefact(dir, arg2);
    if (!item) fail(`Not found: ${arg2}`);
    const result = validateArtefact(item, arg1);
    output({ ok: result.valid, id: arg2, type: arg1, ...result });
    if (!result.valid) process.exit(1);
    break;
  }

  case "state": {
    const stateFile = join(p.state, "current.json");
    if (!existsSync(stateFile)) fail("No runtime state found");
    const state = readJson(stateFile);
    const result = validateArtefact(state, "runtime-state");
    output({ ok: result.valid, ...result, state });
    if (!result.valid) process.exit(1);
    break;
  }

  default:
    fail("Usage: validate <all|artefact|state>");
}
