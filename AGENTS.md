# AGENTS.md — opencode-fleet
## Implementation notes
## What this project is

`opencode-fleet` is an MCP server written in TypeScript. It allows a master OpenCode instance to coordinate multiple remote OpenCode nodes by exposing `fleet_*` MCP tools. The master agent calls these tools; the fleet server translates them into OpenCode REST API calls on each remote node.

## Repository layout

```
src/
  config.ts   — CLI argument parsing → FleetConfig
  node.ts     — HTTP client for one remote OpenCode node (REST + persistent SSE)
  session.ts  — Per-node session lifecycle (create, reuse, reset)
  tools.ts    — MCP tool definitions and handlers
  index.ts    — MCP Server stdio entry point
dist/         — Compiled JS output (tsc, gitignored)
tests/
  node.test.ts       — Unit tests (mocked fetch, 17 tests)
  tools.test.ts      — Unit tests (mocked SessionManager, 9 tests)
  e2e/
    helpers/
      env.ts         — Env var reading, skipIf guards, prompt factories
      harness.ts     — before/after hooks for session cleanup
    node.e2e.ts      — Live-node tests: ping, sessions, messages, waitForIdle, getSessionStatus
    session.e2e.ts   — SessionManager live tests: lazy create, reuse, 404 rebuild
    tools.e2e.ts     — All 11 fleet_* tool handlers against live nodes + dual-node tests
vitest.e2e.config.ts  — E2E vitest config (60s timeout, forks, verbose)
.env.e2e.example      — Template for E2E environment variables
examples/
  opencode.json  — Sample master opencode.json with fleet MCP config
```

## Build and verify

```bash
npm run build     # tsc, output → dist/
```

Run automated tests with:

```bash
npm test          # vitest, 24 unit tests (zero dependency, mocked HTTP)
npm run test:e2e  # vitest, 33 live tests (requires a running opencode slave node)
```

E2E tests require environment variables — see `.env.e2e.example`. If no nodes are configured, all E2E tests are skipped gracefully.

## Key design decisions

### Persistent SSE status stream (`node.ts` — `StatusStream`)

The status tracking mirrors the OpenCode desktop architecture (`packages/app/src/context/server-sdk.tsx`):

- **Persistent connection**: One `GET /event` SSE stream is opened per `OpenCodeNode` instance on construction (active start, not lazy). The connection is shared by all callers — no new HTTP request per `waitForIdle()` call.
- **Local status cache**: Every `session.status` event writes into `statusCache: Map<sessionID, SessionStatus>`. `getSessionStatus()` reads this cache — O(1), zero network. This mirrors the desktop's `session_status` store.
- **Idle waiters**: `waitForIdle(sessionId, timeoutMs)` registers a one-shot callback in `idleWaiters`. The moment the shared SSE stream emits `session.status: idle` for that session, the waiter resolves. No race condition — all callers share the same stream.
- **Heartbeat & reconnect**: 15s silence triggers an abort + reconnect with fixed 250ms delay — identical constants to the desktop's `HEARTBEAT_TIMEOUT_MS` and `RECONNECT_DELAY_MS`.
- **Optimistic busy**: `sendPromptAsync()` immediately writes `{ type: "busy" }` to the cache after the HTTP call returns, before the first SSE event arrives. This eliminates the race window between sending a prompt and the SSE event propagating — mirroring `submit.ts:60` in the desktop.
- **Destroy**: `node.destroy()` aborts the SSE stream and rejects all pending waiters.

Why not `/api/session/active`: The desktop client never uses this endpoint — it relies entirely on SSE events. Our implementation now does the same. The `/api/session/active` endpoint was removed from `getSessionStatus()` after testing showed it is unreliable across opencode deployments.

### Session lifecycle (`session.ts`)

One session per node, created lazily on the first `sendAsync()`. The session ID is cached in a `Map<nodeName, sessionId>`. If `sendPromptAsync` returns 404, the session is recreated automatically and the prompt is retried once. `fleet_reset_session` clears the cache entry manually.

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
| `GET /session/:id/message?limit=N` | Fetch newest N messages (ascending order; no /api prefix) |
| `GET /event` | SSE stream — persistent, shared by all callers on the same OpenCodeNode instance |
| `POST /api/session/:id/interrupt` | Interrupt a running session |

**Important path quirks (confirmed against opencode 1.18.4):**
- Endpoints with `/api` prefix return `{data: [...], cursor: {...}}` wrapped responses
- Endpoints *without* `/api` prefix return bare arrays/objects (legacy format)
- `GET /session/:id/message` returns newest N messages in **ascending** order (oldest-in-slice first, newest at index N-1)

### SSE event format

`GET /event` emits JSON payloads in `data:` lines. The event shape:

```json
{
  "id": "evt_xxx",
  "type": "session.status",
  "properties": {
    "sessionID": "ses_xxx",
    "status": { "type": "busy" }   // or { "type": "idle" }
  }
}
```

Both `properties` (legacy `GET /event`) and `data` (v2 `GET /api/event`) field names are checked in `applyEvent()`. The deprecated `session.idle` event type is also handled.

### Response shape for `GET /session/:id/message`

Returns `MessageWithParts[]` — each element is `{ info: Message, parts: Part[] }`, not a flat `Message[]`. The `info` field carries role/error; `parts` carries `TextPart`, `StepStartPart`, `StepFinishPart`, `ToolPart`, and other variants.

## Extending the tool set

1. Add a new tool definition object to the `TOOL_DEFINITIONS` array in `src/tools.ts`.
2. Add a handler function (`handleMyTool`) in the same file.
3. Add a `case "my_tool":` branch in `dispatchTool()`.
4. Add a unit test in `tests/tools.test.ts` (mocked `FleetContext`).
5. Add an E2E test in `tests/e2e/tools.e2e.ts` (against a live node).
6. Run `npm run build` to verify types.

## Fleet operation protocol for master agents

This section is directed at AI agents (Claude, OpenCode) acting as the **master** in a fleet session.

### Mental model

`fleet_send_message` is **fire-and-forget**: it dispatches a prompt to a slave node and returns immediately with the session ID. The slave runs autonomously in the background. The master never blocks waiting for a single slave — it can dispatch to multiple nodes in the same turn and poll them independently.

The standard workflow for any task:

1. **Dispatch** — call `fleet_send_message` for each slave. Returns immediately.
2. **Poll** — call `fleet_get_session_status` until status is `idle`.
3. **Retrieve** — call `fleet_get_session_messages` to get the result.

### Concurrent dispatch pattern

Dispatch multiple slaves in the same turn, then poll all of them:

```
# Turn 1 — dispatch concurrently
fleet_send_message(node_A, "task A")  → session_A
fleet_send_message(node_B, "task B")  → session_B

# Turn 2+ — poll until both idle
fleet_get_session_status(node_A)
fleet_get_session_status(node_B)

# When both idle — retrieve results
fleet_get_session_messages(node_A)
fleet_get_session_messages(node_B)
```

### Tool quick-reference

| Situation | Tool to use |
|---|---|
| Check node health **and** understand what it can do before dispatching | `fleet_node_health` (returns ping + capability summary by default) |
| Fast lightweight ping only (no capability fetch) | `fleet_node_health` with `include_capabilities: false` |
| Dispatch a task to a slave | `fleet_send_message` (returns immediately with session ID) |
| Check if slave finished | `fleet_get_session_status` |
| See what slave did / is doing | `fleet_get_session_messages` |
| Stop a running task (keep session) | `fleet_interrupt_session` |
| Stop a task after master restart (cache lost) | `fleet_list_sessions` to find session ID, then `fleet_interrupt_session` with `session_id` |
| Discard session and start fresh | `fleet_reset_session` (last resort, only when session is idle) |

### Slave safety and capability awareness

#### Why slaves can deadlock without `--auto`

When opencode runs in server mode (no terminal), any `ask`-level permission triggers an approval prompt that blocks forever — the session stays `busy` indefinitely, new messages queue up, and the fleet appears hung. Slaves **must** be started with `--auto` so that `deny` rules return errors immediately instead of waiting for human input.

#### `fleet_node_health` — capability-aware health check

`fleet_node_health` (with `include_capabilities: true`, the default) fetches the slave's runtime permission policy by dispatching a one-shot diagnostic session (`opencode debug config`). This gives the master the actual enforced rules before dispatching work.

**Why `opencode debug config` instead of reading a config file directly:**

`opencode debug config` returns the slave's **fully-merged runtime config** — all config layers resolved in order (global → project → managed). The managed config layer (highest priority, user-cannot-override) is already folded in. Reading individual files would miss this merge and could show rules that are actually overridden. Fleet never needs SSH credentials to read the slave's filesystem.

**Why capability fetch is built into `fleet_node_health` rather than a separate tool:**

The master naturally calls `fleet_node_health` before first use to confirm the node is alive. Embedding capability fetch there aligns the timing with when the master needs it, with no extra constraint needed. A separate `fleet_describe_node` would require the master to remember to call it first — which means relying on AGENTS.md discipline rather than tool design.

**Implementation details (for developers):**
- One-shot session: `createSession` → `sendPromptAsync` → `waitForIdle` → `getMessages` → `deleteSession`. Never touches the node's active session binding.
- JSON extraction uses bracket-depth counting (`findJsonEnd`) — immune to stray `}` inside string values.
- Capability summary covers bash / write / edit and any other configured tools, reporting five cases: allow-all, deny-all, ask-all, mixed rules, no rules configured.
- On timeout: returns structured three-step escalation guidance prompting human inspection.

## Implementation notes

- **Persistent SSE, not per-call**: The `StatusStream` is opened once per `OpenCodeNode` instance and shared. `waitForIdle()` registers a waiter on the shared stream rather than opening a new HTTP connection.
- **SSE stream is global**: `GET /event` emits events for *all* sessions on the node. Always filter by `sessionID` before acting on an event.
- **Bootstrap**: No separate bootstrap phase needed — the SSE stream receives `session.status: busy` events the moment any prompt starts executing. Combined with the optimistic busy write in `sendPromptAsync()`, there is no time window where `getSessionStatus()` returns a stale `idle`.
- **Node 18+ required**: The implementation uses native `fetch` with `ReadableStream`. Do not polyfill or replace with `node-fetch`.
- **`destroy()` required**: In long-running processes, call `node.destroy()` when a node is no longer needed to close the SSE connection and prevent resource leaks. The MCP server entry point (`index.ts`) does not call destroy — fine for short-lived stdio servers. Tests and long-lived apps should.
- **Testing**: Unit tests use `vitest` mocking; `getSessionStatus` tests inject status directly via `injectStatusForTesting()`. E2E tests hit live opencode slave nodes and require `E2E_NODE_*` environment variables — skipped silently if unset.
- **Dual-node E2E tests**: The concurrent send and cross-node isolation tests require both nodes configured. They use `describe.skipIf(skipIfNotBothNodes)`.
