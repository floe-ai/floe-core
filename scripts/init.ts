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
    "remote": { type: "string" },       // e.g. https://github.com/org/repo.git or git@github.com:org/repo.git
    "branch": { type: "string" },       // default branch name, defaults to "main"
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

// ── Credential helper detection ───────────────────────────────────────

/**
 * Probe for the best available git credential helper in priority order:
 *   1. Git Credential Manager (cross-platform, most secure)
 *   2. Platform keychain (osxkeychain / wincred / gnome-libsecret)
 *   3. cache  — in-memory, survives a session (unavailable on Windows)
 *   4. store  — plaintext fallback, always present
 */
function detectCredentialHelper(): string {
  function binaryExists(name: string): boolean {
    const probe = Bun.spawnSync(
      process.platform === "win32" ? ["where", name] : ["which", name],
      { stdout: "ignore", stderr: "ignore" },
    );
    return probe.exitCode === 0;
  }

  // Priority list: tuples of [git-config-value, binary-to-probe | null]
  // null means always-available (no binary check needed).
  const candidates: Array<[string, string | null]> = [
    ["manager",             "git-credential-manager"],
    ["manager-core",        "git-credential-manager-core"],
    ...(process.platform === "darwin"
      ? [["osxkeychain",    "git-credential-osxkeychain"] as [string, string]]
      : []),
    ...(process.platform === "win32"
      ? [["wincred",        "git-credential-wincred"] as [string, string]]
      : []),
    ...(process.platform === "linux"
      ? [
          ["gnome-libsecret", "git-credential-gnome-libsecret"] as [string, string],
          ["secretservice",   "git-credential-secretservice"] as [string, string],
        ]
      : []),
    // cache: in-memory, not available on Windows
    ...(process.platform !== "win32" ? [["cache", null] as [string, null]] : []),
    ["store", null],  // plaintext fallback — always available
  ];

  for (const [helper, binary] of candidates) {
    if (binary === null || binaryExists(binary)) return helper;
  }
  return "store";
}

// ── Set up remote, credential helper, initial commit + push ──────────

const remoteUrl = values["remote"] as string | undefined;
const branchName = (values["branch"] as string | undefined) || "main";
let remoteSetup: { ok: boolean; remote?: string; branch?: string; pushed?: boolean; credentialHelper?: string; error?: string } | null = null;

if (remoteUrl) {
  try {
    // Ensure we are on the right branch
    const currentBranch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: p.root, stdout: "pipe", stderr: "ignore",
    });
    const currentBranchName = currentBranch.stdout.toString().trim();
    if (currentBranchName !== branchName && currentBranchName !== "HEAD") {
      Bun.spawnSync(["git", "branch", "-M", branchName], { cwd: p.root, stdout: "ignore", stderr: "ignore" });
    }

    // Add or update origin remote
    const existingRemotes = Bun.spawnSync(["git", "remote"], { cwd: p.root, stdout: "pipe", stderr: "ignore" });
    const remotes = existingRemotes.stdout.toString().trim().split("\n").filter(Boolean);
    if (remotes.includes("origin")) {
      Bun.spawnSync(["git", "remote", "set-url", "origin", remoteUrl], { cwd: p.root, stdout: "ignore", stderr: "ignore" });
    } else {
      Bun.spawnSync(["git", "remote", "add", "origin", remoteUrl], { cwd: p.root, stdout: "ignore", stderr: "ignore" });
    }

    // Detect and configure credential helper for HTTPS remotes
    let credentialHelper: string | undefined;
    if (remoteUrl.startsWith("https://")) {
      credentialHelper = detectCredentialHelper();
      Bun.spawnSync(["git", "config", "credential.helper", credentialHelper], { cwd: p.root, stdout: "ignore", stderr: "ignore" });
    }

    // Stage everything and make the initial commit (if working tree is dirty)
    const statusResult = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: p.root, stdout: "pipe", stderr: "ignore" });
    const hasPendingChanges = statusResult.stdout.toString().trim().length > 0;
    if (hasPendingChanges) {
      Bun.spawnSync(["git", "add", "-A"], { cwd: p.root, stdout: "ignore", stderr: "ignore" });
      Bun.spawnSync(["git", "commit", "-m", "chore: initialise floe framework structure"], {
        cwd: p.root, stdout: "ignore", stderr: "ignore",
        env: { ...process.env },
      });
    }

    // Push and set upstream tracking
    const pushResult = Bun.spawnSync(["git", "push", "-u", "origin", branchName], {
      cwd: p.root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env },
    });
    if (pushResult.exitCode === 0) {
      remoteSetup = { ok: true, remote: remoteUrl, branch: branchName, pushed: true, credentialHelper };
    } else {
      remoteSetup = { ok: false, remote: remoteUrl, credentialHelper, error: pushResult.stderr.toString().trim() || "push failed" };
    }
  } catch (e: any) {
    remoteSetup = { ok: false, remote: remoteUrl, error: e?.message ?? "unknown error" };
  }
}

ok("Framework initialised", {
  project_root: p.root,
  git_initialised: gitInitialised,
  remote_setup: remoteSetup,
  directories_created: created,
  floe_mem_detected: hasMem,
});
