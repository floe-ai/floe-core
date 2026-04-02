#!/usr/bin/env bun
/**
 * floe-exec installer — invoked via:
 *   bunx github:floe-ai/floe-core
 *
 * Copies the floe-exec skill and agent definitions into one or more
 * agent client directories. Optionally scaffolds the delivery structure.
 *
 * Prerequisites: bun, git
 */

import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

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
    // Codex: copy AGENTS.md to project root
    const source = join(sourceDir, "AGENTS.md");
    const dest = join(targetDir, "AGENTS.md");
    if (existsSync(dest) && !force) {
      throw new Error(`Already exists: ${dest} (use --force to overwrite)`);
    }
    mkdirSync(targetDir, { recursive: true });
    cpSync(source, dest);
    return dest;
  } else {
    // Copilot/Claude: copy agent files to agents directory
    copyDir(sourceDir, targetDir, force);
    return targetDir;
  }
}

function registerMcpServer(client: Client, projectRoot: string, runtimePath: string): void {
  const mcpEntry = {
    type: "stdio",
    command: "bun",
    args: ["run", runtimePath],
    env: {},
  };

  if (client === "copilot") {
    // Copilot: project-local .github/copilot-mcp.json
    const mcpConfigPath = join(projectRoot, ".github", "copilot-mcp.json");
    mkdirSync(join(mcpConfigPath, ".."), { recursive: true });
    let existing: any = {};
    if (existsSync(mcpConfigPath)) {
      try { existing = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch {}
    }
    existing.mcpServers = existing.mcpServers ?? {};
    existing.mcpServers["floe-runtime"] = mcpEntry;
    writeFileSync(mcpConfigPath, JSON.stringify(existing, null, 2), "utf-8");

  } else if (client === "claude") {
    // Claude: project-local .claude/settings.json
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    mkdirSync(join(settingsPath, ".."), { recursive: true });
    let existing: any = {};
    if (existsSync(settingsPath)) {
      try { existing = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    }
    existing.mcpServers = existing.mcpServers ?? {};
    existing.mcpServers["floe-runtime"] = mcpEntry;
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2), "utf-8");

  } else if (client === "codex") {
    // Codex: no project-local MCP config equivalent in v1.
    // Print manual setup instructions.
    console.log(`
  ────────────────────────────────────────────────────────
  Codex MCP setup (manual):
  
  Codex does not currently support project-local MCP config files.
  To use floe-runtime with Codex, add the following to your
  Codex CLI configuration (~/.codex/config.toml) manually:
  
  [[mcp_servers]]
  name = "floe-runtime"
  type = "stdio"
  command = "bun"
  args = ["run", "${runtimePath}"]
  
  Reference: https://developers.openai.com/codex/mcp
  ────────────────────────────────────────────────────────
`);
  }
}

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

  return created;
}

// ── CLI entry point ───────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      target: { type: "string" },
      "project-root": { type: "string" },
      force: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      scaffold: { type: "boolean", default: false },
      "non-interactive": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const nonInteractive = Boolean(values["non-interactive"]);
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
          ? (values["target"].split(",").map((t) => t.trim().toLowerCase()) as Client[])
          : await selectClients(rl);
    }

    // Confirm
    if (!values["yes"] && process.stdout.isTTY) {
      console.log(`\n  floe-exec will be installed for:\n`);
      for (const c of clients) {
        console.log(`    ${c.padEnd(10)}  skill → ${shortPath(skillTargetDir(c, projectRoot))}`);
        console.log(`    ${" ".repeat(10)}  agents → ${shortPath(agentTargetDir(c, projectRoot))}`);
      }
      if (values["scaffold"]) console.log("\n  Project structure will be scaffolded.");
      if (values["force"]) console.log("  Existing installations will be replaced (--force).");
      console.log("");
      const ok = await confirm(rl, "Proceed?");
      if (!ok) {
        console.log("Cancelled.");
        process.exit(1);
      }
    }

    // Install
    const results: { client: Client; skill: string; agents: string; status: string }[] = [];

    for (const c of clients) {
      try {
        const skillPath = installSkill(c, projectRoot, Boolean(values["force"]));
        const agentPath = installAgents(c, projectRoot, Boolean(values["force"]));

        // Register floe-runtime MCP server project-locally
        const runtimeServerPath = join(PACKAGE_ROOT, "runtime", "src", "server.ts");
        registerMcpServer(c, projectRoot, runtimeServerPath);

        results.push({ client: c, skill: skillPath, agents: agentPath, status: "installed" });
        console.log(`  ✓ ${c.padEnd(10)} → skill + agents installed`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ client: c, skill: "", agents: "", status: `failed: ${msg}` });
        console.error(`  ✗ ${c.padEnd(10)} → ${msg}`);
      }
    }

    // Scaffold if requested
    let scaffolded: string[] = [];
    if (values["scaffold"]) {
      scaffolded = scaffoldProject(projectRoot);
      if (scaffolded.length > 0) {
        console.log(`\n  Scaffolded ${scaffolded.length} directories`);
      } else {
        console.log("\n  Project structure already exists");
      }
    }

    const failures = results.filter((r) => r.status.startsWith("failed"));
    if (failures.length > 0) {
      console.error(`\n${failures.length} installation(s) failed.`);
      process.exit(1);
    }

    console.log(`\n✓ ${results.length} installation(s) complete.`);
    if (!values["scaffold"]) {
      console.log("  Run with --scaffold to also create delivery/ and .ai/ directories.");
    }
    console.log("  Agents can now use the floe-exec skill for structured delivery.");
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
