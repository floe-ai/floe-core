/**
 * Pi SDK substrate — implements SessionSubstrate using Pi's createAgentSession().
 *
 * Workers are real Pi agent sessions running in-process. They get the full
 * Pi tool set (read, write, edit, bash) plus custom Floe tools (call-blocking,
 * state, artefact, review) registered via customTools.
 *
 * This replaces the old raw HTTP substrate (pi.ts) that manually called
 * Anthropic/OpenAI APIs.
 */

import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  codingTools,
  createCodingTools,
  defineTool,
  type AgentSession,
  type CreateAgentSessionResult,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

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
 * Each worker is a full Pi agent session with coding tools + Floe-specific tools.
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
    const sessionId = config.sessionId ?? `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const model = config.model ? this.resolveModel(config.model) : undefined;

    const { session } = await createAgentSession({
      model,
      sessionManager: SessionManager.inMemory(),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      cwd: config.cwd ?? process.cwd(),
      tools: createCodingTools(config.cwd ?? process.cwd()),
    });

    const workerSession: WorkerSession = {
      sessionId,
      role: config.role,
      status: "active",
      model: config.model ?? model?.id ?? "default",
      createdAt: new Date().toISOString(),
      conversationHistory: [],
    };

    this.sessions.set(sessionId, {
      session,
      config,
      workerSession,
      messageHistory: [],
    });

    // If there's a system prompt (role content), send it as the first message
    if (config.systemPrompt) {
      await session.prompt(config.systemPrompt);
    }

    return workerSession;
  }

  async resumeSession(sessionId: string, storedSession: WorkerSession, config?: Partial<WorkerConfig>): Promise<WorkerSession> {
    // For Pi SDK sessions, resume = create a new session with the conversation context
    const fullConfig: WorkerConfig = {
      role: storedSession.role,
      model: config?.model ?? storedSession.model,
      cwd: config?.cwd,
      sessionId,
      ...config,
    };
    return this.startSession(fullConfig);
  }

  async sendMessage(sessionId: string, message: string, options?: SendOptions): Promise<MessageResult> {
    const piSession = this.sessions.get(sessionId);
    if (!piSession) {
      throw new Error(`No Pi session found: ${sessionId}`);
    }

    const { session } = piSession;
    let responseText = "";

    // Subscribe to collect the response
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && "assistantMessageEvent" in event) {
        const ame = event.assistantMessageEvent as any;
        if (ame.type === "text_delta") {
          responseText += ame.delta;
        }
      }
    });

    try {
      await session.prompt(message);
    } finally {
      unsubscribe();
    }

    // Record in history
    piSession.messageHistory.push(
      { role: "user", content: message, timestamp: new Date().toISOString() },
      { role: "assistant", content: responseText, timestamp: new Date().toISOString() },
    );
    piSession.workerSession.conversationHistory = [...piSession.messageHistory];

    return {
      response: responseText,
      status: "completed",
    };
  }

  async getStatus(sessionId: string): Promise<WorkerStatus> {
    const piSession = this.sessions.get(sessionId);
    if (!piSession) return { status: "not_found" };

    return {
      status: piSession.session.isStreaming ? "streaming" : "idle",
      model: piSession.config.model,
      messageCount: piSession.messageHistory.length,
    };
  }

  getSession(sessionId: string): WorkerSession | undefined {
    return this.sessions.get(sessionId)?.workerSession;
  }

  async stopSession(sessionId: string): Promise<void> {
    const piSession = this.sessions.get(sessionId);
    if (!piSession) return;

    await piSession.session.abort();
    piSession.workerSession.status = "stopped";
  }

  async closeSession(sessionId: string): Promise<void> {
    const piSession = this.sessions.get(sessionId);
    if (!piSession) return;

    piSession.session.dispose();
    piSession.workerSession.status = "completed";
    this.sessions.delete(sessionId);
  }

  private resolveModel(modelId: string): any {
    // Try to find the model in the registry
    // Format: "provider/model-id" or just "model-id"
    const parts = modelId.split("/");
    if (parts.length === 2) {
      return this.modelRegistry.find(parts[0], parts[1]) ?? undefined;
    }

    // Try common providers
    for (const provider of ["anthropic", "openai", "google"]) {
      const model = this.modelRegistry.find(provider, modelId);
      if (model) return model;
    }

    // Fall back to getModel for built-in models
    if (modelId.startsWith("claude")) {
      return getModel("anthropic", modelId) ?? undefined;
    }
    if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4")) {
      return getModel("openai", modelId) ?? undefined;
    }

    return undefined;
  }
}
