import type { ToolHandler, Services, ServiceContainer, GlobalConfig } from "../types.js";
import { registerNoteTools } from "./note-tools.js";
import { registerVaultTools } from "./vault-tools.js";
import { registerFrontmatterTools } from "./frontmatter-tools.js";
import { registerSearchTools } from "./search-tools.js";
import { registerSchemaTools } from "./schema-tools.js";
import { registerCreateNoteTool } from "./create-note-tool.js";
import { registerLinkTools } from "./link-tools.js";

/**
 * Extract services from the container, throwing if no vault is active.
 * Call this at the top of every tool handler.
 */
export function requireServices(container: ServiceContainer): Services {
  if (!container.services) {
    throw new Error("No vault is active. Use the switch_vault tool to select a vault first.");
  }
  return container.services;
}

/**
 * Register all tools into the registry.
 */
export function registerTools(
  registry: Map<string, ToolHandler>,
  container: ServiceContainer,
  globalConfig: GlobalConfig | null,
): void {
  registerNoteTools(registry, container);
  registerVaultTools(registry, container, globalConfig);
  registerFrontmatterTools(registry, container);
  registerSearchTools(registry, container);
  registerSchemaTools(registry, container);
  registerCreateNoteTool(registry, container);
  registerLinkTools(registry, container);
}
