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

There are no automated tests yet. Verify correctness by running the built binary against a live OpenCode node (see README for slave setup).

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
| `GET /session` | List sessions |
| `POST /session` | Create session |
| `DELETE /session/:id` | Delete session |
| `POST /session/:id/prompt_async` | Send prompt (non-blocking) |
| `GET /session/:id/message?limit=N` | Fetch messages |
| `GET /event` | SSE stream for idle detection |
| `POST /session/:id/abort` | Abort a running session (returns boolean) |

### Response shape for `GET /session/:id/message`

Returns `MessageWithParts[]` — each element is `{ info: Message, parts: Part[] }`, not a flat `Message[]`. The `info` field carries role/error; `parts` carries `TextPart` and other variants.

### Prompt request body for `POST /session/:id/prompt_async`

```json
{ "parts": [{ "type": "text", "text": "<prompt string>" }] }
```

## Extending the tool set

1. Add a new tool definition object to the `TOOL_DEFINITIONS` array in `src/tools.ts`.
2. Add a handler function (`handleMyTool`) in the same file.
3. Add a `case "my_tool":` branch in `dispatchTool()`.
4. Run `npm run build` to verify types.

## Common pitfalls

- **`waitForIdleViaSSE` resolves only once** — do not reuse the same SSE connection across multiple prompts. Each `send()` call opens and closes its own connection.
- **SSE stream is global** — `GET /event` emits events for *all* sessions on the node. Always filter by `sessionID` before acting on an event.
- **Node 18+ required** — the implementation uses native `fetch` with `ReadableStream`. Do not polyfill or replace with `node-fetch`.
- **No polling fallback** — if `GET /event` returns a non-200, a `NodeError` is thrown immediately. There is no silent retry or polling path.
