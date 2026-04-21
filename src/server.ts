#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { markscribeLog } from "./markscribe-log.js";
import type { ToolHandler, ServiceContainer } from "./types.js";
import { registerTools } from "./tools/index.js";
import { buildServices } from "./build-services.js";
import { parseCliArgs } from "./cli.js";

const SERVER_NAME = "markscribe";
const SERVER_VERSION = "0.1.0";

/**
 * Start the MarkScribe MCP server.
 * Root path from --root flag or cwd. Always has an active root.
 */
export async function startServer(): Promise<void> {
  const args = parseCliArgs();

  // Set log level from CLI args (pino supports runtime level changes)
  markscribeLog.level = args.logLevel;

  markscribeLog.info({ rootPath: args.root, schemasDir: args.schemasDir }, "starting markscribe server");

  // Build service container — tools close over this, services are swapped on switch_directory
  const container: ServiceContainer = { services: null };
  container.services = await buildServices(args.root, args.schemasDir);

  // Build tool registry — tools reference `container` so they see mutations
  const registry = new Map<string, ToolHandler>();
  registerTools(registry, container, (rootPath) => buildServices(rootPath, args.schemasDir));

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
    markscribeLog.debug({ toolCount: tools.length }, "tools/list");
    return { tools };
  });

  // tools/call — dispatch to registered handler
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const handler = registry.get(toolName);

    if (!handler) {
      markscribeLog.warn({ toolName }, "unknown tool called");
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    markscribeLog.info({ toolName }, "tool/call start");

    try {
      const result = await handler.handler(args);
      markscribeLog.info({ toolName, isError: result.isError ?? false }, "tool/call complete");
      return result as CallToolResult;
    } catch (err) {
      markscribeLog.error({ err, toolName }, "tool/call unhandled error");
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
  markscribeLog.info(
    { rootPath: args.root, toolCount: registry.size },
    "server connected",
  );
}

// Entry point when run directly
startServer().catch((err: unknown) => {
  markscribeLog.fatal({ err }, "server startup failed");
  process.exit(1);
});
