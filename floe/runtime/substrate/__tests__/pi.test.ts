import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { PiSubstrate, detectModelFamily } from "../pi.ts";
import type { WorkerConfig } from "../../types.ts";

// ── Model detection ───────────────────────────────────────────────────

describe("detectModelFamily", () => {
  test("claude models → anthropic", () => {
    expect(detectModelFamily("claude-sonnet-4-20250514")).toBe("anthropic");
    expect(detectModelFamily("claude-3-opus-20240229")).toBe("anthropic");
    expect(detectModelFamily("claude-haiku-4.5")).toBe("anthropic");
    expect(detectModelFamily("Claude-Sonnet-4")).toBe("anthropic");
  });

  test("anthropic/ prefixed models → anthropic", () => {
    expect(detectModelFamily("anthropic/claude-sonnet-4")).toBe("anthropic");
  });

  test("gpt/o models → openai", () => {
    expect(detectModelFamily("gpt-4o")).toBe("openai");
    expect(detectModelFamily("gpt-4-turbo")).toBe("openai");
    expect(detectModelFamily("o3-mini")).toBe("openai");
    expect(detectModelFamily("o1-preview")).toBe("openai");
  });

  test("unknown models → openai (default)", () => {
    expect(detectModelFamily("llama-3-70b")).toBe("openai");
    expect(detectModelFamily("mistral-large")).toBe("openai");
  });
});

// ── PiSubstrate lifecycle ─────────────────────────────────────────────

describe("PiSubstrate", () => {
  let substrate: PiSubstrate;

  beforeEach(() => {
    substrate = new PiSubstrate();
  });

  const baseConfig: WorkerConfig = {
    role: "implementer",
    featureId: "feat-001",
    model: "claude-sonnet-4-20250514",
    roleContent: "You are a test agent.",
  };

  describe("session lifecycle", () => {
    test("startSession creates a session with correct properties", async () => {
      const session = await substrate.startSession(baseConfig);

      expect(session.id).toMatch(/^implementer-/);
      expect(session.role).toBe("implementer");
      expect(session.status).toBe("active");
      expect(session.featureId).toBe("feat-001");
      expect(session.metadata?.model).toBe("claude-sonnet-4-20250514");
      expect(session.metadata?.family).toBe("anthropic");
      expect(session.createdAt).toBeTruthy();
    });

    test("startSession throws when no model configured", async () => {
      const noModelConfig: WorkerConfig = {
        role: "planner",
        featureId: "feat-001",
      };
      await expect(substrate.startSession(noModelConfig)).rejects.toThrow(
        /No model configured/,
      );
    });

    test("hasSession returns true for active sessions", async () => {
      const session = await substrate.startSession(baseConfig);
      expect(substrate.hasSession(session.id)).toBe(true);
      expect(substrate.hasSession("nonexistent-123")).toBe(false);
    });

    test("getSession returns session data", async () => {
      const session = await substrate.startSession(baseConfig);
      const retrieved = substrate.getSession(session.id);
      expect(retrieved?.id).toBe(session.id);
      expect(retrieved?.role).toBe("implementer");
    });

    test("getSession returns undefined for unknown session", () => {
      expect(substrate.getSession("nonexistent")).toBeUndefined();
    });

    test("getStatus returns correct status", async () => {
      const session = await substrate.startSession(baseConfig);
      expect(await substrate.getStatus(session.id)).toBe("active");
    });

    test("getStatus returns stopped for unknown sessions", async () => {
      expect(await substrate.getStatus("nonexistent")).toBe("stopped");
    });

    test("stopSession marks session as stopped", async () => {
      const session = await substrate.startSession(baseConfig);
      await substrate.stopSession(session.id);
      expect(await substrate.getStatus(session.id)).toBe("stopped");
      expect(substrate.getSession(session.id)?.stoppedAt).toBeTruthy();
    });

    test("closeSession removes session entirely", async () => {
      const session = await substrate.startSession(baseConfig);
      await substrate.closeSession(session.id);
      expect(substrate.hasSession(session.id)).toBe(false);
      expect(substrate.getSession(session.id)).toBeUndefined();
    });

    test("multiple sessions coexist independently", async () => {
      const s1 = await substrate.startSession({ ...baseConfig, role: "planner" });
      const s2 = await substrate.startSession({ ...baseConfig, role: "reviewer" });

      expect(s1.id).not.toBe(s2.id);
      expect(substrate.hasSession(s1.id)).toBe(true);
      expect(substrate.hasSession(s2.id)).toBe(true);

      await substrate.closeSession(s1.id);
      expect(substrate.hasSession(s1.id)).toBe(false);
      expect(substrate.hasSession(s2.id)).toBe(true);
    });
  });

  describe("resumeSession", () => {
    test("resumes from stored session data", async () => {
      const session = await substrate.startSession(baseConfig);
      const storedSession = substrate.getSession(session.id)!;

      await substrate.closeSession(session.id);
      expect(substrate.hasSession(session.id)).toBe(false);

      const resumed = await substrate.resumeSession(session.id, storedSession);
      expect(substrate.hasSession(session.id)).toBe(true);
      expect(resumed.status).toBe("active");
      expect(resumed.metadata?.resumed).toBe(true);
    });

    test("resume returns existing session if already in memory", async () => {
      const session = await substrate.startSession(baseConfig);
      const resumed = await substrate.resumeSession(session.id, session);
      expect(resumed.id).toBe(session.id);
    });

    test("resume throws when no model available", async () => {
      const noModelSession = {
        id: "test-123",
        role: "implementer" as const,
        status: "stopped" as const,
        featureId: "feat-001",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await expect(
        substrate.resumeSession("test-123", noModelSession),
      ).rejects.toThrow(/no model available/);
    });
  });

  describe("sendMessage", () => {
    test("throws for unknown session", async () => {
      await expect(
        substrate.sendMessage("nonexistent", "hello"),
      ).rejects.toThrow(/Session not found/);
    });

    test("sendMessage calls Anthropic API for claude models", async () => {
      // Set up mock environment
      const origKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "test-key-123";

      const session = await substrate.startSession(baseConfig);

      // Mock fetch globally
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "Hello from Claude!" }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "end_turn",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as any;

      try {
        const result = await substrate.sendMessage(session.id, "test message");

        expect(result.sessionId).toBe(session.id);
        expect(result.content).toBe("Hello from Claude!");
        expect(result.usage?.inputTokens).toBe(10);
        expect(result.usage?.outputTokens).toBe(5);
        expect(result.finishReason).toBe("end_turn");

        // Session should be idle after successful message
        expect(await substrate.getStatus(session.id)).toBe("idle");

        // Verify fetch was called with correct URL
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        const callArgs = (globalThis.fetch as any).mock.calls[0];
        expect(callArgs[0]).toContain("/v1/messages");
      } finally {
        globalThis.fetch = originalFetch;
        if (origKey !== undefined) {
          process.env.ANTHROPIC_API_KEY = origKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
      }
    });

    test("sendMessage calls OpenAI API for gpt models", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key-456";

      const openaiConfig: WorkerConfig = {
        ...baseConfig,
        model: "gpt-4o",
      };
      const session = await substrate.startSession(openaiConfig);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "Hello from GPT!" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 15, completion_tokens: 8 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as any;

      try {
        const result = await substrate.sendMessage(session.id, "test message");

        expect(result.content).toBe("Hello from GPT!");
        expect(result.usage?.inputTokens).toBe(15);
        expect(result.usage?.outputTokens).toBe(8);
        expect(result.finishReason).toBe("stop");

        const callArgs = (globalThis.fetch as any).mock.calls[0];
        expect(callArgs[0]).toContain("/v1/chat/completions");
      } finally {
        globalThis.fetch = originalFetch;
        if (origKey !== undefined) {
          process.env.OPENAI_API_KEY = origKey;
        } else {
          delete process.env.OPENAI_API_KEY;
        }
      }
    });

    test("sendMessage accumulates conversation history", async () => {
      const origKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "test-key-789";

      const session = await substrate.startSession(baseConfig);

      let callCount = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (_url: any, opts: any) => {
        callCount++;
        const body = JSON.parse(opts.body);
        // Verify conversation history grows
        if (callCount === 2) {
          // Second call should have user + assistant + user messages
          expect(body.messages.length).toBe(3);
        }
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: `Response ${callCount}` }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "end_turn",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as any;

      try {
        const r1 = await substrate.sendMessage(session.id, "first message");
        expect(r1.content).toBe("Response 1");

        const r2 = await substrate.sendMessage(session.id, "second message");
        expect(r2.content).toBe("Response 2");
        expect(callCount).toBe(2);
      } finally {
        globalThis.fetch = originalFetch;
        if (origKey !== undefined) {
          process.env.ANTHROPIC_API_KEY = origKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
      }
    });

    test("sendMessage sets session to failed on API error", async () => {
      const origKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "test-key-err";

      const session = await substrate.startSession(baseConfig);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response("Internal Server Error", { status: 500 });
      }) as any;

      try {
        await expect(
          substrate.sendMessage(session.id, "test"),
        ).rejects.toThrow(/Anthropic API error 500/);

        expect(await substrate.getStatus(session.id)).toBe("failed");
        expect(substrate.getSession(session.id)?.error).toContain("500");
      } finally {
        globalThis.fetch = originalFetch;
        if (origKey !== undefined) {
          process.env.ANTHROPIC_API_KEY = origKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
      }
    });

    test("sendMessage throws when API key is missing", async () => {
      const origKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      const session = await substrate.startSession(baseConfig);

      try {
        await expect(
          substrate.sendMessage(session.id, "test"),
        ).rejects.toThrow(/ANTHROPIC_API_KEY not set/);
      } finally {
        if (origKey !== undefined) {
          process.env.ANTHROPIC_API_KEY = origKey;
        }
      }
    });
  });

  describe("system prompt construction", () => {
    test("combines roleContent and contextAddendum", async () => {
      const origKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "test-key-sys";

      const config: WorkerConfig = {
        ...baseConfig,
        roleContent: "You are the implementer.",
        contextAddendum: "Source root: src/",
      };

      const session = await substrate.startSession(config);

      let capturedSystem: string | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (_url: any, opts: any) => {
        const body = JSON.parse(opts.body);
        capturedSystem = body.system;
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "end_turn",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as any;

      try {
        await substrate.sendMessage(session.id, "test");
        expect(capturedSystem).toContain("You are the implementer.");
        expect(capturedSystem).toContain("Source root: src/");
      } finally {
        globalThis.fetch = originalFetch;
        if (origKey !== undefined) {
          process.env.ANTHROPIC_API_KEY = origKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
      }
    });
  });

  describe("thinking support", () => {
    test("Anthropic thinking is enabled when configured", async () => {
      const origKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "test-key-think";

      const config: WorkerConfig = {
        ...baseConfig,
        thinking: "high",
      };

      const session = await substrate.startSession(config);

      let capturedBody: any;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (_url: any, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "thought about it" }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "end_turn",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as any;

      try {
        await substrate.sendMessage(session.id, "think hard");
        expect(capturedBody.thinking).toEqual({
          type: "enabled",
          budget_tokens: 32000,
        });
      } finally {
        globalThis.fetch = originalFetch;
        if (origKey !== undefined) {
          process.env.ANTHROPIC_API_KEY = origKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
      }
    });
  });
});
