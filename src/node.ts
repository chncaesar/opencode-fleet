/**
 * node.ts
 *
 * HTTP client for a single remote OpenCode instance.
 * Wraps all OpenCode REST API calls used by the fleet.
 */

import type { NodeConfig } from "./config.js";

// ── OpenCode REST types (subset) ──────────────────────────────────────────────

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

export interface Session {
  id: string;
  title: string;
  version: string;
  projectID: string;
  directory: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  time: { created: number; updated: number };
}

/** Options when creating a new session. */
export interface CreateSessionOptions {
  /** Working directory for the session. Required for the session to appear in the desktop UI. */
  cwd: string;
  title?: string;
  /** Agent mode, e.g. "build" or "plan". Defaults to the node's configured default. */
  agent?: string;
  /**
   * Model to use, as "providerID/modelID", e.g. "anthropic/claude-sonnet-4-6".
   * If omitted, the node's configured default model is used.
   */
  model?: string;
}

/** A model entry returned by GET /api/model. */
export interface ModelInfo {
  id: string;
  providerID: string;
  name: string;
  enabled?: boolean;
  status?: string;
}

export interface TextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
}

export interface StepStartPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-start";
  snapshot?: string;
}

export interface StepFinishPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-finish";
  reason?: string;
  snapshot?: string;
  cost?: number;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

export interface ToolState {
  status: "pending" | "running" | "completed" | "error";
  /** Input passed to the tool (shape depends on tool type). */
  input?: Record<string, unknown>;
  /** Output returned by the tool (string or structured). */
  output?: string | unknown;
  /** Error message if status === "error". */
  error?: string;
}

export interface ToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
}

export interface FilePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "file";
  mime?: string;
  filename?: string;
  url?: string;
}

// Catch-all for any future part types not yet modelled.
export type UnknownPart = { type: string; [key: string]: unknown };

export type Part =
  | TextPart
  | StepStartPart
  | StepFinishPart
  | ToolPart
  | FilePart
  | UnknownPart;

export interface AssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  error?: unknown;
}

export interface UserMessage {
  id: string;
  sessionID: string;
  role: "user";
}

export type Message = UserMessage | AssistantMessage;

/**
 * The actual response shape from GET /session/:id/message.
 * Each element pairs a Message info object with its Part array.
 */
export interface MessageWithParts {
  info: Message;
  parts: Part[];
}

// ── OpenCodeNode ──────────────────────────────────────────────────────────────

export class OpenCodeNode {
  readonly name: string;
  readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(config: NodeConfig, username: string, password: string) {
    this.name = config.name;
    // Strip trailing slash
    this.baseUrl = config.url.replace(/\/$/, "");
    const credentials = Buffer.from(`${username}:${password}`).toString("base64");
    this.authHeader = password ? `Basic ${credentials}` : "";
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.authHeader) h["Authorization"] = this.authHeader;
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new NodeError(
        `${method} ${path} → HTTP ${res.status}: ${text}`,
        res.status
      );
    }

    const text = await res.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  // ── Health ──────────────────────────────────────────────────────────────────

  /** Ping the node. Returns true if reachable and authenticated. */
  async ping(): Promise<boolean> {
    try {
      await this.request<unknown>("GET", "/global/health");
      return true;
    } catch {
      return false;
    }
  }

  // ── Session management ──────────────────────────────────────────────────────

  /** List all sessions on the node. */
  async listSessions(): Promise<Session[]> {
    const result = await this.request<Session[] | { sessions: Session[] }>(
      "GET",
      "/session"
    );
    // Handle both array and wrapped-object responses
    return Array.isArray(result) ? result : result.sessions ?? [];
  }

  /**
   * Create a new session.
   *
   * @param options  Optional title, agent mode, and model override.
   *                 model should be in "providerID/modelID" format.
   */
  async createSession(options: CreateSessionOptions): Promise<Session> {
    const body: Record<string, unknown> = {};
    body["cwd"] = options.cwd;
    if (options.title) body["title"] = options.title;
    if (options.agent) body["agent"] = options.agent;
    if (options.model) {
      const [providerID, ...rest] = options.model.split("/");
      const id = rest.join("/");
      if (providerID && id) {
        body["model"] = { id, providerID };
      }
    }
    return this.request<Session>("POST", "/session", body);
  }

  /** List all available models on the node. */
  async listModels(): Promise<ModelInfo[]> {
    const result = await this.request<{ data?: ModelInfo[]; location?: unknown }>(
      "GET",
      "/api/model"
    );
    return result.data ?? [];
  }

  /** Delete / close a session. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/session/${sessionId}`);
  }

  /**
   * Send an abort signal to a running session.
   * Returns true if the session acknowledged the abort, false if it was not running.
   * This is fire-and-forget — it does NOT wait for the session to become idle.
   */
  async abortSession(sessionId: string): Promise<boolean> {
    return this.request<boolean>("POST", `/session/${sessionId}/abort`);
  }

  // ── Messaging ───────────────────────────────────────────────────────────────

  /**
   * Send a prompt to a session asynchronously (non-blocking).
   * The agent begins processing; use pollStatus() to wait for completion.
   *
   * @param sessionId         Target session ID.
   * @param prompt            The prompt text.
   * @param reasoningEffort   Optional reasoning effort hint ("low" | "medium" | "high").
   */
  async sendPromptAsync(
    sessionId: string,
    prompt: string,
    reasoningEffort?: string
  ): Promise<void> {
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: prompt }],
    };
    if (reasoningEffort) body["reasoning_effort"] = reasoningEffort;
    await this.request<unknown>("POST", `/session/${sessionId}/prompt_async`, body);
  }

  /**
   * Get messages for a session, newest-first.
   * Returns the wrapped format: each element is { info: Message, parts: Part[] }.
   * @param limit Max number of messages to return.
   */
  async getMessages(sessionId: string, limit = 20): Promise<MessageWithParts[]> {
    return this.request<MessageWithParts[]>(
      "GET",
      `/session/${sessionId}/message?limit=${limit}`
    );
  }

  // ── Convenience ─────────────────────────────────────────────────────────────

  /**
   * Wait for a session to become idle using Server-Sent Events.
   *
   * Connects to GET /event and listens for:
   *   - session.status  { sessionID, status: { type: "idle" } }
   *   - session.idle    { sessionID }  (deprecated but still emitted)
   *
   * The fetch is aborted via AbortController when the deadline is reached.
   *
   * @throws TimeoutError  if the session is still busy after timeoutMs.
   * @throws NodeError     if the SSE connection fails (caller should fallback).
   */
  async waitForIdleViaSSE(
    sessionId: string,
    timeoutMs: number
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/event`, {
        method: "GET",
        headers: {
          ...this.headers(),
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new NodeError(
          `GET /event → HTTP ${res.status}: ${text}`,
          res.status
        );
      }

      if (!res.body) {
        throw new NodeError("GET /event returned no response body");
      }

      // Parse the SSE stream line by line
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split("\n");
        // Keep the last (potentially incomplete) chunk in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trimEnd();

          if (!trimmed.startsWith("data:")) continue;

          const jsonStr = trimmed.slice("data:".length).trim();
          if (!jsonStr) continue;

          let event: SseEvent;
          try {
            event = JSON.parse(jsonStr) as SseEvent;
          } catch {
            continue; // malformed JSON — skip
          }

          if (isIdleEvent(event, sessionId)) {
            // Session reached idle — clean up and resolve
            reader.cancel().catch(() => undefined);
            return;
          }
        }
      }

      // Stream ended without an idle event — treat as timeout
      throw new TimeoutError(
        `Session ${sessionId} on node "${this.name}" SSE stream ended without becoming idle`
      );
    } catch (err) {
      if (isAbortError(err)) {
        throw new TimeoutError(
          `Session ${sessionId} on node "${this.name}" did not become idle within ${timeoutMs}ms (SSE timeout)`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Wait for a session to become idle via SSE.
   * Connects to GET /event and resolves when session.status(idle) arrives.
   *
   * @throws TimeoutError  if the session is still busy after timeoutMs.
   * @throws NodeError     if the SSE connection fails.
   */
  async waitForIdle(
    sessionId: string,
    timeoutMs: number
  ): Promise<void> {
    return this.waitForIdleViaSSE(sessionId, timeoutMs);
  }

  /**
   * Extract the last assistant text reply from a message list.
   * Returns an empty string if no assistant message is found.
   */
  extractLastReply(messages: MessageWithParts[]): string {
    // Messages are returned newest-first from the API
    for (const mwp of messages) {
      if (mwp.info.role !== "assistant") continue;

      const text = mwp.parts
        .filter((p): p is TextPart => p.type === "text")
        .map((p) => p.text)
        .join("");

      if (text) return text;
    }
    return "";
  }
}

// ── Custom errors ─────────────────────────────────────────────────────────────

export class NodeError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "NodeError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

/**
 * Shape of each JSON payload in the SSE stream from GET /event.
 * OpenCode emits all events on the "message" SSE event name;
 * the discriminant is the `type` field inside the JSON data.
 */
interface SseEvent {
  id?: string;
  type: string;
  /** Legacy field name used by GET /event (not /api/event). */
  properties?: Record<string, unknown>;
  /** V2 API uses "data" instead of "properties". */
  data?: Record<string, unknown>;
}

/**
 * Return true if this SSE event signals that the given session is now idle.
 */
function isIdleEvent(event: SseEvent, sessionId: string): boolean {
  const props = (event.properties ?? event.data) as Record<string, unknown> | undefined;
  if (!props) return false;

  if (event.type === "session.status") {
    if (props["sessionID"] !== sessionId) return false;
    const status = props["status"] as { type?: string } | undefined;
    return status?.type === "idle";
  }

  if (event.type === "session.idle") {
    // Deprecated but still emitted — treat as idle
    return props["sessionID"] === sessionId;
  }

  return false;
}

/**
 * Return true if an error is an AbortController abort signal.
 */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError" || err.message.includes("aborted");
  }
  return false;
}
