#!/usr/bin/env bun
/**
 * floe-exec note — manage the repo-local notes inbox.
 *
 * Usage:
 *   bun run scripts/note.ts create --data '<json>'
 *   bun run scripts/note.ts get <note_id>
 *   bun run scripts/note.ts update <note_id> --data '<json>'
 *   bun run scripts/note.ts promote <note_id> <target_type> <target_id>
 *   bun run scripts/note.ts list [--kind <kind>] [--status <status>] [--tag <tag>]
 *   bun run scripts/note.ts search <query>
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  paths, writeJson, validateArtefact, findArtefact,
  generateId, timestamp, listArtefacts, output, ok, fail,
} from "./helpers.ts";

const p = paths();

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    data: { type: "string" },
    kind: { type: "string" },
    status: { type: "string" },
    tag: { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

const [cmd, arg1, arg2, arg3] = positionals;

switch (cmd) {
  case "create": {
    if (!values.data) fail("--data is required");
    let data: any;
    try { data = JSON.parse(values.data as string); } catch { fail("Invalid JSON"); }

    const now = timestamp();
    if (!data.id) {
      data.id = generateId("note", data.summary?.slice(0, 30) ?? `${Date.now().toString(36)}`);
    }
    data.created_at = data.created_at ?? now;
    data.updated_at = now;
    data.status = data.status ?? "captured";
    data.tags = data.tags ?? [];
    data.references = data.references ?? [];

    const validation = validateArtefact(data, "note");
    if (!validation.valid) fail("Validation failed", { errors: validation.errors });

    writeJson(join(p.notes, `${data.id}.json`), data);
    ok(`Created note: ${data.id}`, { note: data });
    break;
  }

  case "get": {
    if (!arg1) fail("Usage: note get <note_id>");
    const note = findArtefact(p.notes, arg1);
    if (!note) fail(`Not found: ${arg1}`);
    output({ ok: true, note });
    break;
  }

  case "update": {
    if (!arg1) fail("Usage: note update <note_id> --data '<json>'");
    if (!values.data) fail("--data is required");
    let patch: any;
    try { patch = JSON.parse(values.data as string); } catch { fail("Invalid JSON"); }

    const existing = findArtefact(p.notes, arg1);
    if (!existing) fail(`Not found: ${arg1}`);

    const updated = { ...existing, ...patch, id: existing.id, updated_at: timestamp() };
    writeJson(join(p.notes, `${existing.id}.json`), updated);
    ok(`Updated note: ${existing.id}`, { note: updated });
    break;
  }

  case "promote": {
    if (!arg1 || !arg2 || !arg3) {
      fail("Usage: note promote <note_id> <target_type> <target_id>");
    }
    const note = findArtefact(p.notes, arg1);
    if (!note) fail(`Not found: ${arg1}`);

    note.status = "promoted";
    note.promoted_to = { type: arg2, id: arg3 };
    note.updated_at = timestamp();
    writeJson(join(p.notes, `${note.id}.json`), note);
    ok(`Note promoted: ${note.id} -> ${arg2}:${arg3}`, { note });
    break;
  }

  case "list": {
    let items = listArtefacts(p.notes);
    if (values.kind) items = items.filter((n) => n.kind === values.kind);
    if (values.status) items = items.filter((n) => n.status === values.status);
    if (values.tag) items = items.filter((n) => n.tags?.includes(values.tag));

    output({
      ok: true,
      count: items.length,
      notes: items.map((n) => ({
        id: n.id, kind: n.kind, summary: n.summary,
        status: n.status, tags: n.tags, created_at: n.created_at,
      })),
    });
    break;
  }

  case "search": {
    if (!arg1) fail("Usage: note search <query>");
    const query = arg1.toLowerCase();
    const items = listArtefacts(p.notes).filter(
      (n) =>
        n.summary?.toLowerCase().includes(query) ||
        n.raw_content?.toLowerCase().includes(query) ||
        n.tags?.some((t: string) => t.toLowerCase().includes(query))
    );
    output({
      ok: true,
      query: arg1,
      count: items.length,
      notes: items.map((n) => ({
        id: n.id, kind: n.kind, summary: n.summary,
        status: n.status, tags: n.tags,
      })),
    });
    break;
  }

  default:
    fail("Usage: note <create|get|update|promote|list|search>");
}
