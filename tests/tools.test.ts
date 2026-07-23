/**
 * tests/tools.test.ts
 *
 * Unit tests for handleSendMessage:
 *   - timeout path: returns ok() with diagnostic guidance (NOT err/isError:true)
 *   - completed path: returns ok() with reply
 *   - error path: returns err() when hasError
 *   - validation: missing node / prompt
 */

import { describe, it, expect, vi } from "vitest";
import { handleSendMessage } from "../src/tools.js";
import type { FleetContext } from "../src/tools.js";
import type { SendResult } from "../src/session.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const SESSION_ID = "ses_abc123";
const NODE_NAME = "ubuntu";

/** Build a minimal FleetContext with a mocked send(). */
function makeCtx(sendResult: SendResult): FleetContext {
  return {
    nodes: new Map([
      [
        NODE_NAME,
        // OpenCodeNode only needs to exist in the map; send() is on SessionManager
        {} as ReturnType<typeof import("../src/node.js").OpenCodeNode.prototype.constructor>,
      ],
    ]),
    sessions: {
      send: vi.fn().mockResolvedValue(sendResult),
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

// ── Timeout path ───────────────────────────────────────────────────────────────

describe("handleSendMessage — timeout path", () => {
  it("returns ok (NOT error) when send() times out", async () => {
    const ctx = makeCtx({
      timedOut: true,
      reply: "[Agent is busy — tool: bash ⟳ make -j4]",
      hasError: false,
      messages: [],
    });

    const result = await handleSendMessage(ctx, BASE_ARGS);

    // Must NOT be an error — master should not panic-reset
    expect(result.isError).toBeFalsy();
    expect(result.content).toBeDefined();
  });

  it("timeout response contains TIMEOUT keyword and node name", async () => {
    const ctx = makeCtx({
      timedOut: true,
      reply: "(no text yet)",
      hasError: false,
      messages: [],
    });

    const result = await handleSendMessage(ctx, BASE_ARGS);
    const text =
      typeof result.content === "string"
        ? result.content
        : (result.content as Array<{ text: string }>)
            .map((c) => c.text)
            .join("");

    expect(text).toContain("TIMEOUT");
    expect(text).toContain(NODE_NAME);
  });

  it("timeout response includes recommended next steps mentioning fleet_get_session_status", async () => {
    const ctx = makeCtx({
      timedOut: true,
      reply: "",
      hasError: false,
      messages: [],
    });

    const result = await handleSendMessage(ctx, BASE_ARGS);
    const text =
      typeof result.content === "string"
        ? result.content
        : (result.content as Array<{ text: string }>)
            .map((c) => c.text)
            .join("");

    expect(text).toContain("fleet_get_session_status");
    expect(text).toContain("fleet_reset_session");
  });

  it("timeout response includes partial output from the agent", async () => {
    const partialOutput = "Running cmake step 3 of 7...";
    const ctx = makeCtx({
      timedOut: true,
      reply: partialOutput,
      hasError: false,
      messages: [],
    });

    const result = await handleSendMessage(ctx, BASE_ARGS);
    const text =
      typeof result.content === "string"
        ? result.content
        : (result.content as Array<{ text: string }>)
            .map((c) => c.text)
            .join("");

    expect(text).toContain(partialOutput);
  });
});

// ── Completed path ─────────────────────────────────────────────────────────────

describe("handleSendMessage — completed path", () => {
  it("returns ok with reply when completed successfully", async () => {
    const ctx = makeCtx({
      timedOut: false,
      reply: "Build succeeded.",
      hasError: false,
      messages: [],
    });

    const result = await handleSendMessage(ctx, BASE_ARGS);
    expect(result.isError).toBeFalsy();

    const text =
      typeof result.content === "string"
        ? result.content
        : (result.content as Array<{ text: string }>)
            .map((c) => c.text)
            .join("");

    expect(text).toContain("completed");
    expect(text).toContain("Build succeeded.");
  });

  it("returns err when completed with hasError=true", async () => {
    const ctx = makeCtx({
      timedOut: false,
      reply: "cmake: error: missing Qt6",
      hasError: true,
      messages: [],
    });

    const result = await handleSendMessage(ctx, BASE_ARGS);
    expect(result.isError).toBe(true);
  });
});

// ── Validation ─────────────────────────────────────────────────────────────────

describe("handleSendMessage — argument validation", () => {
  it("returns err when node argument is missing", async () => {
    // A ctx with no nodes at all
    const ctx = makeCtx({
      timedOut: false,
      reply: "",
      hasError: false,
      messages: [],
    });

    const result = await handleSendMessage(ctx, { prompt: "hello" });
    expect(result.isError).toBe(true);
  });

  it("returns err when node is unknown", async () => {
    const ctx = makeCtx({
      timedOut: false,
      reply: "",
      hasError: false,
      messages: [],
    });

    const result = await handleSendMessage(ctx, {
      node: "nonexistent",
      prompt: "hello",
    });
    expect(result.isError).toBe(true);
  });

  it("returns err when prompt argument is missing", async () => {
    const ctx = makeCtx({
      timedOut: false,
      reply: "",
      hasError: false,
      messages: [],
    });

    const result = await handleSendMessage(ctx, { node: NODE_NAME });
    expect(result.isError).toBe(true);
  });
});
