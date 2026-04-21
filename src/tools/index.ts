import type { ToolHandler, Services, ServiceContainer } from "../types.js";
import { registerNoteTools } from "./note-tools.js";
import { registerDirectoryTools, type RebuildServices } from "./directory-tools.js";
import { registerFrontmatterTools } from "./frontmatter-tools.js";
import { registerSearchTools } from "./search-tools.js";
import { registerSchemaTools } from "./schema-tools.js";
import { registerCreateNoteTool } from "./create-note-tool.js";
import { registerLinkTools } from "./link-tools.js";

/**
 * Extract services from the container, throwing if no directory is active.
 * Call this at the top of every tool handler.
 */
export function requireServices(container: ServiceContainer): Services {
  if (!container.services) {
    throw new Error(
      "No directory is active. Pass --root <path> when starting the server, or call switch_directory to set one.",
    );
  }
  return container.services;
}

/**
 * Return the active root directory path, or process.cwd() if no directory is active.
 * Include as the first key in every tool response payload.
 */
export function getRoot(container: ServiceContainer): string {
  return container.services?.file.rootPath ?? process.cwd();
}

/**
 * Register all tools into the registry.
 */
export function registerTools(
  registry: Map<string, ToolHandler>,
  container: ServiceContainer,
  rebuildServices: RebuildServices,
): void {
  registerNoteTools(registry, container);
  registerDirectoryTools(registry, container, rebuildServices);
  registerFrontmatterTools(registry, container);
  registerSearchTools(registry, container);
  registerSchemaTools(registry, container);
  registerCreateNoteTool(registry, container);
  registerLinkTools(registry, container);
}
