import path from "node:path";
import fs from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { vaultscribeLog } from "./vaultscribe-log.js";
import type { ToolHandler, Services, PathFilterConfig } from "./types.js";
import { registerTools } from "./tools/index.js";
import { PathFilterImpl } from "./services/path-filter.js";
import { VaultServiceImpl } from "./services/vault-service.js";
import { FrontmatterServiceImpl } from "./services/frontmatter-service.js";
import { SearchServiceImpl } from "./services/search-service.js";
import { SchemaEngineImpl } from "./services/schema-engine.js";
import { LinkEngineImpl } from "./services/link-engine.js";

const SERVER_NAME = "vaultscribe";
const SERVER_VERSION = "0.1.0";

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

  // Build services with dependency injection
  const pathFilterConfig: PathFilterConfig = {
    blockedPaths: [],
    allowedExtensions: [".md", ".markdown", ".txt"],
  };
  const pathFilter = new PathFilterImpl(pathFilterConfig);
  const vault = new VaultServiceImpl(vaultPath, pathFilter);
  const frontmatter = new FrontmatterServiceImpl(vault);
  const search = new SearchServiceImpl(vault, frontmatter);
  const schema = new SchemaEngineImpl(vault, frontmatter);
  const links = new LinkEngineImpl(vault);

  // Load schemas from .vaultscribe/schemas/ if the directory exists
  const schemasDir = path.join(vaultPath, ".vaultscribe", "schemas");
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
