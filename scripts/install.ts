#!/usr/bin/env bun
/**
 * floe-core installer — invoked via:
 *   bunx github:floe-ai/floe-core
 *
 * Single-step install: copies .floe/ directory (scripts, schemas, roles,
 * runtime, CLI entrypoint), installs provider agent files, scaffolds the
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

import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
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

function agentSourceDir(client: Client): string {
  const candidate = join(PACKAGE_ROOT, "agents", client);
  if (existsSync(candidate)) return candidate;
  throw new Error(`Agent source not found for ${client} at: ${candidate}`);
}

function skillTargetDir(client: Client, projectRoot: string): string {
  const dirs: Record<Client, string> = {
    codex: join(projectRoot, ".agents", "skills", "floe-exec"),
    copilot: join(projectRoot, ".github", "skills", "floe-exec"),
    claude: join(projectRoot, ".claude", "skills", "floe-exec"),
  };
  return dirs[client];
}

function agentTargetDir(client: Client, projectRoot: string): string {
  const dirs: Record<Client, string> = {
    codex: projectRoot,
    copilot: join(projectRoot, ".github", "agents"),
    claude: join(projectRoot, ".claude", "agents"),
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

function copyDir(source: string, dest: string, force: boolean): void {
  if (existsSync(dest)) {
    if (!force) throw new Error(`Already exists: ${dest} (use --force to overwrite)`);
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(resolve(dest, ".."), { recursive: true });
  cpSync(source, dest, { recursive: true });
}

function installFloeDir(projectRoot: string, force: boolean): void {
  const source = floeSourceDir();
  const dest = join(projectRoot, ".floe");

  if (existsSync(dest)) {
    if (!force) throw new Error(`Already exists: ${dest} (use --force to overwrite)`);
    rmSync(dest, { recursive: true, force: true });
  }

  mkdirSync(dest, { recursive: true });

  // Copy subdirectories: bin, scripts, schemas, roles, runtime
  for (const subdir of ["bin", "scripts", "schemas", "roles", "runtime"]) {
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

  // Create memory directory (empty, for floe-mem)
  mkdirSync(join(dest, "memory"), { recursive: true });
}

function createThinSkillPointer(client: Client, projectRoot: string, force: boolean): void {
  const targetDir = skillTargetDir(client, projectRoot);
  const skillMdPath = join(targetDir, "SKILL.md");

  if (existsSync(skillMdPath) && !force) {
    throw new Error(`Already exists: ${skillMdPath} (use --force to overwrite)`);
  }

  mkdirSync(targetDir, { recursive: true });

  const content = [
    "---",
    "name: floe-exec",
    "description: Structured delivery framework. See .floe/ for full docs.",
    "---",
    "",
    "The full skill definition is at: `.floe/SKILL.md`",
    "",
    "Read that file and follow it.",
    "",
  ].join("\n");

  writeFileSync(skillMdPath, content, "utf-8");
}

function installAgents(client: Client, projectRoot: string, force: boolean): string {
  const sourceDir = agentSourceDir(client);
  const targetDir = agentTargetDir(client, projectRoot);

  if (client === "codex") {
    const source = join(sourceDir, "AGENTS.md");
    const dest = join(targetDir, "AGENTS.md");
    if (existsSync(dest) && !force) {
      throw new Error(`Already exists: ${dest} (use --force to overwrite)`);
    }
    mkdirSync(targetDir, { recursive: true });
    cpSync(source, dest);
    return dest;
  } else {
    copyDir(sourceDir, targetDir, force);
    return targetDir;
  }
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
    "memory/*.db",
    "memory/*.db-*",
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
        console.log(`    ${c.padEnd(10)}  skill → ${shortPath(skillTargetDir(c, projectRoot))}`);
        console.log(`    ${" ".repeat(10)}  agents → ${shortPath(agentTargetDir(c, projectRoot))}`);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ .floe/ — ${msg}`);
      process.exit(1);
    }

    // ── Step 2: Install thin SKILL.md pointers + agents per client ────

    const results: { client: Client; status: string }[] = [];

    for (const c of clients) {
      try {
        createThinSkillPointer(c, projectRoot, force);
        installAgents(c, projectRoot, force);
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

    // ── Step 5: Validate (optional) ───────────────────────────────────

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

    console.log(`\n✓ floe-core installed. Open your agent (codex, claude, or copilot) to start.\n`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
