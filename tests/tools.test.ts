/**
 * tests/tools.test.ts
 *
 * Unit tests for handleSendMessage (async/fire-and-forget semantics):
 *   - dispatched path: returns ok() with session ID and next-step instructions
 *   - error path: returns err() when sendAsync throws
 *   - validation: missing node / prompt / unknown node
 *   - options forwarding: agent, model, cwd, reasoning_effort
 *
 * Unit tests for handleGetSessionStatus (permission-aware):
 *   - busy + pending permissions: output includes permission details
 *   - busy + no pending permissions: output identical to pre-permission behavior
 *
 * Unit tests for handleReplyPermission:
 *   - once: calls replyPermission and removePendingPermission, returns success text
 *   - reject: calls replyPermission and removePendingPermission, returns success text
 *   - always: returns isError=true, does not call replyPermission
 *   - missing request_id: returns isError=true
 */

import { describe, it, expect, vi } from "vitest";
import { handleSendMessage, handleGetSessionStatus, handleReplyPermission, dispatchTool } from "../src/tools.js";
import type { FleetContext } from "../src/tools.js";
import type { AsyncSendResult } from "../src/session.js";
import type { PendingPermission } from "../src/node.js";

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

/**
 * Build a FleetContext suitable for fleet_get_session_status and
 * fleet_reply_permission tests, where the node mock has the
 * permission-related methods.
 */
function makeStatusCtx(opts: {
  statusType?: "idle" | "busy";
  pendingPermissions?: PendingPermission[];
  replyPermissionResult?: Error | void;
} = {}): FleetContext {
  const { statusType = "busy", pendingPermissions = [], replyPermissionResult } = opts;

  const mockNode = {
    getSessionStatus: vi.fn().mockResolvedValue({ type: statusType }),
    getPendingPermissions: vi.fn().mockReturnValue(pendingPermissions),
    replyPermission:
      replyPermissionResult instanceof Error
        ? vi.fn().mockRejectedValue(replyPermissionResult)
        : vi.fn().mockResolvedValue(undefined),
    removePendingPermission: vi.fn(),
  };

  return {
    nodes: new Map([[NODE_NAME, mockNode as unknown as ReturnType<typeof import("../src/node.js").OpenCodeNode.prototype.constructor>]]),
    sessions: {
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

// ── fleet_get_session_status — permission-aware ────────────────────────────────

describe("handleGetSessionStatus — permission-aware", () => {
  it("busy session with pending permissions: output includes permission details", async () => {
    const pending: PendingPermission[] = [
      { id: "per_001", permission: "bash", patterns: ["rm -rf /tmp/build"] },
    ];
    const ctx = makeStatusCtx({ statusType: "busy", pendingPermissions: pending });

    const result = await handleGetSessionStatus(ctx, { node: NODE_NAME });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join("");
    expect(text).toContain("Status: busy");
    expect(text).toContain("Permission approval required");
    expect(text).toContain("per_001");
    expect(text).toContain("bash");
    expect(text).toContain("fleet_reply_permission");
  });

  it("busy session with no pending permissions: output does not include permission paragraph", async () => {
    const ctx = makeStatusCtx({ statusType: "busy", pendingPermissions: [] });

    const result = await handleGetSessionStatus(ctx, { node: NODE_NAME });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join("");
    expect(text).toContain("Status: busy");
    expect(text).not.toContain("Permission approval required");
    expect(text).not.toContain("fleet_reply_permission");
    // Original busy message lines should still be present
    expect(text).toContain("The agent is currently executing.");
  });
});

// ── fleet_reply_permission ─────────────────────────────────────────────────────

describe("handleReplyPermission", () => {
  it("reply=once calls replyPermission and removePendingPermission, returns success text", async () => {
    const ctx = makeStatusCtx();
    const mockNode = ctx.nodes.get(NODE_NAME) as unknown as {
      replyPermission: ReturnType<typeof vi.fn>;
      removePendingPermission: ReturnType<typeof vi.fn>;
    };

    const result = await handleReplyPermission(ctx, {
      node: NODE_NAME,
      request_id: "per_001",
      reply: "once",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join("");
    expect(text).toContain("per_001");
    expect(text).toContain("once");
    expect(text).toContain("unblocked");

    expect(mockNode.replyPermission).toHaveBeenCalledWith(
      SESSION_ID, "per_001", "once", undefined
    );
    expect(mockNode.removePendingPermission).toHaveBeenCalledWith(SESSION_ID, "per_001");
  });

  it("reply=reject calls replyPermission and removePendingPermission, returns success text", async () => {
    const ctx = makeStatusCtx();
    const mockNode = ctx.nodes.get(NODE_NAME) as unknown as {
      replyPermission: ReturnType<typeof vi.fn>;
      removePendingPermission: ReturnType<typeof vi.fn>;
    };

    const result = await handleReplyPermission(ctx, {
      node: NODE_NAME,
      request_id: "per_002",
      reply: "reject",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join("");
    expect(text).toContain("per_002");
    expect(text).toContain("reject");

    expect(mockNode.replyPermission).toHaveBeenCalledWith(
      SESSION_ID, "per_002", "reject", undefined
    );
    expect(mockNode.removePendingPermission).toHaveBeenCalledWith(SESSION_ID, "per_002");
  });

  it("reply=always returns isError=true and does not call replyPermission", async () => {
    const ctx = makeStatusCtx();
    const mockNode = ctx.nodes.get(NODE_NAME) as unknown as {
      replyPermission: ReturnType<typeof vi.fn>;
    };

    const result = await handleReplyPermission(ctx, {
      node: NODE_NAME,
      request_id: "per_003",
      reply: "always",
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join("");
    expect(text).toContain("once");
    expect(text).toContain("reject");
    expect(mockNode.replyPermission).not.toHaveBeenCalled();
  });

  it("missing request_id returns isError=true", async () => {
    const ctx = makeStatusCtx();

    const result = await handleReplyPermission(ctx, {
      node: NODE_NAME,
      reply: "once",
      // request_id omitted
    });

    expect(result.isError).toBe(true);
  });

  it("replyPermission HTTP failure: returns isError=true with error message", async () => {
    const httpError = new Error("POST /api/session/ses_abc123/permission/per_err/reply → HTTP 404: not found");
    const ctx = makeStatusCtx({ replyPermissionResult: httpError });
    const mockNode = ctx.nodes.get(NODE_NAME) as unknown as {
      replyPermission: ReturnType<typeof vi.fn>;
      removePendingPermission: ReturnType<typeof vi.fn>;
    };

    const result = await handleReplyPermission(ctx, {
      node: NODE_NAME,
      request_id: "per_err",
      reply: "once",
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join("");
    expect(text).toContain("per_err");
    expect(text).toContain("HTTP 404");

    // replyPermission was called but removePendingPermission must NOT be called on failure
    expect(mockNode.replyPermission).toHaveBeenCalledOnce();
    expect(mockNode.removePendingPermission).not.toHaveBeenCalled();
  });
});
