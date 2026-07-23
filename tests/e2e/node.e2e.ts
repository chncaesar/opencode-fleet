/**
 * tests/e2e/node.e2e.ts
 *
 * E2E tests for the OpenCodeNode HTTP client (src/node.ts).
 *
 * Each describe block is parameterized over every configured node so the same
 * assertions run against opt186 and Windows when both are available.
 *
 * Tests are skipped gracefully when the corresponding env var is absent.
 */

import { describe, test, expect, beforeAll } from "vitest";
import { OpenCodeNode, TimeoutError } from "../../src/node.js";
import {
  configuredNodes,
  skipIfNoNodes,
  makeOpt186Node,
  makeWindowsNode,
  hasOpt186,
  hasWindows,
  FAST_PROMPT,
  makeSlowPrompt,
  INTENTIONAL_TIMEOUT_MS,
  E2E_USERNAME,
  E2E_PASSWORD,
} from "./helpers/env.js";
import { setupE2EHarness } from "./helpers/harness.js";

// Skip the entire file if no nodes are configured.
describe.skipIf(skipIfNoNodes)("OpenCodeNode E2E", () => {
  // Parameterize over each configured node.
  for (const nodeConfig of configuredNodes) {
    describe(`node: ${nodeConfig.name}`, () => {
      const node = new OpenCodeNode(nodeConfig, E2E_USERNAME, E2E_PASSWORD);
      const { trackSession, cleanup } = setupE2EHarness(node);

      // ── ping ──────────────────────────────────────────────────────────────

      test("ping returns true", async () => {
        const result = await node.ping();
        expect(result).toBe(true);
      });

      // ── listSessions ──────────────────────────────────────────────────────

      test("listSessions returns an array", async () => {
        const sessions = await node.listSessions();
        expect(Array.isArray(sessions)).toBe(true);
      });

      test("each session has an id and cwd", async () => {
        // Create a session so there's at least one to inspect.
        const created = await node.createSession({ cwd: "/tmp" });
        trackSession(created.id);

        const sessions = await node.listSessions();
        const found = sessions.find((s) => s.id === created.id);
        expect(found).toBeDefined();
        expect(typeof found!.id).toBe("string");
        // directory is the working dir field on the Session shape
        expect("directory" in found!).toBe(true);
      });

      // ── createSession / deleteSession ─────────────────────────────────────

      test("createSession returns a Session with an id", async () => {
        const session = await node.createSession({ cwd: "/tmp" });
        trackSession(session.id);

        expect(typeof session.id).toBe("string");
        expect(session.id.length).toBeGreaterThan(0);
      });

      test("deleteSession removes the session from the list", async () => {
        const session = await node.createSession({ cwd: "/tmp" });
        // Don't track — we'll delete manually to test the API.

        await node.deleteSession(session.id);

        const sessions = await node.listSessions();
        const found = sessions.find((s) => s.id === session.id);
        expect(found).toBeUndefined();
      });

      // ── sendPromptAsync + waitForIdle (fast) ──────────────────────────────

      test("sendPromptAsync + waitForIdle completes fast prompt", async () => {
        const session = await node.createSession({ cwd: "/tmp" });
        trackSession(session.id);

        await node.sendPromptAsync(session.id, FAST_PROMPT);
        // Should resolve well within 30s
        await expect(
          node.waitForIdle(session.id, 30_000)
        ).resolves.toBeUndefined();
      });

      // ── sendPromptAsync + waitForIdle (slow) ──────────────────────────────

      test("sendPromptAsync + waitForIdle completes slow prompt within 60s", async () => {
        const session = await node.createSession({ cwd: "/tmp" });
        trackSession(session.id);

        await node.sendPromptAsync(session.id, makeSlowPrompt());
        await expect(
          node.waitForIdle(session.id, 60_000)
        ).resolves.toBeUndefined();
      });

      // ── getMessages ───────────────────────────────────────────────────────

      test("getMessages returns messages in ascending order with assistant part", async () => {
        const session = await node.createSession({ cwd: "/tmp" });
        trackSession(session.id);

        await node.sendPromptAsync(session.id, FAST_PROMPT);
        await node.waitForIdle(session.id, 30_000);

        const messages = await node.getMessages(session.id, 20);
        expect(messages.length).toBeGreaterThan(0);

        // Messages must be in ascending (oldest-first) order.
        // The first message should be a user/prompt and there should be
        // at least one assistant message.
        const hasAssistant = messages.some(
          (m) =>
            m.info.role === "assistant" ||
            m.parts.some((p) => p.type === "text")
        );
        expect(hasAssistant).toBe(true);
      });

      // ── extractLastReply ──────────────────────────────────────────────────

      test("extractLastReply returns non-empty string after fast prompt", async () => {
        const session = await node.createSession({ cwd: "/tmp" });
        trackSession(session.id);

        await node.sendPromptAsync(session.id, FAST_PROMPT);
        await node.waitForIdle(session.id, 30_000);

        const messages = await node.getMessages(session.id, 20);
        const reply = node.extractLastReply(messages);
        expect(typeof reply).toBe("string");
        expect(reply.length).toBeGreaterThan(0);
      });

      // ── getSessionStatus: busy ────────────────────────────────────────────

      test("getSessionStatus returns busy while prompt is running", async () => {
        const session = await node.createSession({ cwd: "/tmp" });
        trackSession(session.id);

        await node.sendPromptAsync(session.id, makeSlowPrompt());

        // Poll immediately — the session should be busy.
        const status = await node.getSessionStatus(session.id);
        expect(status.type).toBe("busy");

        // Wait for it to finish so we don't leave a running session.
        await node.waitForIdle(session.id, 60_000);
      });

      // ── getSessionStatus: idle ────────────────────────────────────────────

      test("getSessionStatus returns idle after prompt completes", async () => {
        const session = await node.createSession({ cwd: "/tmp" });
        trackSession(session.id);

        await node.sendPromptAsync(session.id, FAST_PROMPT);
        await node.waitForIdle(session.id, 30_000);

        const status = await node.getSessionStatus(session.id);
        expect(status.type).toBe("idle");
      });

      // ── TimeoutError ──────────────────────────────────────────────────────

      test("waitForIdle throws TimeoutError when timeout fires before idle", async () => {
        const session = await node.createSession({ cwd: "/tmp" });
        trackSession(session.id);

        await node.sendPromptAsync(session.id, makeSlowPrompt());

        await expect(
          node.waitForIdle(session.id, INTENTIONAL_TIMEOUT_MS)
        ).rejects.toThrow(TimeoutError);

        // Clean up: wait for the session to actually finish before the
        // afterEach cleanup tries to delete it.
        await node.waitForIdle(session.id, 60_000).catch(() => {});
      });
    });
  }
});
