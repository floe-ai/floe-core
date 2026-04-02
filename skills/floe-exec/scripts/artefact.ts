#!/usr/bin/env bun
/**
 * floe-exec artefact — create and update durable artefacts.
 *
 * Usage:
 *   bun run scripts/artefact.ts create <type> --data '<json>'
 *   bun run scripts/artefact.ts update <type> <id> --data '<json>'
 *   bun run scripts/artefact.ts get <type> <id>
 *   bun run scripts/artefact.ts list <type> [--status <status>] [--parent <id>]
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  paths, readJson, writeJson, validateArtefact,
  generateId, timestamp, listArtefacts, findArtefact,
  output, ok, fail,
} from "./helpers.ts";

const TYPES = ["release", "epic", "feature"] as const;
type ArtefactType = (typeof TYPES)[number];

const PREFIX_MAP: Record<ArtefactType, string> = {
  release: "rel",
  epic: "epic",
  feature: "feat",
};

const PARENT_FIELD: Record<ArtefactType, string | null> = {
  release: null,
  epic: "release_id",
  feature: "epic_id",
};

function dirForType(type: ArtefactType): string {
  const p = paths();
  const map: Record<ArtefactType, string> = {
    release: p.releases,
    epic: p.epics,
    feature: p.features,
  };
  return map[type];
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    data: { type: "string" },
    status: { type: "string" },
    parent: { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

const [cmd, typeOrId, idArg] = positionals;

if (!cmd) fail("Usage: artefact <create|update|get|list> <type> [id] --data '<json>'");

switch (cmd) {
  case "create": {
    const type = typeOrId as ArtefactType;
    if (!TYPES.includes(type)) fail(`Invalid type: ${type}. Expected: ${TYPES.join(", ")}`);
    if (!values.data) fail("--data is required for create");

    let data: any;
    try { data = JSON.parse(values.data as string); } catch { fail("Invalid JSON in --data"); }

    const now = timestamp();

    // Generate ID from title if not provided
    if (!data.id && data.title) {
      data.id = generateId(PREFIX_MAP[type], data.title);
    }
    if (!data.id) fail("Either id or title must be provided");

    // Set defaults
    data.status = data.status ?? "draft";
    data.priority = data.priority ?? "normal";
    data.created_at = data.created_at ?? now;
    data.updated_at = now;

    if (type === "feature") {
      data.dependencies = data.dependencies ?? [];
      data.acceptance_criteria = data.acceptance_criteria ?? [];
      data.file_hints = data.file_hints ?? [];
      data.test_hints = data.test_hints ?? [];
      data.execution_state = data.execution_state ?? {
        run_count: 0,
        failed_runs: 0,
        last_run_outcome: "not_started",
      };
      data.review_state = data.review_state ?? { current_outcome: "pending" };
    }

    if (type === "epic") {
      data.dependencies = data.dependencies ?? [];
      data.acceptance_criteria = data.acceptance_criteria ?? [];
      data.subsystem_hints = data.subsystem_hints ?? [];
    }

    if (type === "release") {
      data.dependencies = data.dependencies ?? [];
      data.acceptance_criteria = data.acceptance_criteria ?? [];
    }

    // Validate
    const validation = validateArtefact(data, type);
    if (!validation.valid) fail("Validation failed", { errors: validation.errors });

    // Check for duplicates
    const dir = dirForType(type);
    const filePath = join(dir, `${data.id}.json`);
    if (existsSync(filePath)) fail(`Artefact already exists: ${data.id}`);

    writeJson(filePath, data);
    ok(`Created ${type}: ${data.id}`, { artefact: data });
    break;
  }

  case "update": {
    const type = typeOrId as ArtefactType;
    if (!TYPES.includes(type)) fail(`Invalid type: ${type}`);
    if (!idArg) fail("ID is required for update");
    if (!values.data) fail("--data is required for update");

    let patch: any;
    try { patch = JSON.parse(values.data as string); } catch { fail("Invalid JSON in --data"); }

    const dir = dirForType(type);
    const existing = findArtefact(dir, idArg);
    if (!existing) fail(`Not found: ${idArg}`);

    const updated = { ...existing, ...patch, updated_at: timestamp() };
    // Don't allow changing the ID
    updated.id = existing.id;

    const validation = validateArtefact(updated, type);
    if (!validation.valid) fail("Validation failed", { errors: validation.errors });

    writeJson(join(dir, `${existing.id}.json`), updated);
    ok(`Updated ${type}: ${existing.id}`, { artefact: updated });
    break;
  }

  case "get": {
    const type = typeOrId as ArtefactType;
    if (!TYPES.includes(type)) fail(`Invalid type: ${type}`);
    if (!idArg) fail("ID is required for get");

    const dir = dirForType(type);
    const artefact = findArtefact(dir, idArg);
    if (!artefact) fail(`Not found: ${idArg}`);

    output({ ok: true, artefact });
    break;
  }

  case "list": {
    const type = typeOrId as ArtefactType;
    if (!TYPES.includes(type)) fail(`Invalid type: ${type}`);

    let items = listArtefacts(dirForType(type));

    // Filter by status
    if (values.status) {
      items = items.filter((i) => i.status === values.status);
    }

    // Filter by parent
    if (values.parent) {
      const parentField = PARENT_FIELD[type];
      if (parentField) {
        items = items.filter((i) => i[parentField] === values.parent);
      }
    }

    output({ ok: true, type, count: items.length, items });
    break;
  }

  default:
    fail(`Unknown command: ${cmd}`);
}
