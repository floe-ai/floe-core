import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
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

    // Re-read role content so adapters that need to reconnect (e.g. Copilot) can
    // restore the original system prompt without storing it in the registry.
    let roleContent: string | undefined;
    if (stored.roleContentPath && existsSync(stored.roleContentPath)) {
      try {
        roleContent = readFileSync(stored.roleContentPath, "utf-8");
      } catch {
        // Non-fatal: adapter will proceed without role content
      }
    }

    const session = await adapter.resumeSession(
      input.sessionId,
      stored,
      roleContent ? { roleContent } : undefined
    );

    registry.update(input.sessionId, { status: session.status, updatedAt: session.updatedAt });

    return { ok: true, sessionId: session.id, status: session.status };
  };
}
