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
 * Non-streaming runtime behavior:
 *   - The adapter intentionally uses send() + session.idle (no SDK timeout path)
 *     so daemon-managed calls can run indefinitely until completion.
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

  private generateId(): string {
    return `copilot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private async sendPromptUntilIdle(
    session: CopilotSession,
    prompt: string,
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let deltaContent = "";
      let assistantMessageContent = "";
      let unsubscribe: (() => void) | null = null;

      const complete = (result: string) => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        resolve(result);
      };

      const fail = (err: unknown) => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        reject(err);
      };

      unsubscribe = session.on((event: unknown) => {
        const e = event as { type?: string; data?: { deltaContent?: string; content?: string; message?: string } };
        if (e?.type === "assistant.message_delta" && typeof e.data?.deltaContent === "string") {
          deltaContent += e.data.deltaContent;
          onDelta?.(e.data.deltaContent);
          return;
        }
        if (e?.type === "assistant.message") {
          const content = e.data?.content;
          if (typeof content === "string") assistantMessageContent = content;
          return;
        }
        if (e?.type === "session.error") {
          fail(new Error(e.data?.message ?? "Copilot session error"));
          return;
        }
        if (e?.type === "session.idle") {
          complete(assistantMessageContent || deltaContent);
        }
      });

      session.send({ prompt }).catch((err: unknown) => fail(err));
    });
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
      await this.sendPromptUntilIdle(
        copilotSession,
        `[System context — resumed session. Your role definition follows.]\n\n${roleContent}\n\nReply with only: "Ready."`,
      ).catch(() => {
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
    _options?: SendOptions
  ): Promise<MessageResult> {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`Copilot session not found: ${sessionId}`);

    const content = await this.sendPromptUntilIdle(meta.copilotSession, message);

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

    try {
      const fullContent = await this.sendPromptUntilIdle(
        meta.copilotSession,
        message,
        (delta) => {
          handlers.onDelta?.(delta, {
            type: "message_delta",
            sessionId,
            data: delta,
          });
        },
      );

      meta.session.lastMessageAt = this.now();
      meta.session.updatedAt = this.now();

      const result: MessageResult = { sessionId, content: fullContent, finishReason: "stop" };
      handlers.onComplete?.(result, { type: "message_complete", sessionId, data: result });
    } catch (err: unknown) {
      handlers.onError?.(String(err), { type: "error", sessionId, error: String(err) });
      throw err;
    }
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
