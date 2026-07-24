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

// ── StatusStream ─────────────────────────────────────────────────────────────

/**
 * Persistent SSE subscriber for a single OpenCode node.
 *
 * Mirrors the desktop architecture (packages/app/src/context/server-sdk.tsx):
 *   - Opens GET /event on construction, reconnects on error/timeout.
 *   - Maintains a local statusCache: Map<sessionId, SessionStatus>.
 *   - Fires idle waiters registered by waitForIdle().
 *   - 15s heartbeat timeout triggers reconnect (same as desktop).
 *   - Fixed 250ms reconnect delay (same as desktop RECONNECT_DELAY_MS).
 *   - destroy() closes the stream permanently.
 */
class StatusStream {
  /** Live status for every session seen since last (re)connect. */
  readonly statusCache = new Map<string, SessionStatus>();

  /**
   * Pending waiters per session: each entry is a Set of { resolve, reject }
   * pairs waiting for that session to become idle.
   */
  private readonly idleWaiters = new Map<
    string,
    Set<{ resolve: () => void; reject: (err: unknown) => void }>
  >();

  private destroyed = false;
  private abortCtrl = new AbortController();

  // Mirrors desktop constants
  private static readonly HEARTBEAT_TIMEOUT_MS = 15_000;
  private static readonly RECONNECT_DELAY_MS = 250;

  constructor(
    private readonly baseUrl: string,
    private readonly authHeaders: Record<string, string>
  ) {
    // Start immediately — same as desktop's onMount (not lazy).
    void this.loop();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Return the cached status for a session.
   * O(1), zero network — reads the local cache populated by the SSE stream.
   * Returns idle for any session not yet seen (conservative default).
   */
  getStatus(sessionId: string): SessionStatus {
    return this.statusCache.get(sessionId) ?? { type: "idle" };
  }

  /**
   * Register a one-shot waiter that resolves when the session emits
   * session.status: idle.  Times out with TimeoutError after timeoutMs.
   *
   * Mirrors desktop logic: only resolve immediately if the cache
   * *explicitly* shows idle.  If the session is not yet in the cache,
   * we must wait — the SSE stream may not have received the first
   * session.status: busy event yet.
   */
  waitForIdle(sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Only short-circuit if we have an explicit idle status in cache.
      // "not in cache" ≠ idle — it means we haven't heard from this session yet.
      const cached = this.statusCache.get(sessionId);
      if (cached?.type === "idle") {
        resolve();
        return;
      }

      const entry = { resolve, reject };

      let waiters = this.idleWaiters.get(sessionId);
      if (!waiters) {
        waiters = new Set();
        this.idleWaiters.set(sessionId, waiters);
      }
      waiters.add(entry);

      const timer = setTimeout(() => {
        const w = this.idleWaiters.get(sessionId);
        if (w) {
          w.delete(entry);
          if (w.size === 0) this.idleWaiters.delete(sessionId);
        }
        reject(
          new TimeoutError(
            `Session ${sessionId} did not become idle within ${timeoutMs}ms`
          )
        );
      }, timeoutMs);

      // Wrap resolve/reject so we always clear the timer.
      const originalResolve = entry.resolve;
      const originalReject = entry.reject;
      entry.resolve = () => { clearTimeout(timer); originalResolve(); };
      entry.reject = (err: unknown) => { clearTimeout(timer); originalReject(err); };
    });
  }

  /** Permanently close the SSE connection and reject all pending waiters. */
  destroy(): void {
    this.destroyed = true;
    this.abortCtrl.abort();
    const err = new NodeError("StatusStream destroyed");
    for (const waiters of this.idleWaiters.values()) {
      for (const w of waiters) w.reject(err);
    }
    this.idleWaiters.clear();
  }

  // ── Reconnect loop ──────────────────────────────────────────────────────────

  /**
   * Outer reconnect loop — mirrors desktop's while(!abort.signal.aborted) loop.
   * Reconnects with fixed 250ms delay after any stream error or heartbeat timeout.
   */
  private async loop(): Promise<void> {
    while (!this.destroyed) {
      // Each attempt gets its own AbortController for heartbeat cancellation.
      const attempt = new AbortController();

      // Cancel this attempt if the whole stream is destroyed.
      const onDestroy = () => attempt.abort();
      this.abortCtrl.signal.addEventListener("abort", onDestroy, { once: true });

      try {
        await this.connect(attempt.signal);
      } catch {
        // Swallow — reconnect after delay unless destroyed.
      } finally {
        this.abortCtrl.signal.removeEventListener("abort", onDestroy);
        attempt.abort();
      }

      if (this.destroyed) break;

      await sleep(StatusStream.RECONNECT_DELAY_MS);
    }
  }

  /**
   * Open GET /event, parse the SSE stream, update statusCache, fire waiters.
   * Mirrors desktop's `connect` attempt inside the while loop.
   *
   * Heartbeat: any event resets the timer; 15s silence aborts → reconnect.
   */
  private async connect(signal: AbortSignal): Promise<void> {
    // Heartbeat timer — reset on every event received.
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;

    const resetHeartbeat = () => {
      if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        (signal as AbortSignal & { __ctrl?: AbortController }).__ctrl?.abort();
      }, StatusStream.HEARTBEAT_TIMEOUT_MS);
    };

    // We need a per-attempt controller to implement heartbeat abort.
    // The caller passes us the signal; we create a child controller here.
    const child = new AbortController();
    signal.addEventListener("abort", () => child.abort(), { once: true });

    // Store child on the signal so resetHeartbeat can abort it.
    (signal as AbortSignal & { __ctrl?: AbortController }).__ctrl = child;

    try {
      const res = await fetch(`${this.baseUrl}/event`, {
        method: "GET",
        headers: { ...this.authHeaders, Accept: "text/event-stream", "Cache-Control": "no-cache" },
        signal: child.signal,
      });

      if (!res.ok || !res.body) return; // Will reconnect.

      resetHeartbeat();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          resetHeartbeat();
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trimEnd();
            if (!trimmed.startsWith("data:")) continue;
            const jsonStr = trimmed.slice("data:".length).trim();
            if (!jsonStr) continue;

            let event: SseEvent;
            try { event = JSON.parse(jsonStr) as SseEvent; }
            catch { continue; }

            this.applyEvent(event);
          }
        }
      } finally {
        clearTimeout(heartbeatTimer);
        reader.cancel().catch(() => undefined);
      }
    } catch {
      clearTimeout(heartbeatTimer);
      // Propagate to loop() for reconnect.
      throw new Error("SSE connect failed");
    }
  }

  // ── Event handling ──────────────────────────────────────────────────────────

  /**
   * Apply one parsed SSE event to the local cache and fire any waiters.
   * Mirrors desktop's server-session.ts apply() case "session.status".
   */
  private applyEvent(event: SseEvent): void {
    const props = (event.properties ?? event.data) as Record<string, unknown> | undefined;
    if (!props) return;

    if (event.type === "session.status") {
      const sessionId = props["sessionID"] as string | undefined;
      if (!sessionId) return;

      const status = props["status"] as SessionStatus | undefined;
      if (!status) return;

      // Write to cache (mirrors setData("session_status", ...))
      this.statusCache.set(sessionId, status);

      // Fire idle waiters
      if (status.type === "idle") {
        this.fireIdleWaiters(sessionId);
      }
      return;
    }

    if (event.type === "session.idle") {
      // Deprecated but still emitted — treat as idle
      const sessionId = props["sessionID"] as string | undefined;
      if (!sessionId) return;
      this.statusCache.set(sessionId, { type: "idle" });
      this.fireIdleWaiters(sessionId);
    }
  }

  private fireIdleWaiters(sessionId: string): void {
    const waiters = this.idleWaiters.get(sessionId);
    if (!waiters) return;
    this.idleWaiters.delete(sessionId);
    for (const w of waiters) w.resolve();
  }
}

// ── OpenCodeNode ──────────────────────────────────────────────────────────────

export class OpenCodeNode {
  readonly name: string;
  readonly baseUrl: string;
  private readonly authHeader: string;
  /** Persistent SSE subscriber — started on construction, mirrors desktop. */
  private readonly statusStream: StatusStream;

  constructor(config: NodeConfig, username: string, password: string) {
    this.name = config.name;
    // Strip trailing slash
    this.baseUrl = config.url.replace(/\/$/, "");
    const credentials = Buffer.from(`${username}:${password}`).toString("base64");
    this.authHeader = password ? `Basic ${credentials}` : "";
    // Start SSE stream immediately (main process, not lazy — same as desktop).
    this.statusStream = new StatusStream(this.baseUrl, this.sseHeaders());
  }

  /** Permanently close the SSE stream. Call when the node is no longer needed. */
  destroy(): void {
    this.statusStream.destroy();
  }

  /**
   * Inject a session status directly into the SSE cache.
   * For testing only — allows unit tests to set up status without a live SSE stream.
   * @internal
   */
  injectStatusForTesting(sessionId: string, status: SessionStatus): void {
    this.statusStream.statusCache.set(sessionId, status);
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

  /** Headers used for the persistent SSE connection. */
  private sseHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
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
   * Send an abort/interrupt signal to a running session.
   * Returns true if the interrupt was acknowledged, false otherwise.
   * This is fire-and-forget — it does NOT wait for the session to become idle.
   *
   * Uses POST /api/session/:id/interrupt (the correct opencode endpoint).
   */
  async abortSession(sessionId: string): Promise<boolean> {
    try {
      await this.request<unknown>("POST", `/api/session/${sessionId}/interrupt`);
      return true;
    } catch {
      return false;
    }
  }

  // ── Messaging ───────────────────────────────────────────────────────────────

  /**
   * Send a prompt to a session asynchronously (non-blocking).
   * The agent begins processing; use pollStatus() to wait for completion.
   *
   * @param sessionId         Target session ID.
   * @param prompt            The prompt text.
   * @param reasoningEffort   Optional reasoning effort hint ("low" | "medium" | "high").
   *                          Passed as the `variant` field in the v1 prompt body, which maps
   *                          to model.variants[variant] → { reasoningEffort } at the server.
   *                          Silently ignored if the target model has no matching variant key.
   */
  async sendPromptAsync(
    sessionId: string,
    prompt: string,
    reasoningEffort?: string
  ): Promise<void> {
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: prompt }],
    };
    // v1 API uses `variant` (not `reasoning_effort`) to select a named model config preset.
    // The server looks up model.variants[variant] and merges the result into LLM options,
    // which is where reasoningEffort ultimately reaches the provider SDK.
    if (reasoningEffort) body["variant"] = reasoningEffort;
    await this.request<unknown>("POST", `/session/${sessionId}/prompt_async`, body);
    // Optimistic update — mirrors desktop submit.ts:60 which immediately sets
    // session_status to busy before the SSE event arrives, eliminating the
    // race window between sendPromptAsync returning and the first SSE event.
    this.statusStream.statusCache.set(sessionId, { type: "busy" });
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
   * Wait for a session to become idle.
   *
   * Delegates to the persistent StatusStream which is driven by the shared
   * GET /event SSE connection.  No new HTTP request is made; resolution
   * happens the moment the SSE stream emits session.status: idle for this
   * session — identical to how the desktop client tracks completion.
   *
   * @throws TimeoutError  if the session is still busy after timeoutMs.
   */
  async waitForIdleViaSSE(
    sessionId: string,
    timeoutMs: number
  ): Promise<void> {
    return this.statusStream.waitForIdle(sessionId, timeoutMs);
  }

  /**
   * Wait for a session to become idle.
   * Delegates to waitForIdleViaSSE (persistent SSE stream).
   *
   * @throws TimeoutError  if the session is still busy after timeoutMs.
   */
  async waitForIdle(sessionId: string, timeoutMs: number): Promise<void> {
    return this.waitForIdleViaSSE(sessionId, timeoutMs);
  }

  /**
   * Query the current execution status of a session.
   *
   * Reads from the local statusCache maintained by the persistent SSE stream —
   * O(1), zero network request.  This mirrors the desktop's session_working()
   * helper which reads from the same SSE-driven store.
   *
   * Returns idle for sessions not yet seen in the stream (conservative default).
   */
  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    return this.statusStream.getStatus(sessionId);
  }

  /**
   * @deprecated The persistent SSE stream makes this unnecessary.
   * Kept for backwards compatibility with existing callers and unit tests.
   * Infers status from message history (step-finish scan).
   * @internal
   */
  async getSessionStatusFallback(sessionId: string): Promise<SessionStatus> {
    const messages = await this.request<MessageWithParts[]>(
      "GET",
      `/session/${sessionId}/message`
    );

    if (messages.length === 0) return { type: "idle" };

    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return { type: "idle" };

    const hasStepFinish = messages
      .slice(lastUserIdx + 1)
      .some((m) => m.parts.some((p) => p.type === "step-finish"));
    return { type: hasStepFinish ? "idle" : "busy" };
  }

  /**
   * Extract the last assistant text reply from a message list.
   *
   * If the most recent assistant message has no TextParts yet (the agent is
   * mid-step doing pure tool calls), falls back to a human-readable summary
   * of the tool activity so the master can see the agent is busy rather than
   * receiving a misleading empty string.
   *
   * Returns an empty string only if there are no assistant messages at all.
   */
  extractLastReply(messages: MessageWithParts[]): string {
    // Messages are returned in ascending order (oldest first, newest last).
    // Scan from the end to find the most recent assistant message.
    for (let i = messages.length - 1; i >= 0; i--) {
      const mwp = messages[i];
      if (mwp.info.role !== "assistant") continue;

      const text = mwp.parts
        .filter((p): p is TextPart => p.type === "text")
        .map((p) => p.text)
        .join("");

      if (text) return text;

      // No text yet — the agent is likely mid-step doing tool calls.
      // Build a summary from ToolParts so the caller knows work is in progress.
      const toolParts = mwp.parts.filter((p): p is ToolPart => p.type === "tool");
      if (toolParts.length > 0) {
        const lines = ["[Agent is busy — no text reply yet. Tool activity in progress:]"];
        for (const tp of toolParts) {
          const status = tp.state.status === "completed" ? "✓"
            : tp.state.status === "error" ? "✗"
            : tp.state.status === "running" ? "⟳"
            : "…";
          let inputSummary = "";
          if (tp.tool === "bash" && typeof tp.state.input?.["command"] === "string") {
            inputSummary = tp.state.input["command"] as string;
          } else if (tp.state.input) {
            const firstVal = Object.values(tp.state.input).find((v) => typeof v === "string");
            inputSummary = firstVal != null ? String(firstVal) : "";
          }
          lines.push(`  [tool:${tp.tool}] ${status} ${inputSummary}`.trimEnd());
        }
        return lines.join("\n");
      }

      // Assistant message exists but has neither text nor tool parts yet.
      return "[Agent started processing — no output yet]";
    }
    return "";
  }
} // end OpenCodeNode

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

/** Utility used by StatusStream.connect to detect fetch AbortController errors. */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError" || err.message.includes("aborted");
  }
  return false;
}

/** Async sleep helper used by StatusStream reconnect loop. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
