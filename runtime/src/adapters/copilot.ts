/**
 * Copilot provider adapter — uses @github/copilot-sdk.
 *
 * SDK reference: https://docs.github.com/en/copilot/how-tos/copilot-sdk
 * SDK repo: https://github.com/github/copilot-sdk
 *
 * Auth: Uses existing GitHub/Copilot CLI signed-in credentials automatically.
 * The CopilotClient picks up the local auth session (useLoggedInUser defaults to true).
 * No API key or env vars required for authenticated users.
 *
 * Note: This SDK is in technical preview and may change.
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

interface CopilotSession {
  send(options: { prompt: string }): Promise<void>;
  on(event: string, callback: (event: unknown) => void): void;
  off(event: string, callback: (event: unknown) => void): void;
  disconnect(): Promise<void>;
  [Symbol.asyncDispose]?(): Promise<void>;
}

interface CopilotClientApi {
  start(): Promise<void>;
  stop(): Promise<unknown[]>;
  createSession(options: {
    model?: string;
    onPermissionRequest?: (req: unknown) => Promise<boolean | string>;
    systemPrompt?: string;
  }): Promise<CopilotSession>;
}

interface CopilotSessionMeta {
  clientInstance: CopilotClientApi;
  copilotSession: CopilotSession;
  session: WorkerSession;
}

export class CopilotAdapter implements ProviderAdapter {
  readonly provider = "copilot";

  private sessions = new Map<string, CopilotSessionMeta>();

  private async createClient(): Promise<CopilotClientApi> {
    try {
      const { CopilotClient } = await import("@github/copilot-sdk");
      return new CopilotClient() as unknown as CopilotClientApi;
    } catch {
      throw new Error(
        "Copilot SDK not available. Install @github/copilot-sdk and ensure you are signed in to Copilot CLI."
      );
    }
  }

  private async approveAll(_req: unknown): Promise<boolean> {
    return true;
  }

  private generateId(): string {
    return `copilot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  async startSession(config: WorkerConfig): Promise<WorkerSession> {
    const client = await this.createClient();
    await client.start();

    const systemPrompt = config.roleContent
      ? config.roleContent + (config.contextAddendum ? `\n\n${config.contextAddendum}` : "")
      : undefined;

    const copilotSession = await client.createSession({
      onPermissionRequest: this.approveAll,
      ...(systemPrompt ? { systemPrompt } : {}),
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
      metadata: {},
    };

    this.sessions.set(id, { clientInstance: client, copilotSession, session });
    return session;
  }

  async resumeSession(
    sessionId: string,
    config?: Partial<WorkerConfig>
  ): Promise<WorkerSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.session.status = "active";
      existing.session.updatedAt = this.now();
      return existing.session;
    }

    // Copilot SDK does not currently support resuming sessions by ID after
    // process restart. Start a fresh session with the same role context.
    if (!config?.featureId || !config?.role) {
      throw new Error("Cannot resume Copilot session: original config required to start fresh");
    }

    return this.startSession({
      role: config.role!,
      provider: "copilot",
      featureId: config.featureId!,
      roleContent: config.roleContent,
      epicId: config.epicId,
      releaseId: config.releaseId,
    });
  }

  async sendMessage(
    sessionId: string,
    message: string,
    options?: SendOptions
  ): Promise<MessageResult> {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`Copilot session not found: ${sessionId}`);

    return new Promise((resolve, reject) => {
      const collected: string[] = [];
      const timeoutMs = options?.timeoutMs ?? 120_000;

      const onMessage = (event: unknown) => {
        const e = event as { data?: { content?: string } };
        if (e?.data?.content) collected.push(e.data.content);
      };

      const onIdle = () => {
        meta.copilotSession.off("assistant.message", onMessage);
        meta.copilotSession.off("session.idle", onIdle);
        meta.session.lastMessageAt = this.now();
        meta.session.updatedAt = this.now();
        clearTimeout(timer);
        resolve({
          sessionId,
          content: collected.join(""),
          finishReason: "stop",
        });
      };

      const timer = setTimeout(() => {
        meta.copilotSession.off("assistant.message", onMessage);
        meta.copilotSession.off("session.idle", onIdle);
        reject(new Error(`Copilot session ${sessionId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      meta.copilotSession.on("assistant.message", onMessage);
      meta.copilotSession.on("session.idle", onIdle);

      meta.copilotSession.send({ prompt: message }).catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
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

      const onDelta = (event: unknown) => {
        const e = event as { data?: { content?: string } };
        const delta = e?.data?.content ?? "";
        if (delta) {
          fullContent += delta;
          handlers.onDelta?.(delta, { type: "message_delta", sessionId, data: delta });
        }
      };

      const onIdle = () => {
        meta.copilotSession.off("assistant.message_delta", onDelta);
        meta.copilotSession.off("assistant.message", onDelta);
        meta.copilotSession.off("session.idle", onIdle);
        meta.session.lastMessageAt = this.now();
        meta.session.updatedAt = this.now();

        const result: MessageResult = { sessionId, content: fullContent, finishReason: "stop" };
        handlers.onComplete?.(result, { type: "message_complete", sessionId, data: result });
        resolve();
      };

      // Subscribe to both delta and full message events (SDK may emit either)
      meta.copilotSession.on("assistant.message_delta", onDelta);
      meta.copilotSession.on("assistant.message", onDelta);
      meta.copilotSession.on("session.idle", onIdle);

      meta.copilotSession.send({ prompt: message }).catch((err) => {
        handlers.onError?.(String(err), { type: "error", sessionId, error: String(err) });
        reject(err);
      });
    });
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
