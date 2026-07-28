# opencode-fleet

An MCP server that lets a master [OpenCode](https://opencode.ai) instance coordinate multiple remote OpenCode nodes.

Instead of switching between terminals, you describe what each machine should do and the master agent dispatches the work — collecting results, relaying them, and keeping the overall task on track.

## Why this exists

Embedded and hardware projects often span more than one machine. A typical setup:

- **Ubuntu** — primary development machine. Runs the build toolchain, serial port simulator, and log analysis.
- **Windows** — runs the HMI upper-computer application that communicates with the embedded target over a (real or simulated) serial port.

Debugging across these two machines is painful. You context-switch constantly: run the simulator on Ubuntu, check the HMI on Windows, paste logs back and forth, repeat.

`opencode-fleet` solves this by letting a single master OpenCode instance drive both. You describe the overall task once; the master dispatches subtasks to each node, collects results, and synthesises the picture — without you having to leave the chat.

**Example workflow:**

1. Master tells the Ubuntu node: *"Start the serial simulator in touch mode and tail the output."*
2. Master tells the Windows node: *"Launch the HMI app and connect to the simulated port. Report what the UI shows."*
3. Master correlates both outputs and suggests the next debugging step.

## How it works

```
Master OpenCode (your machine)
    │  uses MCP tools
    ▼
opencode-fleet (MCP server, this package)
    ├─► fleet_send_message → Ubuntu node  (opencode serve at 192.168.1.10:4096)
    └─► fleet_send_message → Windows node (opencode serve at 192.168.1.20:4096)
```

Each remote machine runs `opencode serve`. The fleet server opens a persistent SSE connection to each node on startup, maintaining a local status cache. `fleet_send_message` dispatches a prompt and returns immediately with the session ID — the slave runs in the background. Use `fleet_get_session_status` to poll for completion (reads from local cache, O(1), no network) and `fleet_get_session_messages` to retrieve the result.

## Slave setup (remote machines)

On each machine that the master will control, start opencode in server mode:

**Linux / macOS:**

```bash
# Bind to 0.0.0.0 so the node is reachable from other hosts.
OPENCODE_SERVER_PASSWORD=your-password opencode serve --hostname 0.0.0.0 --port 4096
```

**Windows (PowerShell):**

```powershell
$env:OPENCODE_SERVER_PASSWORD="your-password"
opencode serve --hostname 0.0.0.0 --port 4096
```

**Windows (Command Prompt):**

```cmd
set OPENCODE_SERVER_PASSWORD=your-password
opencode serve --hostname 0.0.0.0 --port 4096
```

Note the URL that is printed — you will use it in the master's `opencode.json`.

## Slave permission configuration

opencode's built-in `permission` system controls what tools the slave agent can use. Configure it in `opencode.jsonc` in the project directory, or in the platform managed config path for global enforcement (highest priority, cannot be overridden by project config):

- **Linux**: `/etc/opencode/opencode.jsonc`
- **macOS**: `/Library/Application Support/opencode/opencode.jsonc`
- **Windows**: `%ProgramData%\opencode\opencode.jsonc`

Example — allow only safe operations, deny everything else:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": {
      "*": "deny",
      "git *": "allow",
      "make *": "allow",
      "cmake *": "allow",
      "python3 *": "allow",
      "rm /tmp/*": "allow"
    },
    "edit": {
      "*": "deny",
      "/work/code/**": "allow",
      "/tmp/**": "allow"
    }
  }
}
```

With `deny` rules, the slave agent reports the failure to the master instead of hanging. Use `fleet_node_health` (with `include_capabilities: true`, the default) to inspect the slave's effective permission policy before dispatching work.

If a slave's permission policy includes `ask` rules — or no rules at all — the slave may pause and emit a `permission.asked` event, blocking the session. The fleet master detects this automatically: `fleet_get_session_status` will show the pending permission requests, and you can approve or deny them with `fleet_reply_permission` without leaving the chat.

## Installation

```bash
npm install -g opencode-fleet
```

## Configuration

Add to your master machine's `opencode.jsonc`:

```json
{
  "mcp": {
    "fleet": {
      "type": "local",
      "command": [
        "npx", "-y", "opencode-fleet",
        "--node", "ubuntu=http://192.168.1.10:4096",
        "--node", "windows=http://192.168.1.20:4096",
        "--password", "your-shared-password",
        "--timeout", "600"
      ]
    }
  }
}
```

Or set credentials via environment variables:

```bash
export FLEET_PASSWORD=your-shared-password
```

## CLI options

| Option | Default | Description |
|---|---|---|
| `--node name=url` | (required) | Register a remote node. Repeat for multiple nodes. |
| `--password <pw>` | `""` | Shared Basic Auth password for all nodes. |
| `--username <u>` | `opencode` | Shared Basic Auth username for all nodes. |
| `--timeout <s>` | `600` | Seconds to wait for the capability-fetch diagnostic session in `fleet_node_health`. Does not affect `fleet_send_message` (fire-and-forget). |

Environment variable fallbacks: `FLEET_PASSWORD`, `FLEET_USERNAME`, `OPENCODE_SERVER_PASSWORD`.

## MCP tools

| Tool | Description |
|---|---|
| `fleet_list_nodes` | List all configured nodes and their health/latency. |
| `fleet_node_health` | Check if a specific node is reachable. |
| `fleet_list_models` | List all models available on a node. |
| `fleet_list_sessions` | List all sessions on a node. |
| `fleet_create_session` | Create a new session on a node with optional title, agent, and model. |
| `fleet_switch_session` | Bind to an existing session by ID (for tools that target the "current" session). |
| `fleet_send_message` | Dispatch a prompt to a node and return immediately (fire-and-forget). Poll with `fleet_get_session_status`, retrieve with `fleet_get_session_messages`. |
| `fleet_get_session_messages` | Fetch recent message history from a node's session. |
| `fleet_get_session_status` | Check whether a node's session is idle or busy (local cache, zero network). Shows pending permission requests when the session is blocked waiting for approval. |
| `fleet_reply_permission` | Approve (`once`) or deny (`reject`) a pending permission request on a slave node, unblocking a session that is waiting for user decision. |
| `fleet_interrupt_session` | Signal a running session to stop (fire-and-forget; does not reset). |
| `fleet_reset_session` | Discard a node's session so the next call starts fresh (last resort). |

## Example usage (in OpenCode chat)

```
Use fleet_list_nodes to check what machines are available.

Dispatch both tasks concurrently:
  fleet_send_message to the ubuntu node:
    "Read the serial port logs at /tmp/serial.log and summarise the last 50 lines."
  fleet_send_message to the windows node:
    "Check the HMI connection status and report what the UI shows."

Poll fleet_get_session_status for both nodes until idle, then
use fleet_get_session_messages to retrieve each result and correlate.
```

## Session management

The fleet server maintains one session per node in memory. Sessions are created lazily on the first message and reused across calls to preserve context. Use `fleet_reset_session` to clear a node's context when you want a clean slate.

## Completion detection

`fleet_send_message` is fire-and-forget: it dispatches a prompt and returns immediately with the session ID. The slave runs autonomously in the background via a persistent SSE connection (`GET /event`) opened once on startup.

Poll `fleet_get_session_status` until the session is idle (reads from local SSE cache — O(1), no network), then call `fleet_get_session_messages` to retrieve the result.

This model lets the master dispatch tasks to multiple nodes in the same turn and track them independently — no blocking, no forced sequencing.

## Security

All traffic is plain HTTP. Use a VPN or SSH tunnel when communicating over untrusted networks. Passwords are transmitted as HTTP Basic Auth — adequate for a trusted LAN, not for public internet.

## More OpenCode Tools

| Tool | Description |
|------|-------------|
| [opencode-db-clean](https://github.com/chncaesar/opencode-db-clean) | Reclaim disk space from bloated SQLite databases |
| [opencode-waitfor](https://github.com/chncaesar/opencode-waitfor) | `wait_for` for HTTP/TCP/command readiness checks |
| [opencode-session-reflection](https://github.com/chncaesar/opencode-session-reflection) | Qualitative review of past coding sessions |
| [opencode-fleet](https://github.com/chncaesar/opencode-fleet) | Multi-node remote OpenCode orchestration |

## Release History

| Version | Date | Changes |
|---------|------|---------|
| [0.2.0](https://github.com/chncaesar/opencode-fleet/releases/tag/v0.2.0) | 2026-07-28 | Embed fleet operation protocol as MCP server `instructions` field (auto-injected into every master LLM request). Fire-and-forget `fleet_send_message` with SSE-based status polling. `fleet_reply_permission` for handling slave permission prompts. Permission-aware `fleet_get_session_status`. Improved tool descriptions with inline workflow guidance. |
| [0.1.0](https://github.com/chncaesar/opencode-fleet/releases/tag/v0.1.0) | 2026-07-25 | Initial release. Multi-node coordination, session management, persistent SSE status tracking, `fleet_node_health` with capability detection, 11 MCP tools. |

## License

MIT
