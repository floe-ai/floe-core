import { unlinkSync, existsSync, chmodSync } from "node:fs";
import { createServer, type Socket } from "node:net";

import { DaemonService } from "./service.ts";
import type { DaemonRequest, DaemonResponse, WorkerChannelMessage } from "./types.ts";
import { handleWorkerConnection, type WorkerChannelCallbacks, type WaiterRegistry, type WorkerConnectionRegistry } from "./worker-channel.ts";

export type ListenTarget =
  | { transport: "unix"; socketPath: string }
  | { transport: "tcp"; host: string; port: number };

export class DaemonServer {
  private readonly service: DaemonService;
  private readonly target: ListenTarget;
  private readonly waiters: WaiterRegistry;
  private readonly workerConnections: WorkerConnectionRegistry;
  private readonly channelCallbacks: WorkerChannelCallbacks;

  constructor(
    service: DaemonService,
    target: ListenTarget,
    waiters: WaiterRegistry,
    workerConnections: WorkerConnectionRegistry,
    channelCallbacks: WorkerChannelCallbacks,
  ) {
    this.service = service;
    this.target = target;
    this.waiters = waiters;
    this.workerConnections = workerConnections;
    this.channelCallbacks = channelCallbacks;
  }

  async listen(): Promise<void> {
    if (this.target.transport === "unix" && existsSync(this.target.socketPath)) {
      try {
        unlinkSync(this.target.socketPath);
      } catch {
        // will fail on bind if stale file cannot be removed
      }
    }

    const server = createServer((connection) => {
      let buffer = "";
      let handedOff = false;

      connection.on("data", (chunk) => {
        if (handedOff) return; // persistent handler takes over

        buffer += chunk.toString("utf-8");
        const nlIdx = buffer.indexOf("\n");
        if (nlIdx === -1) return; // wait for complete first line

        const firstLine = buffer.slice(0, nlIdx).trim();
        const remainder = buffer.slice(nlIdx + 1);

        if (!firstLine) {
          buffer = remainder;
          return;
        }

        // Detect connection type from first message.
        // Worker channel messages have a `type` field (e.g. "worker.hello").
        // One-shot CLI requests have `id` + `action` fields.
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(firstLine);
        } catch {
          // Invalid JSON — treat as one-shot and report error
          const fallback: DaemonResponse = { id: "unknown", ok: false, error: "Invalid JSON" };
          connection.write(JSON.stringify(fallback) + "\n");
          connection.end();
          return;
        }

        if (parsed.type === "worker.hello") {
          // Persistent worker connection — hand off to worker channel handler.
          handedOff = true;
          connection.removeAllListeners("data");

          handleWorkerConnection(
            connection,
            this.channelCallbacks,
            this.workerConnections,
            this.waiters,
          );

          // Re-feed the first message and any remainder into the persistent handler's
          // data listener by re-emitting. The handler installs its own `data` listener
          // in handleWorkerConnection, so we emit after a microtick to ensure it's ready.
          queueMicrotask(() => {
            connection.emit("data", Buffer.from(firstLine + "\n" + remainder));
          });
          return;
        }

        // One-shot CLI request — original behaviour.
        this.handleOneShotLine(firstLine, connection, server);

        // Process any remaining complete lines in the buffer
        const remainingLines = remainder.split("\n");
        buffer = remainingLines.pop() ?? "";
        for (const line of remainingLines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.handleOneShotLine(trimmed, connection, server);
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if (this.target.transport === "unix") {
        server.listen(this.target.socketPath, () => {
          try { chmodSync(this.target.socketPath, 0o600); } catch {}
          resolve();
        });
        return;
      }

      server.listen(this.target.port, this.target.host, () => {
        resolve();
      });
    });
  }

  private handleOneShotLine(line: string, connection: Socket, server: ReturnType<typeof createServer>): void {
    this.parseAndHandle(line)
      .then((response) => {
        connection.write(JSON.stringify(response) + "\n");
        connection.end();
        if ((response as any).shutdownRequested) {
          setTimeout(() => {
            server.close(() => process.exit(0));
          }, 50);
        }
      })
      .catch((error: any) => {
        const fallback: DaemonResponse = {
          id: "unknown",
          ok: false,
          error: error?.message ?? String(error),
        };
        connection.write(JSON.stringify(fallback) + "\n");
        connection.end();
      });
  }

  private async parseAndHandle(line: string): Promise<DaemonResponse & { shutdownRequested?: boolean }> {
    let request: DaemonRequest;

    try {
      request = JSON.parse(line) as DaemonRequest;
    } catch {
      return {
        id: "unknown",
        ok: false,
        error: "Invalid daemon request JSON",
      };
    }

    if (!request.id || !request.action) {
      return {
        id: request.id ?? "unknown",
        ok: false,
        error: "Request requires id and action",
      };
    }

    const result = await this.service.handle(request);
    return {
      id: request.id,
      ok: result.ok,
      result: result.result,
      error: result.error,
      shutdownRequested: result.shutdown,
    };
  }
}
