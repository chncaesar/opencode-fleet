/**
 * tools.ts
 *
 * MCP tool definitions for opencode-fleet.
 * Each tool returns a CallToolResult-compatible object.
 *
 * Tools:
 *   fleet_list_nodes         — list all configured nodes + health
 *   fleet_send_message       — send a prompt to a node and wait for reply
 *   fleet_get_session_messages — fetch message history from a node's session
 *   fleet_reset_session      — discard cached session for a node
 *   fleet_node_health        — check health of a specific node
 *   fleet_list_sessions      — list all sessions on a node
 *   fleet_create_session     — create a new session and bind to it
 *   fleet_switch_session     — switch to an existing session
 *   fleet_list_models        — list available models on a node
 *   fleet_interrupt_session  — send abort signal to a running session
 */

import { OpenCodeNode } from "./node.js";
import { SessionManager } from "./session.js";
import type { SendOptions } from "./session.js";
import type { FleetConfig } from "./config.js";
import type {
  Part,
  TextPart,
  ToolPart,
  StepFinishPart,
  FilePart,
} from "./node.js";

// ── Context ───────────────────────────────────────────────────────────────────

export interface FleetContext {
  nodes: Map<string, OpenCodeNode>;
  sessions: SessionManager;
  config: FleetConfig;
}

export function buildContext(config: FleetConfig): FleetContext {
  const nodes = new Map<string, OpenCodeNode>();
  for (const nodeConfig of config.nodes) {
    nodes.set(
      nodeConfig.name,
      new OpenCodeNode(nodeConfig, config.username, config.password)
    );
  }
  return {
    nodes,
    sessions: new SessionManager(config),
    config,
  };
}

// ── Tool schemas (JSON Schema for MCP) ────────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: "fleet_list_nodes",
    description:
      "List all configured remote OpenCode nodes and their current health status. " +
      "Use this to understand what nodes are available before dispatching work.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "fleet_send_message",
    description:
      "Send a prompt to a specific remote OpenCode node and wait for it to finish. " +
      "The node runs the prompt autonomously and returns the last assistant reply. " +
      "This call blocks until the remote agent is idle (or until timeout). " +
      "Use this to dispatch tasks to specialist nodes.",
    inputSchema: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description: "Name of the target node (as configured with --node).",
        },
        prompt: {
          type: "string",
          description: "The instruction or question to send to the remote OpenCode agent.",
        },
        agent: {
          type: "string",
          description:
            "Agent mode to use when a new session is created. " +
            "Supported values: \"build\" (default), \"plan\". " +
            "Has no effect if a session already exists for this node.",
        },
        model: {
          type: "string",
          description:
            "Model to use when a new session is created, in \"providerID/modelID\" format " +
            "(e.g. \"anthropic/claude-sonnet-4-6\"). " +
            "Use fleet_list_models to see available options. " +
            "Has no effect if a session already exists for this node.",
        },
        reasoning_effort: {
          type: "string",
          description:
            "Reasoning effort hint passed to each prompt call. " +
            "Supported values: \"low\", \"medium\", \"high\". " +
            "Only effective for models that support extended thinking / reasoning.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory (absolute path on the remote machine) used when a new session " +
            "is created automatically. Has no effect if a session already exists. " +
            "Defaults to \"/\" if omitted.",
        },
      },
      required: ["node", "prompt"],
    },
  },
  {
    name: "fleet_get_session_messages",
    description:
      "Fetch the recent message history from a node's current session. " +
      "Returns the last N messages, newest first. Useful for inspecting " +
      "what a node has been doing or debugging an unexpected reply.",
    inputSchema: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description: "Name of the target node.",
        },
        session_id: {
          type: "string",
          description:
            "Optional explicit session ID to query. If omitted, uses the node's active session binding.",
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return (default: 50, max: 200).",
        },
      },
      required: ["node"],
    },
  },
  {
    name: "fleet_reset_session",
    description:
      "Reset (discard) the current session for a node. " +
      "The next fleet_send_message call will start a fresh session. " +
      "Use this to clear context when a node seems confused or stuck. " +
      "WARNING: will be blocked if the session is currently BUSY — use " +
      "fleet_get_session_status to check first, then fleet_interrupt_session if needed. " +
      "Resetting a busy session loses in-flight work and context. " +
      "This is a LAST RESORT — prefer waiting or interrupting over resetting.",
    inputSchema: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description: "Name of the target node.",
        },
      },
      required: ["node"],
    },
  },
  {
    name: "fleet_node_health",
    description:
      "Check whether a specific remote OpenCode node is reachable and responding. " +
      "Returns ok/error status with latency.",
    inputSchema: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description: "Name of the node to check.",
        },
      },
      required: ["node"],
    },
  },
  {
    name: "fleet_list_sessions",
    description:
      "List all sessions on a remote OpenCode node, with their titles, agents, models, " +
      "cost, and timestamps. The currently bound session (used by fleet_send_message) " +
      "is marked with an asterisk.",
    inputSchema: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description: "Name of the target node.",
        },
      },
      required: ["node"],
    },
  },
  {
    name: "fleet_create_session",
    description:
      "Create a new session on a remote node and automatically bind to it. " +
      "Subsequent fleet_send_message calls to this node will use the new session. " +
      "Use this to start a fresh context, or to switch to a specific agent/model.",
    inputSchema: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description: "Name of the target node.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for the session (absolute path on the remote machine). " +
            "Required — the session will not appear in the desktop UI without this.",
        },
        title: {
          type: "string",
          description: "Optional display title for the session.",
        },
        agent: {
          type: "string",
          description: "Agent mode: \"build\" (default) or \"plan\".",
        },
        model: {
          type: "string",
          description:
            "Model in \"providerID/modelID\" format, e.g. \"anthropic/claude-sonnet-4-6\". " +
            "Use fleet_list_models to see options.",
        },
      },
      required: ["node", "cwd"],
    },
  },
  {
    name: "fleet_switch_session",
    description:
      "Switch the current binding for a node to an existing session. " +
      "Use fleet_list_sessions to find session IDs. " +
      "Subsequent fleet_send_message calls will continue in this session.",
    inputSchema: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description: "Name of the target node.",
        },
        session_id: {
          type: "string",
          description: "ID of the session to switch to (e.g. ses_07cbd9...).",
        },
      },
      required: ["node", "session_id"],
    },
  },
  {
    name: "fleet_list_models",
    description:
      "List all available models on a remote OpenCode node. " +
      "Returns the model IDs in \"providerID/modelID\" format that can be passed to " +
      "fleet_send_message or fleet_create_session.",
    inputSchema: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description: "Name of the target node.",
        },
      },
      required: ["node"],
    },
  },
  {
    name: "fleet_interrupt_session",
    description:
      "Send an abort signal to the currently running task on a remote node's active session. " +
      "Fire-and-forget: returns immediately after the signal is sent. " +
      "Does NOT wait for the session to become idle, does NOT reset the session binding, " +
      "and does NOT delete the session. " +
      "Use this when you want to stop a long-running task early (like Ctrl+C).",
    inputSchema: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description: "Name of the target node.",
        },
      },
      required: ["node"],
    },
  },
  {
    name: "fleet_get_session_status",
    description:
      "Check whether a specific remote node's session is currently idle or busy. " +
      "Returns idle/busy/retry status without sending any new messages. " +
      "Use this after a fleet_send_message timeout to confirm whether the agent is still " +
      "running before deciding whether to wait, interrupt, or reset. " +
      "If session_id is omitted, checks the currently bound session for the node.",
    inputSchema: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description: "Name of the target node.",
        },
        session_id: {
          type: "string",
          description:
            "Optional session ID to check. If omitted, uses the currently bound session.",
        },
      },
      required: ["node"],
    },
  },
] as const;

// ── Tool handlers ─────────────────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// fleet_list_nodes ─────────────────────────────────────────────────────────────

export async function handleListNodes(ctx: FleetContext): Promise<ToolResult> {
  const results: string[] = [];

  await Promise.allSettled(
    Array.from(ctx.nodes.entries()).map(async ([name, node]) => {
      const t0 = Date.now();
      const healthy = await node.ping();
      const latencyMs = Date.now() - t0;
      const sessionId = ctx.sessions.getSessionId(name);
      results.push(
        `• ${name}: ${healthy ? "✓ online" : "✗ offline"} (${latencyMs}ms)` +
          (sessionId ? ` | session=${sessionId}` : " | no active session") +
          ` | url=${node.baseUrl}`
      );
    })
  );

  return ok(
    `Fleet nodes (${ctx.nodes.size} configured):\n\n` +
      (results.length > 0 ? results.join("\n") : "(no nodes)")
  );
}

// fleet_send_message ───────────────────────────────────────────────────────────

export async function handleSendMessage(
  ctx: FleetContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const nodeName = String(args["node"] ?? "");
  const prompt = String(args["prompt"] ?? "");

  if (!nodeName) return err("Missing required argument: node");
  if (!prompt) return err("Missing required argument: prompt");

  const node = ctx.nodes.get(nodeName);
  if (!node) {
    return err(
      `Unknown node "${nodeName}". Available: ${Array.from(ctx.nodes.keys()).join(", ")}`
    );
  }

  // Collect optional overrides
  const options: SendOptions = {};
  if (args["agent"]) options.agent = String(args["agent"]);
  if (args["model"]) options.model = String(args["model"]);
  if (args["reasoning_effort"]) options.reasoningEffort = String(args["reasoning_effort"]);
  if (args["cwd"]) options.cwd = String(args["cwd"]);

  try {
    const result = await ctx.sessions.send(node, prompt, options);

    const lines: string[] = [];
    lines.push(`Node: ${nodeName}`);

    if (result.timedOut) {
      lines.push(`Status: TIMEOUT — agent is still running (not a failure)`);
      lines.push(`Session: ${ctx.sessions.getSessionId(nodeName) ?? "(unknown)"}`);
      lines.push("");
      lines.push("The remote agent did not finish within the timeout window.");
      lines.push("It is STILL RUNNING. Do NOT reset the session.");
      lines.push("");
      lines.push("Recommended next steps:");
      lines.push("  1. Call fleet_get_session_status to check if still busy.");
      lines.push("  2. Call fleet_get_session_messages to see current progress.");
      lines.push("  3. Wait and retry fleet_send_message with a follow-up prompt.");
      lines.push("  4. Call fleet_interrupt_session only if you need to stop it early.");
      lines.push("  5. LAST RESORT: fleet_reset_session (loses all session context).");
      lines.push("");
      lines.push("--- Partial output (agent still working) ---");
      lines.push(result.reply || "(no output yet — agent may be in early tool-call phase)");
      // Timeout is not an error — master should not panic-reset
      return ok(lines.join("\n"));
    }

    lines.push(`Status: ${result.hasError ? "completed with error" : "completed"}`);
    lines.push("");
    lines.push("--- Reply ---");
    lines.push(result.reply || "(no text reply)");

    return result.hasError
      ? err(lines.join("\n"))
      : ok(lines.join("\n"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Failed to send message to "${nodeName}": ${msg}`);
  }
}

// fleet_get_session_messages ───────────────────────────────────────────────────

/**
 * Render a single Part into human-readable text.
 * Returns null for parts that carry no useful display content (e.g. step-start).
 */
function renderPart(part: Part): string | null {
  switch (part.type) {
    case "text": {
      const tp = part as TextPart;
      return tp.text.trim() ? tp.text.trim() : null;
    }

    case "tool": {
      const toolPart = part as ToolPart;
      const { tool, state } = toolPart;
      const statusTag = state.status === "completed" ? "✓" : state.status === "error" ? "✗" : "…";

      // Build a human-readable command/input summary
      let inputSummary = "";
      if (tool === "bash" && typeof state.input?.["command"] === "string") {
        inputSummary = state.input["command"] as string;
      } else if (tool === "write" || tool === "edit") {
        inputSummary = String(state.input?.["filePath"] ?? state.input?.["path"] ?? "");
      } else if (state.input) {
        // Generic fallback: first string value or JSON dump truncated
        const firstVal = Object.values(state.input).find((v) => typeof v === "string");
        inputSummary = firstVal != null
          ? String(firstVal)
          : JSON.stringify(state.input).slice(0, 200);
      }

      const lines: string[] = [`[tool:${tool}] ${statusTag} ${inputSummary}`.trim()];

      // Append output, trimmed + capped at 2000 chars to avoid flooding context
      if (state.status !== "pending") {
        const raw =
          typeof state.output === "string"
            ? state.output
            : state.output != null
            ? JSON.stringify(state.output)
            : "";
        const output = raw.trim();
        if (output) {
          const capped = output.length > 2000 ? output.slice(0, 2000) + "\n…(truncated)" : output;
          lines.push(capped);
        }
        if (state.error) {
          lines.push(`Error: ${state.error}`);
        }
      }

      return lines.join("\n");
    }

    case "step-finish": {
      const sfp = part as StepFinishPart;
      if (!sfp.reason) return null;
      // Only show non-trivial finish reasons (skip "tool-calls" noise)
      if (
        sfp.reason === "tool-calls" ||
        sfp.reason === "end-turn" ||
        sfp.reason === "stop"
      )
        return null;
      return `[step-finish: ${sfp.reason}]`;
    }

    case "file": {
      const fp = part as FilePart;
      const name = fp.filename ?? fp.url ?? "(file)";
      return `[file: ${name}${fp.mime ? ` (${fp.mime})` : ""}]`;
    }

    case "step-start":
      // Pure snapshot marker — no display value
      return null;

    default:
      // Unknown future types: show raw keys so nothing is silently dropped
      return `[${part.type}]`;
  }
}

export async function handleGetSessionMessages(
  ctx: FleetContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const nodeName = String(args["node"] ?? "");
  const limitRaw = args["limit"];
  const limit = typeof limitRaw === "number" ? Math.min(Math.max(1, limitRaw), 200) : 50;

  if (!nodeName) return err("Missing required argument: node");

  const node = ctx.nodes.get(nodeName);
  if (!node) {
    return err(
      `Unknown node "${nodeName}". Available: ${Array.from(ctx.nodes.keys()).join(", ")}`
    );
  }

  // Accept an explicit session_id argument; fall back to the active binding.
  const explicitId = args["session_id"] ? String(args["session_id"]) : undefined;
  const sessionId = explicitId ?? ctx.sessions.getSessionId(nodeName);
  if (!sessionId) {
    return ok(`Node "${nodeName}" has no active session. Use fleet_send_message to start one.`);
  }

  try {
    const messages = await node.getMessages(sessionId, limit);
    if (messages.length === 0) {
      return ok(`Session ${sessionId} on "${nodeName}" has no messages yet.`);
    }

    const lines: string[] = [
      `Messages from node "${nodeName}" (session: ${sessionId}):`,
      "",
    ];

    for (const mwp of messages) {
      const role = mwp.info.role.toUpperCase();
      lines.push(`── [${role}] id=${mwp.info.id} ──`);

      for (const part of mwp.parts) {
        const rendered = renderPart(part);
        if (rendered) lines.push(rendered);
      }

      lines.push(""); // blank line between messages
    }

    return ok(lines.join("\n"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Failed to fetch messages from "${nodeName}": ${msg}`);
  }
}

// fleet_reset_session ──────────────────────────────────────────────────────────

export async function handleResetSession(
  ctx: FleetContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const nodeName = String(args["node"] ?? "");
  if (!nodeName) return err("Missing required argument: node");

  if (!ctx.nodes.has(nodeName)) {
    return err(
      `Unknown node "${nodeName}". Available: ${Array.from(ctx.nodes.keys()).join(", ")}`
    );
  }

  const oldId = ctx.sessions.getSessionId(nodeName);

  // Guard: refuse to reset while the session is busy, to prevent losing
  // in-flight work.  If status check fails (endpoint not supported), warn
  // but allow the reset to proceed.
  if (oldId) {
    const node = ctx.nodes.get(nodeName)!;
    try {
      const status = await node.getSessionStatus(oldId);
      if (status.type === "busy") {
        return err(
          `RESET BLOCKED — session ${oldId} on "${nodeName}" is currently BUSY.\n` +
            `Resetting now would discard in-flight work and lose session context.\n\n` +
            `Recommended actions:\n` +
            `  1. Wait for the task to finish, then check fleet_get_session_messages.\n` +
            `  2. Call fleet_interrupt_session to stop the running task gracefully.\n` +
            `  3. If you are sure you want to discard the session anyway, interrupt first, ` +
            `then reset.`
        );
      }
    } catch {
      // Status endpoint not available or unreachable — proceed with reset but warn.
    }
  }

  ctx.sessions.resetSession(nodeName);

  return ok(
    oldId
      ? `Session ${oldId} for node "${nodeName}" has been discarded. A new session will be created on the next message.`
      : `Node "${nodeName}" had no active session. Nothing to reset.`
  );
}

// fleet_node_health ────────────────────────────────────────────────────────────

export async function handleNodeHealth(
  ctx: FleetContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const nodeName = String(args["node"] ?? "");
  if (!nodeName) return err("Missing required argument: node");

  const node = ctx.nodes.get(nodeName);
  if (!node) {
    return err(
      `Unknown node "${nodeName}". Available: ${Array.from(ctx.nodes.keys()).join(", ")}`
    );
  }

  const t0 = Date.now();
  const healthy = await node.ping();
  const latencyMs = Date.now() - t0;

  if (healthy) {
    return ok(
      `Node "${nodeName}" is online\n` +
        `URL: ${node.baseUrl}\n` +
        `Latency: ${latencyMs}ms`
    );
  }
  return err(
    `Node "${nodeName}" is OFFLINE or unreachable\n` +
      `URL: ${node.baseUrl}\n` +
      `Latency: ${latencyMs}ms`
  );
}

// fleet_list_sessions ──────────────────────────────────────────────────────────

export async function handleListSessions(
  ctx: FleetContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const nodeName = String(args["node"] ?? "");
  if (!nodeName) return err("Missing required argument: node");

  const node = ctx.nodes.get(nodeName);
  if (!node) {
    return err(
      `Unknown node "${nodeName}". Available: ${Array.from(ctx.nodes.keys()).join(", ")}`
    );
  }

  try {
    const sessions = await node.listSessions();
    if (sessions.length === 0) {
      return ok(`Node "${nodeName}" has no sessions.`);
    }

    const boundId = ctx.sessions.getSessionId(nodeName);
    const lines: string[] = [`Sessions on node "${nodeName}" (${sessions.length} total):\n`];

    for (const s of sessions) {
      const isBound = s.id === boundId;
      const modelStr = s.model ? `${s.model.providerID}/${s.model.id}` : "default";
      const agentStr = s.agent ?? "build";
      const created = new Date(s.time.created).toISOString().slice(0, 16).replace("T", " ");
      lines.push(
        `${isBound ? "* " : "  "}${s.id}  [${agentStr}|${modelStr}]  "${s.title ?? "(untitled)"}"  created=${created}`
      );
    }

    return ok(lines.join("\n"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Failed to list sessions on "${nodeName}": ${msg}`);
  }
}

// fleet_create_session ─────────────────────────────────────────────────────────

export async function handleCreateSession(
  ctx: FleetContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const nodeName = String(args["node"] ?? "");
  if (!nodeName) return err("Missing required argument: node");

  const cwd = String(args["cwd"] ?? "");
  if (!cwd) return err("Missing required argument: cwd");

  const node = ctx.nodes.get(nodeName);
  if (!node) {
    return err(
      `Unknown node "${nodeName}". Available: ${Array.from(ctx.nodes.keys()).join(", ")}`
    );
  }

  try {
    const session = await node.createSession({
      cwd,
      title: args["title"] ? String(args["title"]) : undefined,
      agent: args["agent"] ? String(args["agent"]) : undefined,
      model: args["model"] ? String(args["model"]) : undefined,
    });

    // Bind the new session
    ctx.sessions.setSessionId(nodeName, session.id);

    const modelStr = session.model
      ? `${session.model.providerID}/${session.model.id}`
      : "default";
    const agentStr = session.agent ?? "build";

    return ok(
      `Created and bound new session on "${nodeName}":\n` +
        `  ID:    ${session.id}\n` +
        `  Title: ${session.title ?? "(untitled)"}\n` +
        `  Agent: ${agentStr}\n` +
        `  Model: ${modelStr}`
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Failed to create session on "${nodeName}": ${msg}`);
  }
}

// fleet_switch_session ─────────────────────────────────────────────────────────

export async function handleSwitchSession(
  ctx: FleetContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const nodeName = String(args["node"] ?? "");
  const sessionId = String(args["session_id"] ?? "");

  if (!nodeName) return err("Missing required argument: node");
  if (!sessionId) return err("Missing required argument: session_id");

  if (!ctx.nodes.has(nodeName)) {
    return err(
      `Unknown node "${nodeName}". Available: ${Array.from(ctx.nodes.keys()).join(", ")}`
    );
  }

  const oldId = ctx.sessions.getSessionId(nodeName);
  ctx.sessions.setSessionId(nodeName, sessionId);

  return ok(
    `Switched node "${nodeName}" to session ${sessionId}` +
      (oldId && oldId !== sessionId ? ` (was: ${oldId})` : "")
  );
}

// fleet_list_models ────────────────────────────────────────────────────────────

export async function handleListModels(
  ctx: FleetContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const nodeName = String(args["node"] ?? "");
  if (!nodeName) return err("Missing required argument: node");

  const node = ctx.nodes.get(nodeName);
  if (!node) {
    return err(
      `Unknown node "${nodeName}". Available: ${Array.from(ctx.nodes.keys()).join(", ")}`
    );
  }

  try {
    const models = await node.listModels();
    if (models.length === 0) {
      return ok(`Node "${nodeName}" returned no models.`);
    }

    const lines: string[] = [`Models available on "${nodeName}" (${models.length} total):\n`];
    for (const m of models) {
      const statusMark = m.enabled === false ? " [disabled]" : "";
      lines.push(`  ${m.providerID}/${m.id}  —  ${m.name}${statusMark}`);
    }

    return ok(lines.join("\n"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Failed to list models on "${nodeName}": ${msg}`);
  }
}

// fleet_interrupt_session ─────────────────────────────────────────────────────

export async function handleInterruptSession(
  ctx: FleetContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const nodeName = String(args["node"] ?? "");
  if (!nodeName) return err("Missing required argument: node");

  const node = ctx.nodes.get(nodeName);
  if (!node) {
    return err(
      `Unknown node "${nodeName}". Available: ${Array.from(ctx.nodes.keys()).join(", ")}`
    );
  }

  const sessionId = ctx.sessions.getSessionId(nodeName);
  if (!sessionId) {
    return err(
      `Node "${nodeName}" has no active session. Use fleet_send_message to start one first.`
    );
  }

  try {
    const acknowledged = await node.abortSession(sessionId);
    return ok(
      acknowledged
        ? `Abort signal sent to session ${sessionId} on "${nodeName}". The session acknowledged the abort.`
        : `Abort signal sent to session ${sessionId} on "${nodeName}". The session may not have been running.`
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Failed to send abort signal to "${nodeName}": ${msg}`);
  }
}

// fleet_get_session_status ─────────────────────────────────────────────────────

export async function handleGetSessionStatus(
  ctx: FleetContext,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const nodeName = String(args["node"] ?? "");
  if (!nodeName) return err("Missing required argument: node");

  const node = ctx.nodes.get(nodeName);
  if (!node) {
    return err(
      `Unknown node "${nodeName}". Available: ${Array.from(ctx.nodes.keys()).join(", ")}`
    );
  }

  // Accept an explicit session_id argument; fall back to the active binding.
  const explicitId = args["session_id"] ? String(args["session_id"]) : undefined;
  const sessionId = explicitId ?? ctx.sessions.getSessionId(nodeName);
  if (!sessionId) {
    return ok(
      `Node "${nodeName}" has no active session.\n` +
        `Use fleet_send_message to start one.`
    );
  }

  try {
    const status = await node.getSessionStatus(sessionId);
    const lines: string[] = [
      `Node: ${nodeName}`,
      `Session: ${sessionId}`,
      `Status: ${status.type}`,
    ];

    if (status.type === "busy") {
      lines.push("");
      lines.push("The agent is currently executing. Do NOT reset the session.");
      lines.push("Use fleet_get_session_messages to see current progress.");
      lines.push("Use fleet_interrupt_session to stop it early if needed.");
    } else if (status.type === "retry") {
      const r = status as { type: "retry"; attempt: number; message: string; next: number };
      lines.push(`Attempt: ${r.attempt}`);
      lines.push(`Message: ${r.message}`);
      lines.push(`Next retry in: ${r.next}ms`);
    } else {
      lines.push("");
      lines.push("The agent is idle and ready for a new prompt.");
    }

    return ok(lines.join("\n"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Failed to get session status from "${nodeName}": ${msg}`);
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function dispatchTool(
  ctx: FleetContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case "fleet_list_nodes":
      return handleListNodes(ctx);
    case "fleet_send_message":
      return handleSendMessage(ctx, args);
    case "fleet_get_session_messages":
      return handleGetSessionMessages(ctx, args);
    case "fleet_reset_session":
      return handleResetSession(ctx, args);
    case "fleet_node_health":
      return handleNodeHealth(ctx, args);
    case "fleet_list_sessions":
      return handleListSessions(ctx, args);
    case "fleet_create_session":
      return handleCreateSession(ctx, args);
    case "fleet_switch_session":
      return handleSwitchSession(ctx, args);
    case "fleet_list_models":
      return handleListModels(ctx, args);
    case "fleet_interrupt_session":
      return handleInterruptSession(ctx, args);
    case "fleet_get_session_status":
      return handleGetSessionStatus(ctx, args);
    default:
      return err(`Unknown tool: ${toolName}`);
  }
}
