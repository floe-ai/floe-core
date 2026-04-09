/**
 * Copilot provider adapter — uses @github/copilot-sdk.
 *
 * SDK reference:  https://docs.github.com/en/copilot/how-tos/copilot-sdk
 * SDK source:     https://github.com/github/copilot-sdk
 * Getting started: https://github.com/github/copilot-sdk/blob/main/docs/getting-started.md
 * SDK version:    v0.2.x (technical preview)
 *
 * Auth: Uses existing GitHub/Copilot CLI credentials automatically.
 * The CopilotClient picks up the local auth session. No API key required.
 *
 * Session model:
 *   - Sessions persist via "infinite sessions" (enabled by default), which stores
 *     workspace state to a disk directory under session.workspacePath.
 *   - Sessions can be resumed cross-process via client.resumeSession(sessionId, config).
 *   - session.sessionId is a public property — always store this in metadata.
 *
 * Streaming:
 *   - Must set streaming: true in createSession options to receive delta events.
 *   - Delta events: assistant.message_delta with event.data.deltaContent
 *   - Completion: session.idle fires when the response is ready.
 *   - session.on() returns an unsubscribe function — there is no .off() method.
 *
 * Non-streaming convenience:
 *   - sendAndWait({ prompt }) returns a promise that resolves with the full response.
 *   - Used in sendMessage() for cleaner non-streaming path.
 */

import type { ProviderAdapter } from "./interface.ts";
import type {
  WorkerConfig,
  WorkerSession,
  WorkerStatus,
  SendOptions,
  MessageResult,
  EventHandlers,
} from "../types.ts";

// ── SDK type shapes (sourced from @github/copilot-sdk v0.1.x) ───────────────

type SessionEventHandler = (event: unknown) => void;

interface CopilotSendAndWaitResult {
  data: { content: string };
}

interface CopilotPermissionResult {
  kind: string;
  [key: string]: unknown;
}

type CopilotPermissionHandler = (
  req: unknown,
  invocation?: { sessionId: string },
) => Promise<CopilotPermissionResult> | CopilotPermissionResult;

interface CopilotSession {
  /** SDK-assigned session identifier. Persist and use with client.resumeSession(). */
  readonly sessionId: string;
  /** Path to the persistent workspace directory for this session. */
  readonly workspacePath?: string;
  /** Send a prompt. Resolves when dispatch is complete; subscribe to events for the response. */
  send(options: { prompt: string }): Promise<void>;
  /** Send a prompt and wait for the complete response. */
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<CopilotSendAndWaitResult | null>;
  /** Subscribe to all events or a specific event type. Returns an unsubscribe function. */
  on(handler: SessionEventHandler): () => void;
  on(eventType: string, handler: SessionEventHandler): () => void;
  /** Disconnect from the session (preserves disk state for future resume). */
  disconnect(): Promise<void>;
}

interface CopilotClientApi {
  /** Start the underlying Copilot CLI process. */
  start(): Promise<void>;
  /** Stop the client and release all resources. */
  stop(): Promise<unknown[]>;
  /** Create a new session. streaming: true enables assistant.message_delta events. */
  createSession(options: {
    model?: string;
    sessionId?: string;
    streaming?: boolean;
    infiniteSessions?: { enabled?: boolean };
    onPermissionRequest: CopilotPermissionHandler;
    systemMessage?: { content: string };
  }): Promise<CopilotSession>;
  /** Resume a previously created session by its sessionId. */
  resumeSession(sessionId: string, config: {
    model?: string;
    streaming?: boolean;
    onPermissionRequest: CopilotPermissionHandler;
  }): Promise<CopilotSession>;
}

// ── Internal session state ────────────────────────────────────────────────────

interface CopilotSessionMeta {
  clientInstance: CopilotClientApi;
  copilotSession: CopilotSession;
  session: WorkerSession;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class CopilotAdapter implements ProviderAdapter {
  readonly provider = "copilot";

  private sessions = new Map<string, CopilotSessionMeta>();
  private permissionHandler: CopilotPermissionHandler = () => ({ kind: "approved" });

  private async createClient(): Promise<CopilotClientApi> {
    try {
      // @ts-ignore — optional peer dependency, dynamically imported
      const { CopilotClient, approveAll } = await import("@github/copilot-sdk");
      if (typeof approveAll === "function") {
        this.permissionHandler = approveAll as CopilotPermissionHandler;
      }
      return new CopilotClient() as unknown as CopilotClientApi;
    } catch {
      throw new Error(
        "Copilot SDK not available. Install @github/copilot-sdk and ensure you are signed in to Copilot CLI."
      );
    }
  }

  private resolveSendTimeoutMs(requested?: number): number {
    if (Number.isFinite(requested) && (requested as number) >= 100) {
      return Math.floor(requested as number);
    }
    const envValue = Number(process.env.FLOE_COPILOT_SEND_TIMEOUT_MS ?? "");
    if (Number.isFinite(envValue) && envValue >= 100) {
      return Math.floor(envValue);
    }
    return 30 * 60_000;
  }

  private generateId(): string {
    return `copilot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async startSession(config: WorkerConfig): Promise<WorkerSession> {
    const client = await this.createClient();
    await client.start();

    const roleContentFull = config.roleContent
      ? config.roleContent + (config.contextAddendum ? `\n\n${config.contextAddendum}` : "")
      : undefined;

    const systemMessage = roleContentFull
      ? { content: roleContentFull }
      : undefined;

    const copilotSession = await client.createSession({
      streaming: true,
      onPermissionRequest: this.permissionHandler,
      ...(systemMessage ? { systemMessage } : {}),
      ...(config.model ? { model: config.model } : {}),
    });

    const id = this.generateId();
    const now = this.now();

    const session: WorkerSession = {
      id,
      role: config.role,
      provider: "copilot",
      status: "active",
      featureId: config.featureId,
      epicId: config.epicId,
      releaseId: config.releaseId,
      roleContentPath: config.roleContentPath,
      createdAt: now,
      updatedAt: now,
      metadata: {
        copilotSessionId: copilotSession.sessionId,
        workspacePath: copilotSession.workspacePath,
        model: config.model,
        roleContent: roleContentFull,
      },
    };

    this.sessions.set(id, { clientInstance: client, copilotSession, session });
    return session;
  }

  async resumeSession(
    sessionId: string,
    storedSession: WorkerSession,
    config?: Partial<WorkerConfig>
  ): Promise<WorkerSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.session.status = "active";
      existing.session.updatedAt = this.now();
      return existing.session;
    }

    // Cross-process resume using the SDK's native resumeSession().
    // Infinite sessions (enabled by default) persist the workspace to disk,
    // so conversation context is restored on resume.
    const copilotSessionId = storedSession.metadata?.copilotSessionId as string | undefined;
    if (!copilotSessionId) {
      throw new Error(
        `Cannot resume Copilot session ${sessionId}: missing copilotSessionId in stored metadata`
      );
    }

    const client = await this.createClient();
    await client.start();

    const storedModel = storedSession.metadata?.model as string | undefined;
    const copilotSession = await client.resumeSession(copilotSessionId, {
      streaming: true,
      onPermissionRequest: this.permissionHandler,
      ...(storedModel ? { model: storedModel } : {}),
    });

    // Re-inject role content as a context reminder after cross-process resume.
    // Infinite sessions may not faithfully preserve the original system message,
    // so we send the role content as a user message to re-establish context.
    // Keep the injected message minimal to avoid wasting context tokens.
    const roleContent =
      config?.roleContent ??
      (storedSession.metadata?.roleContent as string | undefined);

    if (roleContent) {
      await copilotSession.sendAndWait({
        prompt: `[System context — resumed session. Your role definition follows.]\n\n${roleContent}\n\nReply with only: "Ready."`,
      }, this.resolveSendTimeoutMs()).catch(() => {
        // Best-effort: if re-injection fails, the session still works
      });
    }

    const now = this.now();
    const resumedSession: WorkerSession = {
      ...storedSession,
      status: "active",
      updatedAt: now,
      metadata: {
        ...storedSession.metadata,
        workspacePath: copilotSession.workspacePath ?? storedSession.metadata?.workspacePath,
        resumedAt: now,
      },
    };

    this.sessions.set(sessionId, { clientInstance: client, copilotSession, session: resumedSession });
    return resumedSession;
  }

  async sendMessage(
    sessionId: string,
    message: string,
    options?: SendOptions
  ): Promise<MessageResult> {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`Copilot session not found: ${sessionId}`);

    // Use sendAndWait() for non-streaming — cleaner than manual event subscription
    const response = await meta.copilotSession.sendAndWait(
      { prompt: message },
      this.resolveSendTimeoutMs(options?.timeoutMs),
    );
    const content = response?.data?.content ?? "";

    meta.session.lastMessageAt = this.now();
    meta.session.updatedAt = this.now();

    return { sessionId, content, finishReason: "stop" };
  }

  async streamEvents(
    sessionId: string,
    message: string,
    handlers: EventHandlers
  ): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`Copilot session not found: ${sessionId}`);

    return new Promise((resolve, reject) => {
      let fullContent = "";
      let unsubscribe: (() => void) | null = null;

      unsubscribe = meta.copilotSession.on((event: unknown) => {
        const e = event as { type?: string; data?: { deltaContent?: string; content?: string } };
        if (e?.type === "assistant.message_delta" && e?.data?.deltaContent) {
          fullContent += e.data.deltaContent;
          handlers.onDelta?.(e.data.deltaContent, {
            type: "message_delta",
            sessionId,
            data: e.data.deltaContent,
          });
        } else if (e?.type === "session.idle") {
          if (unsubscribe) unsubscribe();
          meta.session.lastMessageAt = this.now();
          meta.session.updatedAt = this.now();

          const result: MessageResult = { sessionId, content: fullContent, finishReason: "stop" };
          handlers.onComplete?.(result, { type: "message_complete", sessionId, data: result });
          resolve();
        }
      });

      meta.copilotSession.send({ prompt: message }).catch((err: unknown) => {
        if (unsubscribe) unsubscribe();
        handlers.onError?.(String(err), { type: "error", sessionId, error: String(err) });
        reject(err);
      });
    });
  }

  getSession(sessionId: string): WorkerSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  async getStatus(sessionId: string): Promise<WorkerStatus> {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`Copilot session not found: ${sessionId}`);
    return meta.session.status;
  }

  async stopSession(sessionId: string): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    await meta.copilotSession.disconnect().catch(() => {});
    meta.session.status = "stopped";
    meta.session.stoppedAt = this.now();
    meta.session.updatedAt = this.now();
  }

  async closeSession(sessionId: string): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    await meta.clientInstance.stop().catch(() => {});
    this.sessions.delete(sessionId);
  }
}
