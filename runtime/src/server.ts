#!/usr/bin/env bun
/**
 * floe-runtime — local MCP server for worker session management.
 *
 * Exposes 8 coarse tools for the foreman to manage Planner, Implementer,
 * and Reviewer worker sessions across provider backends.
 *
 * Start: bun run src/server.ts
 * Transport: stdio (standard for local MCP servers)
 *
 * Provider env vars:
 *   ANTHROPIC_API_KEY   — required for Claude adapter
 *   OPENAI_API_KEY      — optional for Codex (falls back to local sign-in)
 *   FLOE_PROVIDER       — default provider: codex|claude|copilot|mock (default: mock)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { SessionRegistry } from "./registry.ts";
import type { ProviderAdapter } from "./adapters/interface.ts";
import { MockAdapter } from "./adapters/mock.ts";

import {
  launchWorkerSchema,
  createLaunchWorkerHandler,
} from "./tools/launch-worker.ts";
import { resumeWorkerSchema, createResumeWorkerHandler } from "./tools/resume-worker.ts";
import { messageWorkerSchema, createMessageWorkerHandler } from "./tools/message-worker.ts";
import { getWorkerStatusSchema, createGetWorkerStatusHandler } from "./tools/get-worker-status.ts";
import { replaceWorkerSchema, createReplaceWorkerHandler } from "./tools/replace-worker.ts";
import { stopWorkerSchema, createStopWorkerHandler } from "./tools/stop-worker.ts";
import { listActiveWorkersSchema, createListActiveWorkersHandler } from "./tools/list-active-workers.ts";
import { manageFeaturePairSchema, createManageFeaturePairHandler } from "./tools/manage-feature-pair.ts";

// ─── Adapter registry ──────────────────────────────────────────────────────

const adapters = new Map<string, ProviderAdapter>();

// Mock adapter is always available
adapters.set("mock", new MockAdapter());

// Lazily load real adapters — they are peer dependencies
async function loadLiveAdapters(): Promise<void> {
  try {
    const { CodexAdapter } = await import("./adapters/codex.ts");
    adapters.set("codex", new CodexAdapter());
  } catch { /* Codex SDK not installed */ }

  try {
    const { ClaudeAdapter } = await import("./adapters/claude.ts");
    adapters.set("claude", new ClaudeAdapter());
  } catch { /* Claude Agent SDK not installed */ }

  try {
    const { CopilotAdapter } = await import("./adapters/copilot.ts");
    adapters.set("copilot", new CopilotAdapter());
  } catch { /* Copilot SDK not installed */ }
}

// ─── Registry ──────────────────────────────────────────────────────────────

const registry = new SessionRegistry();

// ─── Tool handlers ─────────────────────────────────────────────────────────

const launchWorker = createLaunchWorkerHandler(adapters, registry);
const resumeWorker = createResumeWorkerHandler(adapters, registry);
const messageWorker = createMessageWorkerHandler(adapters, registry);
const getWorkerStatus = createGetWorkerStatusHandler(adapters, registry);
const replaceWorker = createReplaceWorkerHandler(adapters, registry);
const stopWorker = createStopWorkerHandler(adapters, registry);
const listActiveWorkers = createListActiveWorkersHandler(registry);
const manageFeaturePair = createManageFeaturePairHandler(adapters, registry);

// ─── MCP server ────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "floe-runtime",
  version: "0.1.0",
});

server.tool(
  "launch_worker",
  "Launch a new worker session for a role and feature. Returns a session ID for subsequent calls.",
  launchWorkerSchema.shape,
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await launchWorker(input as any)) }],
  })
);

server.tool(
  "resume_worker",
  "Resume an existing worker session that was previously started.",
  resumeWorkerSchema.shape,
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await resumeWorker(input)) }],
  })
);

server.tool(
  "message_worker",
  "Send a message to an active worker session and get a response.",
  messageWorkerSchema.shape,
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await messageWorker(input as any)) }],
  })
);

server.tool(
  "get_worker_status",
  "Get the current lifecycle status of a worker session.",
  getWorkerStatusSchema.shape,
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await getWorkerStatus(input)) }],
  })
);

server.tool(
  "replace_worker",
  "Stop an existing worker and launch a fresh replacement for the same role and feature.",
  replaceWorkerSchema.shape,
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await replaceWorker(input)) }],
  })
);

server.tool(
  "stop_worker",
  "Stop an active worker session cleanly.",
  stopWorkerSchema.shape,
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await stopWorker(input)) }],
  })
);

server.tool(
  "list_active_workers",
  "List all currently active worker sessions. Optionally filter by feature ID.",
  listActiveWorkersSchema.shape,
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await listActiveWorkers(input)) }],
  })
);

server.tool(
  "manage_feature_pair",
  "Launch an implementer and reviewer worker pair for a feature in a single call.",
  manageFeaturePairSchema.shape,
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await manageFeaturePair(input as any)) }],
  })
);

// ─── Start ─────────────────────────────────────────────────────────────────

await loadLiveAdapters();

const transport = new StdioServerTransport();
await server.connect(transport);

// Signal readiness to stderr so callers can detect the server is up
process.stderr.write(JSON.stringify({ event: "ready", server: "floe-runtime", version: "0.1.0" }) + "\n");
