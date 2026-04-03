#!/usr/bin/env bun
/**
 * floe-exec installer — invoked via:
 *   bunx github:floe-ai/floe-core
 *
 * Single-step install: copies skill + agent definitions, scaffolds the
 * delivery structure, installs runtime dependencies, and registers the
 * MCP server for each provider. The MCP server auto-starts when the
 * provider loads its config — no manual server start needed.
 *
 * Flags:
 *   --project-root <path>  Target project (default: cwd)
 *   --target <clients>     Comma-separated: codex,copilot,claude (default: all)
 *   --force                Overwrite existing installations
 *   --no-scaffold          Skip delivery/docs/.ai directory creation
 *   --validate             Run consistency checks after install
 *   --yes / -y             Skip confirmation prompt
 *   --non-interactive      No prompts (implies --yes)
 *
 * Prerequisites: bun ≥ 1.0
 */

import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { execSync } from "node:child_process";

// ── Constants ─────────────────────────────────────────────────────────

const SKILL_NAME = "floe-exec";
const CLIENTS = ["codex", "copilot", "claude"] as const;
type Client = (typeof CLIENTS)[number];

// ── Path resolution ───────────────────────────────────────────────────

const SCRIPT_DIR = import.meta.dir;
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");

function skillSourceDir(): string {
  const candidate = join(PACKAGE_ROOT, "skills", SKILL_NAME);
  if (existsSync(candidate)) return candidate;
  throw new Error(`Skill source not found at: ${candidate}`);
}

function agentSourceDir(client: Client): string {
  const candidate = join(PACKAGE_ROOT, "agents", client);
  if (existsSync(candidate)) return candidate;
  throw new Error(`Agent source not found for ${client} at: ${candidate}`);
}

function skillTargetDir(client: Client, projectRoot: string): string {
  const dirs: Record<Client, string> = {
    codex: join(projectRoot, ".agents", "skills", SKILL_NAME),
    copilot: join(projectRoot, ".github", "skills", SKILL_NAME),
    claude: join(projectRoot, ".claude", "skills", SKILL_NAME),
  };
  return dirs[client];
}

function agentTargetDir(client: Client, projectRoot: string): string {
  const dirs: Record<Client, string> = {
    codex: projectRoot, // AGENTS.md goes in project root
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

function installSkill(client: Client, projectRoot: string, force: boolean): string {
  const source = skillSourceDir();
  const dest = skillTargetDir(client, projectRoot);
  copyDir(source, dest, force);
  return dest;
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

function registerMcpServer(client: Client, projectRoot: string, runtimePath: string): void {
  if (client === "copilot") {
    const mcpConfigPath = join(projectRoot, ".github", "copilot-mcp.json");
    mkdirSync(join(mcpConfigPath, ".."), { recursive: true });
    let existing: any = {};
    if (existsSync(mcpConfigPath)) {
      try { existing = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch {}
    }
    existing.mcpServers = existing.mcpServers ?? {};
    existing.mcpServers["floe-runtime"] = {
      type: "stdio",
      command: "bun",
      args: ["run", runtimePath],
      env: {},
    };
    writeFileSync(mcpConfigPath, JSON.stringify(existing, null, 2), "utf-8");

  } else if (client === "claude") {
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    mkdirSync(join(settingsPath, ".."), { recursive: true });
    let existing: any = {};
    if (existsSync(settingsPath)) {
      try { existing = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    }
    existing.mcpServers = existing.mcpServers ?? {};
    existing.mcpServers["floe-runtime"] = {
      type: "stdio",
      command: "bun",
      args: ["run", runtimePath],
      env: {},
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2), "utf-8");

  } else if (client === "codex") {
    // Codex: project-local .codex/config.toml
    const codexDir = join(projectRoot, ".codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });

    const mcpBlock = [
      "",
      `[mcp_servers.floe-runtime]`,
      `command = "bun"`,
      `args = ["run", "${runtimePath}"]`,
      `enabled = true`,
      "",
    ].join("\n");

    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      if (content.includes("[mcp_servers.floe-runtime]")) {
        // Already registered — leave it alone
        return;
      }
      writeFileSync(configPath, content + mcpBlock, "utf-8");
    } else {
      writeFileSync(configPath, mcpBlock.trimStart(), "utf-8");
    }
  }
}

// ── Scaffold ──────────────────────────────────────────────────────────

function scaffoldProject(projectRoot: string): string[] {
  const created: string[] = [];
  const dirs = [
    "delivery/releases", "delivery/epics", "delivery/features",
    "delivery/reviews", "delivery/summaries", "delivery/notes",
    "docs/prd", "docs/architecture", "docs/decisions",
    ".ai/state", ".ai/memory",
  ];

  for (const dir of dirs) {
    const full = join(projectRoot, dir);
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true });
      writeFileSync(join(full, ".gitkeep"), "", "utf-8");
      created.push(dir);
    }
  }

  // .ai/.gitignore
  const aiGitignore = join(projectRoot, ".ai", ".gitignore");
  if (!existsSync(aiGitignore)) {
    writeFileSync(aiGitignore, "state/\nmemory/*.db\nmemory/*.db-*\n", "utf-8");
    created.push(".ai/.gitignore");
  }

  // Initialise runtime state if not present
  const stateFile = join(projectRoot, ".ai", "state", "current.json");
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
      "utf-8"
    );
    created.push(".ai/state/current.json");
  }

  return created;
}

// ── Runtime dependency install ────────────────────────────────────────

function installRuntimeDeps(): boolean {
  const runtimeDir = join(PACKAGE_ROOT, "runtime");
  if (!existsSync(join(runtimeDir, "package.json"))) return false;

  try {
    execSync("bun install --frozen-lockfile 2>/dev/null || bun install", {
      cwd: runtimeDir,
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
  const validateScript = join(PACKAGE_ROOT, "skills", SKILL_NAME, "scripts", "validate.ts");
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
      console.log(`\n  floe-exec will be installed for:\n`);
      for (const c of clients) {
        console.log(`    ${c.padEnd(10)}  skill → ${shortPath(skillTargetDir(c, projectRoot))}`);
        console.log(`    ${" ".repeat(10)}  agents → ${shortPath(agentTargetDir(c, projectRoot))}`);
      }
      if (shouldScaffold) console.log("\n  Project structure will be scaffolded.");
      if (force) console.log("  Existing installations will be replaced (--force).");
      console.log("");
      const ok = await confirm(rl, "Proceed?");
      if (!ok) {
        console.log("Cancelled.");
        process.exit(1);
      }
    }

    console.log("");

    // ── Step 1: Install skill + agents per client ─────────────────────

    const results: { client: Client; status: string }[] = [];
    const runtimeServerPath = join(PACKAGE_ROOT, "runtime", "src", "server.ts");

    for (const c of clients) {
      try {
        installSkill(c, projectRoot, force);
        installAgents(c, projectRoot, force);
        registerMcpServer(c, projectRoot, runtimeServerPath);
        results.push({ client: c, status: "ok" });
        console.log(`  ✓ ${c}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ client: c, status: `failed: ${msg}` });
        console.error(`  ✗ ${c} — ${msg}`);
      }
    }

    // ── Step 2: Scaffold project structure ────────────────────────────

    let scaffolded: string[] = [];
    if (shouldScaffold) {
      scaffolded = scaffoldProject(projectRoot);
      if (scaffolded.length > 0) {
        console.log(`  ✓ scaffolded ${scaffolded.length} directories`);
      } else {
        console.log(`  ✓ project structure already present`);
      }
    }

    // ── Step 3: Install runtime dependencies ─────────────────────────

    const depsOk = installRuntimeDeps();
    if (depsOk) {
      console.log(`  ✓ runtime dependencies installed`);
    } else {
      console.log(`  ⚠ runtime dependencies skipped (run 'bun install' in runtime/ manually)`);
    }

    // ── Step 4: Validate (optional) ──────────────────────────────────

    if (shouldValidate) {
      const validation = runValidation(projectRoot);
      if (validation.ok) {
        console.log(`  ✓ validation passed`);
      } else {
        console.log(`  ⚠ validation issues found:`);
        console.log(validation.output);
      }
    }

    // ── Summary ──────────────────────────────────────────────────────

    const failures = results.filter((r) => r.status.startsWith("failed"));
    if (failures.length > 0) {
      console.error(`\n✗ ${failures.length} installation(s) failed.`);
      process.exit(1);
    }

    console.log(`\n✓ floe-exec installed. Open your agent (codex, claude, or copilot) to start.`);
    console.log(`  The MCP server auto-starts when the provider loads its config — no manual setup needed.\n`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
