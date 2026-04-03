/**
 * Shared types for the floe-runtime MCP server.
 */

export type WorkerRole = "foreman" | "planner" | "implementer" | "reviewer";
export type WorkerProvider = "codex" | "claude" | "copilot" | "mock";
export type WorkerStatus = "starting" | "active" | "idle" | "stopped" | "failed";

export interface WorkerConfig {
  role: WorkerRole;
  provider: WorkerProvider;
  featureId: string;
  epicId?: string;
  releaseId?: string;
  /** Canonical role content to inject as session system prompt */
  roleContent?: string;
  /** Path to the canonical role file (for reference/logging) */
  roleContentPath?: string;
  /** Additional context to include in the system prompt */
  contextAddendum?: string;
}

export interface WorkerSession {
  id: string;
  role: WorkerRole;
  provider: WorkerProvider;
  status: WorkerStatus;
  featureId: string;
  epicId?: string;
  releaseId?: string;
  roleContentPath?: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
  lastMessageAt?: string;
  error?: string;
  /** Adapter-internal metadata (thread IDs, conversation history, etc.) */
  metadata?: Record<string, unknown>;
}

export interface SendOptions {
  stream?: boolean;
  timeoutMs?: number;
}

export interface MessageResult {
  sessionId: string;
  content: string;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface WorkerEvent {
  type: "message_delta" | "message_complete" | "error" | "status_change";
  sessionId: string;
  data?: unknown;
  error?: string;
}

export interface EventHandlers {
  onDelta?: (delta: string, event: WorkerEvent) => void;
  onComplete?: (result: MessageResult, event: WorkerEvent) => void;
  onError?: (error: string, event: WorkerEvent) => void;
  onStatusChange?: (status: WorkerStatus, event: WorkerEvent) => void;
}
