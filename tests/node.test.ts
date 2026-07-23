/**
 * tests/node.test.ts
 *
 * Unit tests for OpenCodeNode utility methods:
 *   - extractLastReply: text / tool-only / empty
 *   - getSessionStatus: idle / busy / empty session
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenCodeNode } from "../src/node.js";
import type {
  MessageWithParts,
  TextPart,
  ToolPart,
  StepFinishPart,
} from "../src/node.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeNode(): OpenCodeNode {
  return new OpenCodeNode(
    { name: "test", url: "http://localhost:9999" },
    "opencode",
    "test-password"
  );
}

/** Build a minimal user MessageWithParts. */
function userMsg(id = "u1"): MessageWithParts {
  return { info: { id, sessionID: "s1", role: "user" }, parts: [] };
}

/** Build an assistant MessageWithParts with the given parts. */
function assistantMsg(
  parts: MessageWithParts["parts"],
  id = "a1"
): MessageWithParts {
  return { info: { id, sessionID: "s1", role: "assistant" }, parts };
}

/** Build a TextPart. */
function textPart(text: string): TextPart {
  return { id: "p1", sessionID: "s1", messageID: "a1", type: "text", text };
}

/** Build a ToolPart with the given status. */
function toolPart(
  tool: string,
  status: "pending" | "running" | "completed" | "error",
  input?: Record<string, unknown>
): ToolPart {
  return {
    id: "t1",
    sessionID: "s1",
    messageID: "a1",
    type: "tool",
    callID: "c1",
    tool,
    state: { status, input },
  };
}

/** Build a StepFinishPart. */
function stepFinishPart(): StepFinishPart {
  return { id: "sf1", sessionID: "s1", messageID: "a1", type: "step-finish" };
}

// ── extractLastReply ──────────────────────────────────────────────────────────
//
// Messages from the API are in ascending order (oldest first, newest last).
// extractLastReply scans from the END of the array and returns the LAST
// (most recent) assistant message found.

describe("extractLastReply", () => {
  it("returns text from an assistant message", () => {
    const node = makeNode();
    const messages: MessageWithParts[] = [
      userMsg(),
      assistantMsg([textPart("Hello from the agent.")]),
    ];
    expect(node.extractLastReply(messages)).toBe("Hello from the agent.");
  });

  it("skips user messages and returns the LAST assistant text found", () => {
    const node = makeNode();
    // Messages are ascending (oldest first). Scan from end → last assistant hit.
    const messages: MessageWithParts[] = [
      assistantMsg([textPart("first reply")], "a1"),
      userMsg(),
      assistantMsg([textPart("second reply")], "a2"),
    ];
    // Most recent assistant message is "second reply"
    expect(node.extractLastReply(messages)).toBe("second reply");
  });

  it("returns tool activity summary when first assistant has no text", () => {
    const node = makeNode();
    const messages: MessageWithParts[] = [
      userMsg(),
      assistantMsg([toolPart("bash", "running", { command: "make -j4" })]),
    ];
    const result = node.extractLastReply(messages);
    expect(result).toContain("[Agent is busy");
    expect(result).toContain("bash");
    expect(result).toContain("make -j4");
    expect(result).toContain("⟳"); // running symbol
  });

  it("shows ✓ for completed tool and ✗ for error tool", () => {
    const node = makeNode();
    const messages: MessageWithParts[] = [
      userMsg(),
      assistantMsg([
        toolPart("glob", "completed", { pattern: "**/*.ts" }),
        toolPart("bash", "error", { command: "npm test" }),
      ]),
    ];
    const result = node.extractLastReply(messages);
    expect(result).toContain("✓");
    expect(result).toContain("✗");
  });

  it("returns fallback string when assistant message has no parts at all", () => {
    const node = makeNode();
    const messages: MessageWithParts[] = [userMsg(), assistantMsg([])];
    expect(node.extractLastReply(messages)).toBe(
      "[Agent started processing — no output yet]"
    );
  });

  it("returns empty string when there are no assistant messages", () => {
    const node = makeNode();
    expect(node.extractLastReply([])).toBe("");
    expect(node.extractLastReply([userMsg()])).toBe("");
  });
});

// ── getSessionStatus ──────────────────────────────────────────────────────────
//
// getSessionStatus now uses GET /session/active which returns
// { [sessionID]: { type: "running" } } for all currently-executing sessions.
// Present → busy. Absent → idle. O(1), no message history needed.

describe("getSessionStatus", () => {
  let node: OpenCodeNode;

  beforeEach(() => {
    node = makeNode();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Mock fetch to return a /api/session/active response.
   * The real API wraps the map in { data: { ... } }.
   * activeSessions is the inner map of running session IDs.
   */
  function mockActive(activeSessions: Record<string, { type: string }>) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: activeSessions })),
      })
    );
  }

  it("returns busy when session appears in /session/active", async () => {
    mockActive({ s1: { type: "running" } });
    const status = await node.getSessionStatus("s1");
    expect(status.type).toBe("busy");
  });

  it("returns idle when session is absent from /session/active", async () => {
    // Different session is running, but not s1
    mockActive({ other_session: { type: "running" } });
    const status = await node.getSessionStatus("s1");
    expect(status.type).toBe("idle");
  });

  it("returns idle when /session/active map is empty", async () => {
    mockActive({});
    const status = await node.getSessionStatus("s1");
    expect(status.type).toBe("idle");
  });

  it("returns idle when multiple other sessions are active but not ours", async () => {
    mockActive({
      ses_abc: { type: "running" },
      ses_def: { type: "running" },
      ses_ghi: { type: "running" },
    });
    const status = await node.getSessionStatus("s1");
    expect(status.type).toBe("idle");
  });

  it("returns busy when target session is among multiple active sessions", async () => {
    mockActive({
      ses_abc: { type: "running" },
      s1: { type: "running" },
      ses_def: { type: "running" },
    });
    const status = await node.getSessionStatus("s1");
    expect(status.type).toBe("busy");
  });
});

// ── getSessionStatusFallback ───────────────────────────────────────────────────
//
// The fallback implementation uses message history scanning (step-finish parts).
// Kept for degraded environments where /session/active is unavailable.

describe("getSessionStatusFallback", () => {
  let node: OpenCodeNode;

  beforeEach(() => {
    node = makeNode();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockMessages(messages: MessageWithParts[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(messages)),
      })
    );
  }

  it("returns idle when session has no messages", async () => {
    mockMessages([]);
    const status = await node.getSessionStatusFallback("s1");
    expect(status.type).toBe("idle");
  });

  it("returns idle when no user messages exist", async () => {
    mockMessages([assistantMsg([textPart("hello")])]);
    const status = await node.getSessionStatusFallback("s1");
    expect(status.type).toBe("idle");
  });

  it("returns idle when last user message is followed by step-finish", async () => {
    mockMessages([
      userMsg(),
      assistantMsg([textPart("Done."), stepFinishPart()]),
    ]);
    const status = await node.getSessionStatusFallback("s1");
    expect(status.type).toBe("idle");
  });

  it("returns busy when last user message has no step-finish after it", async () => {
    mockMessages([
      userMsg(),
      assistantMsg([toolPart("bash", "running", { command: "make" })]),
    ]);
    const status = await node.getSessionStatusFallback("s1");
    expect(status.type).toBe("busy");
  });

  it("uses the LAST user message, not an earlier one", async () => {
    mockMessages([
      userMsg("u1"),
      assistantMsg([textPart("first answer"), stepFinishPart()], "a1"),
      userMsg("u2"),
      assistantMsg([toolPart("bash", "running", { command: "sleep 30" })], "a2"),
    ]);
    const status = await node.getSessionStatusFallback("s1");
    expect(status.type).toBe("busy");
  });

  it("returns idle when both exchanges are complete", async () => {
    mockMessages([
      userMsg("u1"),
      assistantMsg([textPart("first"), stepFinishPart()], "a1"),
      userMsg("u2"),
      assistantMsg([textPart("second"), stepFinishPart()], "a2"),
    ]);
    const status = await node.getSessionStatusFallback("s1");
    expect(status.type).toBe("idle");
  });
});
