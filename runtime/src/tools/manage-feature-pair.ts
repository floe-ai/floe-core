import { z } from "zod";
import type { ProviderAdapter } from "../adapters/interface.ts";
import type { SessionRegistry } from "../registry.ts";
import { createLaunchWorkerHandler } from "./launch-worker.ts";

export const manageFeaturePairSchema = z.object({
  featureId: z.string(),
  epicId: z.string().optional(),
  releaseId: z.string().optional(),
  implementerProvider: z.enum(["codex", "claude", "copilot", "mock"]).default("mock"),
  reviewerProvider: z.enum(["codex", "claude", "copilot", "mock"]).default("mock"),
  projectRoot: z.string().optional(),
});

export function createManageFeaturePairHandler(
  adapters: Map<string, ProviderAdapter>,
  registry: SessionRegistry
) {
  const launch = createLaunchWorkerHandler(adapters, registry);
  return async (input: z.infer<typeof manageFeaturePairSchema>) => {
    const [implementer, reviewer] = await Promise.all([
      launch({ role: "implementer", provider: input.implementerProvider, featureId: input.featureId, epicId: input.epicId, releaseId: input.releaseId, projectRoot: input.projectRoot }),
      launch({ role: "reviewer", provider: input.reviewerProvider, featureId: input.featureId, epicId: input.epicId, releaseId: input.releaseId, projectRoot: input.projectRoot }),
    ]);

    return {
      ok: true,
      featureId: input.featureId,
      implementer: { sessionId: (implementer as any).sessionId, provider: input.implementerProvider },
      reviewer: { sessionId: (reviewer as any).sessionId, provider: input.reviewerProvider },
    };
  };
}
