import type { WorkerConfig, WorkerRole } from "../types.ts";

export type RuntimeRunState =
  | "initialising"
  | "planning"
  | "awaiting_plan_review"
  | "plan_revision"
  | "implementing"
  | "awaiting_code_review"
  | "code_revision"
  | "awaiting_floe"
  | "completed"
  | "escalated"
  | "cancelled"
  | "failed";

export type RuntimeWorkerState =
  | "starting"
  | "active"
  | "waiting"
  | "resolved"
  | "stalled"
  | "interrupted"
  | "stopped"
  | "failed";

export type PendingCallStatus =
  | "pending"
  | "resolved"
  | "timed_out"
  | "cancelled"
  | "failed"
  | "orphaned";

export type ResumeStrategy = "warm" | "session" | "artefact";

export interface RunBudgets {
  maxPlanRounds?: number;
  maxReviewRounds?: number;
  maxWorkerMessages?: number;
  maxBlockingCalls?: number;
  maxResumes?: number;
  maxRetries?: number;
  maxWallClockMs?: number;
  maxToolCalls?: number;
  maxTokens?: number;
}

export interface RunRecord {
  runId: string;
  type: string;
  objective: string;
  participants: string[];
  budgets?: RunBudgets;
  state: RuntimeRunState;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  escalationReason?: string;
  terminalReason?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerRuntimeRecord {
  workerId: string;
  sessionId: string;
  role: WorkerRole;
  runId?: string;
  state: RuntimeWorkerState;
  pendingCallId?: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  lastHeartbeatAt?: string;
  retryCount: number;
  lastError?: string;
  metadata?: Record<string, unknown>;
}

export interface PendingCallRecord {
  callId: string;
  runId: string;
  workerId: string;
  role: WorkerRole;
  callType: string;
  status: PendingCallStatus;
  payload: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  dependsOn: string[];
  resumeStrategy: ResumeStrategy;
  timeoutAt?: string;
  retryCount: number;
  resolvedBy?: string;
  notes?: string;
}

export interface RuntimeEvent {
  seq: number;
  timestamp: string;
  type: string;
  runId?: string;
  workerId?: string;
  callId?: string;
  data?: Record<string, unknown>;
}

export interface RuntimeStatus {
  runtime: {
    pid: number;
    startedAt: string;
    socketPath: string;
  };
  counts: {
    runs: number;
    pendingCalls: number;
    workers: number;
  };
}

export interface RuntimeEnsurePayload {
  socketPath: string;
}

export interface RunStartPayload {
  type: string;
  objective: string;
  participants?: string[];
  budgets?: RunBudgets;
  state?: RuntimeRunState;
  metadata?: Record<string, unknown>;
}

export interface WorkerStartPayload extends Partial<WorkerConfig> {
  runId?: string;
  initialMessage?: string;
  sessionId?: string;
}

export interface WorkerResumePayload {
  workerId?: string;
  sessionRef?: string;
  runId?: string;
}

export interface WorkerContinuePayload {
  workerId: string;
  callId: string;
  continuation?: string;
  runId?: string;
}

export interface WorkerInterruptPayload {
  workerId: string;
  reason?: string;
}

export interface WorkerStopPayload {
  workerId: string;
  reason?: string;
}

export interface WorkerRecoverPayload {
  workerId: string;
  strategy?: ResumeStrategy;
  contextAddendum?: string;
  runId?: string;
}

export interface CallBlockingPayload {
  runId: string;
  workerId: string;
  callType: string;
  payload?: Record<string, unknown>;
  dependsOn?: string[];
  resumeStrategy?: ResumeStrategy;
  timeoutAt?: string;
}

export interface CallResolvePayload {
  callId: string;
  responsePayload?: Record<string, unknown>;
  resolvedBy?: string;
}

export interface CallDetectOrphanedPayload {
  runId?: string;
}

export interface RouteSendPayload {
  to: string;
  message: string;
  context?: Record<string, unknown>;
  runId?: string;
}

export interface RouteReplyPayload {
  callId: string;
  response: Record<string, unknown>;
  resolvedBy?: string;
}

export interface RunGetPayload {
  runId: string;
}

export interface WorkerGetPayload {
  workerId: string;
}

export interface EventsSubscribePayload {
  runId?: string;
  /** If provided, only return events whose callId matches this value. */
  callId?: string;
  cursor?: number;
  limit?: number;
  waitMs?: number;
}

export interface EventsReplayPayload {
  runId?: string;
  cursor?: number;
  limit?: number;
}

export interface DaemonRequest {
  id: string;
  action: string;
  payload?: Record<string, unknown>;
}

export interface DaemonResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

// ── Worker Channel Protocol ──────────────────────────────────────────
//
// Persistent bidirectional JSON-line messages exchanged over a long-lived
// socket connection between an active worker process and the daemon.
// Each message is a single JSON line terminated by \n.

/** Envelope for all worker channel messages. */
export interface WorkerChannelMessage {
  /** Unique message identifier. */
  messageId: string;
  /** Message type — determines payload shape. */
  type: WorkerChannelMessageType;
  /** Correlation ID for request/response pairs. */
  requestId?: string;
  /** Worker identifier. Present on all messages after hello. */
  workerId?: string;
  /** Run identifier where relevant. */
  runId?: string;
  /** Call identifier where relevant. */
  callId?: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Type-specific payload. */
  payload?: Record<string, unknown>;
}

/** All recognised message types on the worker channel. */
export type WorkerChannelMessageType =
  // Worker → Daemon
  | "worker.hello"
  | "worker.heartbeat"
  | "worker.disconnecting"
  | "call.blocking"
  // Daemon → Worker
  | "worker.hello.ack"
  | "call.resolved"
  | "call.cancelled"
  | "call.timed_out"
  | "worker.interrupt"
  | "worker.stop"
  | "error";

/** Worker → Daemon: establish session identity. */
export interface WorkerHelloPayload {
  workerId: string;
  runId?: string;
}

/** Daemon → Worker: acknowledge hello. */
export interface WorkerHelloAckPayload {
  workerId: string;
  status: "ok" | "unknown_worker" | "already_connected";
}

/** Worker → Daemon: register a blocking call and wait for resolution. */
export interface CallBlockingChannelPayload {
  runId: string;
  workerId: string;
  callType: string;
  payload?: Record<string, unknown>;
  dependsOn?: string[];
  resumeStrategy?: ResumeStrategy;
  timeoutAt?: string;
}

/** Daemon → Worker: pushed when call is resolved. */
export interface CallResolvedPush {
  callId: string;
  responsePayload: Record<string, unknown> | null;
  resolvedBy: string | null;
}

/** Daemon → Worker: pushed when call is cancelled. */
export interface CallCancelledPush {
  callId: string;
  reason: string;
}

/** Daemon → Worker: pushed when call times out. */
export interface CallTimedOutPush {
  callId: string;
}

/** Daemon → Worker: interrupt request. */
export interface WorkerInterruptPush {
  reason?: string;
}

/** Daemon → Worker: stop request. */
export interface WorkerStopPush {
  reason?: string;
}

/** Daemon → Worker: protocol error. */
export interface WorkerChannelError {
  message: string;
  code?: string;
}
