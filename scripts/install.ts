#!/usr/bin/env bun
/**
 * floe project initialiser — invoked via `floe init` or `bunx github:floe-ai/floe-core`.
 *
 * Creates project-local state in `.floe/` and scaffolds the delivery structure.
 * Does NOT copy framework code — the engine (runtime, scripts, schemas, roles,
 * skills) lives in the global Floe install and is referenced at runtime.
 *
 * What `.floe/` contains after init:
 *   config.json   — project-specific configuration
 *   dod.json      — project-level definition of done
 *   state/        — runtime state (gitignored)
 *   .gitignore    — keeps state/ out of version control
 *
 * Flags:
 *   --project-root <path>  Target project (default: cwd)
 *   --force                Re-initialise existing project state
 *   --no-scaffold          Skip delivery/docs directory creation
 *   --yes / -y             Skip confirmation prompt
 *   --non-interactive      No prompts (implies --yes)
 *
 * Prerequisites: bun ≥ 1.0
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

// ── Helpers ───────────────────────────────────────────────────────────

function shortPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function confirm(rl: ReturnType<typeof createInterface>, message: string): Promise<boolean> {
  const raw = (await ask(rl, `${message} [Y/n] `)).trim().toLowerCase();
  return raw === "" || raw === "y" || raw === "yes";
}

// ── Project-local state initialisation ────────────────────────────────

function initProjectState(projectRoot: string, force: boolean): string[] {
  const floeDir = join(projectRoot, ".floe");
  const created: string[] = [];

  if (existsSync(floeDir) && !force) {
    // Preserve existing config — only create missing pieces
  }

  mkdirSync(floeDir, { recursive: true });

  // config.json — project-specific settings
  const configPath = join(floeDir, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      JSON.stringify({ configured: false }, null, 2) + "\n",
      "utf-8",
    );
    created.push(".floe/config.json");
  } else if (force) {
    // On force, preserve existing config — don't wipe user settings
    try {
      const existing = JSON.parse(readFileSync(configPath, "utf-8"));
      if (existing.configured) {
        // Already configured — leave it alone
      }
    } catch {
      // Corrupted — rewrite
      writeFileSync(
        configPath,
        JSON.stringify({ configured: false }, null, 2) + "\n",
        "utf-8",
      );
      created.push(".floe/config.json (reset)");
    }
  }

  // dod.json — project definition of done
  const dodPath = join(floeDir, "dod.json");
  if (!existsSync(dodPath)) {
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
    writeFileSync(dodPath, JSON.stringify(dodDefault, null, 2) + "\n", "utf-8");
    created.push(".floe/dod.json");
  }

  // state/ — runtime state directory (gitignored)
  const stateDir = join(floeDir, "state");
  mkdirSync(stateDir, { recursive: true });

  const stateFile = join(stateDir, "current.json");
  if (!existsSync(stateFile)) {
    writeFileSync(
      stateFile,
      JSON.stringify({
        mode: "idle",
        activeReleaseId: null,
        activeEpicId: null,
        activeFeatureId: null,
        continuationPreference: "stop_after_feature",
        updatedAt: new Date().toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );
    created.push(".floe/state/current.json");
  }

  // .gitignore — keep runtime state out of version control
  const gitignorePath = join(floeDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(
      gitignorePath,
      [
        "# Runtime state — not committed",
        "state/",
        "",
      ].join("\n"),
      "utf-8",
    );
    created.push(".floe/.gitignore");
  }

  return created;
}

// ── Scaffold delivery/docs structure ──────────────────────────────────

function scaffoldProject(projectRoot: string): string[] {
  const created: string[] = [];
  const dirs = [
    "delivery/releases",
    "delivery/epics",
    "delivery/features",
    "delivery/reviews",
    "delivery/summaries",
    "delivery/notes",
    "docs/prd",
    "docs/architecture",
    "docs/decisions",
  ];

  for (const dir of dirs) {
    const full = join(projectRoot, dir);
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true });
      writeFileSync(join(full, ".gitkeep"), "", "utf-8");
      created.push(dir);
    }
  }

  return created;
}

// ── CLI entry point ───────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "project-root": { type: "string" },
      force: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      "no-scaffold": { type: "boolean", default: false },
      "non-interactive": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const nonInteractive = Boolean(values["non-interactive"]);
  const shouldScaffold = !values["no-scaffold"];
  const force = Boolean(values["force"]);
  const projectRoot = resolve(
    (values["project-root"] as string | undefined) ?? process.cwd(),
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    if (!values["yes"] && !nonInteractive && process.stdout.isTTY) {
      console.log(`\n  Floe will initialise project state at:\n`);
      console.log(`    ${shortPath(join(projectRoot, ".floe"))}/`);
      if (shouldScaffold) console.log("    Delivery/docs structure will be scaffolded.");
      if (force) console.log("    Existing state will be re-initialised (--force).");
      console.log("");
      const ok = await confirm(rl, "Proceed?");
      if (!ok) {
        console.log("Cancelled.");
        process.exit(1);
      }
    }

    console.log("");

    // ── Step 1: Initialise project-local state ────────────────────────

    const stateCreated = initProjectState(projectRoot, force);
    if (stateCreated.length > 0) {
      for (const item of stateCreated) {
        console.log(`  ✓ ${item}`);
      }
    } else {
      console.log(`  ✓ project state already initialised`);
    }

    // ── Step 2: Scaffold delivery/docs ────────────────────────────────

    if (shouldScaffold) {
      const scaffolded = scaffoldProject(projectRoot);
      if (scaffolded.length > 0) {
        console.log(`  ✓ scaffolded ${scaffolded.length} directories`);
      } else {
        console.log(`  ✓ project structure already present`);
      }
    }

    // ── Summary ───────────────────────────────────────────────────────

    console.log(`\n✓ Floe project initialised. Run 'floe' to start.`);
    console.log(`  Configure model settings with 'floe configure'.`);
    console.log("");
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
