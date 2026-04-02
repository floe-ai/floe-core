import { z } from "zod";
import type { ProviderAdapter } from "../adapters/interface.ts";
import type { SessionRegistry } from "../registry.ts";

export const getWorkerStatusSchema = z.object({
  sessionId: z.string(),
});

export function createGetWorkerStatusHandler(
  adapters: Map<string, ProviderAdapter>,
  registry: SessionRegistry
) {
  return async (input: { sessionId: string }) => {
    const stored = registry.get(input.sessionId);
    if (!stored) return { ok: false, error: `Session not found: ${input.sessionId}` };

    const adapter = adapters.get(stored.provider);
    if (!adapter) return { ok: false, error: `No adapter for provider: ${stored.provider}` };

    const status = await adapter.getStatus(input.sessionId);
    return { ok: true, sessionId: input.sessionId, role: stored.role, provider: stored.provider, status, featureId: stored.featureId };
  };
}
