/**
 * session.ts
 *
 * SessionManager: per-node session lifecycle.
 *
 * Strategy (v1): reuse a single long-lived session per node.
 * The session is created lazily on the first send, and the ID
 * is kept in an in-memory Map.  If the node disappears or returns
 * a 404, a fresh session is created automatically.
 *
 * Calling resetSession() discards the cached ID so the next call
 * creates a new one.
 */

import { OpenCodeNode } from "./node.js";
import type { FleetConfig } from "./config.js";

export interface SendOptions {
  /**
   * Working directory for the session (absolute path on the remote machine).
   * Used when a new session is created lazily. Defaults to "/" if not provided.
   */
  cwd?: string;
  /**
   * Agent mode, e.g. "build" or "plan".
   * Only applied when creating a brand-new session; has no effect on an existing session.
   */
  agent?: string;
  /**
   * Model override in "providerID/modelID" format, e.g. "anthropic/claude-sonnet-4-6".
   * Only applied when creating a brand-new session.
   */
  model?: string;
  /**
   * Reasoning effort hint passed to each prompt call: "low" | "medium" | "high".
   */
  reasoningEffort?: string;
}

export interface AsyncSendResult {
  /**
   * The session ID that received the prompt.
   * Use with fleet_get_session_status / fleet_get_session_messages.
   */
  sessionId: string;
  /** Always "dispatched" — the prompt was sent and the agent is now running. */
  nodeStatus: "dispatched";
}

export class SessionManager {
  /** Map from node name → active session ID */
  private sessionIds = new Map<string, string>();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: FleetConfig) {
    // config reserved for future use (e.g. per-node overrides)
  }

  /**
   * Ensure a session exists for the node.
   * Reuses the cached ID, or creates a new one using the supplied options.
   */
  async getOrCreateSession(
    node: OpenCodeNode,
    options: SendOptions = {}
  ): Promise<string> {
    const cached = this.sessionIds.get(node.name);
    if (cached) {
      // Trust the cached ID; if it's stale, sendPromptAsync will return 404
      // and sendAsync() will recreate it automatically.
      return cached;
    }

    // Create a new session, forwarding agent/model options
    const session = await node.createSession({
      cwd: options.cwd ?? "/",
      agent: options.agent,
      model: options.model,
    });
    this.sessionIds.set(node.name, session.id);
    return session.id;
  }

  /**
   * Discard the cached session ID for a node.
   * The next call to getOrCreateSession() will create a fresh one.
   */
  resetSession(nodeName: string): void {
    this.sessionIds.delete(nodeName);
  }

  /**
   * Get the current cached session ID for a node (may be undefined).
   */
  getSessionId(nodeName: string): string | undefined {
    return this.sessionIds.get(nodeName);
  }

  /**
   * Manually bind a node to an existing session ID.
   * Used by fleet_switch_session.
   */
  setSessionId(nodeName: string, sessionId: string): void {
    this.sessionIds.set(nodeName, sessionId);
  }

  /**
   * Fire-and-forget: send a prompt to a node and return immediately.
   *
   * The prompt is dispatched asynchronously — the agent starts running in the
   * background. Use fleet_get_session_status to poll for completion and
   * fleet_get_session_messages to retrieve the result.
   *
   * @param node     Target OpenCodeNode.
   * @param prompt   The prompt text to send.
   * @param options  Optional agent/model/reasoningEffort overrides.
   */
  async sendAsync(
    node: OpenCodeNode,
    prompt: string,
    options: SendOptions = {}
  ): Promise<AsyncSendResult> {
    let sessionId = await this.getOrCreateSession(node, options);

    // Attempt to send; on 404 recreate and retry once
    try {
      await node.sendPromptAsync(sessionId, prompt, options.reasoningEffort);
    } catch (err: unknown) {
      if (isNotFound(err)) {
        this.sessionIds.delete(node.name);
        const session = await node.createSession({
          cwd: options.cwd ?? "/",
          agent: options.agent,
          model: options.model,
        });
        sessionId = session.id;
        this.sessionIds.set(node.name, sessionId);
        await node.sendPromptAsync(sessionId, prompt, options.reasoningEffort);
      } else {
        throw err;
      }
    }

    return { sessionId, nodeStatus: "dispatched" };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isNotFound(err: unknown): boolean {
  if (err instanceof Error) {
    // NodeError sets statusCode
    const ne = err as Error & { statusCode?: number };
    if (ne.statusCode === 404) return true;
    if (err.message.includes("HTTP 404")) return true;
  }
  return false;
}
