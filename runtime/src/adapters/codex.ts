/**
 * Codex provider adapter — uses @openai/codex-sdk.
 *
 * Codex SDK reference: https://developers.openai.com/codex/sdk
 *
 * Auth: OPENAI_API_KEY env var, or local sign-in mode (both officially supported).
 * If OPENAI_API_KEY is not set, the SDK will attempt to use the local ChatGPT
 * sign-in session. This adapter does not manage auth centrally.
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

interface CodexThread {
  run(prompt: string): Promise<string>;
  runStreamed?: (prompt: string) => AsyncIterable<{ type: string; delta?: string; content?: string }>;
}

interface CodexClient {
  startThread(options?: { systemPrompt?: string }): CodexThread & { id?: string };
  resumeThread(threadId: string): CodexThread;
}

interface CodexSessionMeta {
  thread: CodexThread;
  threadId?: string;
  session: WorkerSession;
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex";

  private sessions = new Map<string, CodexSessionMeta>();
  private codex: CodexClient | null = null;

  private async getClient(): Promise<CodexClient> {
    if (this.codex) return this.codex;
    try {
      // @openai/codex-sdk — install separately; treated as a peer dependency
      const { Codex } = await import("@openai/codex-sdk");
      this.codex = new Codex();
      return this.codex;
    } catch {
      throw new Error(
        "Codex SDK not available. Install @openai/codex-sdk and ensure OPENAI_API_KEY is set or you are signed in to ChatGPT locally."
      );
    }
  }

  private generateId(): string {
    return `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  async startSession(config: WorkerConfig): Promise<WorkerSession> {
    const client = await this.getClient();
    const systemPrompt = config.roleContent
      ? config.roleContent + (config.contextAddendum ? `\n\n${config.contextAddendum}` : "")
      : undefined;

    const thread = client.startThread(systemPrompt ? { systemPrompt } : undefined);
    const id = this.generateId();
    const now = this.now();

    const session: WorkerSession = {
      id,
      role: config.role,
      provider: "codex",
      status: "active",
      featureId: config.featureId,
      epicId: config.epicId,
      releaseId: config.releaseId,
      roleContentPath: config.roleContentPath,
      createdAt: now,
      updatedAt: now,
      metadata: { codexThreadId: (thread as any).id },
    };

    this.sessions.set(id, { thread, threadId: (thread as any).id, session });
    return session;
  }

  async resumeSession(
    sessionId: string,
    storedSession: WorkerSession,
    _config?: Partial<WorkerConfig>
  ): Promise<WorkerSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.session.status = "active";
      existing.session.updatedAt = this.now();
      return existing.session;
    }

    // Process restart: use the Codex thread ID stored in metadata to reconnect.
    // resumeThread(threadId) tells the SDK to continue the existing conversation
    // thread on the OpenAI backend without replaying history locally.
    const codexThreadId = storedSession.metadata?.codexThreadId as string | undefined;
    if (!codexThreadId) {
      throw new Error(
        `Cannot resume Codex session ${sessionId}: no codexThreadId in stored metadata`
      );
    }

    return this.resumeByThreadId(sessionId, codexThreadId, storedSession);
  }

  /** Resume using a Codex-native thread ID from stored metadata. */
  async resumeByThreadId(
    sessionId: string,
    codexThreadId: string,
    originalSession: WorkerSession
  ): Promise<WorkerSession> {
    const client = await this.getClient();
    const thread = client.resumeThread(codexThreadId);
    const now = this.now();

    const session: WorkerSession = {
      ...originalSession,
      status: "active",
      updatedAt: now,
      metadata: { codexThreadId },
    };

    this.sessions.set(sessionId, { thread, threadId: codexThreadId, session });
    return session;
  }

  async sendMessage(
    sessionId: string,
    message: string,
    _options?: SendOptions
  ): Promise<MessageResult> {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`Codex session not found: ${sessionId}`);

    const content = await meta.thread.run(message);
    meta.session.lastMessageAt = this.now();
    meta.session.updatedAt = this.now();

    return {
      sessionId,
      content: typeof content === "string" ? content : JSON.stringify(content),
      finishReason: "stop",
    };
  }

  async streamEvents(
    sessionId: string,
    message: string,
    handlers: EventHandlers
  ): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`Codex session not found: ${sessionId}`);

    if (meta.thread.runStreamed) {
      let fullContent = "";
      for await (const event of meta.thread.runStreamed(message)) {
        if (event.type === "delta" && event.delta) {
          fullContent += event.delta;
          handlers.onDelta?.(event.delta, { type: "message_delta", sessionId, data: event.delta });
        }
      }
      meta.session.lastMessageAt = this.now();
      meta.session.updatedAt = this.now();

      const result: MessageResult = { sessionId, content: fullContent, finishReason: "stop" };
      handlers.onComplete?.(result, { type: "message_complete", sessionId, data: result });
    } else {
      // Fallback: non-streaming run, emit as single complete event
      const content = await meta.thread.run(message);
      const strContent = typeof content === "string" ? content : JSON.stringify(content);
      meta.session.lastMessageAt = this.now();
      meta.session.updatedAt = this.now();

      const result: MessageResult = { sessionId, content: strContent, finishReason: "stop" };
      handlers.onDelta?.(strContent, { type: "message_delta", sessionId, data: strContent });
      handlers.onComplete?.(result, { type: "message_complete", sessionId, data: result });
    }
  }

  async getStatus(sessionId: string): Promise<WorkerStatus> {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`Codex session not found: ${sessionId}`);
    return meta.session.status;
  }

  async stopSession(sessionId: string): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.session.status = "stopped";
    meta.session.stoppedAt = this.now();
    meta.session.updatedAt = this.now();
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
