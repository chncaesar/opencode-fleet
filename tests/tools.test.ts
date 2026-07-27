/**
 * tests/tools.test.ts
 *
 * Unit tests for handleSendMessage (async/fire-and-forget semantics):
 *   - dispatched path: returns ok() with session ID and next-step instructions
 *   - error path: returns err() when sendAsync throws
 *   - validation: missing node / prompt / unknown node
 *   - options forwarding: agent, model, cwd, reasoning_effort
 */

import { describe, it, expect, vi } from "vitest";
import { handleSendMessage, dispatchTool } from "../src/tools.js";
import type { FleetContext } from "../src/tools.js";
import type { AsyncSendResult } from "../src/session.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const SESSION_ID = "ses_abc123";
const NODE_NAME = "ubuntu";

/** Build a minimal FleetContext with a mocked sendAsync(). */
function makeCtx(sendAsyncResult: AsyncSendResult | Error): FleetContext {
  return {
    nodes: new Map([
      [
        NODE_NAME,
        // OpenCodeNode only needs to exist in the map; sendAsync() is on SessionManager
        {} as ReturnType<typeof import("../src/node.js").OpenCodeNode.prototype.constructor>,
      ],
    ]),
    sessions: {
      sendAsync:
        sendAsyncResult instanceof Error
          ? vi.fn().mockRejectedValue(sendAsyncResult)
          : vi.fn().mockResolvedValue(sendAsyncResult),
      getSessionId: vi.fn().mockReturnValue(SESSION_ID),
    } as unknown as import("../src/session.js").SessionManager,
    config: {
      nodes: [],
      username: "opencode",
      password: "pw",
      timeoutSeconds: 600,
    },
  };
}

const BASE_ARGS = { node: NODE_NAME, prompt: "build the project" };

// ── Dispatched path ────────────────────────────────────────────────────────────

describe("handleSendMessage — dispatched path", () => {
  it("returns ok with dispatched status and session ID", async () => {
    const ctx = makeCtx({ sessionId: SESSION_ID, nodeStatus: "dispatched" });

    const result = await handleSendMessage(ctx, BASE_ARGS);

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join("");
    expect(text).toContain("dispatched");
    expect(text).toContain(SESSION_ID);
    expect(text).toContain(NODE_NAME);
  });

  it("response includes next-step instructions for polling", async () => {
    const ctx = makeCtx({ sessionId: SESSION_ID, nodeStatus: "dispatched" });

    const result = await handleSendMessage(ctx, BASE_ARGS);
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join("");

    expect(text).toContain("fleet_get_session_status");
    expect(text).toContain("fleet_get_session_messages");
  });
});

// ── Error path ─────────────────────────────────────────────────────────────────

describe("handleSendMessage — error path", () => {
  it("returns err when sendAsync throws", async () => {
    const ctx = makeCtx(new Error("connection refused"));

    const result = await handleSendMessage(ctx, BASE_ARGS);

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join("");
    expect(text).toContain("connection refused");
  });
});

// ── Validation ─────────────────────────────────────────────────────────────────

describe("handleSendMessage — argument validation", () => {
  it("returns err when node argument is missing", async () => {
    const ctx = makeCtx({ sessionId: SESSION_ID, nodeStatus: "dispatched" });

    const result = await handleSendMessage(ctx, { prompt: "hello" });
    expect(result.isError).toBe(true);
  });

  it("returns err when node is unknown", async () => {
    const ctx = makeCtx({ sessionId: SESSION_ID, nodeStatus: "dispatched" });

    const result = await handleSendMessage(ctx, {
      node: "nonexistent",
      prompt: "hello",
    });
    expect(result.isError).toBe(true);
  });

  it("returns err when prompt argument is missing", async () => {
    const ctx = makeCtx({ sessionId: SESSION_ID, nodeStatus: "dispatched" });

    const result = await handleSendMessage(ctx, { node: NODE_NAME });
    expect(result.isError).toBe(true);
  });
});

// ── Options forwarding ─────────────────────────────────────────────────────────

describe("handleSendMessage — options forwarding", () => {
  it("passes agent, model, cwd, reasoning_effort to sendAsync", async () => {
    const mockSendAsync = vi.fn().mockResolvedValue({ sessionId: SESSION_ID, nodeStatus: "dispatched" });
    const ctx: FleetContext = {
      nodes: new Map([[NODE_NAME, {} as ReturnType<typeof import("../src/node.js").OpenCodeNode.prototype.constructor>]]),
      sessions: {
        sendAsync: mockSendAsync,
        getSessionId: vi.fn().mockReturnValue(SESSION_ID),
      } as unknown as import("../src/session.js").SessionManager,
      config: { nodes: [], username: "opencode", password: "pw", timeoutSeconds: 600 },
    };

    await dispatchTool(ctx, "fleet_send_message", {
      node: NODE_NAME,
      prompt: "do work",
      cwd: "/work/project",
      agent: "plan",
      model: "anthropic/claude-opus-4",
      reasoning_effort: "high",
    });

    expect(mockSendAsync).toHaveBeenCalledWith(
      expect.anything(),
      "do work",
      {
        cwd: "/work/project",
        agent: "plan",
        model: "anthropic/claude-opus-4",
        reasoningEffort: "high",
      }
    );
  });
});
