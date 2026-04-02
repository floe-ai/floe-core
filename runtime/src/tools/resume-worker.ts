import { z } from "zod";
import type { ProviderAdapter } from "../adapters/interface.ts";
import type { SessionRegistry } from "../registry.ts";

export const resumeWorkerSchema = z.object({
  sessionId: z.string(),
});

export function createResumeWorkerHandler(
  adapters: Map<string, ProviderAdapter>,
  registry: SessionRegistry
) {
  return async (input: { sessionId: string }) => {
    const stored = registry.get(input.sessionId);
    if (!stored) return { ok: false, error: `Session not found: ${input.sessionId}` };

    const adapter = adapters.get(stored.provider);
    if (!adapter) return { ok: false, error: `No adapter for provider: ${stored.provider}` };

    const session = await adapter.resumeSession(input.sessionId);
    registry.update(input.sessionId, { status: session.status });

    return { ok: true, sessionId: session.id, status: session.status };
  };
}
