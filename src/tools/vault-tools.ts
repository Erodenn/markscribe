import { z } from "zod";
import type { ToolHandler, Services, ToolResponse } from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";

const log = createChildLog({ module: "vault-tools" });

// ============================================================================
// list_directory
// ============================================================================

const ListDirectorySchema = z.object({
  path: z
    .string()
    .default("")
    .describe("Vault-relative directory path. Empty string or omitted = vault root."),
});

function makeListDirectoryTool(services: Services): ToolHandler {
  return {
    name: "list_directory",
    description:
      "List files and subdirectories within the vault at the given path. Returns a DirectoryListing with path and entries. Blocked paths (.obsidian, .git, etc.) are automatically excluded.",
    inputSchema: ListDirectorySchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { path: dirPath } = ListDirectorySchema.parse(args);
        log.info({ dirPath }, "list_directory called");
        const listing = await services.vault.listDirectory(dirPath);
        log.info({ entryCount: listing.entries.length }, "list_directory complete");
        return {
          content: [{ type: "text", text: JSON.stringify(listing, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "list_directory failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// get_vault_stats
// ============================================================================

const GetVaultStatsSchema = z.object({});

function makeGetVaultStatsTool(services: Services): ToolHandler {
  return {
    name: "get_vault_stats",
    description:
      "Get vault statistics: total note count, total size in bytes, and the most recently modified files.",
    inputSchema: GetVaultStatsSchema,
    async handler(_args): Promise<ToolResponse> {
      try {
        log.info("get_vault_stats called");
        const stats = await services.vault.getVaultStats();
        log.info(
          { noteCount: stats.noteCount, totalSize: stats.totalSize },
          "get_vault_stats complete",
        );
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "get_vault_stats failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerVaultTools(registry: Map<string, ToolHandler>, services: Services): void {
  const tools = [makeListDirectoryTool(services), makeGetVaultStatsTool(services)];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
