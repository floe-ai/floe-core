import { createConnection } from "node:net";
import type { DaemonRequest, DaemonResponse } from "./types.ts";

export interface DaemonClientOptions {
  timeoutMs?: number;
}

export async function sendDaemonRequest(
  endpoint: string,
  action: string,
  payload?: Record<string, unknown>,
  options?: DaemonClientOptions,
): Promise<DaemonResponse> {
  const timeoutMs = Math.max(100, options?.timeoutMs ?? 30_000);

  const request: DaemonRequest = {
    id: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    action,
    payload,
  };

  return new Promise<DaemonResponse>((resolve, reject) => {
    const socket = endpoint.startsWith("tcp://")
      ? (() => {
          const url = new URL(endpoint);
          const port = Number(url.port);
          if (!url.hostname || Number.isNaN(port)) {
            throw new Error(`Invalid TCP daemon endpoint: ${endpoint}`);
          }
          return createConnection({ host: url.hostname, port });
        })()
      : createConnection(endpoint);
    let done = false;
    let buffer = "";

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      try { socket.end(); } catch {}
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for daemon response after ${timeoutMs}ms`)));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;

      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);

      if (!line) {
        finish(() => reject(new Error("Empty daemon response")));
        return;
      }

      try {
        const response = JSON.parse(line) as DaemonResponse;
        finish(() => resolve(response));
      } catch (error: any) {
        finish(() => reject(new Error(`Invalid daemon response JSON: ${error?.message ?? String(error)}`)));
      }
    });

    socket.on("error", (error) => {
      finish(() => reject(error));
    });

    socket.on("end", () => {
      if (!done && buffer.trim()) {
        try {
          const response = JSON.parse(buffer.trim()) as DaemonResponse;
          finish(() => resolve(response));
        } catch {
          finish(() => reject(new Error("Daemon closed connection without valid JSON response")));
        }
      }
    });
  });
}
