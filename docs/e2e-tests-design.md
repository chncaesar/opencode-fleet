# E2E Tests Design — opencode-fleet

Date: 2026-07-23

## Context

opencode-fleet currently has 26 unit tests (all mock-based). This spec adds a separate E2E test suite that runs against real OpenCode server instances, validating the full request path from MCP tool handlers down to actual HTTP calls and SSE event streams.

Two slave nodes are available for testing:
- opt186: Ubuntu 24.04, `http://192.168.88.186:4096`
- Windows local machine: `http://<windows-ip>:4096`

## Goals

- Validate that all 11 MCP tools work correctly against real OpenCode nodes
- Test SSE idle detection under realistic timing (not mocked)
- Test timeout and partial-reply behavior with a genuinely slow prompt
- Keep `npm test` (unit tests) runnable with zero external dependencies
- Support open-source users: slave nodes configured via environment variables, not hardcoded

## Non-Goals

- CI integration (slave nodes are not reachable from public CI)
- Performance benchmarking
- Load testing or multi-session stress tests

## Architecture

```
tests/
  e2e/
    helpers/
      env.ts        — read env vars, build node configs, export skipIf guards
      harness.ts    — beforeEach/afterEach session cleanup
    node.e2e.ts     — OpenCodeNode direct HTTP tests
    session.e2e.ts  — SessionManager lifecycle tests
    tools.e2e.ts    — all 11 MCP tools integration tests

vitest.e2e.config.ts   — separate vitest config: 60s timeout, sequential, verbose
.env.e2e.example       — template for env vars (committed, no real credentials)
```

`package.json` addition:
```
"test:e2e": "vitest run --config vitest.e2e.config.ts"
```

## Configuration

Slave nodes are passed in via environment variables:

```
E2E_NODE_OPT186_URL=http://192.168.88.186:4096
E2E_NODE_WINDOWS_URL=http://<windows-ip>:4096
E2E_NODE_USERNAME=opencode
E2E_NODE_PASSWORD=your-password
```

`env.ts` behavior:
- If `E2E_NODE_OPT186_URL` is unset, all tests targeting opt186 are skipped via `test.skipIf`
- If `E2E_NODE_WINDOWS_URL` is unset, all tests targeting windows are skipped
- If both are unset, the entire suite skips gracefully with a clear message
- Dual-node tests (concurrency, cross-node isolation) only run when both are configured

## Prompt Strategy

Two classes of prompts are used:

**Fast prompt** — `"Reply with exactly: hello"` (< 2s)
Used for: connectivity, session creation, message format, tool connectivity checks.

**Slow prompt** — `"Write a 50-line Python quicksort implementation with inline comments explaining each step"` (5–15s on real LLM)
Used for: SSE idle wait validation, timeout triggering, partial reply, interrupt.

Timeout test: slow prompt + 3s timeout → expect `timedOut=true`, `messages` non-empty.
Normal wait test: slow prompt + 60s timeout → expect complete reply returned.

## Test Cases

### node.e2e.ts — OpenCodeNode HTTP layer

Each test runs against each configured node independently.

| Test | Prompt type | What is verified |
|------|-------------|-----------------|
| ping | — | GET /global/health returns 200 |
| listSessions | — | returns array, each item has cwd |
| createSession + deleteSession | — | session appears in list after create, disappears after delete |
| sendPromptAsync + waitForIdle (fast) | fast | SSE idle event received, no timeout |
| sendPromptAsync + waitForIdle (slow) | slow | SSE idle event received within 60s |
| getMessages | fast | messages in ascending order, assistant part present |
| extractLastReply | fast | extracted text is non-empty string |
| getSessionStatus — busy | slow | status is busy immediately after sendPromptAsync |
| getSessionStatus — idle | fast | status is idle after waitForIdle resolves |
| TimeoutError | slow | 500ms timeout throws TimeoutError |

### session.e2e.ts — SessionManager lifecycle

| Test | What is verified |
|------|-----------------|
| lazy create | first send() creates a session automatically |
| session reuse | two consecutive send() calls use the same session ID |
| 404 auto-rebuild | manually delete session, next send() recreates and succeeds |
| timedOut partial reply | slow prompt + 3s timeout → timedOut=true, messages non-empty |

### tools.e2e.ts — All 11 MCP tools

| Tool | Test scenario |
|------|--------------|
| fleet_list_nodes | returns list containing configured node names |
| fleet_node_health | opt186 and windows both return healthy status |
| fleet_list_sessions | returns current sessions for a node |
| fleet_create_session | created session ID appears in fleet_list_sessions result |
| fleet_switch_session | after switch, session ID changes in manager |
| fleet_list_models | returns non-empty model list |
| fleet_send_message (fast) | fast prompt returns complete reply |
| fleet_send_message (slow) | slow prompt returns complete reply within 60s |
| fleet_get_session_messages | returns list containing assistant message |
| fleet_interrupt_session | interrupt during slow prompt → session becomes idle |
| fleet_reset_session (guard) | reset while busy → returns error, instructs to interrupt first |
| fleet_reset_session (success) | reset while idle → succeeds, session cleared |
| fleet_get_session_status (busy) | returns busy during slow prompt |
| fleet_get_session_status (idle) | returns idle after fast prompt completes |

### Dual-node tests (both nodes required)

| Test | What is verified |
|------|-----------------|
| concurrent send | simultaneous slow prompts to both nodes complete independently |
| cross-node session isolation | opt186 sessions do not appear in windows session list |

## Harness (cleanup)

`harness.ts` exports `setupE2EHarness(node)`:
- `beforeEach`: record existing session IDs
- `afterEach`: delete any sessions created during the test that are not in the pre-existing set

This prevents session accumulation across tests and avoids interference between test cases.

## vitest.e2e.config.ts

- `testTimeout`: 60000ms (matches SSE wait ceiling)
- `hookTimeout`: 15000ms (cleanup)
- `pool`: `forks` with `singleFork: true` (sequential execution, no parallel interference)
- `reporter`: `verbose`
- `include`: `tests/e2e/**/*.e2e.ts`

## Files to create

| File | Purpose |
|------|---------|
| `vitest.e2e.config.ts` | separate vitest config for e2e |
| `.env.e2e.example` | env var template for contributors |
| `tests/e2e/helpers/env.ts` | env var reading + skipIf guards |
| `tests/e2e/helpers/harness.ts` | session cleanup before/after each test |
| `tests/e2e/node.e2e.ts` | OpenCodeNode HTTP layer tests |
| `tests/e2e/session.e2e.ts` | SessionManager lifecycle tests |
| `tests/e2e/tools.e2e.ts` | all 11 MCP tools integration tests |

`package.json` gains one script entry. No other existing files are modified.
