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
 * Allowlist of tool names exposed in --lite mode.
 *
 * Lite mode trims the surface to MarkScribe's unique value — convention
 * enforcement and the link graph — and defers note CRUD / frontmatter /
 * discovery to the harness's native file tools.
 */
export const LITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Schema / lint
  "lint_note",
  "validate_folder",
  "validate_area",
  "validate_all",
  "list_schemas",
  // Link graph
  "find_broken_links",
  "find_orphans",
  "find_unlinked_mentions",
  "get_backlinks",
  // Meta
  "switch_directory",
  "get_stats",
]);

export interface RegisterToolsOptions {
  lite?: boolean;
}

/**
 * Register all tools into the registry.
 *
 * When `lite` is true, every tool not in LITE_TOOL_NAMES is removed from the
 * registry after sub-registers run. Sub-registers stay lite-unaware so the
 * allowlist remains a single, greppable source of truth.
 */
export function registerTools(
  registry: Map<string, ToolHandler>,
  container: ServiceContainer,
  rebuildServices: RebuildServices,
  options: RegisterToolsOptions = {},
): void {
  registerNoteTools(registry, container);
  registerDirectoryTools(registry, container, rebuildServices);
  registerFrontmatterTools(registry, container);
  registerSearchTools(registry, container);
  registerSchemaTools(registry, container);
  registerCreateNoteTool(registry, container);
  registerLinkTools(registry, container);

  if (options.lite) {
    for (const name of registry.keys()) {
      if (!LITE_TOOL_NAMES.has(name)) registry.delete(name);
    }
  }
}
