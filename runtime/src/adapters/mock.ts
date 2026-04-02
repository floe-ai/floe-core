/**
 * Mock provider adapter — for testing the full MCP tool surface without live API keys.
 *
 * Simulates a plausible worker lifecycle with configurable response delays.
 * All sessions are in-memory only; nothing is persisted to the filesystem.
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

interface MockSessionState {
  session: WorkerSession;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export class MockAdapter implements ProviderAdapter {
  readonly provider = "mock";

  private sessions = new Map<string, MockSessionState>();
  private responseDelayMs: number;

  constructor(options: { responseDelayMs?: number } = {}) {
    this.responseDelayMs = options.responseDelayMs ?? 100;
  }

  private generateId(): string {
    return `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  async startSession(config: WorkerConfig): Promise<WorkerSession> {
    const id = this.generateId();
    const now = this.now();

    const session: WorkerSession = {
      id,
      role: config.role,
      provider: "mock",
      status: "active",
      featureId: config.featureId,
      epicId: config.epicId,
      releaseId: config.releaseId,
      roleContentPath: config.roleContentPath,
      createdAt: now,
      updatedAt: now,
      metadata: { mock: true },
    };

    const messages: MockSessionState["messages"] = [];
    if (config.roleContent) {
      messages.push({ role: "system", content: config.roleContent });
    }

    this.sessions.set(id, { session, messages });
    return session;
  }

  async resumeSession(
    sessionId: string,
    storedSession: WorkerSession,
    _config?: Partial<WorkerConfig>
  ): Promise<WorkerSession> {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.session.status = "active";
      state.session.updatedAt = this.now();
      return state.session;
    }

    // Simulate a process restart: reconstruct in-memory state from the stored session.
    const resumed: WorkerSession = {
      ...storedSession,
      status: "active",
      updatedAt: this.now(),
    };
    this.sessions.set(sessionId, { session: resumed, messages: [] });
    return resumed;
  }

  async sendMessage(
    sessionId: string,
    message: string,
    _options?: SendOptions
  ): Promise<MessageResult> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Mock session not found: ${sessionId}`);

    state.messages.push({ role: "user", content: message });

    await new Promise((resolve) => setTimeout(resolve, this.responseDelayMs));

    const responseContent = `[Mock response from ${state.session.role}] I received: "${message.slice(0, 80)}${message.length > 80 ? "..." : ""}"`;
    state.messages.push({ role: "assistant", content: responseContent });
    state.session.lastMessageAt = this.now();
    state.session.updatedAt = this.now();

    return {
      sessionId,
      content: responseContent,
      finishReason: "stop",
      usage: { inputTokens: message.length, outputTokens: responseContent.length },
    };
  }

  async streamEvents(
    sessionId: string,
    message: string,
    handlers: EventHandlers
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Mock session not found: ${sessionId}`);

    state.messages.push({ role: "user", content: message });

    const words = `[Mock stream from ${state.session.role}] Received your message.`.split(" ");

    for (const word of words) {
      await new Promise((resolve) => setTimeout(resolve, this.responseDelayMs / words.length));
      handlers.onDelta?.(word + " ", {
        type: "message_delta",
        sessionId,
        data: word + " ",
      });
    }

    const fullContent = words.join(" ");
    state.messages.push({ role: "assistant", content: fullContent });
    state.session.lastMessageAt = this.now();
    state.session.updatedAt = this.now();

    const result: MessageResult = {
      sessionId,
      content: fullContent,
      finishReason: "stop",
    };

    handlers.onComplete?.(result, { type: "message_complete", sessionId, data: result });
  }

  async getStatus(sessionId: string): Promise<WorkerStatus> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Mock session not found: ${sessionId}`);
    return state.session.status;
  }

  async stopSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.session.status = "stopped";
    state.session.stoppedAt = this.now();
    state.session.updatedAt = this.now();
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
