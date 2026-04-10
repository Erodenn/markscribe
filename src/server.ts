import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { vaultscribeLog } from "./vaultscribe-log.js";
import type { ToolHandler, Services } from "./types.js";
import { registerTools } from "./tools/index.js";

const SERVER_NAME = "vaultscribe";
const SERVER_VERSION = "0.1.0";

/**
 * Build the tool registry and wire MCP request handlers.
 * services is partial here (Phase 0 has no real services yet).
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

  // Services are injected in later phases. Cast to satisfy the type — the
  // registry is empty in Phase 0 so no handler will dereference these.
  const services = {} as Services;
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
