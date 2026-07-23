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

Each remote machine runs `opencode serve`. The fleet server opens a persistent SSE connection to each node on startup, maintaining a local status cache. `fleet_get_session_status` reads this cache — O(1), no network request. `fleet_send_message` blocks until the SSE stream emits `session.status: idle`, then returns the reply with zero polling lag.

## Slave setup (remote machines)

On each machine that the master will control:

**Linux / macOS:**

```bash
# The server must bind to 0.0.0.0 so it is reachable from other hosts.
# Set a password if you want Basic Auth (recommended on untrusted LANs).
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
| `--timeout <s>` | `600` | Seconds to wait for an agent to finish before giving up. |

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
| `fleet_send_message` | Send a prompt to a node and wait for the reply. |
| `fleet_get_session_messages` | Fetch recent message history from a node's session. |
| `fleet_get_session_status` | Check whether a node's session is idle or busy (local cache, zero network). |
| `fleet_interrupt_session` | Signal a running session to stop (fire-and-forget; does not reset). |
| `fleet_reset_session` | Discard a node's session so the next call starts fresh (last resort). |

## Example usage (in OpenCode chat)

```
Use fleet_list_nodes to check what machines are available.

Then use fleet_send_message to the ubuntu node:
  "Read the serial port logs at /tmp/serial.log and summarise the last 50 lines."

Once it replies, use fleet_send_message to the windows node:
  "The Ubuntu simulator reported: <summary>. Update the HMI display config accordingly."
```

## Session management

The fleet server maintains one session per node in memory. Sessions are created lazily on the first message and reused across calls to preserve context. Use `fleet_reset_session` to clear a node's context when you want a clean slate.

## Completion detection

`fleet_send_message` uses a persistent SSE connection (`GET /event`) that is opened once on startup and shared by all status checks. When you send a prompt, the server registers a waiter on this shared stream and resolves the moment the session goes idle — identical to how the desktop client tracks completion. No polling, no extra HTTP requests, no unnecessary waiting.

If the deadline (set by `--timeout`) is reached before the session goes idle, `fleet_send_message` returns a **non-error result** with a `Status: TIMEOUT` header and recommended next steps. The slave session is still running — do not reset it. Use `fleet_get_session_status` to check progress, and `fleet_interrupt_session` if you need to stop it.

## Security

All traffic is plain HTTP. Use a VPN or SSH tunnel when communicating over untrusted networks. Passwords are transmitted as HTTP Basic Auth — adequate for a trusted LAN, not for public internet.

## More OpenCode Tools

| Tool | Description |
|------|-------------|
| [opencode-db-clean](https://github.com/chncaesar/opencode-db-clean) | Reclaim disk space from bloated SQLite databases |
| [opencode-waitfor](https://github.com/chncaesar/opencode-waitfor) | `wait_for` for HTTP/TCP/command readiness checks |
| [opencode-session-reflection](https://github.com/chncaesar/opencode-session-reflection) | Qualitative review of past coding sessions |
| [opencode-fleet](https://github.com/chncaesar/opencode-fleet) | Multi-node remote OpenCode orchestration |

## License

MIT
