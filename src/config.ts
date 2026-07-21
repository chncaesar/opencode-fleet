/**
 * config.ts
 *
 * Parses CLI arguments into a FleetConfig object.
 *
 * Usage:
 *   opencode-fleet --node ubuntu=http://192.168.1.10:4096 \
 *                  --node windows=http://192.168.1.20:4096 \
 *                  --password secret \
 *                  --timeout 600
 */

export interface NodeConfig {
  name: string;
  url: string;
}

export interface FleetConfig {
  nodes: NodeConfig[];
  username: string;
  password: string;
  /** Max seconds to wait for a remote agent to finish. Default: 600 */
  timeoutSeconds: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Parse a single "--node" value like "ubuntu=http://host:4096"
 */
function parseNodeArg(value: string): NodeConfig {
  const eqIdx = value.indexOf("=");
  if (eqIdx === -1) {
    throw new ConfigError(
      `Invalid --node value "${value}". Expected format: name=http://host:port`
    );
  }
  const name = value.slice(0, eqIdx).trim();
  const url = value.slice(eqIdx + 1).trim();
  if (!name) {
    throw new ConfigError(`Node name cannot be empty in "--node ${value}"`);
  }
  try {
    new URL(url);
  } catch {
    throw new ConfigError(
      `Invalid URL "${url}" in "--node ${value}"`
    );
  }
  return { name, url };
}

/**
 * Parse process.argv and return a validated FleetConfig.
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): FleetConfig {
  const nodes: NodeConfig[] = [];
  let password = "";
  let username = "opencode";
  let timeoutSeconds = 600;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--node") {
      const val = argv[++i];
      if (!val) throw new ConfigError("--node requires a value");
      nodes.push(parseNodeArg(val));
    } else if (arg.startsWith("--node=")) {
      nodes.push(parseNodeArg(arg.slice("--node=".length)));
    } else if (arg === "--password") {
      const val = argv[++i];
      if (!val) throw new ConfigError("--password requires a value");
      password = val;
    } else if (arg.startsWith("--password=")) {
      password = arg.slice("--password=".length);
    } else if (arg === "--username") {
      const val = argv[++i];
      if (!val) throw new ConfigError("--username requires a value");
      username = val;
    } else if (arg.startsWith("--username=")) {
      username = arg.slice("--username=".length);
    } else if (arg === "--timeout") {
      const val = argv[++i];
      if (!val) throw new ConfigError("--timeout requires a value");
      const n = parseInt(val, 10);
      if (isNaN(n) || n <= 0)
        throw new ConfigError(`--timeout must be a positive integer, got "${val}"`);
      timeoutSeconds = n;
    } else if (arg.startsWith("--timeout=")) {
      const val = arg.slice("--timeout=".length);
      const n = parseInt(val, 10);
      if (isNaN(n) || n <= 0)
        throw new ConfigError(`--timeout must be a positive integer, got "${val}"`);
      timeoutSeconds = n;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    // Unknown flags are silently ignored to allow MCP host to pass extra args
  }

  if (nodes.length === 0) {
    throw new ConfigError(
      "At least one --node must be specified. Example: --node ubuntu=http://192.168.1.10:4096"
    );
  }

  // Deduplicate node names
  const names = new Set<string>();
  for (const node of nodes) {
    if (names.has(node.name)) {
      throw new ConfigError(`Duplicate node name "${node.name}"`);
    }
    names.add(node.name);
  }

  return { nodes, username, password, timeoutSeconds };
}

function printHelp(): void {
  console.error(`
opencode-fleet — MCP server for coordinating multiple OpenCode instances

Usage:
  opencode-fleet [options]

Options:
  --node <name=url>       Register a remote OpenCode node (repeatable)
                          Example: --node ubuntu=http://192.168.1.10:4096
  --password <password>   Shared password for all nodes (OPENCODE_SERVER_PASSWORD)
  --username <username>   Shared username for all nodes (default: opencode)
  --timeout <seconds>     Max wait time per agent call (default: 600)
  -h, --help              Show this help

Environment variables:
  FLEET_PASSWORD          Alternative to --password
  FLEET_USERNAME          Alternative to --username
`);
}

/**
 * Resolve config, allowing env vars as fallback for sensitive values.
 */
export function resolveConfig(argv?: string[]): FleetConfig {
  const config = parseArgs(argv);

  // Environment variable fallbacks for credentials
  if (!config.password) {
    config.password = process.env["FLEET_PASSWORD"] ?? process.env["OPENCODE_SERVER_PASSWORD"] ?? "";
  }
  if (config.username === "opencode") {
    config.username = process.env["FLEET_USERNAME"] ?? process.env["OPENCODE_SERVER_USERNAME"] ?? "opencode";
  }

  return config;
}
