/**
 * WorkerClient — persistent socket client for worker↔daemon communication.
 *
 * Used by worker processes (via the CLI `call-blocking` command) to maintain
 * a persistent connection to the daemon and issue blocking calls that wait
 * for push-based resolution.
 *
 * Usage:
 *   const client = new WorkerClient(endpoint, workerId, runId);
 *   await client.connect();
 *   const result = await client.callBlocking({ runId, workerId, callType, ... });
 *   // result contains responsePayload from the resolver
 *   client.close();
 */

import { createConnection, type Socket } from "node:net";
import type {
  WorkerChannelMessage,
  CallBlockingChannelPayload,
  CallResolvedPush,
  CallCancelledPush,
  CallTimedOutPush,
  WorkerChannelError,
} from "./types.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function makeMessageId(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface WorkerClientOptions {
  /** Max time to wait for call resolution (ms). Default: 30 min. */
  waitMs?: number;
  /** Heartbeat interval (ms). Default: 30s. */
  heartbeatIntervalMs?: number;
  /** Connection timeout (ms). Default: 10s. */
  connectTimeoutMs?: number;
}

export class WorkerClient {
  private readonly endpoint: string;
  private readonly workerId: string;
  private readonly runId: string | undefined;
  private socket: Socket | null = null;
  private buffer = "";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private closed = false;

  /** Handlers for incoming messages, keyed by requestId. */
  private pending = new Map<string, {
    resolve: (msg: WorkerChannelMessage) => void;
    reject: (err: Error) => void;
  }>();

  /** Handler for unsolicited pushes (interrupt, stop). */
  private pushHandler: ((msg: WorkerChannelMessage) => void) | null = null;

  constructor(endpoint: string, workerId: string, runId?: string) {
    this.endpoint = endpoint;
    this.workerId = workerId;
    this.runId = runId;
  }

  /** Connect to the daemon and send worker.hello. */
  async connect(opts?: WorkerClientOptions): Promise<void> {
    if (this.connected) return;
    const connectTimeoutMs = opts?.connectTimeoutMs ?? 10_000;
    const heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? 30_000;

    this.socket = await this.createSocket(connectTimeoutMs);
    this.connected = true;

    // Set up line-based message reading
    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf-8");
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as WorkerChannelMessage;
          this.handleMessage(msg);
        } catch {
          // Ignore unparseable lines
        }
      }
    });

    this.socket.on("close", () => {
      this.connected = false;
      this.rejectAllPending(new Error("Connection closed"));
    });

    this.socket.on("error", (err) => {
      this.connected = false;
      this.rejectAllPending(err);
    });

    // Send worker.hello and wait for ack
    const helloRequestId = makeMessageId();
    const helloPromise = this.waitForResponse(helloRequestId, connectTimeoutMs);

    this.send({
      messageId: makeMessageId(),
      type: "worker.hello",
      requestId: helloRequestId,
      workerId: this.workerId,
      runId: this.runId,
      timestamp: nowIso(),
      payload: { workerId: this.workerId, runId: this.runId } as unknown as Record<string, unknown>,
    });

    const ack = await helloPromise;
    if (ack.type === "error") {
      const errPayload = ack.payload as unknown as WorkerChannelError | undefined;
      throw new Error(`worker.hello rejected: ${errPayload?.message ?? "unknown"}`);
    }

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected || !this.socket) return;
      this.send({
        messageId: makeMessageId(),
        type: "worker.heartbeat",
        workerId: this.workerId,
        timestamp: nowIso(),
      });
    }, heartbeatIntervalMs);
  }

  /**
   * Issue a blocking call and wait for resolution.
   * This is the main coordination primitive — it blocks until the daemon
   * pushes call.resolved, call.cancelled, or call.timed_out.
   */
  async callBlocking(
    payload: CallBlockingChannelPayload,
    opts?: WorkerClientOptions,
  ): Promise<{ ok: boolean; callId?: string; responsePayload?: Record<string, unknown> | null; resolvedBy?: string | null; error?: string }> {
    if (!this.connected || !this.socket) {
      throw new Error("WorkerClient not connected — call connect() first");
    }

    const waitMs = opts?.waitMs ?? 1_800_000; // 30 min default
    const requestId = makeMessageId();
    const responsePromise = this.waitForResponse(requestId, waitMs);

    this.send({
      messageId: makeMessageId(),
      type: "call.blocking",
      requestId,
      workerId: payload.workerId,
      runId: payload.runId,
      timestamp: nowIso(),
      payload: payload as unknown as Record<string, unknown>,
    });

    const response = await responsePromise;

    switch (response.type) {
      case "call.resolved": {
        const data = response.payload as unknown as CallResolvedPush;
        return {
          ok: true,
          callId: data?.callId ?? response.callId,
          responsePayload: data?.responsePayload ?? null,
          resolvedBy: data?.resolvedBy ?? null,
        };
      }
      case "call.cancelled": {
        const data = response.payload as unknown as CallCancelledPush;
        return {
          ok: false,
          callId: data?.callId ?? response.callId,
          error: `Call cancelled: ${data?.reason ?? "unknown"}`,
        };
      }
      case "call.timed_out": {
        const data = response.payload as unknown as CallTimedOutPush;
        return {
          ok: false,
          callId: data?.callId ?? response.callId,
          error: "Call timed out",
        };
      }
      case "error": {
        const data = response.payload as unknown as WorkerChannelError;
        return {
          ok: false,
          error: data?.message ?? "Unknown error",
        };
      }
      default:
        return {
          ok: false,
          error: `Unexpected response type: ${response.type}`,
        };
    }
  }

  /** Register a handler for unsolicited push messages (interrupt, stop). */
  onPush(handler: (msg: WorkerChannelMessage) => void): void {
    this.pushHandler = handler;
  }

  /** Gracefully disconnect. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.connected && this.socket) {
      try {
        this.send({
          messageId: makeMessageId(),
          type: "worker.disconnecting",
          workerId: this.workerId,
          timestamp: nowIso(),
        });
      } catch {}
      try { this.socket.end(); } catch {}
    }

    this.connected = false;
    this.rejectAllPending(new Error("Client closed"));
  }

  // ── Internals ────────────────────────────────────────────────────

  private createSocket(timeoutMs: number): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = this.endpoint.startsWith("tcp://")
        ? (() => {
            const url = new URL(this.endpoint);
            const port = Number(url.port);
            if (!url.hostname || Number.isNaN(port)) {
              throw new Error(`Invalid TCP endpoint: ${this.endpoint}`);
            }
            return createConnection({ host: url.hostname, port });
          })()
        : createConnection(this.endpoint);

      const timer = setTimeout(() => {
        try { socket.destroy(); } catch {}
        reject(new Error(`Connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });

      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private send(msg: WorkerChannelMessage): void {
    if (!this.socket || this.socket.destroyed || this.socket.writableEnded) {
      throw new Error("Socket not writable");
    }
    this.socket.write(JSON.stringify(msg) + "\n");
  }

  private waitForResponse(requestId: string, timeoutMs: number): Promise<WorkerChannelMessage> {
    return new Promise<WorkerChannelMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for response to ${requestId} after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: (msg) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(err);
        },
      });
    });
  }

  private handleMessage(msg: WorkerChannelMessage): void {
    // If this message correlates to a pending request, deliver it
    if (msg.requestId && this.pending.has(msg.requestId)) {
      this.pending.get(msg.requestId)!.resolve(msg);
      return;
    }

    // Unsolicited push (interrupt, stop, etc.)
    if (this.pushHandler) {
      this.pushHandler(msg);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, handler] of this.pending) {
      handler.reject(err);
    }
    this.pending.clear();
  }
}
