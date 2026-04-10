import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SessionRegistry } from "../registry.ts";
import { loadDod, formatDodForPrompt } from "../dod.ts";
import type { WorkerConfig, WorkerProvider, WorkerRole, WorkerSession } from "../types.ts";
import type { ProviderAdapter } from "../adapters/interface.ts";
import { DaemonStore } from "./store.ts";
import { FeatureWorkflowEngine } from "./feature-workflow.ts";
import type { WaiterRegistry } from "./worker-channel.ts";
import type {
  CallBlockingPayload,
  CallDetectOrphanedPayload,
  CallResolvePayload,
  DaemonRequest,
  EventsReplayPayload,
  EventsSubscribePayload,
  PendingCallRecord,
  RouteReplyPayload,
  RouteSendPayload,
  RunGetPayload,
  RunRecord,
  RunStartPayload,
  WorkerContinuePayload,
  WorkerGetPayload,
  WorkerInterruptPayload,
  WorkerRecoverPayload,
  WorkerResumePayload,
  WorkerRuntimeRecord,
  WorkerStartPayload,
  WorkerStopPayload,
} from "./types.ts";

export interface RunFeaturePayload {
  featureId: string;
  implProvider?: string;
  revProvider?: string;
  epicId?: string;
  releaseId?: string;
  srcRoot?: string;
  budgets?: Record<string, unknown>;
}

interface FloeConfig {
  defaultProvider: string;
  enabledProviders?: string[];
  configured?: boolean;
  srcRoot?: string;
  roles?: {
    planner?: { provider?: string; model?: string; thinking?: string };
    implementer?: { provider?: string; model?: string; thinking?: string };
    reviewer?: { provider?: string; model?: string; thinking?: string };
  };
}

interface DaemonHandleResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  shutdown?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class DaemonService {
  private adapters = new Map<string, ProviderAdapter>();
  private adapterLoadErrors = new Map<string, string>();
  private registry: SessionRegistry;
  private store: DaemonStore;
  private projectRoot: string;
  private socketPath: string;
  private startedAt: string;
  private workflowEngine: FeatureWorkflowEngine;
  private waiterRegistry: WaiterRegistry | null = null;

  constructor(projectRoot: string, socketPath: string) {
    this.projectRoot = projectRoot;
    this.socketPath = socketPath;
    this.registry = new SessionRegistry(projectRoot);
    this.store = new DaemonStore(projectRoot);
    this.startedAt = nowIso();

    this.workflowEngine = new FeatureWorkflowEngine(
      projectRoot,
      this.store,
      (workerId, message) => this.sendMessageToWorker(workerId, message),
    );

    this.store.saveMeta({
      pid: process.pid,
      startedAt: this.startedAt,
      socketPath: this.socketPath,
    });
  }

  async init(): Promise<void> {
    await this.loadLiveAdapters();
    // Export daemon endpoint so child processes (worker tool-call subshells) can
    // use the persistent socket channel instead of CLI polling.
    process.env.FLOE_DAEMON_ENDPOINT = this.socketPath;
    this.store.emitEvent({ type: "runtime.started", data: { pid: process.pid, socketPath: this.socketPath } });
  }

  /** Inject the WaiterRegistry for push-based call resolution. */
  setWaiterRegistry(registry: WaiterRegistry): void {
    this.waiterRegistry = registry;
  }

  /** Get a worker runtime record by workerId (used by channel callbacks). */
  getWorkerRecord(workerId: string): WorkerRuntimeRecord {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new Error(`Worker not found: ${workerId}`);
    return worker;
  }

  /** Update heartbeat timestamp for a connected worker. */
  workerHeartbeat(workerId: string): void {
    const worker = this.store.getWorker(workerId);
    if (worker) {
      this.store.upsertWorker({ ...worker, lastHeartbeatAt: nowIso(), updatedAt: nowIso() });
    }
  }

  /** Handle worker disconnect — mark orphaned calls for grace period. */
  workerDisconnected(workerId: string, orphanedCallIds: string[]): void {
    const worker = this.store.getWorker(workerId);
    if (worker && worker.state === "waiting") {
      this.store.upsertWorker({ ...worker, state: "stalled", updatedAt: nowIso(), lastError: "channel disconnected" });
      this.store.emitEvent({
        type: "worker.stalled",
        runId: worker.runId,
        workerId,
        data: { reason: "channel_disconnected", orphanedCallIds },
      });
    }
    for (const callId of orphanedCallIds) {
      const call = this.store.getCall(callId);
      if (call && call.status === "pending") {
        // Don't orphan immediately — leave pending for grace period.
        // call.detect-orphaned will handle timeout.
        this.store.emitEvent({
          type: "worker.disconnected",
          runId: call.runId,
          workerId,
          callId,
          data: { reason: "channel_disconnected" },
        });
      }
    }
  }

  async handle(request: DaemonRequest): Promise<DaemonHandleResult> {
    const payload = request.payload ?? {};

    try {
      switch (request.action) {
        case "runtime.ensure":
          return this.ok(this.store.status(this.socketPath) as unknown as Record<string, unknown>);
        case "runtime.status":
          return this.ok(this.store.status(this.socketPath) as unknown as Record<string, unknown>);
        case "runtime.shutdown":
          this.store.emitEvent({ type: "runtime.stopping", data: { pid: process.pid } });
          return { ok: true, result: { stopping: true }, shutdown: true };

        case "run.start":
          return this.ok(await this.runStart(payload as unknown as RunStartPayload));
        case "run.complete":
          return this.ok(await this.runComplete(payload.runId as string, payload.reason as string | undefined));
        case "run.escalate":
          return this.ok(await this.runEscalate(payload.runId as string, payload.reason as string | undefined));
        case "run.get":
          return this.ok(await this.runGet(payload as unknown as RunGetPayload));

        case "run.feature":
          return this.ok(await this.runFeature(payload as unknown as RunFeaturePayload));

        case "worker.start":
          return this.ok(await this.workerStart(payload as unknown as WorkerStartPayload));
        case "worker.resume":
          return this.ok(await this.workerResume(payload as unknown as WorkerResumePayload));
        case "worker.continue":
          return this.ok(await this.workerContinue(payload as unknown as WorkerContinuePayload));
        case "worker.interrupt":
          return this.ok(await this.workerInterrupt(payload as unknown as WorkerInterruptPayload));
        case "worker.stop":
          return this.ok(await this.workerStop(payload as unknown as WorkerStopPayload));
        case "worker.recover":
          return this.ok(await this.workerRecover(payload as unknown as WorkerRecoverPayload));
        case "worker.get":
          return this.ok(await this.workerGet(payload as unknown as WorkerGetPayload));

        case "call.blocking":
          return this.ok(await this.callBlocking(payload as unknown as CallBlockingPayload));
        case "call.resolve":
          return this.ok(await this.callResolve(payload as unknown as CallResolvePayload));
        case "call.detectOrphaned":
          return this.ok(await this.callDetectOrphaned(payload as unknown as CallDetectOrphanedPayload));

        case "route.send":
          return this.ok(await this.routeSend(payload as unknown as RouteSendPayload));
        case "route.reply":
          return this.ok(await this.routeReply(payload as unknown as RouteReplyPayload));

        case "events.subscribe":
          return this.ok(await this.eventsSubscribe(payload as unknown as EventsSubscribePayload));
        case "events.replay":
          return this.ok(await this.eventsReplay(payload as unknown as EventsReplayPayload));

        default:
          return { ok: false, error: `Unknown daemon action: ${request.action}` };
      }
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  private ok(result: Record<string, unknown>): DaemonHandleResult {
    return { ok: true, result };
  }

  private async loadLiveAdapters(): Promise<void> {
    try {
      const { CodexAdapter } = await import("../adapters/codex.ts");
      this.adapters.set("codex", new CodexAdapter());
    } catch (error: any) {
      this.adapterLoadErrors.set("codex", error?.message ?? String(error));
    }

    try {
      const { ClaudeAdapter } = await import("../adapters/claude.ts");
      this.adapters.set("claude", new ClaudeAdapter());
    } catch (error: any) {
      this.adapterLoadErrors.set("claude", error?.message ?? String(error));
    }

    try {
      const { CopilotAdapter } = await import("../adapters/copilot.ts");
      this.adapters.set("copilot", new CopilotAdapter());
    } catch (error: any) {
      this.adapterLoadErrors.set("copilot", error?.message ?? String(error));
    }
  }

  private getAdapter(provider: string): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (adapter) return adapter;

    const loadError = this.adapterLoadErrors.get(provider);
    if (loadError) {
      throw new Error(`Adapter for '${provider}' failed to load: ${loadError}`);
    }
    throw new Error(`No adapter for provider '${provider}'`);
  }

  private loadConfig(): FloeConfig | null {
    const configPath = join(this.projectRoot, ".floe", "config.json");
    if (!existsSync(configPath)) return null;
    try {
      return JSON.parse(readFileSync(configPath, "utf-8")) as FloeConfig;
    } catch {
      return null;
    }
  }

  private resolveProvider(role: WorkerRole, requestedProvider?: string): { provider: WorkerProvider; model?: string; thinking?: string } {
    const config = this.loadConfig();

    const fromRole = config?.roles?.[role];
    const provider = (requestedProvider ?? fromRole?.provider ?? config?.defaultProvider ?? "") as WorkerProvider;
    if (!provider) {
      throw new Error("No provider configured for worker start. Set .floe/config.json or pass provider explicitly.");
    }

    if (config?.enabledProviders && !config.enabledProviders.includes(provider)) {
      throw new Error(`Provider '${provider}' is not enabled. Enabled: [${config.enabledProviders.join(", ")}]`);
    }

    return {
      provider,
      model: fromRole?.model,
      thinking: fromRole?.thinking,
    };
  }

  private readRoleContent(role: WorkerRole): { content?: string; path?: string } {
    const candidates = [
      join(this.projectRoot, ".floe", "roles", `${role}.md`),
      join(this.projectRoot, "skills", "floe-exec", "roles", `${role}.md`),
      join(this.projectRoot, ".github", "skills", "floe-exec", "roles", `${role}.md`),
      join(this.projectRoot, ".agents", "skills", "floe-exec", "roles", `${role}.md`),
    ];

    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        return { content: readFileSync(path, "utf-8"), path };
      } catch {
        // continue
      }
    }
    return {};
  }

  private getStoredWorker(workerId: string): WorkerSession {
    const session = this.registry.get(workerId);
    if (!session) throw new Error(`Worker session not found: ${workerId}`);
    return session;
  }

  private async ensureResumed(adapter: ProviderAdapter, sessionId: string, stored: WorkerSession): Promise<void> {
    if (adapter.hasSession(sessionId)) return;

    let roleContent: string | undefined;
    if (stored.roleContentPath && existsSync(stored.roleContentPath)) {
      try {
        roleContent = readFileSync(stored.roleContentPath, "utf-8");
      } catch {
        // ignore
      }
    }

    const resumed = await adapter.resumeSession(
      sessionId,
      stored,
      roleContent ? { roleContent } : undefined,
    );

    this.registry.update(sessionId, { status: resumed.status, updatedAt: resumed.updatedAt, metadata: resumed.metadata });
  }

  private annotateRunFromCallType(run: RunRecord, callType: string): RunRecord {
    const next: RunRecord = { ...run, updatedAt: nowIso() };
    if (callType === "request_foreman_clarification") next.state = "awaiting_foreman";
    if (callType === "request_plan_review") next.state = "awaiting_plan_review";
    if (callType === "request_code_review") next.state = "awaiting_code_review";
    return next;
  }

  private async runStart(payload: RunStartPayload): Promise<Record<string, unknown>> {
    if (!payload.type) throw new Error("run.start requires payload.type");
    if (!payload.objective) throw new Error("run.start requires payload.objective");

    const runId = makeId("run");
    const timestamp = nowIso();
    const run: RunRecord = {
      runId,
      type: payload.type,
      objective: payload.objective,
      participants: payload.participants ?? [],
      budgets: payload.budgets,
      state: payload.state ?? "initialising",
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: payload.metadata,
    };

    this.store.upsertRun(run);
    this.store.emitEvent({ type: "run.started", runId, data: { state: run.state, objective: run.objective } });

    return { run };
  }

  private async runComplete(runId: string, reason?: string): Promise<Record<string, unknown>> {
    if (!runId) throw new Error("run.complete requires runId");
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const updated: RunRecord = {
      ...run,
      state: "completed",
      updatedAt: nowIso(),
      completedAt: nowIso(),
      terminalReason: reason,
    };
    this.store.upsertRun(updated);
    this.store.emitEvent({ type: "run.completed", runId, data: { reason: reason ?? null } });

    return { run: updated };
  }

  private async runEscalate(runId: string, reason?: string): Promise<Record<string, unknown>> {
    if (!runId) throw new Error("run.escalate requires runId");
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const updated: RunRecord = {
      ...run,
      state: "escalated",
      updatedAt: nowIso(),
      completedAt: nowIso(),
      escalationReason: reason,
      terminalReason: reason,
    };
    this.store.upsertRun(updated);
    this.store.emitEvent({ type: "run.escalated", runId, data: { reason: reason ?? null } });

    return { run: updated };
  }

  private async runGet(payload: RunGetPayload): Promise<Record<string, unknown>> {
    if (!payload.runId) throw new Error("run.get requires runId");
    const run = this.store.getRun(payload.runId);
    if (!run) throw new Error(`Run not found: ${payload.runId}`);

    return {
      run,
      workers: this.store.listWorkers(payload.runId),
      calls: this.store.listCalls(payload.runId),
    };
  }

  /**
   * Daemon-native feature execution. Creates a run, starts implementer + reviewer
   * workers, and kicks off the FeatureWorkflowEngine. No external subprocess needed.
   */
  private async runFeature(payload: RunFeaturePayload): Promise<Record<string, unknown>> {
    if (!payload.featureId) throw new Error("run.feature requires featureId");

    // Create the run
    const runResult = await this.runStart({
      type: "feature_execution",
      objective: `Execute feature ${payload.featureId}`,
      state: "initialising",
      metadata: {
        featureId: payload.featureId,
        epicId: payload.epicId ?? null,
        releaseId: payload.releaseId ?? null,
      },
    });
    const run = (runResult as any).run as RunRecord;

    // Build implementer context addendum
    const config = this.loadConfig();
    const srcRoot = payload.srcRoot ?? config?.srcRoot;
    let implAddendum: string | undefined;
    if (srcRoot) {
      implAddendum = [
        "\n## Source Root\n",
        `All application source code for the project under development must be written to the \`${srcRoot}/\` directory (relative to the project root).`,
        `This directory has been configured as the project's source root.`,
        `Do NOT write application files into the .floe framework directory or the project root directly.`,
      ].join("\n");
    }

    // Start implementer
    const implResult = await this.workerStart({
      runId: run.runId,
      role: "implementer" as WorkerRole,
      provider: payload.implProvider as WorkerProvider | undefined,
      featureId: payload.featureId,
      epicId: payload.epicId,
      releaseId: payload.releaseId,
      contextAddendum: implAddendum,
    } as WorkerStartPayload);
    const implWorkerId = (implResult as any).workerId as string;
    if (!implWorkerId) {
      await this.runEscalate(run.runId, "Implementer launch failed");
      throw new Error("Implementer launch failed — no workerId returned");
    }

    // Start reviewer
    const revResult = await this.workerStart({
      runId: run.runId,
      role: "reviewer" as WorkerRole,
      provider: payload.revProvider as WorkerProvider | undefined,
      featureId: payload.featureId,
      epicId: payload.epicId,
      releaseId: payload.releaseId,
    } as WorkerStartPayload);
    const revWorkerId = (revResult as any).workerId as string;
    if (!revWorkerId) {
      await this.runEscalate(run.runId, "Reviewer launch failed");
      throw new Error("Reviewer launch failed — no workerId returned");
    }

    // Start workflow engine (runs asynchronously in-process)
    const workflowState = await this.workflowEngine.start(
      payload.featureId,
      run.runId,
      implWorkerId,
      revWorkerId,
    );

    return {
      featureId: payload.featureId,
      runId: run.runId,
      implementer: { workerId: implWorkerId },
      reviewer: { workerId: revWorkerId },
      workflow: workflowState,
    };
  }

  /**
   * Internal helper: send a message to a worker via the provider adapter.
   * Used by FeatureWorkflowEngine as its sendMessage callback.
   */
  private async sendMessageToWorker(
    workerId: string,
    message: string,
  ): Promise<{ ok: boolean; content?: string; error?: string }> {
    try {
      const stored = this.getStoredWorker(workerId);
      const adapter = this.getAdapter(stored.provider);
      await this.ensureResumed(adapter, workerId, stored);

      const result = await adapter.sendMessage(workerId, message);
      const fresh = adapter.getSession(workerId);
      this.registry.update(workerId, { lastMessageAt: nowIso(), metadata: fresh?.metadata });

      const runtimeWorker = this.store.getWorker(workerId);
      if (runtimeWorker) {
        this.store.upsertWorker({
          ...runtimeWorker,
          state: "active",
          updatedAt: nowIso(),
          lastMessageAt: nowIso(),
        });
      }

      return { ok: true, content: result.content };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  private async workerStart(payload: WorkerStartPayload): Promise<Record<string, unknown>> {
    const role = payload.role as WorkerRole | undefined;
    if (!role) throw new Error("worker.start requires role");

    const providerResolution = this.resolveProvider(role, payload.provider as WorkerProvider | undefined);
    const provider = providerResolution.provider;
    const adapter = this.getAdapter(provider);

    const { content: roleContent, path: roleContentPath } = this.readRoleContent(role);

    let contextAddendum = payload.contextAddendum;
    if (role === "reviewer" || role === "implementer") {
      const dod = loadDod(this.projectRoot);
      if (dod) {
        const dodText = formatDodForPrompt(dod);
        contextAddendum = contextAddendum ? `${contextAddendum}\n\n${dodText}` : dodText;
      }
    }

    const config: WorkerConfig = {
      role,
      provider,
      featureId: payload.featureId ?? "unscoped",
      epicId: payload.epicId,
      releaseId: payload.releaseId,
      roleContent,
      roleContentPath,
      contextAddendum,
      model: (payload.model as string | undefined) ?? providerResolution.model,
      thinking: (payload.thinking as string | undefined) ?? providerResolution.thinking,
    };

    const session = await adapter.startSession(config);
    this.registry.register(session);

    const runtimeWorker: WorkerRuntimeRecord = {
      workerId: session.id,
      sessionId: session.id,
      role: session.role,
      provider: session.provider,
      runId: payload.runId,
      state: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      retryCount: 0,
      metadata: {
        featureId: session.featureId,
        epicId: session.epicId,
        releaseId: session.releaseId,
      },
    };
    this.store.upsertWorker(runtimeWorker);

    this.store.emitEvent({
      type: "worker.started",
      runId: payload.runId,
      workerId: session.id,
      data: { role: session.role, provider: session.provider },
    });

    if (payload.runId) {
      const run = this.store.getRun(payload.runId);
      if (run && !run.participants.includes(session.id)) {
        const updatedRun: RunRecord = {
          ...run,
          updatedAt: nowIso(),
          participants: [...run.participants, session.id],
          state: run.state === "initialising" ? "planning" : run.state,
        };
        this.store.upsertRun(updatedRun);
        this.store.emitEvent({
          type: "run.progress",
          runId: updatedRun.runId,
          data: { participants: updatedRun.participants.length },
        });
      }
    }

    let initialResult: Record<string, unknown> | undefined;
    if (payload.initialMessage) {
      const messageResult = await adapter.sendMessage(session.id, payload.initialMessage);
      const fresh = adapter.getSession(session.id);
      this.registry.update(session.id, { lastMessageAt: nowIso(), metadata: fresh?.metadata ?? session.metadata });
      this.store.upsertWorker({ ...runtimeWorker, lastMessageAt: nowIso(), updatedAt: nowIso() });
      initialResult = {
        content: messageResult.content,
        finishReason: messageResult.finishReason,
        usage: messageResult.usage,
      };
      this.store.emitEvent({
        type: "run.progress",
        runId: payload.runId,
        workerId: session.id,
        data: { event: "worker.initial_message.complete" },
      });
    }

    return {
      workerId: session.id,
      session,
      runtimeWorker,
      initialResult: initialResult ?? null,
    };
  }

  private async workerResume(payload: WorkerResumePayload): Promise<Record<string, unknown>> {
    const workerId = payload.workerId ?? payload.sessionRef;
    if (!workerId) throw new Error("worker.resume requires workerId or sessionRef");

    const stored = this.getStoredWorker(workerId);
    const adapter = this.getAdapter(stored.provider);
    await this.ensureResumed(adapter, workerId, stored);

    const existing = this.store.getWorker(workerId);
    const updated: WorkerRuntimeRecord = {
      ...(existing ?? {
        workerId,
        sessionId: workerId,
        role: stored.role,
        provider: stored.provider,
        createdAt: nowIso(),
        retryCount: 0,
      }),
      runId: payload.runId ?? existing?.runId,
      state: "active",
      updatedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
      pendingCallId: undefined,
    };

    this.store.upsertWorker(updated);
    this.store.emitEvent({ type: "worker.resumed", runId: updated.runId, workerId, data: { provider: stored.provider } });

    return { worker: updated, session: this.registry.get(workerId) };
  }

  private async workerContinue(payload: WorkerContinuePayload): Promise<Record<string, unknown>> {
    if (!payload.workerId) throw new Error("worker.continue requires workerId");
    if (!payload.callId) throw new Error("worker.continue requires callId");

    const call = this.store.getCall(payload.callId);
    if (!call) throw new Error(`Call not found: ${payload.callId}`);
    if (call.status !== "resolved") {
      throw new Error(`Call ${payload.callId} is not resolved (status=${call.status})`);
    }
    if (call.workerId !== payload.workerId) {
      throw new Error(`Call ${payload.callId} does not belong to worker ${payload.workerId}`);
    }

    const stored = this.getStoredWorker(payload.workerId);
    const adapter = this.getAdapter(stored.provider);
    await this.ensureResumed(adapter, payload.workerId, stored);

    const runtimeWorker = this.store.getWorker(payload.workerId);
    if (runtimeWorker?.state && runtimeWorker.state !== "waiting" && runtimeWorker.state !== "resolved") {
      throw new Error(`Worker ${payload.workerId} is not in waiting/resolved state (state=${runtimeWorker.state})`);
    }

    const continuation = payload.continuation
      ?? (call.responsePayload?.continuation as string | undefined)
      ?? (call.responsePayload?.message as string | undefined);

    if (!continuation) {
      throw new Error(`worker.continue requires continuation text or call.responsePayload.message`);
    }

    const result = await adapter.sendMessage(payload.workerId, continuation);
    const fresh = adapter.getSession(payload.workerId);
    this.registry.update(payload.workerId, { lastMessageAt: nowIso(), metadata: fresh?.metadata });

    const nextWorker: WorkerRuntimeRecord = {
      ...(runtimeWorker ?? {
        workerId: payload.workerId,
        sessionId: payload.workerId,
        role: stored.role,
        provider: stored.provider,
        createdAt: nowIso(),
        retryCount: 0,
      }),
      runId: payload.runId ?? runtimeWorker?.runId ?? call.runId,
      state: "active",
      updatedAt: nowIso(),
      lastMessageAt: nowIso(),
      pendingCallId: undefined,
    };
    this.store.upsertWorker(nextWorker);

    this.store.emitEvent({
      type: "worker.resolved",
      runId: nextWorker.runId,
      workerId: payload.workerId,
      callId: payload.callId,
      data: { resumed: true },
    });

    this.store.emitEvent({
      type: "run.progress",
      runId: nextWorker.runId,
      workerId: payload.workerId,
      data: { event: "worker.continue.complete" },
    });

    return {
      worker: nextWorker,
      result: {
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage,
      },
    };
  }

  private async workerInterrupt(payload: WorkerInterruptPayload): Promise<Record<string, unknown>> {
    if (!payload.workerId) throw new Error("worker.interrupt requires workerId");

    const runtimeWorker = this.store.getWorker(payload.workerId);
    if (!runtimeWorker) throw new Error(`Worker not found: ${payload.workerId}`);

    const updated: WorkerRuntimeRecord = {
      ...runtimeWorker,
      state: "interrupted",
      updatedAt: nowIso(),
      lastError: payload.reason,
    };
    this.store.upsertWorker(updated);

    this.store.emitEvent({
      type: "worker.interrupted",
      runId: updated.runId,
      workerId: payload.workerId,
      data: { reason: payload.reason ?? null },
    });

    return { worker: updated };
  }

  private async workerStop(payload: WorkerStopPayload): Promise<Record<string, unknown>> {
    if (!payload.workerId) throw new Error("worker.stop requires workerId");

    const stored = this.getStoredWorker(payload.workerId);
    const adapter = this.getAdapter(stored.provider);
    await this.ensureResumed(adapter, payload.workerId, stored).catch(() => {});
    await adapter.stopSession(payload.workerId).catch(() => {});
    await adapter.closeSession(payload.workerId).catch(() => {});

    this.registry.setStatus(payload.workerId, "stopped");

    const runtimeWorker = this.store.getWorker(payload.workerId);
    const updated: WorkerRuntimeRecord = {
      ...(runtimeWorker ?? {
        workerId: payload.workerId,
        sessionId: payload.workerId,
        role: stored.role,
        provider: stored.provider,
        createdAt: nowIso(),
        retryCount: 0,
      }),
      state: "stopped",
      updatedAt: nowIso(),
      lastError: payload.reason,
    };
    this.store.upsertWorker(updated);

    if (updated.pendingCallId) {
      const call = this.store.getCall(updated.pendingCallId);
      if (call && call.status === "pending") {
        const orphaned: PendingCallRecord = {
          ...call,
          status: "orphaned",
          updatedAt: nowIso(),
          notes: `Worker stopped: ${payload.reason ?? "no reason provided"}`,
        };
        this.store.upsertCall(orphaned);
        this.store.emitEvent({ type: "call.orphaned", runId: orphaned.runId, workerId: payload.workerId, callId: orphaned.callId });
      }
    }

    this.store.emitEvent({
      type: "worker.stopped",
      runId: updated.runId,
      workerId: payload.workerId,
      data: { reason: payload.reason ?? null },
    });

    return { worker: updated };
  }

  private async workerRecover(payload: WorkerRecoverPayload): Promise<Record<string, unknown>> {
    if (!payload.workerId) throw new Error("worker.recover requires workerId");
    const strategy = payload.strategy ?? "session";

    const stored = this.getStoredWorker(payload.workerId);
    const adapter = this.getAdapter(stored.provider);

    if (strategy === "warm" && adapter.hasSession(payload.workerId)) {
      const runtimeWorker = this.store.getWorker(payload.workerId);
      const updated: WorkerRuntimeRecord = {
        ...(runtimeWorker ?? {
          workerId: payload.workerId,
          sessionId: payload.workerId,
          role: stored.role,
          provider: stored.provider,
          createdAt: nowIso(),
          retryCount: 0,
        }),
        state: "active",
        updatedAt: nowIso(),
        retryCount: (runtimeWorker?.retryCount ?? 0) + 1,
      };
      this.store.upsertWorker(updated);
      this.store.emitEvent({ type: "provider.resumed", runId: updated.runId, workerId: payload.workerId, data: { strategy } });
      return { strategy, worker: updated, recovered: true };
    }

    if (strategy === "session" || strategy === "warm") {
      try {
        await this.ensureResumed(adapter, payload.workerId, stored);
        const runtimeWorker = this.store.getWorker(payload.workerId);
        const updated: WorkerRuntimeRecord = {
          ...(runtimeWorker ?? {
            workerId: payload.workerId,
            sessionId: payload.workerId,
            role: stored.role,
            provider: stored.provider,
            createdAt: nowIso(),
            retryCount: 0,
          }),
          runId: payload.runId ?? runtimeWorker?.runId,
          state: "active",
          updatedAt: nowIso(),
          retryCount: (runtimeWorker?.retryCount ?? 0) + 1,
        };
        this.store.upsertWorker(updated);
        this.store.emitEvent({ type: "provider.resumed", runId: updated.runId, workerId: payload.workerId, data: { strategy: "session" } });
        return { strategy: "session", worker: updated, recovered: true };
      } catch (error: any) {
        if (strategy !== "warm") throw error;
      }
    }

    const { content: roleContent, path: roleContentPath } = this.readRoleContent(stored.role);
    const recoveredSession = await adapter.startSession({
      role: stored.role,
      provider: stored.provider,
      featureId: stored.featureId,
      epicId: stored.epicId,
      releaseId: stored.releaseId,
      roleContent,
      roleContentPath,
      contextAddendum: payload.contextAddendum,
      model: stored.metadata?.model as string | undefined,
      thinking: stored.metadata?.thinking as string | undefined,
    });
    this.registry.register(recoveredSession);

    const originalRuntimeWorker = this.store.getWorker(payload.workerId);
    const recoveredRuntimeWorker: WorkerRuntimeRecord = {
      workerId: recoveredSession.id,
      sessionId: recoveredSession.id,
      role: recoveredSession.role,
      provider: recoveredSession.provider,
      runId: payload.runId ?? originalRuntimeWorker?.runId,
      state: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      retryCount: (originalRuntimeWorker?.retryCount ?? 0) + 1,
      metadata: {
        recoveredFrom: payload.workerId,
      },
    };
    this.store.upsertWorker(recoveredRuntimeWorker);

    if (originalRuntimeWorker) {
      this.store.upsertWorker({
        ...originalRuntimeWorker,
        state: "failed",
        updatedAt: nowIso(),
        lastError: `Recovered by artefact strategy to ${recoveredSession.id}`,
      });
    }

    this.store.emitEvent({
      type: "provider.resumed",
      runId: recoveredRuntimeWorker.runId,
      workerId: recoveredSession.id,
      data: { strategy: "artefact", recoveredFrom: payload.workerId },
    });

    return {
      strategy: "artefact",
      recovered: true,
      recoveredWorkerId: recoveredSession.id,
      worker: recoveredRuntimeWorker,
    };
  }

  private async workerGet(payload: WorkerGetPayload): Promise<Record<string, unknown>> {
    if (!payload.workerId) throw new Error("worker.get requires workerId");

    return {
      worker: this.store.getWorker(payload.workerId) ?? null,
      session: this.registry.get(payload.workerId) ?? null,
    };
  }

  private async callBlocking(payload: CallBlockingPayload): Promise<Record<string, unknown>> {
    if (!payload.runId) throw new Error("call.blocking requires runId");
    if (!payload.workerId) throw new Error("call.blocking requires workerId");
    if (!payload.callType) throw new Error("call.blocking requires callType");

    const run = this.store.getRun(payload.runId);
    if (!run) throw new Error(`Run not found: ${payload.runId}`);

    const stored = this.getStoredWorker(payload.workerId);
    const runtimeWorker = this.store.getWorker(payload.workerId);

    const callId = makeId("call");
    const timestamp = nowIso();
    const call: PendingCallRecord = {
      callId,
      runId: payload.runId,
      workerId: payload.workerId,
      role: stored.role,
      callType: payload.callType,
      status: "pending",
      payload: payload.payload ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
      dependsOn: payload.dependsOn ?? [],
      resumeStrategy: payload.resumeStrategy ?? "session",
      timeoutAt: payload.timeoutAt,
      retryCount: 0,
    };

    this.store.upsertCall(call);

    const updatedWorker: WorkerRuntimeRecord = {
      ...(runtimeWorker ?? {
        workerId: payload.workerId,
        sessionId: payload.workerId,
        role: stored.role,
        provider: stored.provider,
        createdAt: nowIso(),
        retryCount: 0,
      }),
      runId: payload.runId,
      state: "waiting",
      pendingCallId: callId,
      updatedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
    };
    this.store.upsertWorker(updatedWorker);

    const annotatedRun = this.annotateRunFromCallType(run, payload.callType);
    this.store.upsertRun(annotatedRun);

    this.store.emitEvent({
      type: "call.pending",
      runId: payload.runId,
      workerId: payload.workerId,
      callId,
      data: { callType: payload.callType },
    });

    this.store.emitEvent({
      type: "worker.waiting",
      runId: payload.runId,
      workerId: payload.workerId,
      callId,
      data: { callType: payload.callType },
    });

    if (payload.callType === "request_foreman_clarification") {
      this.store.emitEvent({
        type: "run.awaiting_foreman",
        runId: payload.runId,
        workerId: payload.workerId,
        callId,
        data: {
          question: payload.payload?.question,
          context: payload.payload?.context,
        },
      });
    }

    return { call, worker: updatedWorker, run: annotatedRun };
  }

  private async callResolve(payload: CallResolvePayload): Promise<Record<string, unknown>> {
    if (!payload.callId) throw new Error("call.resolve requires callId");

    const existing = this.store.getCall(payload.callId);
    if (!existing) throw new Error(`Call not found: ${payload.callId}`);

    const resolved: PendingCallRecord = {
      ...existing,
      status: "resolved",
      responsePayload: payload.responsePayload,
      resolvedBy: payload.resolvedBy,
      resolvedAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.upsertCall(resolved);

    const runtimeWorker = this.store.getWorker(existing.workerId);
    if (runtimeWorker) {
      this.store.upsertWorker({
        ...runtimeWorker,
        state: "resolved",
        updatedAt: nowIso(),
      });
    }

    this.store.emitEvent({
      type: "call.resolved",
      runId: resolved.runId,
      workerId: resolved.workerId,
      callId: resolved.callId,
      // Include responsePayload in the event so both the persistent socket channel
      // and the CLI polling fallback can deliver the resolution inline.
      data: { resolvedBy: payload.resolvedBy ?? null, responsePayload: payload.responsePayload ?? null },
    });

    // Primary path: push resolution over persistent worker channel if a live
    // waiter exists. The worker receives it immediately — no polling, no wake-up.
    // Fallback: CLI polling via events.subscribe (for admin/debug invocations).
    // Recovery: worker.continue (for crash/restart/orphan scenarios).
    let pushedViaChannel = false;
    if (this.waiterRegistry?.has(payload.callId)) {
      pushedViaChannel = this.waiterRegistry.resolve(
        payload.callId,
        payload.responsePayload ?? null,
        payload.resolvedBy ?? null,
      );
    }

    return { call: resolved, pushedViaChannel, reason: pushedViaChannel ? "channel-push" : "event-fallback" };
  }

  private async callDetectOrphaned(payload: CallDetectOrphanedPayload): Promise<Record<string, unknown>> {
    const pending = this.store.listPendingCalls(payload.runId);
    const now = Date.now();

    const orphaned: PendingCallRecord[] = [];
    const timedOut: PendingCallRecord[] = [];

    for (const call of pending) {
      let isTimedOut = false;
      if (call.timeoutAt) {
        const timeoutMs = Date.parse(call.timeoutAt);
        if (!Number.isNaN(timeoutMs) && timeoutMs < now) {
          isTimedOut = true;
        }
      }

      if (isTimedOut) {
        const updated: PendingCallRecord = {
          ...call,
          status: "timed_out",
          updatedAt: nowIso(),
          resolvedAt: nowIso(),
          notes: "Timed out while pending",
        };
        this.store.upsertCall(updated);
        this.store.emitEvent({ type: "call.timed_out", runId: updated.runId, workerId: updated.workerId, callId: updated.callId });

        const worker = this.store.getWorker(updated.workerId);
        if (worker) {
          this.store.upsertWorker({ ...worker, state: "stalled", updatedAt: nowIso(), lastError: "Pending call timed out" });
          this.store.emitEvent({ type: "worker.stalled", runId: worker.runId, workerId: worker.workerId, callId: updated.callId });
        }

        timedOut.push(updated);
        continue;
      }

      const session = this.registry.get(call.workerId);
      const worker = this.store.getWorker(call.workerId);
      const missingWorker = !session || !worker;
      const deadWorker = worker?.state === "stopped" || worker?.state === "failed";
      if (missingWorker || deadWorker) {
        const updated: PendingCallRecord = {
          ...call,
          status: "orphaned",
          updatedAt: nowIso(),
          notes: missingWorker ? "Worker session not found" : `Worker state is ${worker?.state}`,
        };
        this.store.upsertCall(updated);
        this.store.emitEvent({ type: "call.orphaned", runId: updated.runId, workerId: updated.workerId, callId: updated.callId });
        orphaned.push(updated);
      }
    }

    return {
      scanned: pending.length,
      orphanedCount: orphaned.length,
      timedOutCount: timedOut.length,
      orphaned,
      timedOut,
    };
  }

  private async routeSend(payload: RouteSendPayload): Promise<Record<string, unknown>> {
    if (!payload.to) throw new Error("route.send requires 'to' worker id");
    if (!payload.message) throw new Error("route.send requires message");

    const stored = this.getStoredWorker(payload.to);
    const adapter = this.getAdapter(stored.provider);
    await this.ensureResumed(adapter, payload.to, stored);

    const fullMessage = payload.context
      ? `${payload.message}\n\n[Sidecar context]\n${JSON.stringify(payload.context, null, 2)}`
      : payload.message;

    const result = await adapter.sendMessage(payload.to, fullMessage);
    const fresh = adapter.getSession(payload.to);
    this.registry.update(payload.to, { lastMessageAt: nowIso(), metadata: fresh?.metadata });

    const runtimeWorker = this.store.getWorker(payload.to);
    if (runtimeWorker) {
      this.store.upsertWorker({
        ...runtimeWorker,
        state: "active",
        updatedAt: nowIso(),
        lastMessageAt: nowIso(),
      });
    }

    this.store.emitEvent({
      type: "run.progress",
      runId: payload.runId ?? runtimeWorker?.runId,
      workerId: payload.to,
      data: { event: "route.send.complete" },
    });

    return {
      workerId: payload.to,
      result: {
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage,
      },
    };
  }

  private async routeReply(payload: RouteReplyPayload): Promise<Record<string, unknown>> {
    if (!payload.callId) throw new Error("route.reply requires callId");
    return this.callResolve({ callId: payload.callId, responsePayload: payload.response, resolvedBy: payload.resolvedBy });
  }

  private async eventsSubscribe(payload: EventsSubscribePayload): Promise<Record<string, unknown>> {
    const waitMs = Math.max(0, Number(payload.waitMs ?? 0) || 0);
    const limit = payload.limit ?? 100;
    let cursor = payload.cursor ?? 0;

    const start = Date.now();
    while (true) {
      const raw = this.store.listEvents({ runId: payload.runId, cursor, limit });
      // Filter by callId if provided so callers can efficiently wait for a specific call.
      const filtered = payload.callId ? raw.filter((e) => e.callId === payload.callId) : raw;
      if (filtered.length > 0 || waitMs === 0) {
        return {
          events: filtered,
          cursor,
          nextCursor: raw.length > 0 ? raw[raw.length - 1]!.seq : cursor,
          waitedMs: Date.now() - start,
        };
      }
      if (Date.now() - start >= waitMs) {
        return { events: [], cursor, nextCursor: cursor, waitedMs: Date.now() - start };
      }
      // Advance cursor even when no filtered events so we don't re-scan old unrelated events.
      if (raw.length > 0) cursor = raw[raw.length - 1]!.seq;
      await Bun.sleep(250);
    }
  }

  private async eventsReplay(payload: EventsReplayPayload): Promise<Record<string, unknown>> {
    const events = this.store.listEvents({ runId: payload.runId, cursor: payload.cursor ?? 0, limit: payload.limit ?? 100 });
    return {
      events,
      cursor: payload.cursor ?? 0,
      nextCursor: events.length > 0 ? events[events.length - 1]!.seq : payload.cursor ?? 0,
    };
  }
}
