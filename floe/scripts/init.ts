#!/usr/bin/env bun
/**
 * floe-exec init — scaffold the required repo structure.
 *
 * Usage: bun run scripts/init.ts [--project-root <path>]
 *
 * Creates delivery/, docs/prd|architecture|decisions, .floe/state/
 * and initialises runtime state if not present.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { paths, writeJson, readJson, timestamp, ok, fail, floeMemAvailable } from "./helpers.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "project-root": { type: "string" },
  },
  strict: false,
});

const p = paths(values["project-root"] as string | undefined);

// ── Scaffold directories ──────────────────────────────────────────────

const dirs = [
  p.releases, p.epics, p.features, p.reviews, p.summaries, p.notes,
  p.prd, p.architecture, p.decisions,
  p.state,
];

const created: string[] = [];
for (const dir of dirs) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    created.push(dir.replace(p.root + "/", ""));
  }
}

// ── Ensure .gitkeep in empty directories ──────────────────────────────

for (const dir of dirs) {
  const gitkeep = join(dir, ".gitkeep");
  if (!existsSync(gitkeep)) {
    writeFileSync(gitkeep, "", "utf-8");
  }
}

// ── Ensure .gitignore for .floe/ runtime state ─────────────────────────

const floeGitignore = join(p.floe, ".gitignore");
if (!existsSync(floeGitignore)) {
  writeFileSync(
    floeGitignore,
    [
      "# Runtime state — not committed",
      "state/",
      "memory/*.db*",
      "",
    ].join("\n"),
    "utf-8"
  );
  created.push(".floe/.gitignore");
}

// ── Scaffold default DoD if not present ───────────────────────────────

const dodDest = join(p.floe, "dod.json");
if (!existsSync(dodDest)) {
  const dodDefault = {
    version: 1,
    criteria: [
      { id: "tests-pass", category: "quality", description: "All existing tests pass. No test regressions introduced.", severity: "required" },
      { id: "acceptance-met", category: "correctness", description: "All acceptance criteria from the feature artefact are satisfied.", severity: "required" },
      { id: "no-regressions", category: "quality", description: "No regressions in the area touched by the change.", severity: "required" },
      { id: "code-reviewed", category: "quality", description: "Code has been reviewed by the Reviewer role and all critical/major findings resolved.", severity: "required" },
      { id: "docs-updated", category: "documentation", description: "Documentation updated if the change affects public APIs, configuration, or user-facing behaviour.", severity: "recommended" },
      { id: "no-security-issues", category: "security", description: "No known security vulnerabilities introduced. Secrets not committed.", severity: "required" },
    ],
    notes: "This is the project-level Definition of Done. Edit .floe/dod.json to customise criteria for your project.",
  };
  writeJson(dodDest, dodDefault);
  created.push(".floe/dod.json");
}

// ── Initialise runtime state ──────────────────────────────────────────

const stateFile = join(p.state, "current.json");
if (!existsSync(stateFile)) {
  writeJson(stateFile, {
    mode: "idle",
    active_release_id: null,
    active_epic_id: null,
    active_feature_id: null,
    continuation_preference: "stop_after_feature",
    updated_at: timestamp(),
  });
  created.push(".floe/state/current.json");
}

// ── Detect floe-mem ───────────────────────────────────────────────────

const hasMem = floeMemAvailable();

ok("Framework initialised", {
  project_root: p.root,
  directories_created: created,
  floe_mem_detected: hasMem,
});
