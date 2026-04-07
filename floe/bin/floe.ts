#!/usr/bin/env bun
/**
 * floe CLI — worker session management for the floe execution framework.
 *
 * Usage: bun run .floe/bin/floe.ts <command> [options]
 *
 * Commands:
 *   launch-worker        Launch a new worker session
 *   resume-worker        Resume an existing session
 *   message-worker       Send a message to an active worker
 *   get-worker-status    Get session status
 *   replace-worker       Stop and re-launch a worker
 *   stop-worker          Stop a worker session
 *   list-active-workers  List all active sessions
 *   manage-feature-pair  Launch implementer + reviewer pair
 *   check-alignment      Check approach alignment status for a feature
 *   configure            Set up provider defaults (interactive or flags)
 *   show-config          Show current provider configuration
 *   list-models          List available models for a provider
 *   update-config        Update provider/model/thinking configuration
 *
 * Provider resolution order:
 *   1. --provider flag
 *   2. FLOE_PROVIDER env var
 *   3. .floe/config.json role-specific override
 *   4. .floe/config.json defaultProvider
 *   5. Error (no silent mock default)
 *
 * Provider env vars:
 *   ANTHROPIC_API_KEY   — required for Claude adapter
 *   OPENAI_API_KEY      — optional for Codex (falls back to local sign-in)
 *   FLOE_PROVIDER       — override provider for all roles
 */

import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { SessionRegistry } from "../runtime/registry.ts";
import type { ProviderAdapter } from "../runtime/adapters/interface.ts";
import { MockAdapter } from "../runtime/adapters/mock.ts";
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── Adapter registry ────────────────────────────────────────────────

const adapters = new Map<string, ProviderAdapter>();
adapters.set("mock", new MockAdapter());

const adapterLoadErrors = new Map<string, string>();

async function loadLiveAdapters(): Promise<void> {
  try {
    // @ts-ignore — optional peer dependency
    const { CodexAdapter } = await import("../runtime/adapters/codex.ts");
    adapters.set("codex", new CodexAdapter());
  } catch (e: any) {
    adapterLoadErrors.set("codex", e.message ?? String(e));
  }

  try {
    // @ts-ignore — optional peer dependency
    const { ClaudeAdapter } = await import("../runtime/adapters/claude.ts");
    adapters.set("claude", new ClaudeAdapter());
  } catch (e: any) {
    adapterLoadErrors.set("claude", e.message ?? String(e));
  }

  try {
    // @ts-ignore — optional peer dependency
    const { CopilotAdapter } = await import("../runtime/adapters/copilot.ts");
    adapters.set("copilot", new CopilotAdapter());
  } catch (e: any) {
    adapterLoadErrors.set("copilot", e.message ?? String(e));
  }
}

// ─── Project root detection ──────────────────────────────────────────

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if ([".git", ".floe", ".github", ".agents", ".claude"].some(m => existsSync(join(dir, m)))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

// ─── Configuration ───────────────────────────────────────────────────

interface FloeConfig {
  defaultProvider: string;
  roles?: {
    planner?: { provider?: string; model?: string; thinking?: string };
    implementer?: { provider?: string; model?: string; thinking?: string };
    reviewer?: { provider?: string; model?: string; thinking?: string };
  };
}

function loadConfig(projectRoot: string): FloeConfig | null {
  const configPath = join(projectRoot, ".floe", "config.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
}

function resolveProvider(role: string, args: Record<string, any>, config: FloeConfig | null): {
  provider: string;
  model?: string;
  thinking?: string;
} {
  // 1. CLI flag
  if (args.provider) return { provider: args.provider };

  // 2. Environment variable
  if (process.env.FLOE_PROVIDER) return { provider: process.env.FLOE_PROVIDER };

  // 3. Config role-specific
  if (config?.roles) {
    const roleConfig = (config.roles as any)[role];
    if (roleConfig?.provider) {
      return { provider: roleConfig.provider, model: roleConfig.model, thinking: roleConfig.thinking };
    }
  }

  // 4. Config default
  if (config?.defaultProvider) {
    const roleConfig = config.roles ? (config.roles as any)[role] : undefined;
    return {
      provider: config.defaultProvider,
      model: roleConfig?.model,
      thinking: roleConfig?.thinking,
    };
  }

  // 5. No provider configured
  return { provider: "" };
}

function getAdapter(provider: string): { adapter: ProviderAdapter | null; error: string | null } {
  if (!provider) {
    return {
      adapter: null,
      error: "No provider configured. Run: bun run .floe/bin/floe.ts configure",
    };
  }
  const adapter = adapters.get(provider);
  if (!adapter) {
    const loadError = adapterLoadErrors.get(provider);
    const hint = loadError
      ? `Adapter for '${provider}' failed to load: ${loadError}`
      : `No adapter for provider: ${provider}`;
    return { adapter: null, error: hint };
  }
  return { adapter, error: null };
}

// ─── Role content loading ────────────────────────────────────────────

function readRoleContent(role: string, projectRoot: string): { content: string | undefined; path: string | undefined } {
  const candidates = [
    join(projectRoot, ".floe", "roles", `${role}.md`),
    join(projectRoot, "skills", "floe-exec", "roles", `${role}.md`),
    join(projectRoot, ".github", "skills", "floe-exec", "roles", `${role}.md`),
    join(projectRoot, ".agents", "skills", "floe-exec", "roles", `${role}.md`),
    join(projectRoot, ".claude", "skills", "floe-exec", "roles", `${role}.md`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return { content: readFileSync(p, "utf-8"), path: p };
    }
  }
  return { content: undefined, path: undefined };
}

// ─── Validation helpers ──────────────────────────────────────────────

function featureArtefactExists(featureId: string, projectRoot: string): boolean {
  const featuresDir = join(projectRoot, "delivery", "features");
  if (!existsSync(featuresDir)) return false;
  return existsSync(join(featuresDir, `${featureId}.json`));
}

function artefactExists(type: string, id: string, projectRoot: string): boolean {
  const dir = join(projectRoot, "delivery", `${type}s`);
  if (!existsSync(dir)) return false;
  return existsSync(join(dir, `${id}.json`));
}

function getAlignmentStatus(featureId: string, projectRoot: string): {
  hasReview: boolean;
  approachStatus: string | null;
  reviewId: string | null;
} {
  const reviewsDir = join(projectRoot, "delivery", "reviews");
  if (!existsSync(reviewsDir)) return { hasReview: false, approachStatus: null, reviewId: null };

  const files = readdirSync(reviewsDir).filter(f => f.endsWith(".json"));
  for (const f of files) {
    try {
      const review = JSON.parse(readFileSync(join(reviewsDir, f), "utf-8"));
      if (review.target_id === featureId && review.status === "open") {
        const status = review.approach_proposal?.verdict ?? null;
        return { hasReview: true, approachStatus: status, reviewId: review.id };
      }
    } catch {}
  }
  return { hasReview: false, approachStatus: null, reviewId: null };
}

// ─── Commands ────────────────────────────────────────────────────────

const projectRoot = findProjectRoot();
const registry = new SessionRegistry(projectRoot);

async function launchWorker(args: Record<string, any>) {
  const role = args.role;
  if (!role) return { ok: false, error: "Missing required flag: --role" };

  const config = loadConfig(projectRoot);
  const resolved = resolveProvider(role, args, config);
  const { adapter, error } = getAdapter(resolved.provider);
  if (!adapter) return { ok: false, error };

  // Planner scope validation
  if (role === "planner") {
    const scope = args.scope;
    const target = args.target;
    if (!scope || !target) {
      return { ok: false, error: "launch-worker --role planner requires --scope <release|epic> and --target <id>" };
    }
    if (scope !== "release" && scope !== "epic") {
      return { ok: false, error: `Invalid --scope: ${scope}. Must be 'release' or 'epic'.` };
    }
    if (!artefactExists(scope, target, projectRoot)) {
      return { ok: false, error: `${scope} artefact not found: ${target}` };
    }
  }

  // Implementer/reviewer require feature
  if ((role === "implementer" || role === "reviewer") && !args.feature) {
    return { ok: false, error: `launch-worker --role ${role} requires --feature <id>` };
  }

  // Validate feature exists if provided
  if (args.feature && !featureArtefactExists(args.feature, projectRoot)) {
    return { ok: false, error: `Feature artefact not found: ${args.feature}. Create the feature via the Planner first.` };
  }

  const { content: roleContent, path: roleContentPath } = readRoleContent(role, projectRoot);

  const session = await adapter.startSession({
    role,
    provider: resolved.provider as any,
    featureId: args.feature,
    epicId: args.epic,
    releaseId: args.release,
    roleContent,
    roleContentPath,
    contextAddendum: args.context,
    model: resolved.model,
    thinking: resolved.thinking,
  });

  registry.register(session);
  return { ok: true, sessionId: session.id, role: session.role, provider: session.provider, status: session.status };
}

async function resumeWorker(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const { adapter, error } = getAdapter(stored.provider);
  if (!adapter) return { ok: false, error };

  let roleContent: string | undefined;
  if (stored.roleContentPath && existsSync(stored.roleContentPath)) {
    try { roleContent = readFileSync(stored.roleContentPath, "utf-8"); } catch {}
  }

  const session = await adapter.resumeSession(
    args.session,
    stored,
    roleContent ? { roleContent } : undefined
  );

  registry.update(args.session, { status: session.status, updatedAt: session.updatedAt });
  return { ok: true, sessionId: session.id, status: session.status };
}

async function messageWorker(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const { adapter, error } = getAdapter(stored.provider);
  if (!adapter) return { ok: false, error };

  // Hard alignment gate: block implementer messages when approach not approved
  if (stored.role === "implementer" && stored.featureId && !args["force-no-alignment"]) {
    const alignment = getAlignmentStatus(stored.featureId, projectRoot);
    if (!alignment.hasReview || alignment.approachStatus !== "approved") {
      return {
        ok: false,
        error: "Approach not approved — implementer messages are blocked until the reviewer approves the execution approach.",
        featureId: stored.featureId,
        hasReview: alignment.hasReview,
        approachStatus: alignment.approachStatus,
        hint: "Use --force-no-alignment to override (visible, intentional override only).",
      };
    }
  }

  const result = await adapter.sendMessage(args.session, args.message);
  const now = new Date().toISOString();

  const updated = registry.get(args.session);
  registry.update(args.session, { lastMessageAt: now, metadata: updated?.metadata });

  return { ok: true, sessionId: args.session, content: result.content, finishReason: result.finishReason, usage: result.usage };
}

async function getWorkerStatus(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const { adapter, error } = getAdapter(stored.provider);
  if (!adapter) return { ok: false, error };

  const status = await adapter.getStatus(args.session);
  return { ok: true, sessionId: args.session, role: stored.role, provider: stored.provider, status, featureId: stored.featureId };
}

async function replaceWorker(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const adapter = adapters.get(stored.provider);
  if (adapter) {
    await adapter.stopSession(args.session).catch(() => {});
    await adapter.closeSession(args.session).catch(() => {});
  }
  registry.setStatus(args.session, "stopped");

  const newSession = await launchWorker({
    role: stored.role,
    provider: stored.provider,
    feature: stored.featureId,
    epic: stored.epicId,
    release: stored.releaseId,
  });

  return { ok: true, replacedSessionId: args.session, newSessionId: (newSession as any).sessionId, reason: args.reason };
}

async function stopWorker(args: Record<string, any>) {
  const stored = registry.get(args.session);
  if (!stored) return { ok: false, error: `Session not found: ${args.session}` };

  const adapter = adapters.get(stored.provider);
  if (adapter) {
    await adapter.stopSession(args.session).catch(() => {});
    await adapter.closeSession(args.session).catch(() => {});
  }
  registry.setStatus(args.session, "stopped");

  return { ok: true, sessionId: args.session, stopped: true };
}

async function listActiveWorkers(args: Record<string, any>) {
  let sessions = registry.listActive();
  if (args.feature) sessions = sessions.filter(s => s.featureId === args.feature);

  return {
    ok: true,
    count: sessions.length,
    workers: sessions.map(s => ({
      id: s.id, role: s.role, provider: s.provider, status: s.status,
      featureId: s.featureId, createdAt: s.createdAt, lastMessageAt: s.lastMessageAt,
    })),
  };
}

async function manageFeaturePair(args: Record<string, any>) {
  if (!args.feature) return { ok: false, error: "manage-feature-pair requires --feature <id>" };

  if (!featureArtefactExists(args.feature, projectRoot)) {
    return { ok: false, error: `Feature artefact not found: ${args.feature}. The Planner must create the feature before execution can begin.` };
  }

  const config = loadConfig(projectRoot);

  // Resolve providers for implementer and reviewer independently
  const implResolved = args["implementer-provider"]
    ? { provider: args["implementer-provider"] }
    : resolveProvider("implementer", args, config);
  const revResolved = args["reviewer-provider"]
    ? { provider: args["reviewer-provider"] }
    : resolveProvider("reviewer", args, config);

  const [implementer, reviewer] = await Promise.all([
    launchWorker({ role: "implementer", provider: implResolved.provider, feature: args.feature, epic: args.epic, release: args.release }),
    launchWorker({ role: "reviewer", provider: revResolved.provider, feature: args.feature, epic: args.epic, release: args.release }),
  ]);

  return {
    ok: true,
    featureId: args.feature,
    implementer: { sessionId: (implementer as any).sessionId, provider: implResolved.provider },
    reviewer: { sessionId: (reviewer as any).sessionId, provider: revResolved.provider },
  };
}

async function checkAlignment(args: Record<string, any>) {
  if (!args.feature) return { ok: false, error: "check-alignment requires --feature <id>" };

  const alignment = getAlignmentStatus(args.feature, projectRoot);
  return {
    ok: true,
    featureId: args.feature,
    hasReview: alignment.hasReview,
    approachStatus: alignment.approachStatus,
    reviewId: alignment.reviewId,
    approved: alignment.approachStatus === "approved",
  };
}

// ─── Configure command ───────────────────────────────────────────────

const PROVIDERS = ["claude", "codex", "copilot"] as const;
const PROVIDER_HINTS: Record<string, string> = {
  claude: "requires ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY or local sign-in",
  copilot: "uses GitHub CLI credentials",
};

interface ModelChoice { id: string; label: string }

const CURATED_MODELS: Record<string, ModelChoice[]> = {
  claude: [
    { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", label: "Claude Opus 4" },
    { id: "claude-haiku-4-20250514", label: "Claude Haiku 4" },
  ],
  codex: [
    { id: "o3-mini", label: "o3-mini" },
    { id: "o4-mini", label: "o4-mini" },
    { id: "gpt-4.1", label: "GPT-4.1" },
  ],
  copilot: [],
};

const THINKING_LEVELS: ModelChoice[] = [
  { id: "normal", label: "normal (default)" },
  { id: "low", label: "low" },
  { id: "high", label: "high (extended thinking)" },
];

const modelCache = new Map<string, ModelChoice[]>();

async function fetchClaudeModels(): Promise<ModelChoice[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return CURATED_MODELS.claude;
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) return CURATED_MODELS.claude;
    const data = (await res.json()) as { data?: { id: string; display_name?: string }[] };
    const models = (data.data ?? [])
      .filter(m => m.id && !m.id.includes("embed"))
      .map(m => ({ id: m.id, label: m.display_name ?? m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return models.length > 0 ? models : CURATED_MODELS.claude;
  } catch {
    return CURATED_MODELS.claude;
  }
}

async function fetchOpenAIModels(): Promise<ModelChoice[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return CURATED_MODELS.codex;
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return CURATED_MODELS.codex;
    const data = (await res.json()) as { data?: { id: string }[] };
    const relevant = new Set(["o3-mini", "o4-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini", "o3", "o4"]);
    const models = (data.data ?? [])
      .filter(m => m.id && relevant.has(m.id))
      .map(m => ({ id: m.id, label: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return models.length > 0 ? models : CURATED_MODELS.codex;
  } catch {
    return CURATED_MODELS.codex;
  }
}

async function fetchModelsForProvider(provider: string): Promise<ModelChoice[]> {
  if (modelCache.has(provider)) return modelCache.get(provider)!;
  let models: ModelChoice[];
  if (provider === "claude") models = await fetchClaudeModels();
  else if (provider === "codex") models = await fetchOpenAIModels();
  else models = [];
  modelCache.set(provider, models);
  return models;
}

function askLine(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function selectFromList(
  rl: ReturnType<typeof createInterface>,
  items: ModelChoice[],
  prompt: string,
  options?: { allowSkip?: boolean; defaultIndex?: number },
): Promise<string | null> {
  if (items.length === 0) return null;
  console.error(prompt);
  items.forEach((item, i) => {
    const marker = options?.defaultIndex === i ? " (recommended)" : "";
    console.error(`  ${i + 1}) ${item.label}${marker}`);
  });
  if (options?.allowSkip) {
    console.error(`  ${items.length + 1}) Skip (use provider default)`);
  }
  const max = items.length + (options?.allowSkip ? 1 : 0);
  while (true) {
    const raw = (await askLine(rl, "> ")).trim();
    if (!raw && options?.defaultIndex !== undefined) return items[options.defaultIndex].id;
    const idx = parseInt(raw, 10) - 1;
    if (options?.allowSkip && idx === items.length) return null;
    if (idx >= 0 && idx < items.length) return items[idx].id;
    console.error(`  Enter 1-${max}`);
  }
}

async function configureCommand(args: Record<string, any>) {
  const configPath = join(projectRoot, ".floe", "config.json");
  const nonInteractive = !!args["non-interactive"];

  if (nonInteractive) {
    const defaultProvider = args["default-provider"];
    if (!defaultProvider) return { ok: false, error: "configure --non-interactive requires --default-provider <claude|codex|copilot>" };
    if (!PROVIDERS.includes(defaultProvider as any)) return { ok: false, error: `Invalid provider: ${defaultProvider}. Must be: ${PROVIDERS.join(", ")}` };

    const config: FloeConfig = { defaultProvider };
    if (args.model || args.thinking) {
      config.roles = {};
      for (const role of ["planner", "implementer", "reviewer"] as const) {
        const roleConf: Record<string, string> = {};
        if (args.model) roleConf.model = args.model;
        if (args.thinking) roleConf.thinking = args.thinking;
        (config.roles as any)[role] = roleConf;
      }
    }
    mkdirSync(join(projectRoot, ".floe"), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return { ok: true, message: `Wrote ${configPath}`, config };
  }

  // Interactive mode
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  try {
    console.error("\nfloe provider configuration");
    console.error("────────────────────────────\n");

    // 1. Default provider
    console.error("Which provider should workers use by default?");
    PROVIDERS.forEach((p, i) => console.error(`  ${i + 1}) ${p}   (${PROVIDER_HINTS[p]})`));

    let defaultProvider = "";
    while (!defaultProvider) {
      const raw = (await askLine(rl, "> ")).trim();
      const byIndex = PROVIDERS[parseInt(raw, 10) - 1];
      const byName = PROVIDERS.find(p => p === raw);
      const resolved = byIndex ?? byName;
      if (resolved) {
        defaultProvider = resolved;
      } else {
        console.error(`  Invalid choice. Enter 1-${PROVIDERS.length} or a provider name.`);
      }
    }

    const config: FloeConfig = { defaultProvider, roles: {} };
    let globalModel: string | null = null;
    let globalThinking: string | null = null;

    // 2. Default model (fetched from API or curated fallback)
    const defaultModels = await (async () => {
      console.error(`\nFetching available models for ${defaultProvider}...`);
      return fetchModelsForProvider(defaultProvider);
    })();

    if (defaultModels.length > 0) {
      globalModel = await selectFromList(rl, defaultModels, `\nDefault model for ${defaultProvider}:`, {
        allowSkip: true,
        defaultIndex: 0,
      });
    }

    // 3. Default thinking level
    globalThinking = await selectFromList(rl, THINKING_LEVELS, "\nDefault reasoning level:", {
      defaultIndex: 0,
    });

    // 4. Per-role customization
    console.error(`\nDefault: ${defaultProvider}${globalModel ? ` / ${globalModel}` : ""}${globalThinking && globalThinking !== "normal" ? ` / thinking=${globalThinking}` : ""}`);
    const customizeRaw = (await askLine(rl, "Customize per role? [y/N] ")).trim().toLowerCase();
    const customize = customizeRaw === "y" || customizeRaw === "yes";

    if (customize) {
      for (const role of ["planner", "implementer", "reviewer"] as const) {
        console.error(`\n── ${role} ──`);
        const roleConf: Record<string, string> = {};

        // Provider
        const provChoice = await selectFromList(rl, PROVIDERS.map(p => ({ id: p, label: `${p}   (${PROVIDER_HINTS[p]})` })),
          `  Provider [${defaultProvider}]:`, { allowSkip: true, defaultIndex: PROVIDERS.indexOf(defaultProvider as any) });
        const roleProvider = provChoice ?? defaultProvider;
        if (roleProvider !== defaultProvider) roleConf.provider = roleProvider;

        // Model (fetch for this provider if different)
        const roleModels = roleProvider !== defaultProvider
          ? await (async () => { console.error(`  Fetching models for ${roleProvider}...`); return fetchModelsForProvider(roleProvider); })()
          : defaultModels;

        if (roleModels.length > 0) {
          const defaultModelIdx = globalModel ? roleModels.findIndex(m => m.id === globalModel) : -1;
          const modelHint = roleProvider === defaultProvider && globalModel ? ` [${globalModel}]` : "";
          const roleModel = await selectFromList(rl, roleModels,
            `  Model${modelHint}:`,
            { allowSkip: true, defaultIndex: defaultModelIdx >= 0 ? defaultModelIdx : 0 });
          const effectiveModel = roleModel ?? (roleProvider === defaultProvider ? globalModel : null);
          if (effectiveModel) roleConf.model = effectiveModel;
        }

        // Thinking
        const defaultThinkIdx = THINKING_LEVELS.findIndex(t => t.id === globalThinking);
        const roleThinking = await selectFromList(rl, THINKING_LEVELS,
          `  Reasoning [${globalThinking ?? "normal"}]:`,
          { allowSkip: true, defaultIndex: defaultThinkIdx >= 0 ? defaultThinkIdx : 0 });
        const effectiveThinking = roleThinking ?? globalThinking;
        if (effectiveThinking && effectiveThinking !== globalThinking) roleConf.thinking = effectiveThinking;
        else if (effectiveThinking) roleConf.thinking = effectiveThinking;

        if (Object.keys(roleConf).length > 0) {
          (config.roles as any)[role] = roleConf;
        }
      }
    } else {
      // Apply global model/thinking to all roles
      if (globalModel || (globalThinking && globalThinking !== "normal")) {
        for (const role of ["planner", "implementer", "reviewer"] as const) {
          const roleConf: Record<string, string> = {};
          if (globalModel) roleConf.model = globalModel;
          if (globalThinking && globalThinking !== "normal") roleConf.thinking = globalThinking;
          (config.roles as any)[role] = roleConf;
        }
      }
    }

    // Clean up empty roles object
    if (config.roles && Object.keys(config.roles).length === 0) {
      delete config.roles;
    }

    mkdirSync(join(projectRoot, ".floe"), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    console.error(`\n✓ Wrote ${configPath}\n`);

    return { ok: true, message: `Wrote ${configPath}`, config };
  } finally {
    rl.close();
  }
}

// ─── Config management commands ──────────────────────────────────────

async function showConfig(_args: Record<string, any>) {
  const config = loadConfig(projectRoot);
  if (!config) {
    return { ok: false, error: "No .floe/config.json found. Run: bun run .floe/bin/floe.ts configure" };
  }
  return { ok: true, config };
}

async function listModels(args: Record<string, any>) {
  const provider = args.provider;
  if (!provider) return { ok: false, error: "list-models requires --provider <claude|codex|copilot>" };
  if (!PROVIDERS.includes(provider as any)) {
    return { ok: false, error: `Invalid provider: ${provider}. Must be: ${PROVIDERS.join(", ")}` };
  }
  if (provider === "copilot") {
    return { ok: true, provider, models: [], note: "Copilot model selection is SDK-managed" };
  }
  const models = await fetchModelsForProvider(provider);
  const source = (provider === "claude" && process.env.ANTHROPIC_API_KEY)
    || (provider === "codex" && process.env.OPENAI_API_KEY) ? "api" : "curated";
  return { ok: true, provider, source, models };
}

async function updateConfig(args: Record<string, any>) {
  const configPath = join(projectRoot, ".floe", "config.json");
  const config = loadConfig(projectRoot) ?? { defaultProvider: "" } as FloeConfig;

  const role = args.role as string | undefined;
  const provider = args.provider as string | undefined;
  const model = args.model as string | undefined;
  const thinking = args.thinking as string | undefined;

  if (!provider && !model && !thinking && !args["default-provider"]) {
    return { ok: false, error: "update-config requires at least one of: --default-provider, --provider, --model, --thinking" };
  }

  // Validate provider if given
  if (provider && !PROVIDERS.includes(provider as any) && provider !== "mock") {
    return { ok: false, error: `Invalid provider: ${provider}. Must be: ${PROVIDERS.join(", ")}` };
  }

  // Validate thinking if given
  const validThinking = ["low", "normal", "high"];
  if (thinking && !validThinking.includes(thinking)) {
    return { ok: false, error: `Invalid thinking: ${thinking}. Must be: ${validThinking.join(", ")}` };
  }

  // Update default provider
  if (args["default-provider"]) {
    if (!PROVIDERS.includes(args["default-provider"] as any)) {
      return { ok: false, error: `Invalid default provider: ${args["default-provider"]}` };
    }
    config.defaultProvider = args["default-provider"];
  }

  // Determine which roles to update
  const targetRoles: string[] = role === "all"
    ? ["planner", "implementer", "reviewer"]
    : role ? [role] : [];

  if (targetRoles.length > 0 && (provider || model || thinking)) {
    if (!config.roles) config.roles = {};
    for (const r of targetRoles) {
      const existing = (config.roles as any)[r] ?? {};
      if (provider) existing.provider = provider;
      if (model) existing.model = model;
      if (thinking) existing.thinking = thinking;
      (config.roles as any)[r] = existing;
    }
  }

  mkdirSync(join(projectRoot, ".floe"), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return { ok: true, message: `Updated ${configPath}`, config };
}

// ─── CLI dispatch ────────────────────────────────────────────────────

const [command, ...rest] = Bun.argv.slice(2);

const { values: opts } = parseArgs({
  args: rest,
  options: {
    role: { type: "string" },
    provider: { type: "string" },
    feature: { type: "string" },
    epic: { type: "string" },
    release: { type: "string" },
    context: { type: "string" },
    session: { type: "string" },
    message: { type: "string" },
    reason: { type: "string" },
    scope: { type: "string" },
    target: { type: "string" },
    "implementer-provider": { type: "string" },
    "reviewer-provider": { type: "string" },
    "force-no-alignment": { type: "boolean" },
    "default-provider": { type: "string" },
    "non-interactive": { type: "boolean" },
    model: { type: "string" },
    thinking: { type: "string" },
  },
  strict: false,
});

async function main() {
  await loadLiveAdapters();

  const commands: Record<string, (args: Record<string, any>) => Promise<any>> = {
    "launch-worker": launchWorker,
    "resume-worker": resumeWorker,
    "message-worker": messageWorker,
    "get-worker-status": getWorkerStatus,
    "replace-worker": replaceWorker,
    "stop-worker": stopWorker,
    "list-active-workers": listActiveWorkers,
    "manage-feature-pair": manageFeaturePair,
    "check-alignment": checkAlignment,
    "configure": configureCommand,
    "show-config": showConfig,
    "list-models": listModels,
    "update-config": updateConfig,
  };

  const handler = commands[command];
  if (!handler) {
    const available = Object.keys(commands).join(", ");
    console.log(JSON.stringify({ ok: false, error: `Unknown command: ${command}. Available: ${available}` }, null, 2));
    process.exit(1);
  }

  try {
    const result = await handler(opts);
    console.log(JSON.stringify(result, null, 2));
    if (!(result as any).ok) process.exit(1);
  } catch (err: any) {
    console.log(JSON.stringify({ ok: false, error: err.message ?? String(err) }, null, 2));
    process.exit(1);
  }
}

main();
