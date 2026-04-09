import type { WorkerConfig, WorkerProvider, WorkerRole } from "../types.ts";

export type RuntimeRunState =
  | "initialising"
  | "planning"
  | "awaiting_plan_review"
  | "plan_revision"
  | "implementing"
  | "awaiting_code_review"
  | "code_revision"
  | "awaiting_foreman"
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
  provider: WorkerProvider;
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
