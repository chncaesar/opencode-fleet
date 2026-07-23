# AGENTS.md — opencode-fleet

Instructions for AI agents (OpenCode, Claude, etc.) operating in this repository.

## What this project is

`opencode-fleet` is an MCP server written in TypeScript. It allows a master OpenCode instance to coordinate multiple remote OpenCode nodes by exposing `fleet_*` MCP tools. The master agent calls these tools; the fleet server translates them into OpenCode REST API calls on each remote node.

## Repository layout

```
src/
  config.ts   — CLI argument parsing → FleetConfig
  node.ts     — HTTP client for one remote OpenCode node (REST + SSE)
  session.ts  — Per-node session lifecycle (create, reuse, reset)
  tools.ts    — MCP tool definitions and handlers
  index.ts    — MCP Server stdio entry point
dist/         — Compiled JS output (tsc, gitignored)
examples/
  opencode.json  — Sample master opencode.json with fleet MCP config
```

## Build and verify

```bash
npm run build     # tsc, output → dist/
```

Run automated tests with:

```bash
npm test     # vitest, 26 assertions across node.test.ts + tools.test.ts
```

Additional verification: run the built binary against a live OpenCode node (see README for slave setup).

## Key design decisions

### SSE-only completion detection (`node.ts`)

`waitForIdle()` calls `waitForIdleViaSSE()` directly — there is no fallback path.

`waitForIdleViaSSE()` opens `GET /event` with an `AbortController` deadline, reads the SSE stream line by line, and resolves the moment a matching idle event arrives for the target session:

- `session.status` with `properties.status.type === "idle"` and `properties.sessionID === sessionId`
- `session.idle` with `properties.sessionID === sessionId` (deprecated, still emitted)

Both `properties` (legacy `GET /event`) and `data` (v2 `GET /api/event`) field names are checked.

If the deadline fires, `AbortController.abort()` cancels the stream and a `TimeoutError` is thrown. If the stream ends without an idle event, a `TimeoutError` is also thrown. `NodeError` (non-200 HTTP response) propagates to the caller unchanged.

### Session lifecycle (`session.ts`)

One session per node, created lazily on the first `send()`. The session ID is cached in a `Map<nodeName, sessionId>`. If `sendPromptAsync` returns 404, the session is recreated automatically and the prompt is retried once. `fleet_reset_session` clears the cache entry manually.

### Authentication

HTTP Basic Auth using `--password` / `--username` CLI args or `FLEET_PASSWORD` / `FLEET_USERNAME` env vars. The auth header is constructed in the `OpenCodeNode` constructor and attached to every request.

### OpenCode REST API endpoints used

| Endpoint | Purpose |
|---|---|
| `GET /global/health` | Health check / ping |
| `GET /session` | List sessions (no /api prefix — returns bare array) |
| `POST /session` | Create session |
| `DELETE /session/:id` | Delete session |
| `GET /api/model` | List available models |
| `POST /session/:id/prompt_async` | Send prompt (non-blocking, returns 204) |
| `POST /session/:id/prompt` | Send prompt (blocking, returns 200) |
| `GET /session/:id/message?limit=N` | Fetch newest N messages (ascending order; no /api prefix) |
| `GET /api/session/active` | Map of running sessions — returns `{data:{[sessionID]:{type:"running"}}}` |
| `GET /event` | SSE stream for idle detection (no /api prefix) |
| `POST /api/session/:id/interrupt` | Interrupt a running session |

**Important path quirks (confirmed against opencode 1.18.4):**
- Endpoints with `/api` prefix return `{data: [...], cursor: {...}}` wrapped responses
- Endpoints *without* `/api` prefix return bare arrays/objects (legacy format)
- `GET /session/:id/message` returns newest N messages in **ascending** order (oldest-in-slice first, newest at index N-1)
- `GET /api/session/active` returns `{data: {[sessionID]: {type: "running"}}}` — must unwrap `.data` before checking session presence

### Response shape for `GET /session/:id/message`

Returns `MessageWithParts[]` — each element is `{ info: Message, parts: Part[] }`, not a flat `Message[]`. The `info` field carries role/error; `parts` carries `TextPart` and other variants.

```json
{ "parts": [{ "type": "text", "text": "<prompt string>" }] }
```

## Extending the tool set

1. Add a new tool definition object to the `TOOL_DEFINITIONS` array in `src/tools.ts`.
2. Add a handler function (`handleMyTool`) in the same file.
3. Add a `case "my_tool":` branch in `dispatchTool()`.
4. Run `npm run build` to verify types.

## Fleet operation protocol for master agents

This section is directed at AI agents (Claude, OpenCode) acting as the **master** in a fleet session. Following this protocol prevents the most common failure mode: blindly resetting a slave session that is still running.

### Mental model

A `fleet_send_message` call blocks until the slave becomes idle **or** a timeout fires. A **timeout is not a failure** — it means the slave is still working and simply did not finish within the allotted window. The slave session is still alive and should not be discarded.

### Decision tree after fleet_send_message returns

```
fleet_send_message returns
         │
         ├── Status: completed ──────────────────► normal flow, use reply
         │
         ├── Status: completed with error ────────► inspect reply, decide to retry or fix
         │
         └── Status: TIMEOUT (still running)
                  │
                  ▼
          1. fleet_get_session_status          ← check if still busy
                  │
                  ├── idle  ─────────────────► fetch messages, proceed normally
                  │
                  └── busy  ─────────────────► 2. fleet_get_session_messages (view progress)
                                                       │
                                                       ├── looks fine, just slow
                                                       │        └─► wait, then retry fleet_send_message
                                                       │
                                                       ├── stuck / wrong path
                                                       │        └─► fleet_interrupt_session → wait → retry
                                                       │
                                                       └── ONLY if completely broken
                                                                └─► fleet_interrupt_session
                                                                    → confirm idle via fleet_get_session_status
                                                                    → fleet_reset_session (LAST RESORT)
```

### Rules

1. **Never reset on timeout.** A timeout means the slave is busy, not broken.
2. **Check before resetting.** Always call `fleet_get_session_status` before `fleet_reset_session`.
3. **Interrupt before reset.** If you must stop a busy session, call `fleet_interrupt_session` first and confirm idle, then reset.
4. **Empty reply ≠ failure.** If the reply is empty or shows tool activity, the agent was mid-step. Check messages for context.
5. **Queued messages accumulate.** If you send multiple prompts while the slave is busy, they queue up. Use `fleet_get_session_messages` to see what the slave received before sending more.
6. **Escalate to human** if the slave is stuck and you cannot determine why after two attempts. Do not loop indefinitely.

### Tool quick-reference

| Situation | Tool to use |
|---|---|
| Check if slave finished | `fleet_get_session_status` |
| See what slave did / is doing | `fleet_get_session_messages` |
| Stop a running task (keep session) | `fleet_interrupt_session` |
| Discard session and start fresh | `fleet_reset_session` (last resort) |



- **`waitForIdleViaSSE` resolves only once** — do not reuse the same SSE connection across multiple prompts. Each `send()` call opens and closes its own connection.
- **SSE stream is global** — `GET /event` emits events for *all* sessions on the node. Always filter by `sessionID` before acting on an event.
- **Node 18+ required** — the implementation uses native `fetch` with `ReadableStream`. Do not polyfill or replace with `node-fetch`.
- **No polling fallback** — if `GET /event` returns a non-200, a `NodeError` is thrown immediately. There is no silent retry or polling path.
