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
 */

import { OpenCodeNode } from "./node.js";
import { SessionManager } from "./session.js";
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
      "Use this to clear context when a node seems confused or stuck.",
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

  try {
    const result = await ctx.sessions.send(node, prompt);

    const lines: string[] = [];
    lines.push(`Node: ${nodeName}`);
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

  const sessionId = ctx.sessions.getSessionId(nodeName);
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
    default:
      return err(`Unknown tool: ${toolName}`);
  }
}
