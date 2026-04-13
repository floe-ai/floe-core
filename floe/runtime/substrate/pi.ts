/**
 * Pi session substrate — the sole session host for Floe.
 *
 * Manages live AI agent sessions in-memory. Calls model APIs
 * (Anthropic Messages, OpenAI Chat Completions) via direct HTTP
 * based on the model identifier in the worker config.
 *
 * Pi is NOT an adapter — it is the substrate. There is no adapter
 * pattern, no provider registry, no fallback chain.
 */

import type { SessionSubstrate } from "../daemon/service.ts";
import type {
  WorkerConfig,
  WorkerSession,
  WorkerStatus,
  SendOptions,
  MessageResult,
} from "../types.ts";

// ── Model detection ───────────────────────────────────────────────────

type ModelFamily = "anthropic" | "openai";

export function detectModelFamily(model: string): ModelFamily {
  const lower = model.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("anthropic/")) return "anthropic";
  // Everything else routes through OpenAI-compatible API
  return "openai";
}

// ── Conversation types ────────────────────────────────────────────────

interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface PiSession {
  session: WorkerSession;
  systemPrompt: string;
  history: ConversationMessage[];
  model: string;
  thinking?: string;
  family: ModelFamily;
}

// ── API callers ───────────────────────────────────────────────────────

async function callAnthropic(
  model: string,
  systemPrompt: string,
  history: ConversationMessage[],
  options?: { thinking?: string; timeoutMs?: number },
): Promise<{ content: string; inputTokens?: number; outputTokens?: number; stopReason?: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY not set. Configure this environment variable to use Anthropic models.",
    );
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";

  // Build messages (Anthropic requires alternating user/assistant, no system in messages)
  const messages = history
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const body: Record<string, unknown> = {
    model,
    max_tokens: 16384,
    system: systemPrompt,
    messages,
  };

  // Extended thinking support
  if (options?.thinking) {
    const budgetMap: Record<string, number> = {
      low: 4096,
      normal: 10000,
      high: 32000,
    };
    body.thinking = {
      type: "enabled",
      budget_tokens: budgetMap[options.thinking] ?? 10000,
    };
  }

  const controller = new AbortController();
  const timeout = options?.timeoutMs ?? 300_000; // 5 min default
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `Anthropic API error ${response.status}: ${errorBody || response.statusText}`,
      );
    }

    const data = (await response.json()) as any;

    // Extract text from content blocks
    const textBlocks = (data.content ?? []).filter((b: any) => b.type === "text");
    const content = textBlocks.map((b: any) => b.text).join("\n") || "";

    return {
      content,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
      stopReason: data.stop_reason,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(
  model: string,
  systemPrompt: string,
  history: ConversationMessage[],
  options?: { timeoutMs?: number },
): Promise<{ content: string; inputTokens?: number; outputTokens?: number; stopReason?: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY not set. Configure this environment variable to use OpenAI models.",
    );
  }

  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";

  // Build messages (OpenAI uses system as first message)
  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...history
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  const body: Record<string, unknown> = {
    model,
    messages,
  };

  const controller = new AbortController();
  const timeout = options?.timeoutMs ?? 300_000;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `OpenAI API error ${response.status}: ${errorBody || response.statusText}`,
      );
    }

    const data = (await response.json()) as any;
    const choice = data.choices?.[0];

    return {
      content: choice?.message?.content ?? "",
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
      stopReason: choice?.finish_reason,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Pi substrate ──────────────────────────────────────────────────────

function makeSessionId(role: string): string {
  return `${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class PiSubstrate implements SessionSubstrate {
  private sessions = new Map<string, PiSession>();

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async startSession(config: WorkerConfig): Promise<WorkerSession> {
    const model = config.model;
    if (!model) {
      throw new Error(
        `No model configured for role '${config.role}'. Set roles.${config.role}.model in .floe/config.json.`,
      );
    }

    const family = detectModelFamily(model);
    const sessionId = makeSessionId(config.role);
    const now = nowIso();

    // Build system prompt from role content + context addendum
    const parts: string[] = [];
    if (config.roleContent) parts.push(config.roleContent);
    if (config.contextAddendum) parts.push(config.contextAddendum);
    const systemPrompt = parts.join("\n\n");

    const session: WorkerSession = {
      id: sessionId,
      role: config.role,
      status: "active",
      featureId: config.featureId,
      epicId: config.epicId,
      releaseId: config.releaseId,
      roleContentPath: config.roleContentPath,
      createdAt: now,
      updatedAt: now,
      metadata: {
        model,
        thinking: config.thinking,
        family,
      },
    };

    const piSession: PiSession = {
      session,
      systemPrompt,
      history: [],
      model,
      thinking: config.thinking,
      family,
    };

    this.sessions.set(sessionId, piSession);
    return session;
  }

  async resumeSession(
    sessionId: string,
    storedSession: WorkerSession,
    config?: Partial<WorkerConfig>,
  ): Promise<WorkerSession> {
    // If already in memory, return it
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!.session;
    }

    // Reconstruct from stored session — conversation history is lost on process restart,
    // but the session identity and role are preserved for re-engagement.
    const model = (config?.model ?? storedSession.metadata?.model ?? "") as string;
    if (!model) {
      throw new Error(`Cannot resume session ${sessionId}: no model available`);
    }

    const family = detectModelFamily(model);
    const now = nowIso();

    const systemPrompt = config?.roleContent ?? "";

    const session: WorkerSession = {
      ...storedSession,
      status: "active",
      updatedAt: now,
      metadata: {
        ...storedSession.metadata,
        model,
        family,
        resumed: true,
      },
    };

    const piSession: PiSession = {
      session,
      systemPrompt,
      history: [],
      model,
      thinking: (config?.thinking ?? storedSession.metadata?.thinking ?? undefined) as
        | string
        | undefined,
      family,
    };

    this.sessions.set(sessionId, piSession);
    return session;
  }

  async sendMessage(
    sessionId: string,
    message: string,
    options?: SendOptions,
  ): Promise<MessageResult> {
    const piSession = this.sessions.get(sessionId);
    if (!piSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Add user message to history
    piSession.history.push({ role: "user", content: message });

    let result: {
      content: string;
      inputTokens?: number;
      outputTokens?: number;
      stopReason?: string;
    };

    try {
      piSession.session.status = "active";
      piSession.session.updatedAt = nowIso();

      if (piSession.family === "anthropic") {
        result = await callAnthropic(
          piSession.model,
          piSession.systemPrompt,
          piSession.history,
          { thinking: piSession.thinking, timeoutMs: options?.timeoutMs },
        );
      } else {
        result = await callOpenAI(
          piSession.model,
          piSession.systemPrompt,
          piSession.history,
          { timeoutMs: options?.timeoutMs },
        );
      }
    } catch (error: any) {
      piSession.session.status = "failed";
      piSession.session.error = error?.message ?? String(error);
      piSession.session.updatedAt = nowIso();
      throw error;
    }

    // Add assistant response to history
    piSession.history.push({ role: "assistant", content: result.content });

    piSession.session.status = "idle";
    piSession.session.lastMessageAt = nowIso();
    piSession.session.updatedAt = nowIso();

    return {
      sessionId,
      content: result.content,
      finishReason: result.stopReason,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    };
  }

  async getStatus(sessionId: string): Promise<WorkerStatus> {
    const piSession = this.sessions.get(sessionId);
    if (!piSession) return "stopped";
    return piSession.session.status;
  }

  getSession(sessionId: string): WorkerSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  async stopSession(sessionId: string): Promise<void> {
    const piSession = this.sessions.get(sessionId);
    if (piSession) {
      piSession.session.status = "stopped";
      piSession.session.stoppedAt = nowIso();
      piSession.session.updatedAt = nowIso();
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
