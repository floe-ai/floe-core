#!/usr/bin/env bun
/**
 * floe-exec review — manage rolling review objects.
 *
 * Usage:
 *   bun run scripts/review.ts create <target_type> <target_id>
 *   bun run scripts/review.ts get <review_id>
 *   bun run scripts/review.ts get-for <target_id>
 *   bun run scripts/review.ts update <review_id> --data '<json>'
 *   bun run scripts/review.ts add-finding <review_id> --severity <sev> --description '<text>'
 *   bun run scripts/review.ts resolve-finding <review_id> <finding_id>
 *   bun run scripts/review.ts set-outcome <review_id> <outcome>
 *   bun run scripts/review.ts set-approach <review_id> '<proposal text>'
 *   bun run scripts/review.ts approve-approach <review_id>
 *   bun run scripts/review.ts reject-approach <review_id> '<rationale>'
 *   bun run scripts/review.ts add-resolution <rev_id> --from <role> --kind <kind> '<message>' [--requested-action <action>]
 *   bun run scripts/review.ts get-resolution <rev_id>
 *   bun run scripts/review.ts resolve <review_id>
 *   bun run scripts/review.ts list [--status <status>]
 */

import { existsSync } from "node:fs";
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
    data: { type: "string" },
    status: { type: "string" },
    severity: { type: "string" },
    description: { type: "string" },
    from: { type: "string" },
    kind: { type: "string" },
    "requested-action": { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

const [cmd, arg1, arg2] = positionals;

switch (cmd) {
  case "create": {
    if (!arg1 || !arg2) fail("Usage: review create <target_type> <target_id>");
    const targetTypes = ["feature", "epic", "release"];
    if (!targetTypes.includes(arg1)) fail(`target_type must be: ${targetTypes.join(", ")}`);

    const now = timestamp();
    const review = {
      id: generateId("rev", `${arg2}-${Date.now().toString(36)}`),
      target_type: arg1,
      target_id: arg2,
      status: "open",
      outcome: "pending",
      findings: [],
      required_actions: [],
      linked_summary_ids: [],
      created_at: now,
      updated_at: now,
    };

    const validation = validateArtefact(review, "review");
    if (!validation.valid) fail("Validation failed", { errors: validation.errors });

    writeJson(join(p.reviews, `${review.id}.json`), review);
    ok(`Created review: ${review.id}`, { review });
    break;
  }

  case "get": {
    if (!arg1) fail("Usage: review get <review_id>");
    const review = findArtefact(p.reviews, arg1);
    if (!review) fail(`Review not found: ${arg1}`);
    output({ ok: true, review });
    break;
  }

  case "get-for": {
    if (!arg1) fail("Usage: review get-for <target_id>");
    const reviews = listArtefacts(p.reviews);
    const match = reviews.find(
      (r) => r.target_id === arg1 && r.status === "open"
    );
    if (!match) {
      output({ ok: true, review: null, message: "No open review for this target" });
    } else {
      output({ ok: true, review: match });
    }
    break;
  }

  case "update": {
    if (!arg1) fail("Usage: review update <review_id> --data '<json>'");
    if (!values.data) fail("--data is required");
    let patch: any;
    try { patch = JSON.parse(values.data as string); } catch { fail("Invalid JSON"); }

    const existing = findArtefact(p.reviews, arg1);
    if (!existing) fail(`Not found: ${arg1}`);

    const updated = { ...existing, ...patch, id: existing.id, updated_at: timestamp() };
    writeJson(join(p.reviews, `${existing.id}.json`), updated);
    ok(`Updated review: ${existing.id}`, { review: updated });
    break;
  }

  case "add-finding": {
    if (!arg1) fail("Usage: review add-finding <review_id> --severity <sev> --description '<text>'");
    const sev = values.severity as string;
    const desc = values.description as string;
    if (!sev || !desc) fail("--severity and --description are required");

    const review = findArtefact(p.reviews, arg1);
    if (!review) fail(`Not found: ${arg1}`);

    const finding = {
      id: `f-${Date.now().toString(36)}`,
      severity: sev,
      description: desc,
      status: "open",
      added_at: timestamp(),
    };

    review.findings = review.findings ?? [];
    review.findings.push(finding);
    review.updated_at = timestamp();
    writeJson(join(p.reviews, `${review.id}.json`), review);
    ok(`Finding added to ${review.id}`, { finding });
    break;
  }

  case "resolve-finding": {
    if (!arg1 || !arg2) fail("Usage: review resolve-finding <review_id> <finding_id>");
    const review = findArtefact(p.reviews, arg1);
    if (!review) fail(`Not found: ${arg1}`);

    const finding = review.findings?.find((f: any) => f.id === arg2);
    if (!finding) fail(`Finding not found: ${arg2}`);

    finding.status = "fixed";
    finding.resolved_at = timestamp();
    review.updated_at = timestamp();
    writeJson(join(p.reviews, `${review.id}.json`), review);
    ok(`Finding resolved: ${arg2}`);
    break;
  }

  case "set-outcome": {
    if (!arg1 || !arg2) fail("Usage: review set-outcome <review_id> <outcome>");
    const outcomes = ["pass", "fail", "blocked", "needs_replan", "pending"];
    if (!outcomes.includes(arg2)) fail(`outcome must be: ${outcomes.join(", ")}`);

    const review = findArtefact(p.reviews, arg1);
    if (!review) fail(`Not found: ${arg1}`);

    review.outcome = arg2;
    review.updated_at = timestamp();
    writeJson(join(p.reviews, `${review.id}.json`), review);
    ok(`Outcome set to ${arg2} for ${review.id}`);
    break;
  }

  case "set-approach": {
    if (!arg1) fail("Usage: review set-approach <review_id> '<proposal text>'");
    const review = findArtefact(p.reviews, arg1);
    if (!review) fail(`Not found: ${arg1}`);

    const proposal = positionals.slice(2).join(" ");
    if (!proposal) fail("Proposal text is required as third argument");

    review.approach_proposal = {
      proposal,
      proposed_at: timestamp(),
      verdict: "pending",
    };
    review.updated_at = timestamp();
    writeJson(join(p.reviews, `${review.id}.json`), review);
    ok(`Approach proposal set on ${review.id}`);
    break;
  }

  case "approve-approach": {
    if (!arg1) fail("Usage: review approve-approach <review_id> [rationale]");
    const review = findArtefact(p.reviews, arg1);
    if (!review) fail(`Not found: ${arg1}`);
    if (!review.approach_proposal) fail("No approach proposal found on this review");

    review.approach_proposal.verdict = "approved";
    review.approach_proposal.verdict_rationale = positionals.slice(2).join(" ") || "Approved";
    review.approach_proposal.verdict_at = timestamp();
    review.updated_at = timestamp();
    writeJson(join(p.reviews, `${review.id}.json`), review);
    ok(`Approach approved on ${review.id}`);
    break;
  }

  case "reject-approach": {
    if (!arg1) fail("Usage: review reject-approach <review_id> '<rationale>'");
    const review = findArtefact(p.reviews, arg1);
    if (!review) fail(`Not found: ${arg1}`);
    if (!review.approach_proposal) fail("No approach proposal found on this review");

    const rationale = positionals.slice(2).join(" ");
    if (!rationale) fail("Rejection rationale is required");

    review.approach_proposal.verdict = "rejected";
    review.approach_proposal.verdict_rationale = rationale;
    review.approach_proposal.verdict_at = timestamp();
    review.updated_at = timestamp();
    writeJson(join(p.reviews, `${review.id}.json`), review);
    ok(`Approach rejected on ${review.id}`);
    break;
  }

  case "add-resolution": {
    if (!arg1) fail("Usage: review add-resolution <rev_id> --from <role> --kind <kind> '<message>' [--requested-action <action>]");
    const fromRole = values.from as string;
    const kindVal = values.kind as string;
    if (!fromRole || !kindVal) fail("--from and --kind are required");
    const validFrom = ["implementer", "reviewer"];
    if (!validFrom.includes(fromRole)) fail(`--from must be: ${validFrom.join(", ")}`);
    const validKind = ["revised_approach", "counter_proposal", "clarification", "objection", "acceptance"];
    if (!validKind.includes(kindVal)) fail(`--kind must be: ${validKind.join(", ")}`);

    const resMessage = positionals.slice(2).join(" ");
    if (!resMessage) fail("Resolution message is required as positional argument");

    const review = findArtefact(p.reviews, arg1);
    if (!review) fail(`Not found: ${arg1}`);

    const entry: any = {
      from: fromRole,
      kind: kindVal,
      message: resMessage,
      status: "pending",
      at: timestamp(),
    };

    const requestedAction = values["requested-action"] as string | undefined;
    if (requestedAction) {
      const validActions = ["re_evaluate", "revise_approach", "provide_detail", "approve"];
      if (!validActions.includes(requestedAction)) fail(`--requested-action must be: ${validActions.join(", ")}`);
      entry.requested_action = requestedAction;
    }

    review.resolution_thread = review.resolution_thread ?? [];
    review.resolution_thread.push(entry);

    // Auto-escalation: if thread exceeds 6 entries
    if (review.resolution_thread.length > 6 && review.approach_proposal) {
      review.approach_proposal.verdict = "escalated";
      review.approach_proposal.verdict_rationale = "Auto-escalated: resolution thread exceeded maximum rounds";
      review.approach_proposal.verdict_at = timestamp();
    }

    review.updated_at = timestamp();
    writeJson(join(p.reviews, `${review.id}.json`), review);
    ok(`Resolution entry added to ${review.id}`, {
      thread_length: review.resolution_thread.length,
      auto_escalated: review.resolution_thread.length > 6,
    });
    break;
  }

  case "get-resolution": {
    if (!arg1) fail("Usage: review get-resolution <rev_id>");
    const review = findArtefact(p.reviews, arg1);
    if (!review) fail(`Not found: ${arg1}`);
    const thread = review.resolution_thread ?? [];
    output({ ok: true, thread, count: thread.length });
    break;
  }

  case "resolve": {
    const review = findArtefact(p.reviews, arg1);
    if (!review) fail(`Not found: ${arg1}`);

    review.status = "resolved";
    review.resolved_at = timestamp();
    review.updated_at = timestamp();
    writeJson(join(p.reviews, `${review.id}.json`), review);
    ok(`Review resolved: ${review.id}`);
    break;
  }

  case "list": {
    let reviews = listArtefacts(p.reviews);
    if (values.status) reviews = reviews.filter((r) => r.status === values.status);
    output({
      ok: true,
      count: reviews.length,
      reviews: reviews.map((r) => ({
        id: r.id, target_type: r.target_type, target_id: r.target_id,
        status: r.status, outcome: r.outcome,
        findings_count: r.findings?.length ?? 0,
      })),
    });
    break;
  }

  default:
    fail("Usage: review <create|get|get-for|update|add-finding|resolve-finding|set-outcome|set-approach|approve-approach|reject-approach|add-resolution|get-resolution|resolve|list>");
}
