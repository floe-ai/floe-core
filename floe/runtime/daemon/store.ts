import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  PendingCallRecord,
  RunRecord,
  RuntimeEvent,
  WorkerRuntimeRecord,
  RuntimeStatus,
} from "./types.ts";

interface JsonlEnvelope<T> {
  op: "upsert" | "delete";
  key: string;
  value?: T;
  at: string;
}

interface RuntimeMeta {
  pid: number;
  startedAt: string;
  socketPath: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readJsonl<T>(path: string): JsonlEnvelope<T>[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf-8");
  if (!text.trim()) return [];
  const rows: JsonlEnvelope<T>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as JsonlEnvelope<T>);
    } catch {
      // skip invalid rows
    }
  }
  return rows;
}

function appendJsonl<T>(path: string, row: JsonlEnvelope<T>): void {
  appendFileSync(path, JSON.stringify(row) + "\n", "utf-8");
}

function hydrateMap<T extends object>(rows: JsonlEnvelope<T>[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    if (row.op === "delete") {
      map.delete(row.key);
      continue;
    }
    if (row.value) map.set(row.key, row.value);
  }
  return map;
}

export class DaemonStore {
  readonly daemonDir: string;
  readonly runsPath: string;
  readonly workersPath: string;
  readonly callsPath: string;
  readonly eventsPath: string;
  readonly metaPath: string;

  private runs: Map<string, RunRecord>;
  private workers: Map<string, WorkerRuntimeRecord>;
  private calls: Map<string, PendingCallRecord>;
  private nextSeq = 1;

  constructor(projectRoot: string) {
    this.daemonDir = join(projectRoot, ".floe", "state", "daemon");
    mkdirSync(this.daemonDir, { recursive: true });

    this.runsPath = join(this.daemonDir, "runs.jsonl");
    this.workersPath = join(this.daemonDir, "workers.jsonl");
    this.callsPath = join(this.daemonDir, "pending-calls.jsonl");
    this.eventsPath = join(this.daemonDir, "events.jsonl");
    this.metaPath = join(this.daemonDir, "runtime-meta.json");

    this.runs = hydrateMap(readJsonl<RunRecord>(this.runsPath));
    this.workers = hydrateMap(readJsonl<WorkerRuntimeRecord>(this.workersPath));
    this.calls = hydrateMap(readJsonl<PendingCallRecord>(this.callsPath));

    const events = this.readAllEvents();
    const maxSeq = events.reduce((max, event) => Math.max(max, event.seq || 0), 0);
    this.nextSeq = maxSeq + 1;
  }

  saveMeta(meta: RuntimeMeta): void {
    writeFileSync(this.metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  }

  readMeta(): RuntimeMeta | null {
    if (!existsSync(this.metaPath)) return null;
    try {
      return JSON.parse(readFileSync(this.metaPath, "utf-8")) as RuntimeMeta;
    } catch {
      return null;
    }
  }

  upsertRun(run: RunRecord): void {
    this.runs.set(run.runId, run);
    appendJsonl(this.runsPath, { op: "upsert", key: run.runId, value: run, at: nowIso() });
  }

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  listRuns(): RunRecord[] {
    return Array.from(this.runs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  upsertWorker(worker: WorkerRuntimeRecord): void {
    this.workers.set(worker.workerId, worker);
    appendJsonl(this.workersPath, { op: "upsert", key: worker.workerId, value: worker, at: nowIso() });
  }

  getWorker(workerId: string): WorkerRuntimeRecord | undefined {
    return this.workers.get(workerId);
  }

  listWorkers(runId?: string): WorkerRuntimeRecord[] {
    const all = Array.from(this.workers.values());
    const filtered = runId ? all.filter(worker => worker.runId === runId) : all;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  upsertCall(call: PendingCallRecord): void {
    this.calls.set(call.callId, call);
    appendJsonl(this.callsPath, { op: "upsert", key: call.callId, value: call, at: nowIso() });
  }

  getCall(callId: string): PendingCallRecord | undefined {
    return this.calls.get(callId);
  }

  listCalls(runId?: string): PendingCallRecord[] {
    const all = Array.from(this.calls.values());
    const filtered = runId ? all.filter(call => call.runId === runId) : all;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listPendingCalls(runId?: string): PendingCallRecord[] {
    return this.listCalls(runId).filter(call => call.status === "pending");
  }

  emitEvent(event: Omit<RuntimeEvent, "seq" | "timestamp">): RuntimeEvent {
    const fullEvent: RuntimeEvent = {
      ...event,
      seq: this.nextSeq++,
      timestamp: nowIso(),
    };
    appendFileSync(this.eventsPath, JSON.stringify(fullEvent) + "\n", "utf-8");
    return fullEvent;
  }

  readAllEvents(): RuntimeEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const text = readFileSync(this.eventsPath, "utf-8");
    const events: RuntimeEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as RuntimeEvent);
      } catch {
        // ignore invalid lines
      }
    }
    return events.sort((a, b) => a.seq - b.seq);
  }

  listEvents(options: { runId?: string; cursor?: number; limit?: number }): RuntimeEvent[] {
    const { runId, cursor = 0, limit = 100 } = options;
    const events = this.readAllEvents().filter(event => event.seq > cursor);
    const filtered = runId ? events.filter(event => event.runId === runId) : events;
    return filtered.slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  status(socketPath: string): RuntimeStatus {
    return {
      runtime: {
        pid: process.pid,
        startedAt: this.readMeta()?.startedAt ?? nowIso(),
        socketPath,
      },
      counts: {
        runs: this.runs.size,
        pendingCalls: this.listPendingCalls().length,
        workers: this.workers.size,
      },
    };
  }
}
