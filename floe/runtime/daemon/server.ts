import { unlinkSync, existsSync, chmodSync } from "node:fs";
import { createServer } from "node:net";

import { DaemonService } from "./service.ts";
import type { DaemonRequest, DaemonResponse } from "./types.ts";

export type ListenTarget =
  | { transport: "unix"; socketPath: string }
  | { transport: "tcp"; host: string; port: number };

export class DaemonServer {
  private readonly service: DaemonService;
  private readonly target: ListenTarget;

  constructor(service: DaemonService, target: ListenTarget) {
    this.service = service;
    this.target = target;
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

      connection.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.handleLine(trimmed)
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

  private async handleLine(line: string): Promise<DaemonResponse & { shutdownRequested?: boolean }> {
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
