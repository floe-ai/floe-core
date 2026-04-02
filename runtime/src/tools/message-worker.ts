import { z } from "zod";
import type { ProviderAdapter } from "../adapters/interface.ts";
import type { SessionRegistry } from "../registry.ts";

export const messageWorkerSchema = z.object({
  sessionId: z.string(),
  message: z.string(),
  stream: z.boolean().optional().default(false),
});

export function createMessageWorkerHandler(
  adapters: Map<string, ProviderAdapter>,
  registry: SessionRegistry
) {
  return async (input: { sessionId: string; message: string; stream?: boolean }) => {
    const stored = registry.get(input.sessionId);
    if (!stored) return { ok: false, error: `Session not found: ${input.sessionId}` };

    const adapter = adapters.get(stored.provider);
    if (!adapter) return { ok: false, error: `No adapter for provider: ${stored.provider}` };

    const result = await adapter.sendMessage(input.sessionId, input.message);
    registry.update(input.sessionId, { lastMessageAt: new Date().toISOString() });

    return { ok: true, sessionId: input.sessionId, content: result.content, finishReason: result.finishReason };
  };
}
