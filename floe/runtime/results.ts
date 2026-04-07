/**
 * Worker result storage — persists message results to disk for async dispatch.
 *
 * When --async is used, the message is sent in a background subprocess.
 * Results are written to .floe/state/results/<sessionId>-<timestamp>.json
 * and can be polled via get-worker-result or waited on via wait-worker.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface WorkerResult {
  sessionId: string;
  status: "pending" | "complete" | "error";
  dispatchedAt: string;
  completedAt?: string;
  content?: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
}

function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".floe")) || existsSync(join(dir, ".github"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export class ResultStore {
  private resultsDir: string;

  constructor(projectRoot?: string) {
    const root = projectRoot ?? process.env.FLOE_PROJECT_ROOT ?? findProjectRoot(process.cwd());
    this.resultsDir = join(root, ".floe", "state", "results");
    mkdirSync(this.resultsDir, { recursive: true });
  }

  private resultPath(sessionId: string, timestamp: string): string {
    const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeTs = timestamp.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.resultsDir, `${safeSid}-${safeTs}.json`);
  }

  /** Write a pending placeholder when dispatch starts. */
  writePending(sessionId: string): string {
    const now = new Date().toISOString();
    const result: WorkerResult = {
      sessionId,
      status: "pending",
      dispatchedAt: now,
    };
    const path = this.resultPath(sessionId, now);
    writeFileSync(path, JSON.stringify(result, null, 2), "utf-8");
    return path;
  }

  /** Update a result file with the completed response. */
  writeComplete(resultPath: string, content: string, finishReason?: string, usage?: WorkerResult["usage"]): void {
    const existing = this.read(resultPath);
    if (!existing) return;
    const updated: WorkerResult = {
      ...existing,
      status: "complete",
      completedAt: new Date().toISOString(),
      content,
      finishReason,
      usage,
    };
    writeFileSync(resultPath, JSON.stringify(updated, null, 2), "utf-8");
  }

  /** Update a result file with an error. */
  writeError(resultPath: string, error: string): void {
    const existing = this.read(resultPath);
    if (!existing) return;
    const updated: WorkerResult = {
      ...existing,
      status: "error",
      completedAt: new Date().toISOString(),
      error,
    };
    writeFileSync(resultPath, JSON.stringify(updated, null, 2), "utf-8");
  }

  /** Read a specific result file. */
  read(resultPath: string): WorkerResult | null {
    if (!existsSync(resultPath)) return null;
    try {
      return JSON.parse(readFileSync(resultPath, "utf-8"));
    } catch {
      return null;
    }
  }

  /** Find all results for a session, newest first. */
  findBySession(sessionId: string): { path: string; result: WorkerResult }[] {
    if (!existsSync(this.resultsDir)) return [];
    const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const files = readdirSync(this.resultsDir)
      .filter(f => f.startsWith(safeSid) && f.endsWith(".json"))
      .sort()
      .reverse();

    const results: { path: string; result: WorkerResult }[] = [];
    for (const f of files) {
      const fullPath = join(this.resultsDir, f);
      const r = this.read(fullPath);
      if (r) results.push({ path: fullPath, result: r });
    }
    return results;
  }

  /** Get the latest result for a session. */
  latest(sessionId: string): { path: string; result: WorkerResult } | null {
    const results = this.findBySession(sessionId);
    return results[0] ?? null;
  }
}
