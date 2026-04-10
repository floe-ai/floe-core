#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { DaemonService } from "../runtime/daemon/service.ts";
import { DaemonServer, type ListenTarget } from "../runtime/daemon/server.ts";
import { WaiterRegistry, WorkerConnectionRegistry } from "../runtime/daemon/worker-channel.ts";
import type { WorkerChannelCallbacks, } from "../runtime/daemon/worker-channel.ts";

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if ([".git", ".floe", ".github", ".agents", ".claude"].some(marker => existsSync(join(dir, marker)))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const { values: opts } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    socket: { type: "string" },
    project: { type: "string" },
    "tcp-host": { type: "string" },
    "tcp-port": { type: "string" },
  },
  strict: false,
});

const projectRoot = (opts.project as string | undefined) ?? findProjectRoot();
const daemonDir = join(projectRoot, ".floe", "state", "daemon");
mkdirSync(daemonDir, { recursive: true });

const socketPath = (opts.socket as string | undefined) ?? join(daemonDir, "floe-daemon.sock");
const tcpHost = (opts["tcp-host"] as string | undefined) ?? "127.0.0.1";
const tcpPort = opts["tcp-port"] !== undefined ? Number(opts["tcp-port"]) : null;

async function main(): Promise<void> {
  let target: ListenTarget;
  let endpointLabel: string;

  if (tcpPort !== null) {
    if (Number.isNaN(tcpPort) || tcpPort <= 0 || tcpPort > 65535) {
      throw new Error(`Invalid --tcp-port value: ${opts["tcp-port"]}`);
    }
    target = { transport: "tcp", host: tcpHost, port: tcpPort };
    endpointLabel = `tcp://${tcpHost}:${tcpPort}`;
  } else {
    target = { transport: "unix", socketPath };
    endpointLabel = socketPath;
  }

  const service = new DaemonService(projectRoot, endpointLabel);
  await service.init();

  const waiters = new WaiterRegistry();
  const workerConnections = new WorkerConnectionRegistry();

  // Wire the WaiterRegistry into the service so callResolve can push inline.
  service.setWaiterRegistry(waiters);

  const channelCallbacks: WorkerChannelCallbacks = {
    onHello(workerId, runId, socket) {
      // Validate worker exists in store
      try {
        const worker = service.getWorkerRecord(workerId);
        return { workerId, status: "ok" };
      } catch {
        return { workerId, status: "unknown_worker" };
      }
    },
    async onCallBlocking(payload, requestId, socket) {
      // Delegate to daemon service — registers call, emits events, returns callId.
      const result = await service.handle({
        id: requestId,
        action: "call.blocking",
        payload: payload as unknown as Record<string, unknown>,
      });
      if (!result.ok || !result.result) {
        throw new Error(result.error ?? "call.blocking failed");
      }
      return (result.result as any).call?.callId as string;
    },
    onHeartbeat(workerId) {
      // Update last heartbeat in worker runtime record
      service.workerHeartbeat(workerId);
    },
    onDisconnect(workerId, socket) {
      // Clean up waiters for this connection — calls become undeliverable
      const orphanedCallIds = waiters.removeByConnection(socket);
      service.workerDisconnected(workerId, orphanedCallIds);
    },
  };

  const server = new DaemonServer(service, target, waiters, workerConnections, channelCallbacks);
  await server.listen();
}

main().catch((error: any) => {
  console.error(`Failed to start floe-daemon: ${error?.message ?? String(error)}`);
  process.exit(1);
});
