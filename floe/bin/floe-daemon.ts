#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { DaemonService } from "../runtime/daemon/service.ts";
import { DaemonServer, type ListenTarget } from "../runtime/daemon/server.ts";

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

  const server = new DaemonServer(service, target);
  await server.listen();
}

main().catch((error: any) => {
  console.error(`Failed to start floe-daemon: ${error?.message ?? String(error)}`);
  process.exit(1);
});
