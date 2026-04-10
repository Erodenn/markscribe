import { z } from "zod";
import type { ToolHandler, Services, ToolResponse } from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";

const log = createChildLog({ module: "vault-tools" });

// ============================================================================
// list_directory
// ============================================================================

const listDirectorySchema = z.object({
  path: z.string().default("").describe("Vault-relative directory path. Empty string or omitted = vault root."),
});

function makeListDirectoryHandler(services: Services): ToolHandler["handler"] {
  return async (args: Record<string, unknown>): Promise<ToolResponse> => {
    const parsed = listDirectorySchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        isError: true,
      };
    }

    const { path: dirPath } = parsed.data;
    const toolLog = createChildLog({ tool: "list_directory", path: dirPath });
    toolLog.info({ dirPath }, "list_directory called");

    try {
      const listing = await services.vault.listDirectory(dirPath);
      toolLog.info({ entryCount: listing.entries.length }, "list_directory complete");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(listing, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolLog.error({ err, dirPath }, "list_directory failed");
      return {
        content: [{ type: "text", text: `Error listing directory: ${message}` }],
        isError: true,
      };
    }
  };
}

// ============================================================================
// get_vault_stats
// ============================================================================

const getVaultStatsSchema = z.object({});

function makeGetVaultStatsHandler(services: Services): ToolHandler["handler"] {
  return async (_args: Record<string, unknown>): Promise<ToolResponse> => {
    const toolLog = createChildLog({ tool: "get_vault_stats" });
    toolLog.info("get_vault_stats called");

    try {
      const stats = await services.vault.getVaultStats();
      toolLog.info({ noteCount: stats.noteCount, totalSize: stats.totalSize }, "get_vault_stats complete");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolLog.error({ err }, "get_vault_stats failed");
      return {
        content: [{ type: "text", text: `Error getting vault stats: ${message}` }],
        isError: true,
      };
    }
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerVaultTools(
  registry: Map<string, ToolHandler>,
  services: Services,
): void {
  log.info("registering vault tools");

  const listDirectory: ToolHandler = {
    name: "list_directory",
    description:
      "List files and subdirectories within the vault at the given path. Returns a DirectoryListing with path and entries. Blocked paths (.obsidian, .git, etc.) are automatically excluded.",
    inputSchema: listDirectorySchema,
    handler: makeListDirectoryHandler(services),
  };

  const getVaultStats: ToolHandler = {
    name: "get_vault_stats",
    description:
      "Get vault statistics: total note count, total size in bytes, and the most recently modified files.",
    inputSchema: getVaultStatsSchema,
    handler: makeGetVaultStatsHandler(services),
  };

  registry.set(listDirectory.name, listDirectory);
  registry.set(getVaultStats.name, getVaultStats);

  log.info({ tools: [listDirectory.name, getVaultStats.name] }, "vault tools registered");
}
