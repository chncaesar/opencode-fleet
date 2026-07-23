/**
 * tests/e2e/helpers/env.ts
 *
 * Read E2E environment variables and export node configs + skipIf guards.
 *
 * If a node URL env var is not set all tests for that node are skipped.
 * If both are unset the entire suite skips gracefully.
 *
 * Environment variables:
 *   E2E_NODE_OPT186_URL   — URL of the opt186 Ubuntu slave node
 *   E2E_NODE_WINDOWS_URL  — URL of the Windows slave node
 *   E2E_NODE_USERNAME     — shared username for all nodes (default: "opencode")
 *   E2E_NODE_PASSWORD     — shared password for all nodes (default: "")
 */

import { OpenCodeNode } from "../../../src/node.js";
import type { FleetConfig, NodeConfig } from "../../../src/config.js";
import { buildContext, type FleetContext } from "../../../src/tools.js";

// ── Env var reading ───────────────────────────────────────────────────────────

export const OPT186_URL = process.env["E2E_NODE_OPT186_URL"] ?? "";
export const WINDOWS_URL = process.env["E2E_NODE_WINDOWS_URL"] ?? "";
export const E2E_USERNAME = process.env["E2E_NODE_USERNAME"] ?? "opencode";
export const E2E_PASSWORD = process.env["E2E_NODE_PASSWORD"] ?? "";

/** True when the opt186 node is configured for testing. */
export const hasOpt186 = OPT186_URL.length > 0;

/** True when the Windows node is configured for testing. */
export const hasWindows = WINDOWS_URL.length > 0;

/** True when both nodes are configured (required for dual-node tests). */
export const hasBothNodes = hasOpt186 && hasWindows;

/** True when at least one node is configured. */
export const hasAnyNode = hasOpt186 || hasWindows;

// ── Node configs ──────────────────────────────────────────────────────────────

/** NodeConfig for opt186 (undefined if not configured). */
export const opt186Config: NodeConfig | undefined = hasOpt186
  ? { name: "opt186", url: OPT186_URL }
  : undefined;

/** NodeConfig for windows (undefined if not configured). */
export const windowsConfig: NodeConfig | undefined = hasWindows
  ? { name: "windows", url: WINDOWS_URL }
  : undefined;

/**
 * All configured node configs (1 or 2 entries, or empty if none configured).
 * Used for parameterized tests that run against each available node.
 */
export const configuredNodes: NodeConfig[] = [
  opt186Config,
  windowsConfig,
].filter((n): n is NodeConfig => n !== undefined);

// ── Node factories ────────────────────────────────────────────────────────────

/**
 * Create a live OpenCodeNode for the opt186 machine.
 * Call only after checking hasOpt186.
 */
export function makeOpt186Node(): OpenCodeNode {
  if (!opt186Config) throw new Error("opt186 not configured");
  return new OpenCodeNode(opt186Config, E2E_USERNAME, E2E_PASSWORD);
}

/**
 * Create a live OpenCodeNode for the Windows machine.
 * Call only after checking hasWindows.
 */
export function makeWindowsNode(): OpenCodeNode {
  if (!windowsConfig) throw new Error("windows not configured");
  return new OpenCodeNode(windowsConfig, E2E_USERNAME, E2E_PASSWORD);
}

/**
 * Build a FleetContext from all configured nodes.
 * Uses a 60s timeout (matches the E2E test ceiling).
 */
export function makeFleetContext(
  nodes: NodeConfig[] = configuredNodes
): FleetContext {
  const config: FleetConfig = {
    nodes,
    username: E2E_USERNAME,
    password: E2E_PASSWORD,
    timeoutSeconds: 60,
  };
  return buildContext(config);
}

// ── skipIf guards ─────────────────────────────────────────────────────────────

/**
 * Returns true (skip) when the opt186 node is NOT configured.
 * Use with `test.skipIf(skipIfNoOpt186)(...)`.
 */
export const skipIfNoOpt186 = !hasOpt186;

/**
 * Returns true (skip) when the Windows node is NOT configured.
 * Use with `test.skipIf(skipIfNoWindows)(...)`.
 */
export const skipIfNoWindows = !hasWindows;

/**
 * Returns true (skip) when fewer than two nodes are configured.
 * Use with `test.skipIf(skipIfNotBothNodes)(...)`.
 */
export const skipIfNotBothNodes = !hasBothNodes;

/**
 * Returns true (skip) when NO nodes are configured at all.
 * Use with `test.skipIf(skipIfNoNodes)(...)`.
 */
export const skipIfNoNodes = !hasAnyNode;

// ── Prompt constants ──────────────────────────────────────────────────────────

/**
 * Fast prompt: expected to complete in < 2s.
 * Used for connectivity checks and basic message/format tests.
 */
export const FAST_PROMPT = "Reply with exactly: hello";

/**
 * Slow prompt factory: returns a unique prompt each call to bypass LLM prompt
 * caching. Each invocation embeds a unique ID so the model cannot serve a
 * cached response, keeping the session busy long enough for status assertions.
 *
 * Expected completion time: 5–20s on a real LLM.
 * Used for SSE idle-wait validation, timeout triggering, and interrupt tests.
 */
export function makeSlowPrompt(): string {
  return (
    `Write a 50-line Python quicksort implementation with inline comments ` +
    `explaining each step. Tag your response with run-id:${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * Timeout (ms) used when we WANT to trigger a TimeoutError for testing.
 * Set short enough to fire before the slow prompt finishes.
 */
export const INTENTIONAL_TIMEOUT_MS = 3_000;
