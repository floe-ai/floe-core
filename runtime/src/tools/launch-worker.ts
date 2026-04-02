import { z } from "zod";
import type { ProviderAdapter } from "../adapters/interface.ts";
import type { SessionRegistry } from "../registry.ts";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const launchWorkerSchema = z.object({
  role: z.enum(["planner", "implementer", "reviewer"]),
  provider: z.enum(["codex", "claude", "copilot", "mock"]),
  featureId: z.string(),
  epicId: z.string().optional(),
  releaseId: z.string().optional(),
  contextAddendum: z.string().optional(),
  projectRoot: z.string().optional(),
});

export type LaunchWorkerInput = z.infer<typeof launchWorkerSchema>;

function readRoleContent(role: string, projectRoot?: string): { content: string | undefined; path: string | undefined } {
  const bases = [
    projectRoot,
    process.cwd(),
    join(process.cwd(), ".."),
  ].filter(Boolean) as string[];

  for (const base of bases) {
    const candidatePaths = [
      join(base, "skills", "floe-exec", "roles", `${role}.md`),
      join(base, ".github", "skills", "floe-exec", "roles", `${role}.md`),
      join(base, ".agents", "skills", "floe-exec", "roles", `${role}.md`),
      join(base, ".claude", "skills", "floe-exec", "roles", `${role}.md`),
    ];
    for (const p of candidatePaths) {
      if (existsSync(p)) {
        return { content: readFileSync(p, "utf-8"), path: p };
      }
    }
  }
  return { content: undefined, path: undefined };
}

export function createLaunchWorkerHandler(
  adapters: Map<string, ProviderAdapter>,
  registry: SessionRegistry
) {
  return async (input: LaunchWorkerInput) => {
    const adapter = adapters.get(input.provider);
    if (!adapter) {
      return { ok: false, error: `No adapter registered for provider: ${input.provider}` };
    }

    const { content: roleContent, path: roleContentPath } = readRoleContent(input.role, input.projectRoot);

    const session = await adapter.startSession({
      role: input.role,
      provider: input.provider,
      featureId: input.featureId,
      epicId: input.epicId,
      releaseId: input.releaseId,
      roleContent,
      roleContentPath,
      contextAddendum: input.contextAddendum,
    });

    registry.register(session);

    return { ok: true, sessionId: session.id, role: session.role, provider: session.provider, status: session.status };
  };
}
