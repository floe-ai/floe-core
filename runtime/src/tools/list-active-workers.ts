import { z } from "zod";
import type { SessionRegistry } from "../registry.ts";

export const listActiveWorkersSchema = z.object({
  featureId: z.string().optional(),
});

export function createListActiveWorkersHandler(registry: SessionRegistry) {
  return async (input: { featureId?: string }) => {
    let sessions = registry.listActive();
    if (input.featureId) sessions = sessions.filter((s) => s.featureId === input.featureId);

    return {
      ok: true,
      count: sessions.length,
      workers: sessions.map((s) => ({
        id: s.id, role: s.role, provider: s.provider, status: s.status,
        featureId: s.featureId, createdAt: s.createdAt, lastMessageAt: s.lastMessageAt,
      })),
    };
  };
}
