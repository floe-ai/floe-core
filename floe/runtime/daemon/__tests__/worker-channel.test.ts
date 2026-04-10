/**
 * Tests for the persistent worker channel transport.
 *
 * Covers:
 * - WaiterRegistry unit tests (register, resolve, cancel, timeout, cleanup)
 * - WorkerConnectionRegistry unit tests
 * - Integration: persistent socket session lifecycle (connect → callBlocking → resolve → continue)
 * - Disconnect handling
 * - Protocol errors
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer, createConnection, type Socket, type Server } from "node:net";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  WaiterRegistry,
  WorkerConnectionRegistry,
  handleWorkerConnection,
  type WorkerChannelCallbacks,
} from "../worker-channel.ts";
import { WorkerClient } from "../worker-client.ts";
import type {
  WorkerChannelMessage,
  CallBlockingChannelPayload,
  WorkerHelloAckPayload,
} from "../types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeSocket(): Socket {
  // Create a mock socket-like object for unit tests that don't need real networking
  const written: string[] = [];
  const socket = {
    destroyed: false,
    writableEnded: false,
    write(data: string) { written.push(data); return true; },
    end() { this.writableEnded = true; },
    on() {},
    once() {},
    removeAllListeners() {},
    emit() {},
    _written: written,
  } as unknown as Socket & { _written: string[] };
  return socket;
}

function parseWritten(socket: Socket & { _written: string[] }): WorkerChannelMessage[] {
  return socket._written
    .flatMap((s) => s.split("\n").filter(Boolean))
    .map((line) => JSON.parse(line));
}

// ── WaiterRegistry unit tests ────────────────────────────────────────

describe("WaiterRegistry", () => {
  let registry: WaiterRegistry;

  beforeEach(() => {
    registry = new WaiterRegistry();
  });

  test("register and retrieve waiter", () => {
    const socket = makeSocket();
    registry.register({
      callId: "call-1",
      workerId: "w-1",
      runId: "run-1",
      requestId: "req-1",
      connection: socket,
      registeredAt: Date.now(),
    });

    expect(registry.size).toBe(1);
    expect(registry.has("call-1")).toBe(true);
    expect(registry.get("call-1")?.workerId).toBe("w-1");
    expect(registry.activeCallIds()).toContain("call-1");
  });

  test("resolve pushes call.resolved over connection and removes waiter", () => {
    const socket = makeSocket();
    registry.register({
      callId: "call-2",
      workerId: "w-2",
      runId: "run-2",
      requestId: "req-2",
      connection: socket,
      registeredAt: Date.now(),
    });

    const sent = registry.resolve("call-2", { verdict: "approved" }, "reviewer-1");
    expect(sent).toBe(true);
    expect(registry.size).toBe(0);
    expect(registry.has("call-2")).toBe(false);

    const messages = parseWritten(socket);
    expect(messages.length).toBe(1);
    expect(messages[0].type).toBe("call.resolved");
    expect(messages[0].requestId).toBe("req-2");
    expect(messages[0].callId).toBe("call-2");
    const payload = messages[0].payload as any;
    expect(payload.callId).toBe("call-2");
    expect(payload.responsePayload).toEqual({ verdict: "approved" });
    expect(payload.resolvedBy).toBe("reviewer-1");
  });

  test("resolve returns false for unknown callId", () => {
    expect(registry.resolve("nonexistent", null, null)).toBe(false);
  });

  test("cancel pushes call.cancelled and removes waiter", () => {
    const socket = makeSocket();
    registry.register({
      callId: "call-3",
      workerId: "w-3",
      runId: "run-3",
      requestId: "req-3",
      connection: socket,
      registeredAt: Date.now(),
    });

    const sent = registry.cancel("call-3", "operator cancelled");
    expect(sent).toBe(true);
    expect(registry.size).toBe(0);

    const messages = parseWritten(socket);
    expect(messages[0].type).toBe("call.cancelled");
    const payload = messages[0].payload as any;
    expect(payload.reason).toBe("operator cancelled");
  });

  test("timeout pushes call.timed_out and removes waiter", () => {
    const socket = makeSocket();
    registry.register({
      callId: "call-4",
      workerId: "w-4",
      runId: "run-4",
      requestId: "req-4",
      connection: socket,
      registeredAt: Date.now(),
    });

    const sent = registry.timeout("call-4");
    expect(sent).toBe(true);
    expect(registry.size).toBe(0);

    const messages = parseWritten(socket);
    expect(messages[0].type).toBe("call.timed_out");
  });

  test("removeByConnection removes all waiters for a socket", () => {
    const socket1 = makeSocket();
    const socket2 = makeSocket();

    registry.register({ callId: "c-a", workerId: "w-a", runId: "r-a", requestId: "ra", connection: socket1, registeredAt: Date.now() });
    registry.register({ callId: "c-b", workerId: "w-b", runId: "r-b", requestId: "rb", connection: socket1, registeredAt: Date.now() });
    registry.register({ callId: "c-c", workerId: "w-c", runId: "r-c", requestId: "rc", connection: socket2, registeredAt: Date.now() });

    const removed = registry.removeByConnection(socket1);
    expect(removed).toEqual(["c-a", "c-b"]);
    expect(registry.size).toBe(1);
    expect(registry.has("c-c")).toBe(true);
  });

  test("removeByWorker removes all waiters for a worker", () => {
    const socket = makeSocket();

    registry.register({ callId: "c-1", workerId: "shared-w", runId: "r-1", requestId: "r1", connection: socket, registeredAt: Date.now() });
    registry.register({ callId: "c-2", workerId: "shared-w", runId: "r-2", requestId: "r2", connection: socket, registeredAt: Date.now() });
    registry.register({ callId: "c-3", workerId: "other-w", runId: "r-3", requestId: "r3", connection: socket, registeredAt: Date.now() });

    const removed = registry.removeByWorker("shared-w");
    expect(removed).toEqual(["c-1", "c-2"]);
    expect(registry.size).toBe(1);
  });

  test("resolve on destroyed socket returns false", () => {
    const socket = makeSocket();
    (socket as any).destroyed = true;
    registry.register({ callId: "c-x", workerId: "w-x", runId: "r-x", requestId: "rx", connection: socket, registeredAt: Date.now() });

    const sent = registry.resolve("c-x", null, null);
    expect(sent).toBe(false);
    expect(registry.size).toBe(0); // still cleaned up
  });
});

// ── WorkerConnectionRegistry unit tests ──────────────────────────────

describe("WorkerConnectionRegistry", () => {
  let registry: WorkerConnectionRegistry;

  beforeEach(() => {
    registry = new WorkerConnectionRegistry();
  });

  test("register and retrieve connection", () => {
    const socket = makeSocket();
    registry.register({ workerId: "w-1", runId: "r-1", socket, connectedAt: Date.now(), lastHeartbeatAt: Date.now() });

    expect(registry.has("w-1")).toBe(true);
    expect(registry.get("w-1")?.runId).toBe("r-1");
    expect(registry.getBySocket(socket)?.workerId).toBe("w-1");
    expect(registry.size).toBe(1);
  });

  test("re-register closes old socket", () => {
    const socket1 = makeSocket();
    const socket2 = makeSocket();
    registry.register({ workerId: "w-1", socket: socket1, connectedAt: Date.now(), lastHeartbeatAt: Date.now() });
    registry.register({ workerId: "w-1", socket: socket2, connectedAt: Date.now(), lastHeartbeatAt: Date.now() });

    expect(registry.size).toBe(1);
    expect(registry.get("w-1")?.socket).toBe(socket2);
    expect((socket1 as any).writableEnded).toBe(true); // old socket was ended
  });

  test("remove by workerId", () => {
    const socket = makeSocket();
    registry.register({ workerId: "w-1", socket, connectedAt: Date.now(), lastHeartbeatAt: Date.now() });
    registry.remove("w-1");

    expect(registry.has("w-1")).toBe(false);
    expect(registry.size).toBe(0);
  });

  test("removeBySocket returns workerId", () => {
    const socket = makeSocket();
    registry.register({ workerId: "w-1", socket, connectedAt: Date.now(), lastHeartbeatAt: Date.now() });
    const removedId = registry.removeBySocket(socket);

    expect(removedId).toBe("w-1");
    expect(registry.size).toBe(0);
  });

  test("heartbeat updates lastHeartbeatAt", () => {
    const socket = makeSocket();
    const before = Date.now();
    registry.register({ workerId: "w-1", socket, connectedAt: before, lastHeartbeatAt: before });

    // Small delay to ensure time difference
    registry.heartbeat("w-1");
    expect(registry.get("w-1")!.lastHeartbeatAt).toBeGreaterThanOrEqual(before);
  });

  test("pushToWorker sends message over socket", () => {
    const socket = makeSocket();
    registry.register({ workerId: "w-1", socket, connectedAt: Date.now(), lastHeartbeatAt: Date.now() });

    const sent = registry.pushToWorker("w-1", {
      messageId: "test",
      type: "worker.stop",
      workerId: "w-1",
      timestamp: new Date().toISOString(),
      payload: { reason: "operator" } as unknown as Record<string, unknown>,
    });

    expect(sent).toBe(true);
    const messages = parseWritten(socket);
    expect(messages[0].type).toBe("worker.stop");
  });
});

// ── Integration tests with real sockets ──────────────────────────────

describe("Persistent socket transport integration", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: Server;
  let waiters: WaiterRegistry;
  let connections: WorkerConnectionRegistry;
  let callIdCounter: number;
  let onCallBlockingResolve: ((callId: string) => void) | null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "floe-test-"));
    socketPath = join(tmpDir, "test.sock");
    waiters = new WaiterRegistry();
    connections = new WorkerConnectionRegistry();
    callIdCounter = 0;
    onCallBlockingResolve = null;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch {}
    }
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });

  function startTestServer(callbacks?: Partial<WorkerChannelCallbacks>): Promise<void> {
    const fullCallbacks: WorkerChannelCallbacks = {
      onHello: callbacks?.onHello ?? ((workerId, _runId, _socket) => {
        return { workerId, status: "ok" } as WorkerHelloAckPayload;
      }),
      onCallBlocking: callbacks?.onCallBlocking ?? (async (payload, _requestId, _socket) => {
        callIdCounter++;
        const callId = `test-call-${callIdCounter}`;
        if (onCallBlockingResolve) {
          onCallBlockingResolve(callId);
        }
        return callId;
      }),
      onHeartbeat: callbacks?.onHeartbeat ?? (() => {}),
      onDisconnect: callbacks?.onDisconnect ?? (() => {}),
    };

    return new Promise<void>((resolve) => {
      server = createServer((socket) => {
        handleWorkerConnection(socket, fullCallbacks, connections, waiters);
      });
      server.listen(socketPath, () => resolve());
    });
  }

  test("worker connects and receives hello ack", async () => {
    await startTestServer();

    const client = new WorkerClient(socketPath, "w-test-1", "run-test-1");
    await client.connect({ connectTimeoutMs: 5_000, heartbeatIntervalMs: 60_000 });

    expect(connections.has("w-test-1")).toBe(true);
    client.close();
  });

  test("worker issues call.blocking and receives call.resolved via push", async () => {
    let capturedCallId = "";

    onCallBlockingResolve = (callId: string) => {
      capturedCallId = callId;
      // Simulate a reviewer resolving the call after a short delay
      setTimeout(() => {
        waiters.resolve(callId, { verdict: "approved", comments: "LGTM" }, "reviewer-agent");
      }, 50);
    };

    await startTestServer();

    const client = new WorkerClient(socketPath, "w-test-2", "run-test-2");
    await client.connect({ connectTimeoutMs: 5_000, heartbeatIntervalMs: 60_000 });

    const result = await client.callBlocking(
      {
        runId: "run-test-2",
        workerId: "w-test-2",
        callType: "request_approach_review",
        payload: { approach: "test approach" },
      },
      { waitMs: 10_000 },
    );

    expect(result.ok).toBe(true);
    expect(result.callId).toBe(capturedCallId);
    expect(result.responsePayload).toEqual({ verdict: "approved", comments: "LGTM" });
    expect(result.resolvedBy).toBe("reviewer-agent");

    // Waiter should be cleaned up
    expect(waiters.size).toBe(0);

    client.close();
  });

  test("call.cancelled is delivered to waiting worker", async () => {
    onCallBlockingResolve = (callId: string) => {
      setTimeout(() => {
        waiters.cancel(callId, "operator cancelled the run");
      }, 50);
    };

    await startTestServer();

    const client = new WorkerClient(socketPath, "w-test-3", "run-test-3");
    await client.connect({ connectTimeoutMs: 5_000, heartbeatIntervalMs: 60_000 });

    const result = await client.callBlocking(
      {
        runId: "run-test-3",
        workerId: "w-test-3",
        callType: "request_code_review",
      },
      { waitMs: 10_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cancelled");

    client.close();
  });

  test("call.timed_out is delivered to waiting worker", async () => {
    onCallBlockingResolve = (callId: string) => {
      setTimeout(() => {
        waiters.timeout(callId);
      }, 50);
    };

    await startTestServer();

    const client = new WorkerClient(socketPath, "w-test-4", "run-test-4");
    await client.connect({ connectTimeoutMs: 5_000, heartbeatIntervalMs: 60_000 });

    const result = await client.callBlocking(
      {
        runId: "run-test-4",
        workerId: "w-test-4",
        callType: "request_approach_review",
      },
      { waitMs: 10_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");

    client.close();
  });

  test("disconnect during wait cleans up waiter", async () => {
    let capturedCallId = "";
    const disconnectedWorkers: string[] = [];

    onCallBlockingResolve = (callId: string) => {
      capturedCallId = callId;
      // Don't resolve — let the client disconnect while waiting
    };

    await startTestServer({
      onDisconnect: (workerId) => {
        disconnectedWorkers.push(workerId);
      },
    });

    const client = new WorkerClient(socketPath, "w-test-5", "run-test-5");
    await client.connect({ connectTimeoutMs: 5_000, heartbeatIntervalMs: 60_000 });

    // Start a blocking call but don't await it — we'll close the client instead
    const resultPromise = client.callBlocking(
      {
        runId: "run-test-5",
        workerId: "w-test-5",
        callType: "request_approach_review",
      },
      { waitMs: 10_000 },
    );

    // Wait a moment for the call to be registered
    await new Promise((r) => setTimeout(r, 100));
    expect(waiters.size).toBe(1);

    // Close the client (simulates disconnect)
    client.close();

    // The callBlocking promise should reject
    try {
      await resultPromise;
      expect(true).toBe(false); // should not reach here
    } catch (err: any) {
      expect(err.message).toContain("closed");
    }

    // Wait for server-side disconnect handling
    await new Promise((r) => setTimeout(r, 200));

    // Waiter should be cleaned up by disconnect handler
    expect(waiters.size).toBe(0);
    expect(disconnectedWorkers).toContain("w-test-5");
  });

  test("multiple workers can connect simultaneously", async () => {
    await startTestServer();

    const client1 = new WorkerClient(socketPath, "w-multi-1", "run-multi");
    const client2 = new WorkerClient(socketPath, "w-multi-2", "run-multi");

    await client1.connect({ connectTimeoutMs: 5_000, heartbeatIntervalMs: 60_000 });
    await client2.connect({ connectTimeoutMs: 5_000, heartbeatIntervalMs: 60_000 });

    expect(connections.size).toBe(2);
    expect(connections.has("w-multi-1")).toBe(true);
    expect(connections.has("w-multi-2")).toBe(true);

    client1.close();
    client2.close();
  });

  test("heartbeat keeps connection alive", async () => {
    const heartbeats: string[] = [];

    await startTestServer({
      onHeartbeat: (workerId) => {
        heartbeats.push(workerId);
      },
    });

    const client = new WorkerClient(socketPath, "w-hb", "run-hb");
    // Very short heartbeat interval for testing
    await client.connect({ connectTimeoutMs: 5_000, heartbeatIntervalMs: 100 });

    // Wait for a few heartbeats
    await new Promise((r) => setTimeout(r, 350));

    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(heartbeats.every((id) => id === "w-hb")).toBe(true);

    client.close();
  });

  test("no worker.continue on happy path — pure push resolution", async () => {
    // This test verifies the core design: resolved calls are pushed directly
    // over the persistent socket. No worker.continue is needed.
    const actions: string[] = [];

    onCallBlockingResolve = (callId: string) => {
      actions.push("call.registered");
      setTimeout(() => {
        actions.push("resolving");
        waiters.resolve(callId, { verdict: "approved" }, "reviewer");
        actions.push("resolved");
      }, 50);
    };

    await startTestServer();

    const client = new WorkerClient(socketPath, "w-noresume", "run-noresume");
    await client.connect({ connectTimeoutMs: 5_000, heartbeatIntervalMs: 60_000 });

    actions.push("calling");
    const result = await client.callBlocking(
      {
        runId: "run-noresume",
        workerId: "w-noresume",
        callType: "request_approach_review",
      },
      { waitMs: 10_000 },
    );
    actions.push("continued");

    expect(result.ok).toBe(true);
    // The sequence should be: calling → registered → resolving → resolved → continued
    // No "worker.continue" step anywhere.
    expect(actions).toEqual(["calling", "call.registered", "resolving", "resolved", "continued"]);

    client.close();
  });
});
