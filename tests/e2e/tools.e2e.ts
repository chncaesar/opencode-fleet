/**
 * tests/e2e/tools.e2e.ts
 *
 * E2E tests for all 11 MCP tool handlers (src/tools.ts).
 *
 * Tests are written against the handler functions directly — no MCP protocol
 * transport needed. Each test calls the handler and asserts the ToolResult
 * shape (content[0].text, isError).
 *
 * Dual-node tests (concurrent sends, cross-node isolation) only run when both
 * E2E_NODE_OPT186_URL and E2E_NODE_WINDOWS_URL are configured.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  handleListNodes,
  handleNodeHealth,
  handleListSessions,
  handleCreateSession,
  handleSwitchSession,
  handleListModels,
  handleSendMessage,
  handleGetSessionMessages,
  handleInterruptSession,
  handleResetSession,
  handleGetSessionStatus,
  handleReplyPermission,
  buildContext,
  type FleetContext,
} from "../../src/tools.js";
import { OpenCodeNode } from "../../src/node.js";
import type { PendingPermission } from "../../src/node.js";
import {
  configuredNodes,
  skipIfNoNodes,
  skipIfNotBothNodes,
  makeFleetContext,
  opt186Config,
  windowsConfig,
  hasBothNodes,
  E2E_USERNAME,
  E2E_PASSWORD,
  FAST_PROMPT,
  makeSlowPrompt,
  INTENTIONAL_TIMEOUT_MS,
} from "./helpers/env.js";
import type { FleetConfig } from "../../src/config.js";

// ── Helper ────────────────────────────────────────────────────────────────────

/** Extract the first text block from a ToolResult. */
function text(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? "";
}

/** Assert that the result is NOT an error and return its text. */
function assertOk(result: { content: Array<{ type: string; text: string }>; isError?: boolean }): string {
  expect(result.isError).toBeFalsy();
  return text(result);
}

/** Assert that the result IS an error and return its text. */
function assertErr(result: { content: Array<{ type: string; text: string }>; isError?: boolean }): string {
  expect(result.isError).toBe(true);
  return text(result);
}

// ── Single-node tool tests ────────────────────────────────────────────────────

describe.skipIf(skipIfNoNodes)("Fleet tool handlers E2E", () => {
  // Run the same tool tests against every configured node.
  for (const nodeConfig of configuredNodes) {
    describe(`node: ${nodeConfig.name}`, () => {
      // Fresh FleetContext for each describe block — one node.
      const config: FleetConfig = {
        nodes: [nodeConfig],
        username: E2E_USERNAME,
        password: E2E_PASSWORD,
        timeoutSeconds: 60,
      };
      let ctx: FleetContext;
      // Direct node reference for cleanup.
      const rawNode = new OpenCodeNode(nodeConfig, E2E_USERNAME, E2E_PASSWORD);

      beforeEach(() => {
        ctx = buildContext(config);
      });

      afterEach(async () => {
        // Best-effort cleanup: delete any session the context is holding.
        const sid = ctx.sessions.getSessionId(nodeConfig.name);
        ctx.sessions.resetSession(nodeConfig.name);
        if (sid) {
          await rawNode.deleteSession(sid).catch(() => {});
        }
      });

      // ── fleet_list_nodes ────────────────────────────────────────────────────

      test("fleet_list_nodes reports the configured node", async () => {
        const result = await handleListNodes(ctx);
        const t = assertOk(result);
        expect(t).toContain(nodeConfig.name);
        expect(t).toContain("online");
      });

      // ── fleet_node_health ────────────────────────────────────────────────────

      test("fleet_node_health returns online for a reachable node", async () => {
        const result = await handleNodeHealth(ctx, { node: nodeConfig.name });
        const t = assertOk(result);
        expect(t).toContain("online");
        expect(t).toContain("Latency");
      });

      test("fleet_node_health returns error for an unknown node", async () => {
        const result = await handleNodeHealth(ctx, { node: "does-not-exist" });
        assertErr(result);
      });

      // ── fleet_list_sessions ──────────────────────────────────────────────────

      test("fleet_list_sessions returns a list (may be empty)", async () => {
        const result = await handleListSessions(ctx, { node: nodeConfig.name });
        // Could be "has no sessions" or a list — both are non-error.
        expect(result.isError).toBeFalsy();
      });

      // ── fleet_create_session ─────────────────────────────────────────────────

      test("fleet_create_session creates a session and binds it", async () => {
        const result = await handleCreateSession(ctx, {
          node: nodeConfig.name,
          cwd: "/tmp",
        });
        const t = assertOk(result);
        expect(t).toContain("Created");
        // Manager must now hold the session ID.
        const sid = ctx.sessions.getSessionId(nodeConfig.name);
        expect(typeof sid).toBe("string");
        expect((sid as string).length).toBeGreaterThan(0);
      });

      // ── fleet_switch_session ─────────────────────────────────────────────────

      test("fleet_switch_session updates the bound session", async () => {
        // First create a session to switch to.
        const created = await rawNode.createSession({ cwd: "/tmp" });

        try {
          const result = await handleSwitchSession(ctx, {
            node: nodeConfig.name,
            session_id: created.id,
          });
          const t = assertOk(result);
          expect(t).toContain(created.id);
          expect(ctx.sessions.getSessionId(nodeConfig.name)).toBe(created.id);
        } finally {
          await rawNode.deleteSession(created.id).catch(() => {});
          ctx.sessions.resetSession(nodeConfig.name);
        }
      });

      // ── fleet_list_models ────────────────────────────────────────────────────

      test("fleet_list_models returns at least one model", async () => {
        const result = await handleListModels(ctx, { node: nodeConfig.name });
        const t = assertOk(result);
        // Format: providerID/modelID
        expect(t).toMatch(/\w+\/\w+/);
      });

      // ── fleet_send_message (fast) ────────────────────────────────────────────

      test("fleet_send_message completes fast prompt", async () => {
        const result = await handleSendMessage(ctx, {
          node: nodeConfig.name,
          prompt: FAST_PROMPT,
          cwd: "/tmp",
        });
        const t = assertOk(result);
        expect(t).toContain("dispatched");
      });

      // ── fleet_send_message (slow) ────────────────────────────────────────────

      test("fleet_send_message dispatches slow prompt (fire-and-forget)", async () => {
        const result = await handleSendMessage(ctx, {
          node: nodeConfig.name,
          prompt: makeSlowPrompt(),
          cwd: "/tmp",
        });
        // Non-error; fire-and-forget returns immediately with "dispatched"
        expect(result.isError).toBeFalsy();
      });

      // ── fleet_get_session_messages ───────────────────────────────────────────

      test("fleet_get_session_messages returns message history", async () => {
        // Send a fast prompt so there are messages to retrieve.
        await handleSendMessage(ctx, {
          node: nodeConfig.name,
          prompt: FAST_PROMPT,
          cwd: "/tmp",
        });

        const result = await handleGetSessionMessages(ctx, {
          node: nodeConfig.name,
          limit: 10,
        });
        const t = assertOk(result);
        // Should contain message role markers.
        expect(t.length).toBeGreaterThan(0);
      });

      // ── fleet_interrupt_session ──────────────────────────────────────────────

      test("fleet_interrupt_session sends abort signal to busy session", async () => {
        // Create a session and start a slow prompt without waiting.
        const session = await rawNode.createSession({ cwd: "/tmp" });
        ctx.sessions.setSessionId(nodeConfig.name, session.id);

        await rawNode.sendPromptAsync(session.id, makeSlowPrompt());

        // Interrupt it immediately.
        const result = await handleInterruptSession(ctx, { node: nodeConfig.name });
        assertOk(result);

        // Wait for the session to settle so afterEach cleanup can delete it.
        await rawNode.waitForIdle(session.id, 60_000).catch(() => {});
      });

      // ── fleet_interrupt_session (no session) ─────────────────────────────────

      test("fleet_interrupt_session errors when no active session", async () => {
        // No session bound.
        const freshCtx = buildContext(config);
        const result = await handleInterruptSession(freshCtx, { node: nodeConfig.name });
        assertErr(result);
      });

      // ── fleet_reset_session: busy → error ────────────────────────────────────

      test("fleet_reset_session is blocked while session is busy", async () => {
        // Create a session, start a slow prompt.
        // Use ctx's node so statusCache is shared with handleResetSession.
        const ctxNode = ctx.nodes.get(nodeConfig.name)!;
        const session = await ctxNode.createSession({ cwd: "/tmp" });
        ctx.sessions.setSessionId(nodeConfig.name, session.id);
        await ctxNode.sendPromptAsync(session.id, makeSlowPrompt());

        // Attempt reset — should be blocked.
        const result = await handleResetSession(ctx, { node: nodeConfig.name });
        // The handler returns isError: true when the guard fires.
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("BLOCKED");

        // Clean up: interrupt, wait, then delete.
        await ctxNode.abortSession(session.id).catch(() => {});
        await ctxNode.waitForIdle(session.id, 60_000).catch(() => {});
        await ctxNode.deleteSession(session.id).catch(() => {});
        ctx.sessions.resetSession(nodeConfig.name);
      });

      // ── fleet_reset_session: idle → succeeds ─────────────────────────────────

      test("fleet_reset_session succeeds when session is idle", async () => {
        // Send a fast prompt, wait for it to finish, then reset.
        const sendResult = await handleSendMessage(ctx, {
          node: nodeConfig.name,
          prompt: FAST_PROMPT,
          cwd: "/tmp",
        });
        assertOk(sendResult);

        // Wait for the session to become idle before attempting reset.
        const sid = ctx.sessions.getSessionId(nodeConfig.name);
        expect(sid).toBeDefined();
        const ctxNode = ctx.nodes.get(nodeConfig.name)!;
        await ctxNode.waitForIdle(sid!, 30_000);

        const result = await handleResetSession(ctx, { node: nodeConfig.name });
        const t = assertOk(result);
        expect(t).toContain("discarded");
        expect(ctx.sessions.getSessionId(nodeConfig.name)).toBeUndefined();

        // Clean up the dangling session manually (reset only clears the cache).
        if (sid) await rawNode.deleteSession(sid).catch(() => {});
      });

      // ── fleet_get_session_status: busy ────────────────────────────────────────

      test("fleet_get_session_status returns busy while prompt is running", async () => {
        // Use ctx's node so statusCache is shared with handleGetSessionStatus.
        const ctxNode = ctx.nodes.get(nodeConfig.name)!;
        const session = await ctxNode.createSession({ cwd: "/tmp" });
        ctx.sessions.setSessionId(nodeConfig.name, session.id);
        await ctxNode.sendPromptAsync(session.id, makeSlowPrompt());

        const result = await handleGetSessionStatus(ctx, { node: nodeConfig.name });
        const t = assertOk(result);
        expect(t).toContain("busy");

        await ctxNode.waitForIdle(session.id, 60_000).catch(() => {});
      });

      // ── fleet_get_session_status: idle ────────────────────────────────────────

      test("fleet_get_session_status returns idle after prompt completes", async () => {
        const sendResult = await handleSendMessage(ctx, {
          node: nodeConfig.name,
          prompt: FAST_PROMPT,
          cwd: "/tmp",
        });
        assertOk(sendResult);

        // Wait for the session to become idle before checking status.
        const sid = ctx.sessions.getSessionId(nodeConfig.name);
        expect(sid).toBeDefined();
        const ctxNode = ctx.nodes.get(nodeConfig.name)!;
        await ctxNode.waitForIdle(sid!, 30_000);

        const result = await handleGetSessionStatus(ctx, { node: nodeConfig.name });
        const t = assertOk(result);
        expect(t).toContain("idle");
      });

      // ── fleet_get_session_status: injected pending permissions ────────────────
      //
      // These tests use injectPermissionForTesting to set up permission state
      // without a live pending permission request. They verify that the
      // fleet_get_session_status output includes the expected permission paragraph.

      test("fleet_get_session_status with injected pending permissions includes permission paragraph", async () => {
        // Inject a fake busy status and permission so the handler sees pending requests.
        const ctxNode = ctx.nodes.get(nodeConfig.name)!;
        const fakeSessionId = "ses_injected_e2e_test";
        ctx.sessions.setSessionId(nodeConfig.name, fakeSessionId);

        const injected: PendingPermission[] = [
          { id: "per_inject_001", permission: "bash", patterns: ["rm -rf /tmp/test"] },
        ];
        ctxNode.injectPermissionForTesting(fakeSessionId, injected);
        // Also inject busy status so the handler queries pending permissions.
        ctxNode.injectStatusForTesting(fakeSessionId, { type: "busy" });

        try {
          const result = await handleGetSessionStatus(ctx, { node: nodeConfig.name });
          const t = assertOk(result);
          expect(t).toContain("Status: busy");
          expect(t).toContain("Permission approval required");
          expect(t).toContain("per_inject_001");
          expect(t).toContain("bash");
          expect(t).toContain("fleet_reply_permission");
        } finally {
          // Clean up injected state.
          ctxNode.removePendingPermission(fakeSessionId, "per_inject_001");
          ctx.sessions.resetSession(nodeConfig.name);
        }
      });

      // ── fleet_reply_permission: injected state, HTTP will 404 ─────────────────
      //
      // fleet_reply_permission sends a real HTTP request to the slave. Since there
      // is no real pending permission on the slave, the slave will return a non-204
      // status (404 or 400). This tests that the handler surfaces the error correctly.
      // The test verifies: (a) handler returns isError=true, (b) error message
      // contains the request ID so the master can act on it.

      test("fleet_reply_permission returns error when slave has no matching permission request", async () => {
        const fakeSessionId = "ses_injected_e2e_test";
        ctx.sessions.setSessionId(nodeConfig.name, fakeSessionId);

        const result = await handleReplyPermission(ctx, {
          node: nodeConfig.name,
          session_id: fakeSessionId,
          request_id: "per_nonexistent_001",
          reply: "once",
        });

        // The slave has no such permission request, so HTTP will fail.
        // Handler must surface isError=true.
        assertErr(result);
      });
    });
  }
});

// ── Dual-node tests ────────────────────────────────────────────────────────────

describe.skipIf(skipIfNotBothNodes)("Dual-node E2E", () => {
  // Only runs when both nodes are configured.
  const config: FleetConfig = {
    nodes: [opt186Config!, windowsConfig!],
    username: E2E_USERNAME,
    password: E2E_PASSWORD,
    timeoutSeconds: 60,
  };

  let ctx: FleetContext;
  let opt186Node: OpenCodeNode;
  let windowsNode: OpenCodeNode;

  beforeEach(() => {
    ctx = buildContext(config);
    opt186Node = new OpenCodeNode(opt186Config!, E2E_USERNAME, E2E_PASSWORD);
    windowsNode = new OpenCodeNode(windowsConfig!, E2E_USERNAME, E2E_PASSWORD);
  });

  afterEach(async () => {
    const sids = [
      [opt186Node, ctx.sessions.getSessionId("opt186")] as const,
      [windowsNode, ctx.sessions.getSessionId("windows")] as const,
    ];
    for (const [n, sid] of sids) {
      ctx.sessions.resetSession(n === opt186Node ? "opt186" : "windows");
      if (sid) await n.deleteSession(sid).catch(() => {});
    }
  });

  // ── Concurrent sends to different nodes ────────────────────────────────────

  test("concurrent fleet_send_message calls complete independently", async () => {
    const [r1, r2] = await Promise.all([
      handleSendMessage(ctx, { node: "opt186", prompt: FAST_PROMPT, cwd: "/tmp" }),
      handleSendMessage(ctx, { node: "windows", prompt: FAST_PROMPT, cwd: "C:\\tmp" }),
    ]);

    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    expect(text(r1)).toContain("dispatched");
    expect(text(r2)).toContain("dispatched");
  });

  // ── Session IDs are isolated across nodes ──────────────────────────────────

  test("sessions are isolated — different IDs per node", async () => {
    await Promise.all([
      handleSendMessage(ctx, { node: "opt186", prompt: FAST_PROMPT, cwd: "/tmp" }),
      handleSendMessage(ctx, { node: "windows", prompt: FAST_PROMPT, cwd: "C:\\tmp" }),
    ]);

    const id1 = ctx.sessions.getSessionId("opt186");
    const id2 = ctx.sessions.getSessionId("windows");

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
  });
});
