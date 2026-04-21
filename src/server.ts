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
 * Server-level instructions returned to the MCP client during `initialize`.
 * Clients typically inject these into the model's system prompt, so they
 * frame how the model reasons about markscribe's role before it sees
 * individual tool descriptions.
 */
const FULL_INSTRUCTIONS =
  "MarkScribe: convention-aware markdown server. It provides atomic note read/write/move/delete, " +
  "batch reads, frontmatter and tag manipulation, full-text search, wikilink graph analysis " +
  "(backlinks, broken links, orphans, unlinked mentions), and schema-driven validation of notes " +
  "and folders. Conventions come from user-defined YAML schemas loaded from --schemas-dir " +
  "(default ~/.markscribe/schemas/). A `_conventions.md` file at any subtree root binds folder " +
  "schemas to that subtree. Search and the link graph rebuild on every call — no stale caches. " +
  "For validation, scale the scope to the question: lint_note for one note, validate_folder for " +
  "one folder, validate_area for a subtree, validate_all for the whole directory.";

const LITE_INSTRUCTIONS =
  "MarkScribe is running in --lite mode. Only schema validation and wikilink graph tools are " +
  "exposed: schema lint (lint_note, validate_folder, validate_area, validate_all, list_schemas), " +
  "link graph (get_backlinks, find_broken_links, find_orphans, find_unlinked_mentions), and meta " +
  "(get_stats, switch_directory). Note read/write/edit/move/delete, directory listing, " +
  "frontmatter and tag manipulation, and full-text search are intentionally NOT exposed — use " +
  "your harness's native file tools (read, write, edit, listing, search) for those operations. " +
  "Schemas load from --schemas-dir (default ~/.markscribe/schemas/); `_conventions.md` files " +
  "scope folder schemas to subtrees. Search and the link graph rebuild on every call.";

/**
 * Start the MarkScribe MCP server.
 * Root path from --root flag or cwd. Always has an active root.
 */
export async function startServer(): Promise<void> {
  const args = parseCliArgs();

  // Set log level from CLI args (pino supports runtime level changes)
  markscribeLog.level = args.logLevel;

  markscribeLog.info(
    { rootPath: args.root, schemasDir: args.schemasDir, lite: args.lite },
    "starting markscribe server",
  );

  // Build service container — tools close over this, services are swapped on switch_directory
  const container: ServiceContainer = { services: null };
  container.services = await buildServices(args.root, args.schemasDir);

  // Build tool registry — tools reference `container` so they see mutations
  const registry = new Map<string, ToolHandler>();
  registerTools(
    registry,
    container,
    (rootPath) => buildServices(rootPath, args.schemasDir),
    { lite: args.lite },
  );

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: args.lite ? LITE_INSTRUCTIONS : FULL_INSTRUCTIONS,
    },
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
