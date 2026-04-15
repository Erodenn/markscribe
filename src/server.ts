import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { vaultscribeLog } from "./vaultscribe-log.js";
import type { ToolHandler, ServiceContainer } from "./types.js";
import { registerTools } from "./tools/index.js";
import { loadGlobalConfig } from "./global-config.js";
import { buildServices } from "./build-services.js";

const SERVER_NAME = "vaultscribe";
const SERVER_VERSION = "0.1.0";

/**
 * Start the VaultScribe MCP server.
 * Vault path from CLI arg, or from ~/.vaultscribe/config.yaml.
 */
export async function startServer(): Promise<void> {
  const cliVaultPath = process.argv[2];

  // Load global config for multi-vault support
  const globalConfig = await loadGlobalConfig();

  // Determine initial vault path
  let initialVaultPath: string | undefined;
  if (cliVaultPath) {
    initialVaultPath = cliVaultPath;
  } else if (globalConfig?.default && globalConfig.vaults?.[globalConfig.default]) {
    initialVaultPath = globalConfig.vaults[globalConfig.default];
  }

  if (!initialVaultPath && !globalConfig) {
    vaultscribeLog.fatal(
      "no vault path provided. Either pass a vault path as CLI argument, " +
        "or create ~/.vaultscribe/config.yaml with named vaults",
    );
    process.exit(1);
  }

  // Build service container — tools close over this, services are swapped on vault switch
  const container: ServiceContainer = { services: null };

  if (initialVaultPath) {
    vaultscribeLog.info({ vaultPath: initialVaultPath }, "starting vaultscribe server");
    container.services = await buildServices(initialVaultPath);
  } else {
    vaultscribeLog.info("starting vaultscribe server with no active vault");
  }

  // Build tool registry — tools reference `container` so they see vault switches
  const registry = new Map<string, ToolHandler>();
  registerTools(registry, container, globalConfig);

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
  vaultscribeLog.info(
    { vaultPath: initialVaultPath ?? "(none)", toolCount: registry.size },
    "server connected",
  );
}

// Entry point when run directly
startServer().catch((err: unknown) => {
  vaultscribeLog.fatal({ err }, "server startup failed");
  process.exit(1);
});
