/**
 * tests/e2e/session.e2e.ts
 *
 * E2E tests for the SessionManager (src/session.ts).
 *
 * These tests verify:
 *   - Lazy session creation on first send
 *   - Session reuse across successive sends
 *   - Automatic 404 recovery (session rebuilt when node discards it)
 *   - timedOut flag + non-empty messages on timeout
 */

import { describe, test, expect, afterEach } from "vitest";
import { SessionManager } from "../../src/session.js";
import { OpenCodeNode } from "../../src/node.js";
import {
  configuredNodes,
  skipIfNoNodes,
  makeFleetContext,
  E2E_USERNAME,
  E2E_PASSWORD,
  FAST_PROMPT,
  makeSlowPrompt,
  INTENTIONAL_TIMEOUT_MS,
} from "./helpers/env.js";
import type { FleetConfig, NodeConfig } from "../../src/config.js";

// Skip the entire file if no nodes are configured.
describe.skipIf(skipIfNoNodes)("SessionManager E2E", () => {
  // Parameterize over each configured node.
  for (const nodeConfig of configuredNodes) {
    describe(`node: ${nodeConfig.name}`, () => {
      // Build a SessionManager with a generous timeout for most tests.
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

      test("session is created lazily on first send", async () => {
        await manager.send(node, FAST_PROMPT);
        const sid = manager.getSessionId(nodeConfig.name);
        expect(typeof sid).toBe("string");
        expect((sid as string).length).toBeGreaterThan(0);
      });

      // ── session reuse ──────────────────────────────────────────────────────

      test("session ID is reused across consecutive sends", async () => {
        await manager.send(node, FAST_PROMPT);
        const first = manager.getSessionId(nodeConfig.name);

        await manager.send(node, FAST_PROMPT);
        const second = manager.getSessionId(nodeConfig.name);

        expect(first).toBe(second);
      });

      // ── 404 auto-rebuild ───────────────────────────────────────────────────

      test("session is rebuilt automatically after injected 404", async () => {
        // Establish a real session.
        await manager.send(node, FAST_PROMPT);
        const originalId = manager.getSessionId(nodeConfig.name)!;

        // Delete the session on the server so the next send gets a 404.
        await node.deleteSession(originalId);

        // send() should detect 404, recreate, and succeed.
        const result = await manager.send(node, FAST_PROMPT);
        expect(result.timedOut).toBe(false);
        expect(result.reply.length).toBeGreaterThan(0);

        // The manager must hold a new session ID.
        const newId = manager.getSessionId(nodeConfig.name);
        expect(newId).toBeDefined();
        expect(newId).not.toBe(originalId);
      });

      // ── timedOut + partial messages ────────────────────────────────────────

      test("timedOut is true and messages non-empty when timeout fires", async () => {
        // Use a tight-timeout manager.
        const shortConfig: FleetConfig = {
          ...config,
          timeoutSeconds: INTENTIONAL_TIMEOUT_MS / 1000,
        };
        const shortManager = new SessionManager(shortConfig);

        let shortSid: string | undefined;
        try {
          const result = await shortManager.send(node, makeSlowPrompt());
          shortSid = shortManager.getSessionId(nodeConfig.name);

          expect(result.timedOut).toBe(true);
          expect(result.messages.length).toBeGreaterThan(0);
        } finally {
          // Clean up: wait for the remote session to finish, then delete.
          if (shortSid) {
            await node.waitForIdle(shortSid, 60_000).catch(() => {});
            await node.deleteSession(shortSid).catch(() => {});
          }
        }
      });
    });
  }
});
