import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolHandler, ServiceContainer, ToolResponse, ConfigHolder } from "../types.js";
import { requireServices } from "./index.js";
import { resolveVaultPath, loadGlobalConfig, saveGlobalConfig } from "../global-config.js";
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
  holder: ConfigHolder,
  cliVaultPath?: string,
): ToolHandler {
  return {
    name: "list_vaults",
    description:
      "List named vaults from the global config (~/.vaultscribe/config.yaml) and show which vault is currently active.",
    inputSchema: ListVaultsSchema,
    async handler(_args): Promise<ToolResponse> {
      try {
        log.info("list_vaults called");
        const globalConfig = holder.config;
        const vaults = globalConfig?.vaults ?? {};
        const activeVaultPath = container.services?.vault.vaultPath ?? null;

        const entries = Object.entries(vaults).map(([name, vaultPath]) => ({
          name,
          path: vaultPath,
          active: activeVaultPath !== null && activeVaultPath === path.resolve(vaultPath),
        }));

        // If active vault came from CLI and isn't in config, show it as a synthetic entry
        if (
          cliVaultPath &&
          activeVaultPath !== null &&
          !entries.some((e) => e.active)
        ) {
          entries.push({
            name: cliVaultPath,
            path: activeVaultPath,
            active: true,
          });
        }

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
  holder: ConfigHolder,
  cliVaultPath?: string,
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

        const resolvedPath = resolveVaultPath(vault, holder.config);
        if (!resolvedPath) {
          const available = Object.keys(holder.config?.vaults ?? {});
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

        const message = cliVaultPath
          ? `Switched to vault: ${resolvedPath} (overrides CLI arg for this session)`
          : `Switched to vault: ${resolvedPath}`;

        log.info({ vault, resolvedPath }, "switch_vault complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                switched: true,
                vault: resolvedPath,
                message,
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
// add_vault
// ============================================================================

const AddVaultSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Alias name for the vault (e.g. 'work', 'personal')."),
  path: z
    .string()
    .min(1)
    .describe("Absolute path to the vault directory."),
  setDefault: z
    .boolean()
    .optional()
    .describe("Set this vault as the default. Auto-set if no default exists."),
});

function makeAddVaultTool(
  container: ServiceContainer,
  holder: ConfigHolder,
  configPath?: string,
): ToolHandler {
  return {
    name: "add_vault",
    description:
      "Register a new vault in the global config (~/.vaultscribe/config.yaml). " +
      "Persists the vault alias and path to disk. Auto-sets as default if no default exists. " +
      "If no vault is currently active, automatically switches to the new vault.",
    inputSchema: AddVaultSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { name, path: vaultPath, setDefault } = AddVaultSchema.parse(args);
        log.info({ name, vaultPath, setDefault }, "add_vault called");

        // Validate path is absolute
        if (!path.isAbsolute(vaultPath)) {
          return {
            content: [{ type: "text", text: `Path must be absolute. Received: ${vaultPath}` }],
            isError: true,
          };
        }

        // Validate directory exists
        try {
          const stat = await fs.stat(vaultPath);
          if (!stat.isDirectory()) {
            return {
              content: [{ type: "text", text: `Path is not a directory: ${vaultPath}` }],
              isError: true,
            };
          }
        } catch {
          return {
            content: [{ type: "text", text: `Directory does not exist: ${vaultPath}` }],
            isError: true,
          };
        }

        // Re-read config from disk to avoid stale reads
        const freshConfig = await loadGlobalConfig(configPath);
        const config = freshConfig ?? { vaults: {}, default: undefined };
        if (!config.vaults) {
          config.vaults = {};
        }

        // Merge new vault entry
        config.vaults[name] = vaultPath;

        // Auto-set default if none exists, or if explicitly requested
        if (setDefault || !config.default) {
          config.default = name;
        }

        // Save to disk
        await saveGlobalConfig(config, configPath);

        // Update in-memory holder
        holder.config = config;

        // If no vault is currently active, auto-switch to the new vault
        let autoSwitched = false;
        if (!container.services) {
          const newServices = await buildServices(vaultPath);
          container.services = newServices;
          autoSwitched = true;
          log.info({ name, vaultPath }, "auto-switched to new vault");
        }

        log.info({ name, vaultPath, isDefault: config.default === name }, "add_vault complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                added: true,
                name,
                path: vaultPath,
                isDefault: config.default === name,
                autoSwitched,
                message: autoSwitched
                  ? `Vault "${name}" added and activated.`
                  : `Vault "${name}" added to config.`,
              }),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "add_vault failed");
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
  holder: ConfigHolder,
  cliVaultPath?: string,
  configPath?: string,
): void {
  const tools = [
    makeListDirectoryTool(container),
    makeGetVaultStatsTool(container),
    makeListVaultsTool(container, holder, cliVaultPath),
    makeSwitchVaultTool(container, holder, cliVaultPath),
    makeAddVaultTool(container, holder, configPath),
  ];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
