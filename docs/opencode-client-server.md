# opencode Client/Server Communication Memo

Source: `/work/code/opencode` — analyzed 2026-07-23.

---

## Architecture Overview

opencode runs as a local HTTP server (default port 4096). All UI frontends (TUI, desktop app) and external tools (like this MCP server) communicate with it via REST + SSE. The server is defined in `packages/server/`, the generated TypeScript client in `packages/client/src/generated/client.ts`, and all endpoint contracts in `packages/protocol/src/`.

---

## HTTP Endpoints

### Health

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Liveness check (Protocol/v2 layer) → `{ healthy: true }` |
| GET | `/global/health` | Liveness check (RootHttpApi/v1 layer) → `{ healthy: true, version: string }` — also carries `version`, used by fleet `ping()` |

### Sessions

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/session` | List sessions (paginated, cursor-based) |
| POST | `/api/session` | Create session |
| GET | `/api/session/active` | **Map of running sessions** → `{ [sessionID]: { type: "running" } }` — only currently-executing sessions appear here |
| GET | `/api/session/:sessionID` | Get one session |
| POST | `/api/session/:sessionID/prompt` | **Send a message** → `SessionInput.Admitted` |
| POST | `/api/session/:sessionID/wait` | **Long-poll until idle** — blocks until agent finishes current turn |
| POST | `/api/session/:sessionID/interrupt` | Interrupt active execution |
| POST | `/api/session/:sessionID/compact` | Compact conversation context |
| POST | `/api/session/:sessionID/agent` | Switch agent for next turns |
| POST | `/api/session/:sessionID/model` | Switch model for next turns |
| POST | `/api/session/:sessionID/revert/stage` | Stage revert to prior boundary |
| POST | `/api/session/:sessionID/revert/clear` | Clear staged revert |
| POST | `/api/session/:sessionID/revert/commit` | Commit staged revert |
| GET | `/api/session/:sessionID/context` | Active context messages after last compaction |
| GET | `/api/session/:sessionID/history` | Paginated durable event history |
| GET | `/api/session/:sessionID/event` | **SSE stream** — replay + live durable events |
| GET | `/api/session/:sessionID/message` | Paginated projected messages (oldest-first when limit given) |
| GET | `/api/session/:sessionID/message/:messageID` | Get one message |
| GET | `/api/session/:sessionID/permission` | List session permission requests |
| POST | `/api/session/:sessionID/permission` | Create/evaluate a permission request |
| POST | `/api/session/:sessionID/permission/:requestID/reply` | Approve or deny a permission |
| GET | `/api/session/:sessionID/question` | List session question requests |
| POST | `/api/session/:sessionID/question/:requestID/reply` | Answer a question |
| POST | `/api/session/:sessionID/question/:requestID/reject` | Reject a question |

### Models / Providers

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/model` | List available models |
| GET | `/api/provider` | List providers |
| GET | `/api/provider/:providerID` | Get one provider |

### File System

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/fs/read/*` | Read file (raw bytes) |
| GET | `/api/fs/list` | List directory |
| GET | `/api/fs/find` | Recursive ranked file search |

### Global SSE

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/event` | **All server events** — live only (no replay), includes heartbeat comment every 15s |

### PTY

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/pty` | List PTY sessions |
| POST | `/api/pty` | Create PTY session |
| GET/PUT/DELETE | `/api/pty/:ptyID` | Get / update / terminate PTY |
| POST | `/api/pty/:ptyID/connect-token` | Issue WebSocket ticket |
| GET | `/api/pty/:ptyID/connect` | **WebSocket** — stream PTY I/O |

---

## SSE Event System

### Two distinct streams

**Global stream** — `GET /api/event`
- Live only (no replay of past events)
- Every event the server emits, all domains
- Starts with a synthetic `{ type: "server.connected", data: {} }` event
- Keepalive comment `: heartbeat` every 15 seconds

**Per-session durable stream** — `GET /api/session/:sessionID/event`
- Replays all durable events for the session starting after optional `?after=<seq>`
- Continues streaming live durable events as they commit
- Only the durable subset (no streaming deltas like `text.delta`)

### Event envelope shape

```ts
{
  id: string,
  type: string,                          // discriminant — see below
  data: Record<string, unknown>,         // event-specific payload
  metadata?: Record<string, unknown>,
  durable?: {
    aggregateID: string,
    seq: number,
    version: number,
  },
  location?: { directory: string, workspaceID?: string },
}
```

### Key session event types

| Type | Durable? | Description |
|------|----------|-------------|
| `session.next.prompt.admitted` | ✅ | User prompt accepted into queue |
| `session.next.prompted` | ✅ | Prompt promoted to active context |
| `session.next.step.started` | ✅ | LLM turn begins |
| `session.next.step.ended` | ✅ | **LLM turn finished** (tokens + cost) — agent idle after this |
| `session.next.step.failed` | ✅ | LLM turn error |
| `session.next.text.started` | ✅ | Text generation begins |
| `session.next.text.delta` | ❌ live only | Streaming text chunk |
| `session.next.text.ended` | ✅ | Text generation complete |
| `session.next.tool.called` | ✅ | Tool invocation recorded |
| `session.next.tool.progress` | ✅ | Tool progress checkpoint |
| `session.next.tool.success` | ✅ | Tool completed successfully |
| `session.next.tool.failed` | ✅ | Tool failed |
| `session.next.compaction.started/ended` | ✅ | Context compaction |
| `server.connected` | ❌ | Synthetic — SSE stream opened |
| `global.disposed` | ❌ | Server shutting down |

---

## Message Send — Full Call Chain

```
[Client]
  client.sessions.prompt({ sessionID, prompt: { text }, delivery })
    → POST /api/session/:sessionID/prompt
          body: { id?, prompt, delivery?, resume? }

[Server handler] packages/server/src/handlers/session.ts:139
  session.prompt({ sessionID, id, prompt, delivery, resume })

[Core] packages/core/src/session.ts:360
  SessionV2.Service.prompt()
    1. Verifies session exists
    2. Resolves file attachments (MIME)
    3. SessionInput.admit(db, events, { ... })
       → publishes SessionEvent.PromptAdmitted (durable, to SQLite + PubSub)
    4. execution.wake(sessionID)   ← if resume !== false

[Run coordinator] packages/core/src/session/run-coordinator.ts:81
  wake(sessionID)
    - If fiber already running: set pendingWake=true (coalesce)
    - If idle: fork new drain fiber → SessionRunner.run()

[LLM runner] packages/core/src/session/runner/llm.ts:383
  run() loop:
    while (hasPending):
      promoteSteers()  → publishes session.next.prompted
      runTurnAttempt():
        - Build LLM request (context, tools, model)
        - llm.stream(request)
        - For each LMEvent:
            publish session.next.text.delta (live) / tool.called etc.
            Fork tool fibers → publish tool.success / tool.failed
        - publish session.next.step.ended
      if (needsContinuation): loop for next LLM turn
    if (hasPending queue): loop outer

[Events] packages/core/src/event.ts
  events.publish() → SQLite write + PubSub notify
    → /api/event SSE clients receive event
    → /api/session/:id/event clients receive durable events
```

---

## Session State Machine

There is **no explicit status field** in `Session.Info`. State is inferred:

```
[CREATED]
  POST /api/session → session record in SQLite
  Not in /api/session/active

       │  POST /api/session/:id/prompt
       ↓
[RUNNING]
  Drain fiber active in SessionRunCoordinator
  Appears in GET /api/session/active: { [id]: { type: "running" } }
  SSE emits: step.started, text.delta, tool.called, tool.success, step.ended, ...

       │  step.ended + no more pending inputs
       ↓
[IDLE]
  Drain fiber exits
  Absent from /api/session/active
  step-finish part present in last assistant message

       │  interrupt
       ↓
[INTERRUPTED]
  Tools fail with "Tool execution interrupted"
  Fiber exits → session returns to IDLE state
```

**Concurrency rules** (from `run-coordinator.ts`):
- At most **one drain fiber per session** — concurrent wakes coalesce via `pendingWake`
- `interrupt()` clears `pendingWake`, so a stopping fiber does NOT start a successor
- Sessions never reach a terminal "done" state — always available for new prompts

---

## Key File Paths

| Concern | Path |
|---------|------|
| API group assembly | `packages/protocol/src/api.ts` |
| All endpoint definitions | `packages/protocol/src/groups/*.ts` |
| Server route wiring | `packages/server/src/routes.ts` |
| Session HTTP handler | `packages/server/src/handlers/session.ts` |
| SSE event handler | `packages/server/src/handlers/event.ts` |
| Auth middleware | `packages/server/src/middleware/authorization.ts` |
| Session service | `packages/core/src/session.ts` |
| Session input (admit/promote) | `packages/core/src/session/input.ts` |
| Run coordinator | `packages/core/src/session/run-coordinator.ts` |
| LLM agent runner | `packages/core/src/session/runner/llm.ts` |
| Event bus | `packages/core/src/event.ts` |
| Session event schemas | `packages/schema/src/session-event.ts` |
| All server event types | `packages/schema/src/event-manifest.ts` |
| Generated TS client | `packages/client/src/generated/client.ts` |

---

## Implications for joint-debug MCP

### `getSessionStatus` — wrong approach (current)

Current implementation fetches **all messages** and scans for `step-finish` parts.

Problems:
- Slow for large sessions (fetches entire history)
- `/api/session/:id/message?limit=N` returns the **oldest** N messages, so a limit is useless
- Misses sessions that are running but haven't emitted any step yet (newly woken)

**Correct approach**: `GET /api/session/active`

```
response: { [sessionID]: { type: "running" } }
present  → busy
absent   → idle
```

O(1), authoritative, no message parsing needed.

### `waitForIdleViaSSE` — workable but complex

Current approach: open SSE stream on `/api/session/:id/event`, parse durable events, detect `session.next.step.ended`.

Alternative: `POST /api/session/:id/wait` — server-side long-poll, blocks until agent is idle. Simpler, no SSE parsing, but may not carry partial output. Current SSE approach is acceptable; the main improvement is handling `TimeoutError` correctly (already done).

### `/api/session/:id/message` — v1 vs v2 semantics differ

**v1 endpoint** — `GET /session/:sessionID/message?limit=N` (no `/api` prefix)

Implemented in `packages/opencode/src/session/message-v2.ts` (`page()`): executes
`ORDER BY time_created DESC, id DESC LIMIT N` then reverses the slice before returning.
Result: the **newest N messages in chronological (ascending) order** — index 0 is the
oldest of the N, last index is the newest. This is what fleet currently uses.

**v2 endpoint** — `GET /api/session/:sessionID/message?limit=N&order=asc|desc`

Supports `limit`, `order` (`asc` / `desc`, default `desc`), and `cursor` for pagination.
`order=desc` returns newest-first; `order=asc` returns oldest-first.
Response shape: `{ data: SessionMessage.Message[], cursor: { previous?, next? } }` — a
different schema from the v1 `MessageWithParts[]` array, requiring separate parsing logic.
