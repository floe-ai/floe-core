/**
 * Pi SDK substrate — implements SessionSubstrate using Pi's createAgentSession().
 *
 * Workers are real Pi agent sessions running in-process. They get the full
 * Pi tool set (read, write, edit, bash) plus Floe tools registered via customTools.
 */

import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createCodingTools,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";

import type { SessionSubstrate } from "./service.ts";
import type { WorkerConfig, WorkerSession, WorkerStatus, MessageResult, SendOptions } from "./worker-types.ts";

interface PiWorkerSession {
  session: AgentSession;
  config: WorkerConfig;
  workerSession: WorkerSession;
  messageHistory: Array<{ role: string; content: string; timestamp: string }>;
}

/**
 * PiSubstrate uses the Pi SDK to create and manage worker agent sessions.
 * Each worker is a full Pi agent session with coding tools.
 */
export class PiSubstrate implements SessionSubstrate {
  private sessions = new Map<string, PiWorkerSession>();
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;

  constructor() {
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async startSession(config: WorkerConfig): Promise<WorkerSession> {
    const id = `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const model = config.model ? this.resolveModel(config.model) : undefined;
    const cwd = config.cwd ?? process.cwd();

    const { session } = await createAgentSession({
      model,
      sessionManager: SessionManager.inMemory(),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      cwd,
      tools: createCodingTools(cwd),
    });

    const now = new Date().toISOString();
    const workerSession: WorkerSession = {
      id,
      role: config.role,
      status: "active",
      featureId: config.featureId,
      epicId: config.epicId,
      releaseId: config.releaseId,
      roleContentPath: config.roleContentPath,
      createdAt: now,
      updatedAt: now,
      metadata: { model: config.model ?? model?.id ?? "default" },
    };

    this.sessions.set(id, {
      session,
      config,
      workerSession,
      messageHistory: [],
    });

    // Build and send the system prompt as the first message
    const systemPrompt = this.buildSystemPrompt(config);
    if (systemPrompt) {
      await session.prompt(systemPrompt);
    }

    return workerSession;
  }

  async resumeSession(sessionId: string, storedSession: WorkerSession, config?: Partial<WorkerConfig>): Promise<WorkerSession> {
    const fullConfig: WorkerConfig = {
      role: storedSession.role,
      featureId: storedSession.featureId,
      model: config?.model ?? (storedSession.metadata?.model as string | undefined),
      cwd: config?.cwd,
      ...config,
    };
    const newSession = await this.startSession(fullConfig);
    // Re-key under the original sessionId so callers can find it
    const piSession = this.sessions.get(newSession.id);
    if (piSession) {
      this.sessions.delete(newSession.id);
      newSession.id = sessionId;
      piSession.workerSession = newSession;
      this.sessions.set(sessionId, piSession);
    }
    return newSession;
  }

  async sendMessage(sessionId: string, message: string, _options?: SendOptions): Promise<MessageResult> {
    const piSession = this.sessions.get(sessionId);
    if (!piSession) {
      throw new Error(`No Pi session found: ${sessionId}`);
    }

    const { session } = piSession;
    let responseText = "";

    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        responseText += event.assistantMessageEvent.delta;
      }
    });

    try {
      await session.prompt(message);
    } finally {
      unsubscribe();
    }

    const now = new Date().toISOString();
    piSession.messageHistory.push(
      { role: "user", content: message, timestamp: now },
      { role: "assistant", content: responseText, timestamp: now },
    );
    piSession.workerSession.updatedAt = now;
    piSession.workerSession.lastMessageAt = now;

    return {
      sessionId,
      content: responseText,
    };
  }

  async getStatus(sessionId: string): Promise<WorkerStatus> {
    const piSession = this.sessions.get(sessionId);
    if (!piSession) return "stopped";
    return piSession.session.isStreaming ? "active" : "idle";
  }

  getSession(sessionId: string): WorkerSession | undefined {
    return this.sessions.get(sessionId)?.workerSession;
  }

  async stopSession(sessionId: string): Promise<void> {
    const piSession = this.sessions.get(sessionId);
    if (!piSession) return;

    await piSession.session.abort();
    piSession.workerSession.status = "stopped";
    piSession.workerSession.stoppedAt = new Date().toISOString();
  }

  async closeSession(sessionId: string): Promise<void> {
    const piSession = this.sessions.get(sessionId);
    if (!piSession) return;

    piSession.session.dispose();
    piSession.workerSession.status = "stopped";
    piSession.workerSession.stoppedAt = new Date().toISOString();
    this.sessions.delete(sessionId);
  }

  /** Build a system prompt from role content + context addendum. */
  private buildSystemPrompt(config: WorkerConfig): string | undefined {
    const parts: string[] = [];
    if (config.roleContent) parts.push(config.roleContent);
    if (config.contextAddendum) parts.push(config.contextAddendum);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  private resolveModel(modelId: string): any {
    const parts = modelId.split("/");
    if (parts.length === 2) {
      return this.modelRegistry.find(parts[0], parts[1]) ?? undefined;
    }

    for (const provider of ["anthropic", "openai", "google"]) {
      const model = this.modelRegistry.find(provider, modelId);
      if (model) return model;
    }

    if (modelId.startsWith("claude")) {
      return getModel("anthropic", modelId) ?? undefined;
    }
    if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4")) {
      return getModel("openai", modelId) ?? undefined;
    }

    return undefined;
  }
}
