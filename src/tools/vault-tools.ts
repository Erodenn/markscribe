import path from "node:path";
import { z } from "zod";
import type { ToolHandler, ServiceContainer, ToolResponse, GlobalConfig } from "../types.js";
import { requireServices } from "./index.js";
import { resolveVaultPath } from "../global-config.js";
import { buildServices } from "../build-services.js";
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

function makeListDirectoryTool(container: ServiceContainer): ToolHandler {
  return {
    name: "list_directory",
    description:
      "List files and subdirectories within the vault at the given path. Returns a DirectoryListing with path and entries. Blocked paths (.obsidian, .git, etc.) are automatically excluded.",
    inputSchema: ListDirectorySchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
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

function makeGetVaultStatsTool(container: ServiceContainer): ToolHandler {
  return {
    name: "get_vault_stats",
    description:
      "Get vault statistics: total note count, total size in bytes, and the most recently modified files.",
    inputSchema: GetVaultStatsSchema,
    async handler(_args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
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
// list_vaults
// ============================================================================

const ListVaultsSchema = z.object({});

function makeListVaultsTool(
  container: ServiceContainer,
  globalConfig: GlobalConfig | null,
): ToolHandler {
  return {
    name: "list_vaults",
    description:
      "List named vaults from the global config (~/.vaultscribe/config.yaml) and show which vault is currently active.",
    inputSchema: ListVaultsSchema,
    async handler(_args): Promise<ToolResponse> {
      try {
        log.info("list_vaults called");
        const vaults = globalConfig?.vaults ?? {};
        const activeVaultPath = container.services?.vault.vaultPath ?? null;

        const entries = Object.entries(vaults).map(([name, vaultPath]) => ({
          name,
          path: vaultPath,
          active: activeVaultPath !== null && activeVaultPath === path.resolve(vaultPath),
        }));

        const result = {
          vaults: entries,
          activeVault: activeVaultPath,
          defaultVault: globalConfig?.default ?? null,
        };

        log.info({ vaultCount: entries.length, activeVaultPath }, "list_vaults complete");
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "list_vaults failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// switch_vault
// ============================================================================

const SwitchVaultSchema = z.object({
  vault: z
    .string()
    .min(1)
    .describe(
      'Vault name (alias from ~/.vaultscribe/config.yaml) or absolute path to the vault directory.',
    ),
});

function makeSwitchVaultTool(
  container: ServiceContainer,
  globalConfig: GlobalConfig | null,
): ToolHandler {
  return {
    name: "switch_vault",
    description:
      "Switch the active vault. Accepts a named vault alias from the global config or an absolute path. Rebuilds all services and reloads schemas for the new vault.",
    inputSchema: SwitchVaultSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { vault } = SwitchVaultSchema.parse(args);
        log.info({ vault }, "switch_vault called");

        const resolvedPath = resolveVaultPath(vault, globalConfig);
        if (!resolvedPath) {
          const available = Object.keys(globalConfig?.vaults ?? {});
          const hint =
            available.length > 0
              ? ` Available vaults: ${available.join(", ")}`
              : " No vaults configured in ~/.vaultscribe/config.yaml.";
          return {
            content: [
              {
                type: "text",
                text: `Cannot resolve vault "${vault}". Provide a named alias or an absolute path.${hint}`,
              },
            ],
            isError: true,
          };
        }

        // Build new services for the target vault
        const newServices = await buildServices(resolvedPath);
        container.services = newServices;

        log.info({ vault, resolvedPath }, "switch_vault complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                switched: true,
                vault: resolvedPath,
                message: `Switched to vault: ${resolvedPath}`,
              }),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "switch_vault failed");
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

export function registerVaultTools(
  registry: Map<string, ToolHandler>,
  container: ServiceContainer,
  globalConfig: GlobalConfig | null,
): void {
  const tools = [
    makeListDirectoryTool(container),
    makeGetVaultStatsTool(container),
    makeListVaultsTool(container, globalConfig),
    makeSwitchVaultTool(container, globalConfig),
  ];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
