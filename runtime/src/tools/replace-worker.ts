import { z } from "zod";
import type { ProviderAdapter } from "../adapters/interface.ts";
import type { SessionRegistry } from "../registry.ts";
import { createLaunchWorkerHandler } from "./launch-worker.ts";

export const replaceWorkerSchema = z.object({
  sessionId: z.string(),
  reason: z.string().optional(),
  projectRoot: z.string().optional(),
});

export function createReplaceWorkerHandler(
  adapters: Map<string, ProviderAdapter>,
  registry: SessionRegistry
) {
  const launch = createLaunchWorkerHandler(adapters, registry);
  return async (input: { sessionId: string; reason?: string; projectRoot?: string }) => {
    const stored = registry.get(input.sessionId);
    if (!stored) return { ok: false, error: `Session not found: ${input.sessionId}` };

    const adapter = adapters.get(stored.provider);
    if (adapter) {
      await adapter.stopSession(input.sessionId).catch(() => {});
      await adapter.closeSession(input.sessionId).catch(() => {});
    }
    registry.setStatus(input.sessionId, "stopped");

    const newSession = await launch({
      role: stored.role as any,
      provider: stored.provider as any,
      featureId: stored.featureId,
      epicId: stored.epicId,
      releaseId: stored.releaseId,
      projectRoot: input.projectRoot,
    });

    return { ok: true, replacedSessionId: input.sessionId, newSessionId: (newSession as any).sessionId, reason: input.reason };
  };
}
