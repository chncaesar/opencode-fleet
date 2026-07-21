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

import { OpenCodeNode, type MessageWithParts } from "./node.js";
import type { FleetConfig } from "./config.js";

export interface SendResult {
  /** The last assistant text extracted from the session. */
  reply: string;
  /** True if the session returned an error part. */
  hasError: boolean;
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
   * Reuses the cached ID, or creates a new one if none exists or the
   * old one returns a 404.
   */
  async getOrCreateSession(node: OpenCodeNode): Promise<string> {
    const cached = this.sessionIds.get(node.name);
    if (cached) {
      // Trust the cached ID; if it's stale, sendPromptAsync will return 404
      // and send() will recreate it automatically.
      return cached;
    }

    // Create a new session
    const session = await node.createSession();
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
   * Send a prompt to a node and wait for the agent to finish.
   *
   * Flow:
   *  1. Ensure session exists (create if needed).
   *  2. POST /session/:id/prompt_async
   *  3. Poll GET /session/status until idle.
   *  4. GET /session/:id/message to fetch last reply.
   *
   * @param node    Target OpenCodeNode.
   * @param prompt  The prompt text to send.
   * @returns       SendResult with reply text and raw messages.
   */
  async send(node: OpenCodeNode, prompt: string): Promise<SendResult> {
    let sessionId = await this.getOrCreateSession(node);

    // Attempt to send; on 404 recreate and retry once
    try {
      await node.sendPromptAsync(sessionId, prompt);
    } catch (err: unknown) {
      if (isNotFound(err)) {
        this.sessionIds.delete(node.name);
        const session = await node.createSession();
        sessionId = session.id;
        this.sessionIds.set(node.name, sessionId);
        await node.sendPromptAsync(sessionId, prompt);
      } else {
        throw err;
      }
    }

    // Wait for idle via SSE
    await node.waitForIdle(sessionId, this.timeoutMs);

    // Fetch last messages
    const messages = await node.getMessages(sessionId, 10);
    const reply = node.extractLastReply(messages);

    // Detect error in assistant message info
    const hasError = messages.some(
      (mwp) =>
        mwp.info.role === "assistant" &&
        (mwp.info as { error?: unknown }).error != null
    );

    return { reply, hasError, messages };
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
