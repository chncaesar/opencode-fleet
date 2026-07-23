/**
 * tests/e2e/helpers/harness.ts
 *
 * E2E test harness: tracks sessions created during a test and cleans them up
 * in afterEach so the slave node doesn't accumulate dangling sessions.
 *
 * Usage:
 *   const { trackSession, cleanup } = setupE2EHarness(node);
 *
 *   beforeEach is handled internally via the returned setup/teardown pair.
 *   Call trackSession(id) any time you create a session inside a test so it
 *   will be deleted after the test finishes (even on failure).
 */

import { beforeEach, afterEach } from "vitest";
import type { OpenCodeNode } from "../../../src/node.js";

export interface E2EHarness {
  /**
   * Register a session ID for cleanup after the current test.
   * Call this immediately after createSession() so cleanup fires even if the
   * test assertion fails.
   */
  trackSession(sessionId: string): void;

  /**
   * Manually run cleanup (delete all tracked sessions).
   * Normally called automatically by afterEach; exposed for tests that need
   * early teardown.
   */
  cleanup(): Promise<void>;
}

/**
 * Set up beforeEach / afterEach hooks that track and delete sessions created
 * during each test.
 *
 * @param node  The OpenCodeNode to clean up sessions on.
 * @returns     Harness object with `trackSession` and `cleanup`.
 */
export function setupE2EHarness(node: OpenCodeNode): E2EHarness {
  // Session IDs accumulated during the current test.
  let trackedIds: string[] = [];

  beforeEach(() => {
    trackedIds = [];
  });

  afterEach(async () => {
    await deleteAll(node, trackedIds);
    trackedIds = [];
  });

  function trackSession(sessionId: string): void {
    trackedIds.push(sessionId);
  }

  async function cleanup(): Promise<void> {
    await deleteAll(node, trackedIds);
    trackedIds = [];
  }

  return { trackSession, cleanup };
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Attempt to delete each session; swallow errors so a missing session (already
 * deleted by the test) doesn't fail teardown.
 */
async function deleteAll(
  node: OpenCodeNode,
  ids: string[]
): Promise<void> {
  await Promise.allSettled(ids.map((id) => node.deleteSession(id)));
}
