/**
 * Shared types for the floe runtime.
 */

export type WorkerRole = "floe" | "planner" | "implementer" | "reviewer";
export type WorkerStatus = "starting" | "active" | "idle" | "stopped" | "failed";

export interface WorkerConfig {
  role: WorkerRole;
  featureId: string;
  epicId?: string;
  releaseId?: string;
  /** Canonical role content to inject as session system prompt */
  roleContent?: string;
  /** Path to the canonical role file (for reference/logging) */
  roleContentPath?: string;
  /** Additional context to include in the system prompt */
  contextAddendum?: string;
  /** Model identifier (e.g. 'claude-sonnet-4-20250514', 'o3-mini'). */
  model?: string;
  /** Thinking/reasoning level: 'low' | 'normal' | 'high'. */
  thinking?: string;
  /** Working directory for the session. Defaults to process.cwd(). */
  cwd?: string;
}

export interface WorkerSession {
  id: string;
  role: WorkerRole;
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
  /** Runtime metadata (thread IDs, conversation history, etc.) */
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
