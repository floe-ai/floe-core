#!/usr/bin/env bun
/**
 * Floe daemon entry point — starts the daemon as a standalone Bun process.
 *
 * Usage: bun run daemon/main.ts <project-root> <socket-path>
 *
 * The daemon runs in the foreground. The parent process (bin/floe) is
 * responsible for backgrounding it and passing the correct arguments.
 */

import { DaemonService } from "./service.ts";
import { DaemonServer } from "./server.ts";
import { PiSubstrate } from "./pi-substrate.ts";
import { WaiterRegistry, WorkerConnectionRegistry } from "./worker-channel.ts";

const projectRoot = process.argv[2];
const socketPath = process.argv[3];

if (!projectRoot || !socketPath) {
  console.error("Usage: bun run daemon/main.ts <project-root> <socket-path>");
  process.exit(1);
}

const service = new DaemonService(projectRoot, socketPath);
const piSubstrate = new PiSubstrate();
service.setSubstrate(piSubstrate);
await service.init();

const waiters = new WaiterRegistry();
const workerConnections = new WorkerConnectionRegistry();
service.setWaiterRegistry(waiters);

const channelCallbacks = {
  onHello(workerId: string, runId: string | undefined, _socket: any) {
    const worker = service.getWorkerRecord(workerId);
    return {
      workerId,
      status: worker ? ("ok" as const) : ("unknown_worker" as const),
    };
  },
  async onCallBlocking(payload: any, _requestId: string, _socket: any) {
    const result = await service.handle({
      id: `daemon-${Date.now().toString(36)}`,
      action: "call.blocking",
      payload,
    });
    return (result.result as any)?.call?.callId ?? "unknown";
  },
  onHeartbeat(workerId: string) {
    service.workerHeartbeat(workerId);
  },
  onDisconnect(workerId: string, _socket: any) {
    service.workerDisconnected(workerId, []);
  },
};

const server = new DaemonServer(
  service,
  { transport: "unix", socketPath },
  waiters,
  workerConnections,
  channelCallbacks,
);

await server.listen();

// Signal readiness to parent process
console.log(`FLOE_DAEMON_READY ${socketPath}`);

// Keep alive — handle shutdown signals
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
