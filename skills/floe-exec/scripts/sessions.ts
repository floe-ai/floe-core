#!/usr/bin/env bun
/**
 * floe-exec sessions — worker session registry CRUD.
 *
 * Manages .ai/state/sessions.json — the source of truth for active and historical
 * worker sessions. This is the write side; floe-runtime registry.ts also reads this file.
 *
 * Usage:
 *   bun run scripts/sessions.ts register --role <role> --provider <provider> --feature <id>
 *   bun run scripts/sessions.ts get <session_id>
 *   bun run scripts/sessions.ts update <session_id> --data '<json>'
 *   bun run scripts/sessions.ts set-status <session_id> <status>
 *   bun run scripts/sessions.ts deactivate <session_id>
 *   bun run scripts/sessions.ts list [--feature <id>] [--role <role>] [--status <status>]
 *   bun run scripts/sessions.ts active [--feature <id>]
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { paths, readJson, writeJson, generateId, timestamp, output, ok, fail } from "./helpers.ts";

const p = paths();
const sessionsFile = join(p.state, "sessions.json");

const ROLES = ["foreman", "planner", "implementer", "reviewer"] as const;
const PROVIDERS = ["codex", "claude", "copilot", "mock"] as const;
const STATUSES = ["starting", "active", "idle", "stopped", "failed"] as const;

function loadRegistry(): { sessions: any[] } {
  if (!existsSync(sessionsFile)) return { sessions: [] };
  return readJson(sessionsFile);
}

function saveRegistry(registry: { sessions: any[] }): void {
  writeJson(sessionsFile, registry);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    role: { type: "string" },
    provider: { type: "string" },
    feature: { type: "string" },
    epic: { type: "string" },
    release: { type: "string" },
    status: { type: "string" },
    data: { type: "string" },
    "provider-session-id": { type: "string" },
    "role-content-path": { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

const [cmd, arg1] = positionals;

switch (cmd) {
  case "register": {
    const role = values.role as string;
    const provider = values.provider as string;
    const featureId = values.feature as string;

    if (!role || !ROLES.includes(role as any)) {
      fail(`--role required. Expected: ${ROLES.join(", ")}`);
    }
    if (!provider || !PROVIDERS.includes(provider as any)) {
      fail(`--provider required. Expected: ${PROVIDERS.join(", ")}`);
    }
    if (!featureId) fail("--feature is required");

    const now = timestamp();
    const session = {
      id: generateId("sess", `${role}-${featureId}-${Date.now().toString(36)}`),
      role,
      provider,
      provider_session_id: (values["provider-session-id"] as string) ?? undefined,
      status: "starting",
      feature_id: featureId,
      epic_id: (values.epic as string) ?? undefined,
      release_id: (values.release as string) ?? undefined,
      role_content_path: (values["role-content-path"] as string) ?? undefined,
      created_at: now,
      updated_at: now,
    };

    // Strip undefined fields
    Object.keys(session).forEach((k) => (session as any)[k] === undefined && delete (session as any)[k]);

    const registry = loadRegistry();
    registry.sessions.push(session);
    saveRegistry(registry);
    ok(`Registered session: ${session.id}`, { session });
    break;
  }

  case "get": {
    if (!arg1) fail("Usage: sessions get <session_id>");
    const registry = loadRegistry();
    const session = registry.sessions.find((s) => s.id === arg1);
    if (!session) fail(`Session not found: ${arg1}`);
    output({ ok: true, session });
    break;
  }

  case "update": {
    if (!arg1) fail("Usage: sessions update <session_id> --data '<json>'");
    if (!values.data) fail("--data is required");
    let patch: any;
    try { patch = JSON.parse(values.data as string); } catch { fail("Invalid JSON in --data"); }

    const registry = loadRegistry();
    const idx = registry.sessions.findIndex((s) => s.id === arg1);
    if (idx === -1) fail(`Session not found: ${arg1}`);

    registry.sessions[idx] = { ...registry.sessions[idx], ...patch, id: arg1, updated_at: timestamp() };
    saveRegistry(registry);
    ok(`Updated session: ${arg1}`, { session: registry.sessions[idx] });
    break;
  }

  case "set-status": {
    if (!arg1 || !positionals[1]) fail("Usage: sessions set-status <session_id> <status>");
    const newStatus = positionals[1];
    if (!STATUSES.includes(newStatus as any)) {
      fail(`Invalid status. Expected: ${STATUSES.join(", ")}`);
    }

    const registry = loadRegistry();
    const idx = registry.sessions.findIndex((s) => s.id === arg1);
    if (idx === -1) fail(`Session not found: ${arg1}`);

    registry.sessions[idx].status = newStatus;
    registry.sessions[idx].updated_at = timestamp();
    if (newStatus === "stopped") registry.sessions[idx].stopped_at = timestamp();
    saveRegistry(registry);
    ok(`Status set to ${newStatus} for ${arg1}`);
    break;
  }

  case "deactivate": {
    if (!arg1) fail("Usage: sessions deactivate <session_id>");
    const registry = loadRegistry();
    const idx = registry.sessions.findIndex((s) => s.id === arg1);
    if (idx === -1) fail(`Session not found: ${arg1}`);

    registry.sessions[idx].status = "stopped";
    registry.sessions[idx].stopped_at = timestamp();
    registry.sessions[idx].updated_at = timestamp();
    saveRegistry(registry);
    ok(`Session deactivated: ${arg1}`);
    break;
  }

  case "list": {
    const registry = loadRegistry();
    let sessions = registry.sessions;

    if (values.feature) sessions = sessions.filter((s) => s.feature_id === values.feature);
    if (values.role) sessions = sessions.filter((s) => s.role === values.role);
    if (values.status) sessions = sessions.filter((s) => s.status === values.status);

    output({
      ok: true,
      count: sessions.length,
      sessions: sessions.map((s) => ({
        id: s.id,
        role: s.role,
        provider: s.provider,
        status: s.status,
        feature_id: s.feature_id,
        created_at: s.created_at,
        updated_at: s.updated_at,
      })),
    });
    break;
  }

  case "active": {
    const registry = loadRegistry();
    let sessions = registry.sessions.filter((s) => ["starting", "active", "idle"].includes(s.status));
    if (values.feature) sessions = sessions.filter((s) => s.feature_id === values.feature);
    output({
      ok: true,
      count: sessions.length,
      sessions: sessions.map((s) => ({
        id: s.id, role: s.role, provider: s.provider, status: s.status, feature_id: s.feature_id,
      })),
    });
    break;
  }

  default:
    fail("Usage: sessions <register|get|update|set-status|deactivate|list|active>");
}
