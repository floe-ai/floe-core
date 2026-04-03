#!/usr/bin/env bun
/**
 * floe-exec sessions — worker session registry CRUD.
 *
 * Manages .floe/state/sessions.json — runtime bookkeeping for active and
 * historical worker sessions. This is NOT the durable source of truth.
 * The runtime registry.ts also reads/writes this file.
 *
 * Field naming: camelCase throughout, matching the runtime TypeScript types.
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

/** Normalise any legacy snake_case fields to camelCase. */
function normaliseSession(s: any): any {
  if (s.feature_id !== undefined && s.featureId === undefined) {
    s.featureId = s.feature_id;
    delete s.feature_id;
  }
  if (s.epic_id !== undefined && s.epicId === undefined) {
    s.epicId = s.epic_id;
    delete s.epic_id;
  }
  if (s.release_id !== undefined && s.releaseId === undefined) {
    s.releaseId = s.release_id;
    delete s.release_id;
  }
  if (s.role_content_path !== undefined && s.roleContentPath === undefined) {
    s.roleContentPath = s.role_content_path;
    delete s.role_content_path;
  }
  if (s.provider_session_id !== undefined) {
    s.metadata = s.metadata ?? {};
    s.metadata.providerSessionId = s.provider_session_id;
    delete s.provider_session_id;
  }
  if (s.created_at !== undefined && s.createdAt === undefined) {
    s.createdAt = s.created_at;
    delete s.created_at;
  }
  if (s.updated_at !== undefined && s.updatedAt === undefined) {
    s.updatedAt = s.updated_at;
    delete s.updated_at;
  }
  if (s.stopped_at !== undefined && s.stoppedAt === undefined) {
    s.stoppedAt = s.stopped_at;
    delete s.stopped_at;
  }
  if (s.last_message_at !== undefined && s.lastMessageAt === undefined) {
    s.lastMessageAt = s.last_message_at;
    delete s.last_message_at;
  }
  return s;
}

function loadRegistry(): { sessions: any[] } {
  if (!existsSync(sessionsFile)) return { sessions: [] };
  const raw = readJson(sessionsFile);
  raw.sessions = (raw.sessions ?? []).map(normaliseSession);
  return raw;
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
    const session: Record<string, unknown> = {
      id: generateId("sess", `${role}-${featureId}-${Date.now().toString(36)}`),
      role,
      provider,
      status: "starting",
      featureId,
      createdAt: now,
      updatedAt: now,
    };

    if (values.epic) session.epicId = values.epic;
    if (values.release) session.releaseId = values.release;

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

    registry.sessions[idx] = { ...registry.sessions[idx], ...patch, id: arg1, updatedAt: timestamp() };
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
    registry.sessions[idx].updatedAt = timestamp();
    if (newStatus === "stopped") registry.sessions[idx].stoppedAt = timestamp();
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
    registry.sessions[idx].stoppedAt = timestamp();
    registry.sessions[idx].updatedAt = timestamp();
    saveRegistry(registry);
    ok(`Session deactivated: ${arg1}`);
    break;
  }

  case "list": {
    const registry = loadRegistry();
    let sessions = registry.sessions;

    if (values.feature) sessions = sessions.filter((s) => s.featureId === values.feature);
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
        featureId: s.featureId,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    });
    break;
  }

  case "active": {
    const registry = loadRegistry();
    let sessions = registry.sessions.filter((s) => ["starting", "active", "idle"].includes(s.status));
    if (values.feature) sessions = sessions.filter((s) => s.featureId === values.feature);
    output({
      ok: true,
      count: sessions.length,
      sessions: sessions.map((s) => ({
        id: s.id, role: s.role, provider: s.provider, status: s.status, featureId: s.featureId,
      })),
    });
    break;
  }

  default:
    fail("Usage: sessions <register|get|update|set-status|deactivate|list|active>");
}
