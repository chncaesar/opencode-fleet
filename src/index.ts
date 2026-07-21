#!/usr/bin/env node
/**
 * index.ts — opencode-fleet MCP Server entry point.
 *
 * Starts a stdio-based MCP server that exposes fleet_* tools,
 * allowing a master OpenCode instance to coordinate multiple
 * remote OpenCode nodes.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { resolveConfig, ConfigError } from "./config.js";
import { buildContext, TOOL_DEFINITIONS, dispatchTool } from "./tools.js";

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Parse config from CLI args / env
  let config;
  try {
    config = resolveConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`opencode-fleet: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  // Build per-node clients + session manager
  const ctx = buildContext(config);

  // Log startup summary to stderr (not captured by MCP host)
  process.stderr.write(
    `opencode-fleet: starting with ${config.nodes.length} node(s): ` +
      config.nodes.map((n) => `${n.name}=${n.url}`).join(", ") +
      `\n`
  );

  // ── MCP Server ────────────────────────────────────────────────────────────

  const server = new Server(
    { name: "opencode-fleet", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
  });

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, unknown>;

    try {
      const result = await dispatchTool(ctx, name, safeArgs);
      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text", text: `Internal error in ${name}: ${msg}` }],
        isError: true,
      };
    }
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep the process alive
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

main().catch((e) => {
  process.stderr.write(`opencode-fleet: fatal error: ${e}\n`);
  process.exit(1);
});
