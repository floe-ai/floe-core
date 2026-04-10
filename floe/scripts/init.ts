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

// ── Initialise git repository if not already present ─────────────────

const gitDir = join(p.root, ".git");
let gitInitialised = false;
if (!existsSync(gitDir)) {
  const result = Bun.spawnSync(["git", "init"], { cwd: p.root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode === 0) {
    gitInitialised = true;
  }
  // Non-fatal: if git is not available, continue without it
}

// ── Ensure root .gitignore exists ─────────────────────────────────────

const rootGitignore = join(p.root, ".gitignore");
if (!existsSync(rootGitignore)) {
  writeFileSync(
    rootGitignore,
    [
      "# Dependencies",
      "node_modules/",
      "",
      "# Build output",
      "dist/",
      "dist-electron/",
      "out/",
      "build/",
      "",
      "# Environment",
      ".env",
      ".env.*",
      "!.env.example",
      "",
      "# OS",
      ".DS_Store",
      "Thumbs.db",
      "",
      "# Floe runtime state (managed separately by .floe/.gitignore)",
      "",
    ].join("\n"),
    "utf-8",
  );
}

// ── Scaffold directories ──────────────────────────────────────────────

const dirs = [
  p.releases, p.epics, p.features, p.reviews, p.summaries, p.notes, p.escalations,
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
      { id: "docs-updated", category: "documentation", description: "Documentation updated if the change affects public APIs, configuration, or user-facing behaviour. For internal refactors only, reviewer may explicitly waive this with a recorded rationale.", severity: "required" },
      { id: "no-security-issues", category: "security", description: "No known security vulnerabilities introduced. Secrets not committed.", severity: "required" },
      { id: "smoke-tested", category: "quality", description: "For features that produce or modify runnable application code: the application was launched and the changed behaviour was exercised manually or via automated E2E test. A review that evaluates only source without running the application is incomplete.", severity: "required" },
      { id: "build-verified", category: "quality", description: "For features that touch the build pipeline or use ESM-only dependencies: the compiled/bundled output was verified to start and run correctly, not just the TypeScript source.", severity: "required" },
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
  git_initialised: gitInitialised,
  directories_created: created,
  floe_mem_detected: hasMem,
});
