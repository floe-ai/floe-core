/**
 * Codex provider adapter — uses @openai/codex-sdk.
 *
 * SDK reference: https://developers.openai.com/codex/sdk
 * SDK source:    https://github.com/openai/codex/tree/main/sdk/typescript
 * SDK package:   @openai/codex-sdk (v0.116.x)
 *
 * Auth: OPENAI_API_KEY env var, or local ChatGPT sign-in (both officially supported).
 *
 * Session model:
 *   - Threads persist to ~/.codex/sessions on disk.
 *   - Thread IDs are assigned after the first run turn (thread.started event sets thread._id).
 *   - Cross-process resume: codex.resumeThread(threadId, options) reconnects by ID.
 *
 * System prompt / role injection:
 *   - ThreadOptions has no systemPrompt field. Role content is prepended to the
 *     first message in the thread so the agent understands its role context.
 *
 * Type shapes below are sourced from the SDK's TypeScript declarations.
 * If the SDK introduces breaking changes, update these shapes to match.
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

// ── SDK type shapes (sourced from @openai/codex-sdk v0.116.x) ───────────────

interface CodexTurn {
  finalResponse: string;
  items: CodexThreadItem[];
  usage: { input_tokens: number; output_tokens: number; cached_input_tokens?: number } | null;
}

interface CodexThreadItem {
  id: string;
  type: string;
  text?: string;
  command?: string;
  status?: string;
  [key: string]: unknown;
}

interface CodexThreadEvent {
  type: string;
  /** thread.started — thread ID assigned by the CLI */
  thread_id?: string;
  /** item.* events */
  item?: CodexThreadItem;
  /** turn.completed */
  usage?: { input_tokens: number; output_tokens: number };
  /** turn.failed / error */
  error?: { message: string };
  message?: string;
}

interface CodexStreamedTurn {
  events: AsyncGenerator<CodexThreadEvent>;
}

interface CodexThread {
  /** Null until the first turn completes (populated from thread.started event). */
  readonly id: string | null;
  run(input: string, options?: Record<string, unknown>): Promise<CodexTurn>;
  runStreamed(input: string, options?: Record<string, unknown>): Promise<CodexStreamedTurn>;
}

interface CodexThreadOptions {
  model?: string;
  sandboxMode?: string;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: string;
  networkAccessEnabled?: boolean;
  approvalPolicy?: string;
}

interface CodexClient {
  startThread(options?: CodexThreadOptions): CodexThread;
  resumeThread(threadId: string, options?: CodexThreadOptions): CodexThread;
}

// ── Internal session state ────────────────────────────────────────────────────

interface CodexSessionMeta {
  thread: CodexThread;
  session: WorkerSession;
  /** Role content to inject into the first message turn. */
  roleContent?: string;
  /** True until the first message is sent (role content not yet injected). */
  isFirstMessage: boolean;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex";

  private sessions = new Map<string, CodexSessionMeta>();
  private codex: CodexClient | null = null;

  private async getClient(): Promise<CodexClient> {
    if (this.codex) return this.codex;
    try {
      // @ts-ignore — optional peer dependency, dynamically imported
      const { Codex } = await import("@openai/codex-sdk");
      this.codex = new Codex() as unknown as CodexClient;
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

  private resolveSandboxMode(stored?: string): string {
    if (stored && stored.trim()) return stored;
    if (process.env.FLOE_CODEX_SANDBOX_MODE?.trim()) return process.env.FLOE_CODEX_SANDBOX_MODE.trim();
    // Daemon workers must be able to execute repo operations without interactive escalation.
    return "danger-full-access";
  }

  private resolveApprovalPolicy(stored?: string): string {
    if (stored && stored.trim()) return stored;
    if (process.env.FLOE_CODEX_APPROVAL_POLICY?.trim()) return process.env.FLOE_CODEX_APPROVAL_POLICY.trim();
    // Avoid interactive approval deadlocks in daemon-managed worker sessions.
    return "never";
  }

  private resolveNetworkAccessEnabled(stored?: boolean): boolean {
    if (typeof stored === "boolean") return stored;
    const envValue = process.env.FLOE_CODEX_NETWORK_ACCESS?.trim().toLowerCase();
    if (!envValue) return true;
    return !["0", "false", "no", "off"].includes(envValue);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async startSession(config: WorkerConfig): Promise<WorkerSession> {
    const client = await this.getClient();
    const sandboxMode = this.resolveSandboxMode();
    const approvalPolicy = this.resolveApprovalPolicy();
    const networkAccessEnabled = this.resolveNetworkAccessEnabled();

    // ThreadOptions has no systemPrompt; role content is injected in the first message.
    const threadOpts: CodexThreadOptions = {
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      networkAccessEnabled,
    };
    if (config.model) threadOpts.model = config.model;
    if (config.thinking) {
      const effortMap: Record<string, string> = { low: "low", normal: "medium", high: "high" };
      threadOpts.modelReasoningEffort = effortMap[config.thinking] ?? "medium";
    }
    const thread = client.startThread(threadOpts);

    const id = this.generateId();
    const now = this.now();

    // thread.id is null at creation — populated after first run (thread.started event)
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
      metadata: {
        model: config.model,
        thinking: config.thinking,
        sandboxMode,
        approvalPolicy,
        networkAccessEnabled,
      },
    };

    this.sessions.set(id, {
      thread,
      session,
      roleContent: config.roleContent
        ? config.roleContent + (config.contextAddendum ? `\n\n${config.contextAddendum}` : "")
        : undefined,
      isFirstMessage: true,
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

    // Process restart: reconnect to existing Codex thread using stored thread ID.
    // Threads persist to ~/.codex/sessions and survive process restarts.
    const codexThreadId = storedSession.metadata?.codexThreadId as string | undefined;
    if (!codexThreadId) {
      throw new Error(
        `Cannot resume Codex session ${sessionId}: no codexThreadId in stored metadata. ` +
        `The session must have completed at least one message turn before being resumable.`
      );
    }

    const client = await this.getClient();
    const storedModel = storedSession.metadata?.model as string | undefined;
    const storedThinking = storedSession.metadata?.thinking as string | undefined;
    const storedSandboxMode = storedSession.metadata?.sandboxMode as string | undefined;
    const storedApprovalPolicy = storedSession.metadata?.approvalPolicy as string | undefined;
    const storedNetworkAccessEnabled = storedSession.metadata?.networkAccessEnabled as boolean | undefined;
    const resumeOpts: CodexThreadOptions = {
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true,
      sandboxMode: this.resolveSandboxMode(storedSandboxMode),
      approvalPolicy: this.resolveApprovalPolicy(storedApprovalPolicy),
      networkAccessEnabled: this.resolveNetworkAccessEnabled(storedNetworkAccessEnabled),
    };
    if (storedModel) resumeOpts.model = storedModel;
    if (storedThinking) {
      const effortMap: Record<string, string> = { low: "low", normal: "medium", high: "high" };
      resumeOpts.modelReasoningEffort = effortMap[storedThinking] ?? "medium";
    }
    const thread = client.resumeThread(codexThreadId, resumeOpts);

    const now = this.now();
    const resumedSession: WorkerSession = {
      ...storedSession,
      status: "active",
      updatedAt: now,
    };

    // Role content not needed for resumed threads — context is in the persisted thread.
    this.sessions.set(sessionId, {
      thread,
      session: resumedSession,
      isFirstMessage: false,
    });
    return resumedSession;
  }

  /** Build the actual message string, prepending role content on the first turn. */
  private buildMessage(meta: CodexSessionMeta, message: string): string {
    if (meta.isFirstMessage && meta.roleContent) {
      meta.isFirstMessage = false;
      return `${meta.roleContent}\n\n---\n\n${message}`;
    }
    return message;
  }

  /** Update session metadata with thread ID once it becomes available. */
  private captureThreadId(meta: CodexSessionMeta): void {
    const threadId = meta.thread.id;
    if (threadId && !meta.session.metadata?.codexThreadId) {
      meta.session.metadata = { ...meta.session.metadata, codexThreadId: threadId };
      meta.session.updatedAt = this.now();
      // Signal registry to persist the updated metadata
      // (The registry.update call is made by the tool handler after sendMessage resolves)
    }
  }

  async sendMessage(
    sessionId: string,
    message: string,
    _options?: SendOptions
  ): Promise<MessageResult> {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`Codex session not found: ${sessionId}`);

    const actualMessage = this.buildMessage(meta, message);
    const turn = await meta.thread.run(actualMessage);

    this.captureThreadId(meta);
    meta.session.lastMessageAt = this.now();
    meta.session.updatedAt = this.now();

    return {
      sessionId,
      content: turn.finalResponse,
      finishReason: "stop",
      usage: turn.usage
        ? { inputTokens: turn.usage.input_tokens, outputTokens: turn.usage.output_tokens }
        : undefined,
    };
  }

  async streamEvents(
    sessionId: string,
    message: string,
    handlers: EventHandlers
  ): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) throw new Error(`Codex session not found: ${sessionId}`);

    const actualMessage = this.buildMessage(meta, message);
    const { events } = await meta.thread.runStreamed(actualMessage);

    let fullContent = "";

    for await (const event of events) {
      if (event.type === "thread.started" && event.thread_id) {
        // Capture thread ID from the first event of the first turn
        if (!meta.session.metadata?.codexThreadId) {
          meta.session.metadata = { ...meta.session.metadata, codexThreadId: event.thread_id };
        }
      } else if (event.type === "item.completed" && event.item?.type === "agent_message") {
        const text = (event.item.text ?? "") as string;
        fullContent += text;
        if (text) {
          handlers.onDelta?.(text, { type: "message_delta", sessionId, data: text });
        }
      } else if (event.type === "turn.failed") {
        const errMsg = event.error?.message ?? "Codex turn failed";
        handlers.onError?.(errMsg, { type: "error", sessionId, error: errMsg });
        return;
      } else if (event.type === "error") {
        const errMsg = event.message ?? "Codex stream error";
        handlers.onError?.(errMsg, { type: "error", sessionId, error: errMsg });
        return;
      }
    }

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
