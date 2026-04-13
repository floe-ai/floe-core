/**
 * Worker Channel — daemon-side persistent socket session handler.
 *
 * Manages long-lived bidirectional connections from active worker processes.
 * Workers connect, identify themselves via worker.hello, then issue
 * call.blocking requests. The daemon holds the connection open and pushes
 * call.resolved / call.cancelled / call.timed_out back over the same socket
 * when the dependency is satisfied.
 *
 * This is the control plane transport — not the observation plane.
 * Events, replay, and dashboards still use one-shot CLI / events.subscribe.
 */

import type { Socket } from "node:net";
import type {
  WorkerChannelMessage,
  WorkerChannelMessageType,
  WorkerHelloPayload,
  WorkerHelloAckPayload,
  CallBlockingChannelPayload,
  CallResolvedPush,
  CallCancelledPush,
  CallTimedOutPush,
  WorkerInterruptPush,
  WorkerStopPush,
  WorkerChannelError,
} from "./types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function makeMessageId(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sendMessage(socket: Socket, msg: WorkerChannelMessage): boolean {
  try {
    if (socket.destroyed || socket.writableEnded) return false;
    socket.write(JSON.stringify(msg) + "\n");
    return true;
  } catch {
    return false;
  }
}

// ── Waiter Registry ──────────────────────────────────────────────────

export interface Waiter {
  callId: string;
  workerId: string;
  runId: string;
  requestId: string;
  connection: Socket;
  registeredAt: number;
}

/**
 * In-memory registry of workers actively waiting for call resolution.
 *
 * This is the fast-path live transport mechanism. The pending-call ledger
 * in DaemonStore remains the durable state mechanism.
 */
export class WaiterRegistry {
  private readonly waiters = new Map<string, Waiter>();
  private readonly byWorker = new Map<string, Set<string>>();
  private readonly byConnection = new Map<Socket, Set<string>>();

  /** Register a live waiter for a pending blocking call. */
  register(waiter: Waiter): void {
    this.waiters.set(waiter.callId, waiter);

    let workerSet = this.byWorker.get(waiter.workerId);
    if (!workerSet) { workerSet = new Set(); this.byWorker.set(waiter.workerId, workerSet); }
    workerSet.add(waiter.callId);

    let connSet = this.byConnection.get(waiter.connection);
    if (!connSet) { connSet = new Set(); this.byConnection.set(waiter.connection, connSet); }
    connSet.add(waiter.callId);
  }

  /** Get waiter by callId. */
  get(callId: string): Waiter | undefined {
    return this.waiters.get(callId);
  }

  /** Check if a live waiter exists for this callId. */
  has(callId: string): boolean {
    return this.waiters.has(callId);
  }

  /**
   * Resolve a waiter — push call.resolved over the persistent connection.
   * Returns true if the waiter was found and the message was sent.
   */
  resolve(callId: string, responsePayload: Record<string, unknown> | null, resolvedBy: string | null): boolean {
    const waiter = this.waiters.get(callId);
    if (!waiter) return false;

    const push: CallResolvedPush = { callId, responsePayload, resolvedBy };
    const msg: WorkerChannelMessage = {
      messageId: makeMessageId(),
      type: "call.resolved",
      requestId: waiter.requestId,
      workerId: waiter.workerId,
      runId: waiter.runId,
      callId,
      timestamp: nowIso(),
      payload: push as unknown as Record<string, unknown>,
    };

    const sent = sendMessage(waiter.connection, msg);
    this.remove(callId);
    return sent;
  }

  /** Cancel a waiter — push call.cancelled. */
  cancel(callId: string, reason: string): boolean {
    const waiter = this.waiters.get(callId);
    if (!waiter) return false;

    const push: CallCancelledPush = { callId, reason };
    const msg: WorkerChannelMessage = {
      messageId: makeMessageId(),
      type: "call.cancelled",
      requestId: waiter.requestId,
      workerId: waiter.workerId,
      runId: waiter.runId,
      callId,
      timestamp: nowIso(),
      payload: push as unknown as Record<string, unknown>,
    };

    const sent = sendMessage(waiter.connection, msg);
    this.remove(callId);
    return sent;
  }

  /** Time-out a waiter — push call.timed_out. */
  timeout(callId: string): boolean {
    const waiter = this.waiters.get(callId);
    if (!waiter) return false;

    const push: CallTimedOutPush = { callId };
    const msg: WorkerChannelMessage = {
      messageId: makeMessageId(),
      type: "call.timed_out",
      requestId: waiter.requestId,
      workerId: waiter.workerId,
      runId: waiter.runId,
      callId,
      timestamp: nowIso(),
      payload: push as unknown as Record<string, unknown>,
    };

    const sent = sendMessage(waiter.connection, msg);
    this.remove(callId);
    return sent;
  }

  /** Remove a waiter from all indices. */
  remove(callId: string): void {
    const waiter = this.waiters.get(callId);
    if (!waiter) return;

    this.waiters.delete(callId);

    const workerSet = this.byWorker.get(waiter.workerId);
    if (workerSet) { workerSet.delete(callId); if (workerSet.size === 0) this.byWorker.delete(waiter.workerId); }

    const connSet = this.byConnection.get(waiter.connection);
    if (connSet) { connSet.delete(callId); if (connSet.size === 0) this.byConnection.delete(waiter.connection); }
  }

  /** Remove all waiters for a connection (on disconnect). Returns affected callIds. */
  removeByConnection(connection: Socket): string[] {
    const connSet = this.byConnection.get(connection);
    if (!connSet) return [];
    const callIds = [...connSet];
    for (const callId of callIds) this.remove(callId);
    return callIds;
  }

  /** Remove all waiters for a worker. Returns affected callIds. */
  removeByWorker(workerId: string): string[] {
    const workerSet = this.byWorker.get(workerId);
    if (!workerSet) return [];
    const callIds = [...workerSet];
    for (const callId of callIds) this.remove(callId);
    return callIds;
  }

  /** Current waiter count. */
  get size(): number {
    return this.waiters.size;
  }

  /** All active waiter callIds. */
  activeCallIds(): string[] {
    return [...this.waiters.keys()];
  }
}

// ── Worker Connection Registry ───────────────────────────────────────

export interface WorkerConnection {
  workerId: string;
  runId?: string;
  socket: Socket;
  connectedAt: number;
  lastHeartbeatAt: number;
}

/**
 * Tracks active persistent worker connections.
 * Used for push-based interrupt/stop and connection health monitoring.
 */
export class WorkerConnectionRegistry {
  private readonly connections = new Map<string, WorkerConnection>();
  private readonly bySocket = new Map<Socket, string>();

  register(conn: WorkerConnection): void {
    // Close old connection for same worker if exists
    const existing = this.connections.get(conn.workerId);
    if (existing && existing.socket !== conn.socket) {
      try { existing.socket.end(); } catch {}
      this.bySocket.delete(existing.socket);
    }
    this.connections.set(conn.workerId, conn);
    this.bySocket.set(conn.socket, conn.workerId);
  }

  get(workerId: string): WorkerConnection | undefined {
    return this.connections.get(workerId);
  }

  getBySocket(socket: Socket): WorkerConnection | undefined {
    const workerId = this.bySocket.get(socket);
    return workerId ? this.connections.get(workerId) : undefined;
  }

  remove(workerId: string): void {
    const conn = this.connections.get(workerId);
    if (conn) {
      this.bySocket.delete(conn.socket);
      this.connections.delete(workerId);
    }
  }

  removeBySocket(socket: Socket): string | undefined {
    const workerId = this.bySocket.get(socket);
    if (workerId) {
      this.connections.delete(workerId);
      this.bySocket.delete(socket);
    }
    return workerId;
  }

  heartbeat(workerId: string): void {
    const conn = this.connections.get(workerId);
    if (conn) conn.lastHeartbeatAt = Date.now();
  }

  has(workerId: string): boolean {
    return this.connections.has(workerId);
  }

  /** Push a message to a connected worker. */
  pushToWorker(workerId: string, msg: WorkerChannelMessage): boolean {
    const conn = this.connections.get(workerId);
    if (!conn) return false;
    return sendMessage(conn.socket, msg);
  }

  get size(): number {
    return this.connections.size;
  }
}

// ── Worker Channel Handler ───────────────────────────────────────────

export interface WorkerChannelCallbacks {
  /** Called when a worker sends worker.hello. */
  onHello(workerId: string, runId: string | undefined, socket: Socket): WorkerHelloAckPayload;
  /** Called when a worker sends call.blocking. Returns callId assigned by the service. */
  onCallBlocking(payload: CallBlockingChannelPayload, requestId: string, socket: Socket): Promise<string>;
  /** Called when a worker sends heartbeat. */
  onHeartbeat(workerId: string): void;
  /** Called when a worker connection closes. */
  onDisconnect(workerId: string, socket: Socket): void;
}

/**
 * Handles a persistent worker connection.
 * Called by DaemonServer when it detects the first message is worker.hello.
 */
export function handleWorkerConnection(
  socket: Socket,
  callbacks: WorkerChannelCallbacks,
  connections: WorkerConnectionRegistry,
  waiters: WaiterRegistry,
): void {
  let buffer = "";
  let identifiedWorkerId: string | undefined;

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: WorkerChannelMessage;
      try {
        msg = JSON.parse(trimmed) as WorkerChannelMessage;
      } catch {
        sendMessage(socket, {
          messageId: makeMessageId(),
          type: "error",
          timestamp: nowIso(),
          payload: { message: "Invalid JSON", code: "PARSE_ERROR" } satisfies WorkerChannelError as unknown as Record<string, unknown>,
        });
        continue;
      }

      handleIncomingMessage(msg).catch((err) => {
        sendMessage(socket, {
          messageId: makeMessageId(),
          type: "error",
          requestId: msg.requestId ?? msg.messageId,
          workerId: identifiedWorkerId,
          timestamp: nowIso(),
          payload: { message: err?.message ?? String(err), code: "HANDLER_ERROR" } satisfies WorkerChannelError as unknown as Record<string, unknown>,
        });
      });
    }
  });

  socket.on("close", () => {
    if (identifiedWorkerId) {
      waiters.removeByConnection(socket);
      connections.removeBySocket(socket);
      callbacks.onDisconnect(identifiedWorkerId, socket);
    }
  });

  socket.on("error", () => {
    if (identifiedWorkerId) {
      waiters.removeByConnection(socket);
      connections.removeBySocket(socket);
      callbacks.onDisconnect(identifiedWorkerId, socket);
    }
  });

  async function handleIncomingMessage(msg: WorkerChannelMessage): Promise<void> {
    switch (msg.type) {
      case "worker.hello": {
        const hello = msg.payload as unknown as WorkerHelloPayload | undefined;
        const workerId = hello?.workerId ?? msg.workerId;
        if (!workerId) {
          sendMessage(socket, {
            messageId: makeMessageId(),
            type: "error",
            requestId: msg.requestId ?? msg.messageId,
            timestamp: nowIso(),
            payload: { message: "worker.hello requires workerId", code: "MISSING_WORKER_ID" } satisfies WorkerChannelError as unknown as Record<string, unknown>,
          });
          return;
        }
        identifiedWorkerId = workerId;
        const ackPayload = callbacks.onHello(workerId, hello?.runId ?? msg.runId, socket);
        connections.register({
          workerId,
          runId: hello?.runId ?? msg.runId,
          socket,
          connectedAt: Date.now(),
          lastHeartbeatAt: Date.now(),
        });

        sendMessage(socket, {
          messageId: makeMessageId(),
          type: "worker.hello.ack",
          requestId: msg.requestId ?? msg.messageId,
          workerId,
          timestamp: nowIso(),
          payload: ackPayload as unknown as Record<string, unknown>,
        });
        return;
      }

      case "worker.heartbeat": {
        const workerId = msg.workerId ?? identifiedWorkerId;
        if (workerId) {
          connections.heartbeat(workerId);
          callbacks.onHeartbeat(workerId);
        }
        return;
      }

      case "worker.disconnecting": {
        const workerId = msg.workerId ?? identifiedWorkerId;
        if (workerId) {
          waiters.removeByConnection(socket);
          connections.removeBySocket(socket);
          callbacks.onDisconnect(workerId, socket);
        }
        try { socket.end(); } catch {}
        return;
      }

      case "call.blocking": {
        const payload = msg.payload as unknown as CallBlockingChannelPayload | undefined;
        if (!payload?.runId || !payload?.workerId || !payload?.callType) {
          sendMessage(socket, {
            messageId: makeMessageId(),
            type: "error",
            requestId: msg.requestId ?? msg.messageId,
            workerId: identifiedWorkerId,
            timestamp: nowIso(),
            payload: { message: "call.blocking requires runId, workerId, callType", code: "MISSING_FIELDS" } satisfies WorkerChannelError as unknown as Record<string, unknown>,
          });
          return;
        }

        const requestId = msg.requestId ?? msg.messageId;
        const callId = await callbacks.onCallBlocking(payload, requestId, socket);

        // Register a waiter — daemon will push call.resolved over this connection.
        waiters.register({
          callId,
          workerId: payload.workerId,
          runId: payload.runId,
          requestId,
          connection: socket,
          registeredAt: Date.now(),
        });
        // No response sent yet — the connection stays open until call.resolved/cancelled/timed_out.
        return;
      }

      default: {
        sendMessage(socket, {
          messageId: makeMessageId(),
          type: "error",
          requestId: msg.requestId ?? msg.messageId,
          workerId: identifiedWorkerId,
          timestamp: nowIso(),
          payload: { message: `Unknown message type: ${msg.type}`, code: "UNKNOWN_TYPE" } satisfies WorkerChannelError as unknown as Record<string, unknown>,
        });
      }
    }
  }
}

// Re-export sendMessage for use by DaemonService
export { sendMessage as sendChannelMessage, makeMessageId as makeChannelMessageId };
