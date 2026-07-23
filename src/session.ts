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

import { OpenCodeNode, TimeoutError, type MessageWithParts } from "./node.js";
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

export interface SendResult {
  /** The last assistant text extracted from the session. */
  reply: string;
  /** True if the session returned an error part. */
  hasError: boolean;
  /**
   * True if the wait timed out before the agent became idle.
   * The agent is likely STILL RUNNING on the remote node.
   * Do NOT reset the session on timeout — use fleet_get_session_status to
   * check the agent's state and fleet_interrupt_session if you need to stop it.
   */
  timedOut: boolean;
  /** Raw messages (newest-first) at time of completion. */
  messages: MessageWithParts[];
}

export class SessionManager {
  /** Map from node name → active session ID */
  private sessionIds = new Map<string, string>();
  private readonly timeoutMs: number;

  constructor(config: FleetConfig) {
    this.timeoutMs = config.timeoutSeconds * 1000;
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
      // and send() will recreate it automatically.
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
   * Send a prompt to a node and wait for the agent to finish.
   *
   * @param node     Target OpenCodeNode.
   * @param prompt   The prompt text to send.
   * @param options  Optional agent/model/reasoningEffort overrides.
   */
  async send(
    node: OpenCodeNode,
    prompt: string,
    options: SendOptions = {}
  ): Promise<SendResult> {
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

    // Wait for idle via SSE; a TimeoutError means the agent is still running —
    // it is NOT a failure.  We capture it, fetch partial messages, and surface
    // a diagnostic reply so the master can decide what to do next.
    let timedOut = false;
    try {
      await node.waitForIdle(sessionId, this.timeoutMs);
    } catch (waitErr: unknown) {
      if (waitErr instanceof TimeoutError) {
        timedOut = true;
        // Fall through — fetch whatever messages are available so the master
        // can see tool activity and make an informed decision.
      } else {
        throw waitErr;
      }
    }

    // Fetch last messages
    const messages = await node.getMessages(sessionId, 10);
    const reply = node.extractLastReply(messages);

    // Detect error in assistant message info
    const hasError = messages.some(
      (mwp) =>
        mwp.info.role === "assistant" &&
        (mwp.info as { error?: unknown }).error != null
    );

    return { reply, hasError, timedOut, messages };
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
