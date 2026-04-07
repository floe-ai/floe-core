/**
 * Definition of Done (DoD) loader and formatter.
 *
 * Reads the project-level .floe/dod.json and renders it as readable text
 * for injection into reviewer and implementer worker session prompts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────

export interface DodCriterion {
  id: string;
  category: string;
  description: string;
  severity: "required" | "recommended";
}

export interface Dod {
  version: number;
  criteria: DodCriterion[];
  notes: string | null;
}

// ── Loader ────────────────────────────────────────────────────────────

/**
 * Read and parse the project-level DoD from `.floe/dod.json`.
 * Returns `null` if the file does not exist or cannot be parsed.
 */
export function loadDod(projectRoot: string): Dod | null {
  const dodPath = join(projectRoot, ".floe", "dod.json");
  if (!existsSync(dodPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(dodPath, "utf-8"));

    if (typeof raw.version !== "number" || !Array.isArray(raw.criteria)) {
      return null;
    }

    return {
      version: raw.version,
      criteria: raw.criteria.map((c: any) => ({
        id: String(c.id ?? ""),
        category: String(c.category ?? ""),
        description: String(c.description ?? ""),
        severity: c.severity === "recommended" ? "recommended" : "required",
      })),
      notes: typeof raw.notes === "string" ? raw.notes : null,
    };
  } catch {
    return null;
  }
}

// ── Formatter ─────────────────────────────────────────────────────────

/**
 * Render a DoD as readable text suitable for prompt injection.
 */
export function formatDodForPrompt(dod: Dod): string {
  const required = dod.criteria.filter((c) => c.severity === "required");
  const recommended = dod.criteria.filter((c) => c.severity === "recommended");

  const lines: string[] = ["## Project Definition of Done", ""];

  if (required.length > 0) {
    lines.push("### Required Criteria (must pass)");
    for (const c of required) {
      lines.push(`- [${c.id}] ${c.description}`);
    }
    lines.push("");
  }

  if (recommended.length > 0) {
    lines.push("### Recommended Criteria (should pass, reviewer discretion)");
    for (const c of recommended) {
      lines.push(`- [${c.id}] ${c.description}`);
    }
    lines.push("");
  }

  if (dod.notes) {
    lines.push(`Notes: ${dod.notes}`);
    lines.push("");
  }

  return lines.join("\n");
}
