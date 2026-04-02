import { z } from "zod";
import type { ProviderAdapter } from "../adapters/interface.ts";
import type { SessionRegistry } from "../registry.ts";

export const stopWorkerSchema = z.object({
  sessionId: z.string(),
});

export function createStopWorkerHandler(
  adapters: Map<string, ProviderAdapter>,
  registry: SessionRegistry
) {
  return async (input: { sessionId: string }) => {
    const stored = registry.get(input.sessionId);
    if (!stored) return { ok: false, error: `Session not found: ${input.sessionId}` };

    const adapter = adapters.get(stored.provider);
    if (adapter) {
      await adapter.stopSession(input.sessionId).catch(() => {});
      await adapter.closeSession(input.sessionId).catch(() => {});
    }
    registry.setStatus(input.sessionId, "stopped");

    return { ok: true, sessionId: input.sessionId, stopped: true };
  };
}
