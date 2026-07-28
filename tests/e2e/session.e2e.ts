/**
 * tests/e2e/session.e2e.ts
 *
 * E2E tests for the SessionManager (src/session.ts).
 *
 * These tests verify:
 *   - Lazy session creation on first sendAsync
 *   - Session reuse across successive sends
 *   - Automatic 404 recovery (session rebuilt when node discards it)
 *   - waitForIdle throws TimeoutError on timeout (tested via node.waitForIdle directly)
 */

import { describe, test, expect, afterEach } from "vitest";
import { SessionManager } from "../../src/session.js";
import { OpenCodeNode, TimeoutError } from "../../src/node.js";
import {
  configuredNodes,
  skipIfNoNodes,
  E2E_USERNAME,
  E2E_PASSWORD,
  FAST_PROMPT,
  makeSlowPrompt,
  INTENTIONAL_TIMEOUT_MS,
} from "./helpers/env.js";
import type { FleetConfig } from "../../src/config.js";

// Skip the entire file if no nodes are configured.
describe.skipIf(skipIfNoNodes)("SessionManager E2E", () => {
  // Parameterize over each configured node.
  for (const nodeConfig of configuredNodes) {
    describe(`node: ${nodeConfig.name}`, () => {
      const config: FleetConfig = {
        nodes: [nodeConfig],
        username: E2E_USERNAME,
        password: E2E_PASSWORD,
        timeoutSeconds: 60,
      };
      const node = new OpenCodeNode(nodeConfig, E2E_USERNAME, E2E_PASSWORD);
      let manager = new SessionManager(config);

      // Clean up the cached session and any created sessions after each test.
      afterEach(async () => {
        const sid = manager.getSessionId(nodeConfig.name);
        manager.resetSession(nodeConfig.name);
        if (sid) {
          await node.deleteSession(sid).catch(() => {});
        }
        // Recreate a fresh manager so tests are isolated.
        manager = new SessionManager(config);
      });

      // ── lazy creation ──────────────────────────────────────────────────────

      test("no session exists before first send", () => {
        expect(manager.getSessionId(nodeConfig.name)).toBeUndefined();
      });

      test("session is created lazily on first sendAsync", async () => {
        const result = await manager.sendAsync(node, FAST_PROMPT, { cwd: "/tmp" });
        expect(result.nodeStatus).toBe("dispatched");
        const sid = manager.getSessionId(nodeConfig.name);
        expect(typeof sid).toBe("string");
        expect((sid as string).length).toBeGreaterThan(0);
        // Wait for idle so afterEach cleanup can delete the session safely.
        await node.waitForIdle(result.sessionId, 30_000).catch(() => {});
      });

      // ── session reuse ──────────────────────────────────────────────────────

      test("session ID is reused across consecutive sends", async () => {
        const r1 = await manager.sendAsync(node, FAST_PROMPT, { cwd: "/tmp" });
        await node.waitForIdle(r1.sessionId, 30_000);
        const first = manager.getSessionId(nodeConfig.name);

        const r2 = await manager.sendAsync(node, FAST_PROMPT, { cwd: "/tmp" });
        await node.waitForIdle(r2.sessionId, 30_000);
        const second = manager.getSessionId(nodeConfig.name);

        expect(first).toBe(second);
      });

      // ── 404 auto-rebuild ───────────────────────────────────────────────────

      test("session is rebuilt automatically after injected 404", async () => {
        // Establish a real session.
        const r1 = await manager.sendAsync(node, FAST_PROMPT, { cwd: "/tmp" });
        await node.waitForIdle(r1.sessionId, 30_000);
        const originalId = manager.getSessionId(nodeConfig.name)!;

        // Delete the session on the server so the next send gets a 404.
        await node.deleteSession(originalId);

        // sendAsync() should detect 404, recreate, and succeed.
        const r2 = await manager.sendAsync(node, FAST_PROMPT, { cwd: "/tmp" });
        expect(r2.nodeStatus).toBe("dispatched");
        await node.waitForIdle(r2.sessionId, 30_000);

        // Verify the agent replied with something.
        const messages = await node.getMessages(r2.sessionId, 10);
        const hasReply = messages.some(
          (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text")
        );
        expect(hasReply).toBe(true);

        // The manager must hold a new session ID.
        const newId = manager.getSessionId(nodeConfig.name);
        expect(newId).toBeDefined();
        expect(newId).not.toBe(originalId);
      });

      // ── timeout via waitForIdle ────────────────────────────────────────────

      test("waitForIdle throws TimeoutError when timeout fires before idle", async () => {
        const result = await manager.sendAsync(node, makeSlowPrompt(), { cwd: "/tmp" });

        await expect(
          node.waitForIdle(result.sessionId, INTENTIONAL_TIMEOUT_MS)
        ).rejects.toThrow(TimeoutError);

        // Clean up: wait for the remote session to actually finish before afterEach deletes it.
        await node.waitForIdle(result.sessionId, 60_000).catch(() => {});
      });
    });
  }
});
