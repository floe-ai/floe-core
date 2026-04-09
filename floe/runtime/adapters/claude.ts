/**
 * Claude provider adapter — uses @anthropic-ai/claude-agent-sdk.
 *
 * SDK reference: https://platform.claude.com/docs/en/agent-sdk/typescript
 * SDK package:   @anthropic-ai/claude-agent-sdk (v0.2.x)
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
 *
 * API surface used:
 *   - query({ prompt, options }) — main entry point, returns an async iterable of events
 *   - Events have a `type` field; assistant messages contain content blocks
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
  systemPrompt?: string;
  model?: string;
  thinking?: string;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
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

  private async getQueryFn(): Promise<(options: Record<string, unknown>) => AsyncIterable<unknown>> {
    try {
      // @ts-ignore — optional peer dependency, dynamically imported
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      return sdk.query as unknown as (options: Record<string, unknown>) => AsyncIterable<unknown>;
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
    return crypto.randomUUID();
  }

  private parseBooleanEnv(name: string): boolean | undefined {
    const raw = process.env[name]?.trim().toLowerCase();
    if (!raw) return undefined;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    return undefined;
  }

  private resolvePermissionMode(stored?: string): string {
    if (stored && stored.trim()) return stored;
    if (process.env.FLOE_CLAUDE_PERMISSION_MODE?.trim()) {
      return process.env.FLOE_CLAUDE_PERMISSION_MODE.trim();
    }
    // Daemon-managed workers should not block on interactive permission prompts.
    return "bypassPermissions";
  }

  private resolveAllowDangerouslySkipPermissions(stored: boolean | undefined, permissionMode: string): boolean {
    if (typeof stored === "boolean") return stored;
    const envOverride = this.parseBooleanEnv("FLOE_CLAUDE_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS");
    if (typeof envOverride === "boolean") return envOverride;
    return permissionMode === "bypassPermissions";
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

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async startSession(config: WorkerConfig): Promise<WorkerSession> {
    this.ensureApiKey();

    const id = this.generateId();
    const claudeSessionId = this.generateSessionId();
    const systemPrompt = this.buildSystemPrompt(config);
    const permissionMode = this.resolvePermissionMode();
    const allowDangerouslySkipPermissions = this.resolveAllowDangerouslySkipPermissions(undefined, permissionMode);
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
      metadata: {
        claudeSessionId,
        model: config.model,
        thinking: config.thinking,
        permissionMode,
        allowDangerouslySkipPermissions,
        systemPrompt,
      },
    };

    this.sessions.set(id, {
      claudeSessionId,
      session,
      systemPrompt,
      model: config.model,
      thinking: config.thinking,
      permissionMode,
      allowDangerouslySkipPermissions,
    });
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

    // Process restart: rehydrate from stored session metadata.
    // The Claude Agent SDK persists sessions as JSONL files on disk, keyed by
    // claudeSessionId. Passing resume: claudeSessionId in the next query()
    // call restores full conversation continuity.
    this.rehydrateSession(storedSession);
    const meta = this.sessions.get(sessionId);
    if (!meta) {
      throw new Error(
        `Cannot resume Claude session ${sessionId}: missing claudeSessionId in stored metadata`
      );
    }
    meta.session.status = "active";
    meta.session.updatedAt = this.now();
    return meta.session;
  }

  /** Rebuild an in-memory session handle from stored metadata (after registry reload). */
  rehydrateSession(session: WorkerSession): void {
    const claudeSessionId = session.metadata?.claudeSessionId as string | undefined;
    if (!claudeSessionId) throw new Error("Session metadata missing claudeSessionId");
    const model = typeof session.metadata?.model === "string" ? (session.metadata.model as string) : undefined;
    const thinking = typeof session.metadata?.thinking === "string" ? (session.metadata.thinking as string) : undefined;
    const systemPrompt = typeof session.metadata?.systemPrompt === "string"
      ? (session.metadata.systemPrompt as string)
      : undefined;
    const storedPermissionMode = typeof session.metadata?.permissionMode === "string"
      ? (session.metadata.permissionMode as string)
      : undefined;
    const permissionMode = this.resolvePermissionMode(storedPermissionMode);
    const storedAllowDangerouslySkipPermissions = typeof session.metadata?.allowDangerouslySkipPermissions === "boolean"
      ? (session.metadata.allowDangerouslySkipPermissions as boolean)
      : undefined;
    const allowDangerouslySkipPermissions = this.resolveAllowDangerouslySkipPermissions(
      storedAllowDangerouslySkipPermissions,
      permissionMode,
    );

    this.sessions.set(session.id, {
      claudeSessionId,
      session,
      model,
      thinking,
      systemPrompt,
      permissionMode,
      allowDangerouslySkipPermissions,
    });
  }

  /** Build query options for the Claude Agent SDK query() call. */
  private buildQueryOptions(meta: ClaudeSessionMeta): Record<string, unknown> {
    const opts: Record<string, unknown> = {
      resume: meta.claudeSessionId,
      sessionId: meta.claudeSessionId,
      persistSession: true,
      ...(meta.systemPrompt ? { systemPrompt: meta.systemPrompt } : {}),
      ...(meta.permissionMode ? { permissionMode: meta.permissionMode } : {}),
      ...(typeof meta.allowDangerouslySkipPermissions === "boolean"
        ? { allowDangerouslySkipPermissions: meta.allowDangerouslySkipPermissions }
        : {}),
    };
    if (meta.model) opts.model = meta.model;
    if (meta.thinking === "high") {
      opts.thinking = { type: "enabled", budget_tokens: 10000 };
    }
    return opts;
  }

  /** Extract text content from a Claude SDK event. */
  private extractText(event: any): string {
    if (event?.type === "assistant" && event?.message?.content) {
      const blocks = Array.isArray(event.message.content) ? event.message.content : [];
      return blocks
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("");
    }
    return "";
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
    const queryOptions = {
      prompt: message,
      options: this.buildQueryOptions(meta),
    };

    let fullContent = "";
    for await (const event of queryFn(queryOptions) as AsyncIterable<any>) {
      fullContent += this.extractText(event);
    }

    // Clear system prompt after first message (it's been injected)
    meta.systemPrompt = undefined;
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
    const queryOptions = {
      prompt: message,
      options: this.buildQueryOptions(meta),
    };

    let fullContent = "";
    for await (const event of queryFn(queryOptions) as AsyncIterable<any>) {
      const text = this.extractText(event);
      if (text) {
        fullContent += text;
        handlers.onDelta?.(text, {
          type: "message_delta",
          sessionId,
          data: text,
        });
      }
    }

    meta.systemPrompt = undefined;
    meta.session.lastMessageAt = this.now();
    meta.session.updatedAt = this.now();

    const result: MessageResult = { sessionId, content: fullContent, finishReason: "stop" };
    handlers.onComplete?.(result, { type: "message_complete", sessionId, data: result });
  }

  getSession(sessionId: string): WorkerSession | undefined {
    return this.sessions.get(sessionId)?.session;
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
