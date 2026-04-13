#!/usr/bin/env bun
/**
 * floe-exec summary — create and list summaries.
 *
 * Usage:
 *   bun run scripts/summary.ts create --data '<json>'
 *   bun run scripts/summary.ts get <summary_id>
 *   bun run scripts/summary.ts list [--target <id>] [--kind <kind>]
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  paths, writeJson, validateArtefact, findArtefact,
  generateId, timestamp, listArtefacts, output, ok, fail,
  floeMemAvailable, floeMemScriptPath,
} from "./helpers.ts";

const p = paths();

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    data: { type: "string" },
    target: { type: "string" },
    kind: { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

const [cmd, arg1] = positionals;

switch (cmd) {
  case "create": {
    if (!values.data) fail("--data is required");
    let data: any;
    try { data = JSON.parse(values.data as string); } catch { fail("Invalid JSON"); }

    const now = timestamp();
    if (!data.id) {
      data.id = generateId("sum", `${data.target_id ?? "general"}-${Date.now().toString(36)}`);
    }
    data.created_at = data.created_at ?? now;
    data.what_changed = data.what_changed ?? [];
    data.linked_review_ids = data.linked_review_ids ?? [];

    const validation = validateArtefact(data, "summary");
    if (!validation.valid) fail("Validation failed", { errors: validation.errors });

    writeJson(join(p.summaries, `${data.id}.json`), data);

    // If floe-mem is available, register the summary
    let memRegistered = false;
    if (floeMemAvailable()) {
      const memPath = floeMemScriptPath();
      if (memPath) {
        try {
          const relPath = `delivery/summaries/${data.id}.json`;
          const proc = Bun.spawnSync(["bun", "run", memPath, "remember", relPath], {
            cwd: p.root,
            stdout: "pipe",
            stderr: "pipe",
          });
          memRegistered = proc.exitCode === 0;
        } catch {}
      }
    }

    ok(`Created summary: ${data.id}`, { summary: data, mem_registered: memRegistered });
    break;
  }

  case "get": {
    if (!arg1) fail("Usage: summary get <id>");
    const summary = findArtefact(p.summaries, arg1);
    if (!summary) fail(`Not found: ${arg1}`);
    output({ ok: true, summary });
    break;
  }

  case "list": {
    let items = listArtefacts(p.summaries);
    if (values.target) items = items.filter((s) => s.target_id === values.target);
    if (values.kind) items = items.filter((s) => s.kind === values.kind);

    output({
      ok: true,
      count: items.length,
      summaries: items.map((s) => ({
        id: s.id, target_type: s.target_type, target_id: s.target_id,
        kind: s.kind, created_at: s.created_at,
      })),
    });
    break;
  }

  default:
    fail("Usage: summary <create|get|list>");
}
