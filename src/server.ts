import path from "node:path";
import fs from "node:fs/promises";
import yaml from "js-yaml";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { vaultscribeLog } from "./vaultscribe-log.js";
import type { ToolHandler, Services, PathFilterConfig, VaultScribeConfig } from "./types.js";
import { registerTools } from "./tools/index.js";
import { PathFilterImpl } from "./services/path-filter.js";
import { VaultServiceImpl } from "./services/vault-service.js";
import { FrontmatterServiceImpl } from "./services/frontmatter-service.js";
import { SearchServiceImpl } from "./services/search-service.js";
import { SchemaEngineImpl } from "./services/schema-engine.js";
import { LinkEngineImpl } from "./services/link-engine.js";

const SERVER_NAME = "vaultscribe";
const SERVER_VERSION = "0.1.0";

const DEFAULT_ALLOWED_EXTENSIONS = [".md", ".markdown", ".txt"];
const DEFAULT_SCHEMAS_DIR = "schemas";

/**
 * Load .vaultscribe/config.yaml if it exists. Returns defaults for missing/invalid files.
 */
async function loadConfig(vaultPath: string): Promise<VaultScribeConfig> {
  const configPath = path.join(vaultPath, ".vaultscribe", "config.yaml");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = yaml.load(raw);
    if (!parsed || typeof parsed !== "object") {
      vaultscribeLog.debug({ configPath }, "config file empty or non-object, using defaults");
      return {};
    }
    vaultscribeLog.info({ configPath }, "config loaded");
    return parsed as VaultScribeConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      vaultscribeLog.debug({ configPath }, "no config file found, using defaults");
    } else {
      vaultscribeLog.warn({ err, configPath }, "failed to read config, using defaults");
    }
    return {};
  }
}

/**
 * Build the tool registry and wire MCP request handlers.
 */
function buildRegistry(services: Services): Map<string, ToolHandler> {
  const registry = new Map<string, ToolHandler>();
  registerTools(registry, services);
  return registry;
}

/**
 * Start the VaultScribe MCP server.
 * Vault path is read from process.argv[2].
 */
export async function startServer(): Promise<void> {
  const vaultPath = process.argv[2];
  if (!vaultPath) {
    vaultscribeLog.fatal("vault path required as first argument");
    process.exit(1);
  }

  vaultscribeLog.info({ vaultPath }, "starting vaultscribe server");

  // Load user config from .vaultscribe/config.yaml
  const config = await loadConfig(vaultPath);

  // Build services with dependency injection
  const pathFilterConfig: PathFilterConfig = {
    blockedPaths: config.paths?.blocked ?? [],
    allowedExtensions: config.paths?.allowed_extensions ?? DEFAULT_ALLOWED_EXTENSIONS,
  };
  const pathFilter = new PathFilterImpl(pathFilterConfig);
  const vault = new VaultServiceImpl(vaultPath, pathFilter);
  const frontmatter = new FrontmatterServiceImpl(vault);
  const search = new SearchServiceImpl(vault, frontmatter, {
    maxResults: config.search?.max_results,
    excerptChars: config.search?.excerpt_chars,
  });
  const schema = new SchemaEngineImpl(vault, frontmatter);
  const links = new LinkEngineImpl(vault);

  // Load schemas from configured directory (default: .vaultscribe/schemas/)
  const schemasDirName = config.schemas?.directory ?? DEFAULT_SCHEMAS_DIR;
  const schemasDir = path.join(vaultPath, ".vaultscribe", schemasDirName);
  try {
    await fs.access(schemasDir);
    await schema.loadSchemas(schemasDir);
    vaultscribeLog.info({ schemasDir }, "schemas loaded");
  } catch {
    vaultscribeLog.debug({ schemasDir }, "schemas directory not found, skipping");
  }

  const services: Services = { vault, frontmatter, search, schema, links };
  const registry = buildRegistry(services);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // tools/list — enumerate registered tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = Array.from(registry.values()).map((handler) => ({
      name: handler.name,
      description: handler.description,
      inputSchema: handler.inputSchema,
    }));
    vaultscribeLog.debug({ toolCount: tools.length }, "tools/list");
    return { tools };
  });

  // tools/call — dispatch to registered handler
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const handler = registry.get(toolName);

    if (!handler) {
      vaultscribeLog.warn({ toolName }, "unknown tool called");
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    vaultscribeLog.info({ toolName }, "tool/call start");

    try {
      const result = await handler.handler(args);
      vaultscribeLog.info({ toolName, isError: result.isError ?? false }, "tool/call complete");
      return result as CallToolResult;
    } catch (err) {
      vaultscribeLog.error({ err, toolName }, "tool/call unhandled error");
      return {
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  vaultscribeLog.info({ vaultPath, toolCount: registry.size }, "server connected");
}

// Entry point when run directly
startServer().catch((err: unknown) => {
  vaultscribeLog.fatal({ err }, "server startup failed");
  process.exit(1);
});
