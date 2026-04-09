#!/usr/bin/env bun
/**
 * floe-core installer — invoked via:
 *   bunx github:floe-ai/floe-core
 *
 * Single-step install: copies .floe/ directory (scripts, schemas, roles,
 * skills, runtime, CLI entrypoint), installs provider skill pointers and
 * foreman wrappers, scaffolds the
 * delivery structure, and installs dependencies.
 *
 * Flags:
 *   --project-root <path>  Target project (default: cwd)
 *   --target <clients>     Comma-separated: codex,copilot,claude (default: all)
 *   --force                Overwrite existing installations
 *   --no-scaffold          Skip delivery/docs directory creation
 *   --validate             Run consistency checks after install
 *   --yes / -y             Skip confirmation prompt
 *   --non-interactive      No prompts (implies --yes)
 *
 * Prerequisites: bun ≥ 1.0
 */

import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { execSync } from "node:child_process";

// ── Constants ─────────────────────────────────────────────────────────

const CLIENTS = ["codex", "copilot", "claude"] as const;
type Client = (typeof CLIENTS)[number];

const SCRIPT_DIR = import.meta.dir;
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");

// ── Path resolution ───────────────────────────────────────────────────

function floeSourceDir(): string {
  const candidate = join(PACKAGE_ROOT, "floe");
  if (existsSync(candidate)) return candidate;
  throw new Error(`Floe source not found at: ${candidate}`);
}

interface SkillSpec {
  name: string;
  description: string;
}

const INSTALLABLE_SKILLS: SkillSpec[] = [
  {
    name: "floe-exec",
    description: "Structured delivery framework. See .floe/skills/floe-exec/SKILL.md for full rules.",
  },
  {
    name: "sizing-heuristics",
    description: "Canonical sizing heuristics shared across planning and execution roles.",
  },
];

function skillRootDir(client: Client, projectRoot: string): string {
  const dirs: Record<Client, string> = {
    codex: join(projectRoot, ".agents", "skills"),
    copilot: join(projectRoot, ".github", "skills"),
    claude: join(projectRoot, ".claude", "skills"),
  };
  return dirs[client];
}

function skillTargetDir(client: Client, projectRoot: string, skillName: string): string {
  return join(skillRootDir(client, projectRoot), skillName);
}

function agentTargetFile(client: Client, projectRoot: string): string {
  const dirs: Record<Client, string> = {
    codex: join(projectRoot, "AGENTS.md"),
    copilot: join(projectRoot, ".github", "agents", "foreman.agent.md"),
    claude: join(projectRoot, ".claude", "agents", "foreman.md"),
  };
  return dirs[client];
}

function shortPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// ── Interactive prompts ───────────────────────────────────────────────

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function selectClients(rl: ReturnType<typeof createInterface>): Promise<Client[]> {
  console.log("\nSelect target clients (comma-separated, or press Enter for all):");
  CLIENTS.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
  const raw = await ask(rl, "> ");
  if (!raw.trim()) return [...CLIENTS];
  const picked: Client[] = [];
  for (const token of raw.split(",").map((t) => t.trim().toLowerCase())) {
    const byIndex = CLIENTS[parseInt(token, 10) - 1];
    const byName = CLIENTS.find((c) => c === token);
    const resolved = byIndex ?? byName;
    if (!resolved) throw new Error(`Unknown client: '${token}'`);
    if (!picked.includes(resolved)) picked.push(resolved);
  }
  if (picked.length === 0) throw new Error("At least one client must be selected");
  return picked;
}

async function confirm(rl: ReturnType<typeof createInterface>, message: string): Promise<boolean> {
  const raw = (await ask(rl, `${message} [Y/n] `)).trim().toLowerCase();
  return raw === "" || raw === "y" || raw === "yes";
}

// ── Installation ──────────────────────────────────────────────────────

function installFloeDir(projectRoot: string, force: boolean): void {
  const source = floeSourceDir();
  const dest = join(projectRoot, ".floe");

  if (existsSync(dest)) {
    if (!force) throw new Error(`Already exists: ${dest} (use --force to overwrite)`);
    rmSync(dest, { recursive: true, force: true });
  }

  mkdirSync(dest, { recursive: true });

  // Copy canonical install payload from floe/
  for (const subdir of ["bin", "scripts", "schemas", "roles", "runtime", "skills"]) {
    const src = join(source, subdir);
    if (existsSync(src)) {
      cpSync(src, join(dest, subdir), { recursive: true });
    }
  }

  // Copy package.json and SKILL.md
  for (const file of ["package.json", "SKILL.md"]) {
    const src = join(source, file);
    if (existsSync(src)) {
      cpSync(src, join(dest, file));
    }
  }
}

function createThinSkillPointer(client: Client, projectRoot: string, skill: SkillSpec, force: boolean): void {
  const targetDir = skillTargetDir(client, projectRoot, skill.name);
  const skillMdPath = join(targetDir, "SKILL.md");

  if (existsSync(skillMdPath) && !force) {
    throw new Error(`Already exists: ${skillMdPath} (use --force to overwrite)`);
  }

  mkdirSync(targetDir, { recursive: true });

  const content = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    "---",
    "",
    `The full skill definition is at: \`.floe/skills/${skill.name}/SKILL.md\``,
    "",
    "Read that file and follow it.",
    "",
  ].join("\n");

  writeFileSync(skillMdPath, content, "utf-8");
}

function buildForemanWrapper(client: Client): string {
  const shared = [
    "You are the **Foreman** for this project's Floe execution framework.",
    "",
    "## Canonical role definition",
    "",
    "Your full role definition is at: `.floe/roles/foreman.md`",
    "",
    "Read that file now and follow it exactly.",
    "",
    "## First-turn ritual",
    "",
    "1. Read state: `bun run .floe/scripts/state.ts get`",
    "2. Check active pointers reference real artefacts",
    "3. Classify user message (continuation, intake, setup, interruption, brainstorming)",
    "4. Choose mode before doing anything else",
    "",
    "## Hard constraints — you MUST NOT:",
    "",
    "- **Implement code** — you never write production code. Launch workers instead.",
    "- **Create epics or features** — all decomposition below release is the Planner's job.",
    "- **Decompose beyond the current routing decision** — launch the Planner, don't plan yourself.",
    "- **Skip state read** — always read state before acting.",
    "- **Send implementation instructions without approved alignment** — run `check-alignment` first.",
    "- **Resolve architecture/technology decisions** — surface them to the user.",
    "",
  ];

  if (client === "codex") {
    return ["# floe-core — Foreman Agent", "", ...shared].join("\n");
  }

  return [
    "---",
    'name: "Foreman"',
    'description: "Execution framework process controller. Routes work, manages state, and enforces lifecycle boundaries."',
    "---",
    "",
    ...shared,
  ].join("\n");
}

function installAgentWrapper(client: Client, projectRoot: string, force: boolean): string {
  const targetPath = agentTargetFile(client, projectRoot);
  if (existsSync(targetPath) && !force) {
    throw new Error(`Already exists: ${targetPath} (use --force to overwrite)`);
  }
  mkdirSync(resolve(targetPath, ".."), { recursive: true });
  writeFileSync(targetPath, buildForemanWrapper(client), "utf-8");
  return targetPath;
}

function ensureDodFile(projectRoot: string): boolean {
  const dodPath = join(projectRoot, ".floe", "dod.json");
  if (existsSync(dodPath)) return false;

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
  return true;
}

// ── Scaffold ──────────────────────────────────────────────────────────

function scaffoldProject(projectRoot: string): string[] {
  const created: string[] = [];
  const dirs = [
    "delivery/releases", "delivery/epics", "delivery/features",
    "delivery/reviews", "delivery/summaries", "delivery/notes",
    "docs/prd", "docs/architecture", "docs/decisions",
    ".floe/state",
  ];

  for (const dir of dirs) {
    const full = join(projectRoot, dir);
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true });
      writeFileSync(join(full, ".gitkeep"), "", "utf-8");
      created.push(dir);
    }
  }

  // .floe/.gitignore
  const floeGitignore = join(projectRoot, ".floe", ".gitignore");
  const gitignoreContent = [
    "# Runtime state — not committed",
    "state/",
    "node_modules/",
    "",
  ].join("\n");
  if (!existsSync(floeGitignore)) {
    writeFileSync(floeGitignore, gitignoreContent, "utf-8");
    created.push(".floe/.gitignore");
  }

  // Initialise runtime state
  const stateFile = join(projectRoot, ".floe", "state", "current.json");
  if (!existsSync(stateFile)) {
    mkdirSync(join(projectRoot, ".floe", "state"), { recursive: true });
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
      "utf-8"
    );
    created.push(".floe/state/current.json");
  }

  return created;
}

// ── Install dependencies ──────────────────────────────────────────────

function installDeps(projectRoot: string): boolean {
  const floeDir = join(projectRoot, ".floe");
  if (!existsSync(join(floeDir, "package.json"))) return false;

  try {
    execSync("bun install --frozen-lockfile 2>/dev/null || bun install", {
      cwd: floeDir,
      stdio: "pipe",
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Validate ──────────────────────────────────────────────────────────

function runValidation(projectRoot: string): { ok: boolean; output: string } {
  const validateScript = join(projectRoot, ".floe", "scripts", "validate.ts");
  if (!existsSync(validateScript)) {
    return { ok: false, output: "validate.ts not found" };
  }

  try {
    const result = execSync(
      `bun run "${validateScript}" all`,
      { cwd: projectRoot, stdio: "pipe", timeout: 30_000 }
    );
    return { ok: true, output: result.toString("utf-8") };
  } catch (err: any) {
    return { ok: false, output: err.stdout?.toString("utf-8") ?? err.message };
  }
}

// ── CLI entry point ───────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      target: { type: "string" },
      "project-root": { type: "string" },
      force: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      "no-scaffold": { type: "boolean", default: false },
      validate: { type: "boolean", default: false },
      "non-interactive": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const nonInteractive = Boolean(values["non-interactive"]);
  const shouldScaffold = !values["no-scaffold"];
  const shouldValidate = Boolean(values["validate"]);
  const force = Boolean(values["force"]);
  const projectRoot = resolve(
    (values["project-root"] as string | undefined) ?? process.cwd()
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    let clients: Client[];

    if (nonInteractive || !process.stdout.isTTY) {
      const rawTarget = values["target"] as string | undefined;
      clients = rawTarget
        ? (rawTarget.split(",").map((t) => t.trim().toLowerCase()) as Client[])
        : [...CLIENTS];
    } else {
      clients =
        values["target"] != null
          ? ((values["target"] as string).split(",").map((t) => t.trim().toLowerCase()) as Client[])
          : await selectClients(rl);
    }

    // Confirm
    if (!values["yes"] && !nonInteractive && process.stdout.isTTY) {
      console.log(`\n  floe-core will be installed for:\n`);
      for (const c of clients) {
        console.log(`    ${c.padEnd(10)}  skills → ${shortPath(skillRootDir(c, projectRoot))} (${INSTALLABLE_SKILLS.length} pointers)`);
        console.log(`    ${" ".repeat(10)}  agent → ${shortPath(agentTargetFile(c, projectRoot))}`);
      }
      console.log(`\n  Shared framework → ${shortPath(join(projectRoot, ".floe"))}`);
      if (shouldScaffold) console.log("  Project structure will be scaffolded.");
      if (force) console.log("  Existing installations will be replaced (--force).");
      console.log("");
      const ok = await confirm(rl, "Proceed?");
      if (!ok) {
        console.log("Cancelled.");
        process.exit(1);
      }
    }

    console.log("");

    // ── Step 1: Copy .floe/ directory ─────────────────────────────────

    try {
      installFloeDir(projectRoot, force);
      console.log(`  ✓ .floe/ framework installed`);
      if (ensureDodFile(projectRoot)) {
        console.log(`  ✓ .floe/dod.json created`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ .floe/ — ${msg}`);
      process.exit(1);
    }

    // ── Step 2: Install thin SKILL.md pointers + agents per client ────

    const results: { client: Client; status: string }[] = [];

    for (const c of clients) {
      try {
        for (const skill of INSTALLABLE_SKILLS) {
          createThinSkillPointer(c, projectRoot, skill, force);
        }
        installAgentWrapper(c, projectRoot, force);
        results.push({ client: c, status: "ok" });
        console.log(`  ✓ ${c}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ client: c, status: `failed: ${msg}` });
        console.error(`  ✗ ${c} — ${msg}`);
      }
    }

    // ── Step 3: Scaffold project structure ────────────────────────────

    let scaffolded: string[] = [];
    if (shouldScaffold) {
      scaffolded = scaffoldProject(projectRoot);
      if (scaffolded.length > 0) {
        console.log(`  ✓ scaffolded ${scaffolded.length} directories`);
      } else {
        console.log(`  ✓ project structure already present`);
      }
    }

    // ── Step 4: Install dependencies ──────────────────────────────────

    const depsOk = installDeps(projectRoot);
    if (depsOk) {
      console.log(`  ✓ dependencies installed`);
    } else {
      console.log(`  ⚠ dependencies skipped (run 'bun install' in .floe/ manually)`);
    }

    // ── Step 5: Write smart-default config ─────────────────────────────

    const configPath = join(projectRoot, ".floe", "config.json");
    if (!existsSync(configPath)) {
      // Auto-detect best default provider from environment
      const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
      const hasOpenAI = !!process.env.OPENAI_API_KEY;
      let defaultProvider = "copilot"; // safest default — uses GitHub CLI creds
      if (hasAnthropic) defaultProvider = "claude";
      else if (hasOpenAI) defaultProvider = "codex";

      const config = { defaultProvider, configured: false };
      mkdirSync(join(projectRoot, ".floe"), { recursive: true });
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
      console.log(`  ✓ default config written (provider: ${defaultProvider})`);
    }

    // ── Step 6: Validate (optional) ───────────────────────────────────

    if (shouldValidate) {
      const validation = runValidation(projectRoot);
      if (validation.ok) {
        console.log(`  ✓ validation passed`);
      } else {
        console.log(`  ⚠ validation issues found:`);
        console.log(validation.output);
      }
    }

    // ── Summary ───────────────────────────────────────────────────────

    const failures = results.filter((r) => r.status.startsWith("failed"));
    if (failures.length > 0) {
      console.error(`\n✗ ${failures.length} installation(s) failed.`);
      process.exit(1);
    }

    console.log(`\n✓ floe-core installed. Open your agent (codex, claude, or copilot) to start.`);
    console.log(`  Model configuration will be guided on first run.`);
    console.log("");
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
