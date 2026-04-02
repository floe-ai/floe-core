/**
 * Claude provider adapter — uses @anthropic-ai/claude-agent-sdk.
 *
 * SDK reference: https://platform.claude.com/docs/en/agent-sdk/typescript
 *
 * Auth: ANTHROPIC_API_KEY environment variable required.
 * Anthropic explicitly does not allow third-party SDK products to reuse
 * claude.ai interactive login. This is a documented provider constraint, not
 * a gap in implementation.
 *
 * Session model:
 *   - The Agent SDK has native session persistence (JSONL files on disk).
 *   - Sessions can be resumed by session ID using the `resume` option in query().
 *   - This adapter stores the Claude session ID and uses it for all resumptions.
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

interface ClaudeSessionMeta {
  claudeSessionId: string;
  session: WorkerSession;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claude";

  private sessions = new Map<string, ClaudeSessionMeta>();

  private ensureApiKey(): void {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required for the Claude provider adapter. " +
        "Anthropic does not allow third-party products to reuse claude.ai interactive login for SDK usage. " +
        "Set ANTHROPIC_API_KEY to your API key from https://platform.claude.com"
      );
    }
  }

  private async getQueryFn(): Promise<(prompt: string, options: Record<string, unknown>) => AsyncIterable<unknown>> {
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      return sdk.query as unknown as (prompt: string, options: Record<string, unknown>) => AsyncIterable<unknown>;
    } catch {
      throw new Error(
        "Claude Agent SDK not available. Install @anthropic-ai/claude-agent-sdk."
      );
    }
  }

  private generateId(): string {
    return `claude-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  private generateSessionId(): string {
    // Claude session IDs are UUIDs
    return crypto.randomUUID();
  }

  private now(): string {
    return new Date().toISOString();
  }

  private buildSystemPrompt(config: WorkerConfig): string | undefined {
    const parts: string[] = [];
    if (config.roleContent) parts.push(config.roleContent);
    if (config.contextAddendum) parts.push(config.contextAddendum);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  async startSession(config: WorkerConfig): Promise<WorkerSession> {
    this.ensureApiKey();

    const id = this.generateId();
    const claudeSessionId = this.generateSessionId();
    const now = this.now();

    const session: WorkerSession = {
      id,
      role: config.role,
      provider: "claude",
      status: "active",
      featureId: config.featureId,
      epicId: config.epicId,
      releaseId: config.releaseId,
      roleContentPath: config.roleContentPath,
      createdAt: now,
      updatedAt: now,
      metadata: { claudeSessionId },
    };

    this.sessions.set(id, { claudeSessionId, session });
    return session;
  }

  async resumeSession(
    sessionId: string,
    _config?: Partial<WorkerConfig>
  ): Promise<WorkerSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.session.status = "active";
      existing.session.updatedAt = this.now();
      return existing.session;
    }
    throw new Error(`Claude session ${sessionId} not found in memory.`);
  }

  /** Rebuild an in-memory session handle from stored metadata (after registry reload). */
  rehydrateSession(session: WorkerSession): void {
    const claudeSessionId = session.metadata?.claudeSessionId as string | undefined;
    if (!claudeSessionId) throw new Error("Session metadata missing claudeSessionId");
    this.sessions.set(session.id, { claudeSessionId, session });
  }

  async sendMessage(
    sessionId: string,
    message: string,
    _options?: SendOptions
  ): Promise<MessageResult> {
    this.ensureApiKey();

    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`Claude session not found: ${sessionId}`);

    const queryFn = await this.getQueryFn();
    const queryOptions: Record<string, unknown> = {
      resume: meta.claudeSessionId,
      sessionId: meta.claudeSessionId,
      persistSession: true,
    };

    let fullContent = "";
    for await (const event of queryFn(message, queryOptions) as AsyncIterable<any>) {
      if (event?.type === "assistant" && event?.message?.content) {
        for (const block of Array.isArray(event.message.content) ? event.message.content : []) {
          if (block?.type === "text" && typeof block.text === "string") {
            fullContent += block.text;
          }
        }
      }
    }

    meta.session.lastMessageAt = this.now();
    meta.session.updatedAt = this.now();

    return {
      sessionId,
      content: fullContent,
      finishReason: "stop",
    };
  }

  async streamEvents(
    sessionId: string,
    message: string,
    handlers: EventHandlers
  ): Promise<void> {
    this.ensureApiKey();

    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`Claude session not found: ${sessionId}`);

    const queryFn = await this.getQueryFn();
    const queryOptions: Record<string, unknown> = {
      resume: meta.claudeSessionId,
      sessionId: meta.claudeSessionId,
      persistSession: true,
    };

    let fullContent = "";
    for await (const event of queryFn(message, queryOptions) as AsyncIterable<any>) {
      if (event?.type === "assistant" && event?.message?.content) {
        for (const block of Array.isArray(event.message.content) ? event.message.content : []) {
          if (block?.type === "text" && typeof block.text === "string") {
            fullContent += block.text;
            handlers.onDelta?.(block.text, {
              type: "message_delta",
              sessionId,
              data: block.text,
            });
          }
        }
      }
    }

    meta.session.lastMessageAt = this.now();
    meta.session.updatedAt = this.now();

    const result: MessageResult = { sessionId, content: fullContent, finishReason: "stop" };
    handlers.onComplete?.(result, { type: "message_complete", sessionId, data: result });
  }

  async getStatus(sessionId: string): Promise<WorkerStatus> {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`Claude session not found: ${sessionId}`);
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
