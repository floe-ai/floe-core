/**
 * Session registry — in-memory map of active sessions with persistence
 * to .ai/state/sessions.json.
 *
 * The registry is the runtime view; sessions.json is the durable record
 * that survives process restarts.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { WorkerSession, WorkerStatus } from "./types.ts";

function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 20; i++) {
    // Prefer git/github markers over package.json to avoid finding runtime/ as root
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".github"))) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: look for package.json but not one that's inside a known subpackage name
  dir = start;
  for (let i = 0; i < 20; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name !== "floe-runtime") return dir;
      } catch {
        return dir;
      }
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export class SessionRegistry {
  private sessions = new Map<string, WorkerSession>();
  private registryPath: string;

  constructor(projectRoot?: string) {
    const root =
      projectRoot ??
      process.env.FLOE_PROJECT_ROOT ??
      findProjectRoot(process.cwd());
    this.registryPath = join(root, ".ai", "state", "sessions.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.registryPath)) return;
    try {
      const raw = readFileSync(this.registryPath, "utf-8");
      const data = JSON.parse(raw) as { sessions?: WorkerSession[] };
      for (const s of data.sessions ?? []) {
        this.sessions.set(s.id, s);
      }
    } catch {
      // Corrupt file — start empty
    }
  }

  private persist(): void {
    const dir = join(this.registryPath, "..");
    mkdirSync(dir, { recursive: true });
    const data = { sessions: Array.from(this.sessions.values()) };
    writeFileSync(this.registryPath, JSON.stringify(data, null, 2), "utf-8");
  }

  register(session: WorkerSession): void {
    this.sessions.set(session.id, session);
    this.persist();
  }

  get(id: string): WorkerSession | undefined {
    return this.sessions.get(id);
  }

  update(id: string, patch: Partial<WorkerSession>): WorkerSession | undefined {
    const existing = this.sessions.get(id);
    if (!existing) return undefined;
    const updated: WorkerSession = {
      ...existing,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(id, updated);
    this.persist();
    return updated;
  }

  setStatus(id: string, status: WorkerStatus): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = status;
    session.updatedAt = new Date().toISOString();
    if (status === "stopped") session.stoppedAt = new Date().toISOString();
    this.persist();
  }

  listActive(): WorkerSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === "starting" || s.status === "active" || s.status === "idle"
    );
  }

  listByFeature(featureId: string): WorkerSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.featureId === featureId);
  }

  all(): WorkerSession[] {
    return Array.from(this.sessions.values());
  }
}
