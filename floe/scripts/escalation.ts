#!/usr/bin/env bun
/**
 * floe-exec escalation — manage escalation records.
 *
 * Usage:
 *   bun run scripts/escalation.ts create --from <role> --feature <id> --reason <class> '<description>'
 *   bun run scripts/escalation.ts get <escalation_id>
 *   bun run scripts/escalation.ts list [--status <status>]
 *   bun run scripts/escalation.ts resolve <escalation_id> '<resolution>'
 *   bun run scripts/escalation.ts dismiss <escalation_id> '<reason>'
 *   bun run scripts/escalation.ts surface <escalation_id>
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  paths, readJson, writeJson, validateArtefact, findArtefact,
  generateId, timestamp, listArtefacts, output, ok, fail,
} from "./helpers.ts";

const p = paths();

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: "string" },
    feature: { type: "string" },
    reason: { type: "string" },
    status: { type: "string" },
    session: { type: "string" },
    review: { type: "string" },
    context: { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

const REASON_CLASSES = [
  "approach_deadlock",
  "repeated_failure",
  "scope_change",
  "architecture_decision",
  "missing_context",
  "external_dependency",
];

const [cmd, arg1, ...restArgs] = positionals;

switch (cmd) {
  case "create": {
    const from = values.from as string;
    const featureId = values.feature as string;
    const reasonClass = values.reason as string;
    const description = restArgs.join(" ") || (arg1 ?? "");

    if (!from) fail("--from <role> is required");
    if (!featureId) fail("--feature <id> is required");
    if (!reasonClass) fail("--reason <class> is required");
    if (!REASON_CLASSES.includes(reasonClass)) {
      fail(`Invalid reason class: ${reasonClass}. Must be: ${REASON_CLASSES.join(", ")}`);
    }
    if (!description) fail("Description is required as positional argument");

    const now = timestamp();
    const escalation = {
      id: generateId("esc", `${featureId}-${Date.now().toString(36)}`),
      source_role: from,
      source_session_id: (values.session as string) || undefined,
      feature_id: featureId,
      review_id: (values.review as string) || undefined,
      reason_class: reasonClass,
      description,
      context: (values.context as string) || undefined,
      status: "open",
      created_at: now,
      updated_at: now,
    };

    const validation = validateArtefact(escalation, "escalation");
    if (!validation.valid) fail("Validation failed", { errors: validation.errors });

    writeJson(join(p.escalations, `${escalation.id}.json`), escalation);
    ok(`Created escalation: ${escalation.id}`, { escalation });
    break;
  }

  case "get": {
    if (!arg1) fail("Usage: escalation get <escalation_id>");
    const escalation = findArtefact(p.escalations, arg1);
    if (!escalation) fail(`Escalation not found: ${arg1}`);
    output({ ok: true, escalation });
    break;
  }

  case "list": {
    let escalations = listArtefacts(p.escalations);
    if (values.status) {
      escalations = escalations.filter((e) => e.status === values.status);
    }
    output({
      ok: true,
      count: escalations.length,
      escalations: escalations.map((e) => ({
        id: e.id,
        source_role: e.source_role,
        feature_id: e.feature_id,
        reason_class: e.reason_class,
        status: e.status,
        description: e.description,
        created_at: e.created_at,
      })),
    });
    break;
  }

  case "resolve": {
    if (!arg1) fail("Usage: escalation resolve <escalation_id> '<resolution>'");
    const resolution = restArgs.join(" ");
    if (!resolution) fail("Resolution text is required");

    const escalation = findArtefact(p.escalations, arg1);
    if (!escalation) fail(`Escalation not found: ${arg1}`);

    escalation.status = "resolved";
    escalation.resolution = resolution;
    escalation.resolved_at = timestamp();
    escalation.updated_at = timestamp();

    writeJson(join(p.escalations, `${escalation.id}.json`), escalation);
    ok(`Escalation resolved: ${escalation.id}`, { escalation });
    break;
  }

  case "dismiss": {
    if (!arg1) fail("Usage: escalation dismiss <escalation_id> '<reason>'");
    const reason = restArgs.join(" ");
    if (!reason) fail("Dismissal reason is required");

    const escalation = findArtefact(p.escalations, arg1);
    if (!escalation) fail(`Escalation not found: ${arg1}`);

    escalation.status = "dismissed";
    escalation.dismissed_reason = reason;
    escalation.updated_at = timestamp();

    writeJson(join(p.escalations, `${escalation.id}.json`), escalation);
    ok(`Escalation dismissed: ${escalation.id}`, { escalation });
    break;
  }

  case "surface": {
    if (!arg1) fail("Usage: escalation surface <escalation_id>");
    const escalation = findArtefact(p.escalations, arg1);
    if (!escalation) fail(`Escalation not found: ${arg1}`);

    escalation.status = "surfaced";
    escalation.updated_at = timestamp();

    writeJson(join(p.escalations, `${escalation.id}.json`), escalation);
    ok(`Escalation surfaced: ${escalation.id}`, { escalation });
    break;
  }

  default:
    fail("Usage: escalation <create|get|list|resolve|dismiss|surface>");
}
