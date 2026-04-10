import type { ToolHandler, Services } from "../types.js";
import { registerNoteTools } from "./note-tools.js";
import { registerVaultTools } from "./vault-tools.js";
import { registerFrontmatterTools } from "./frontmatter-tools.js";
import { registerSearchTools } from "./search-tools.js";
import { registerSchemaTools } from "./schema-tools.js";
import { registerCreateNoteTool } from "./create-note-tool.js";
import { registerLinkTools } from "./link-tools.js";

/**
 * Register all tools into the registry.
 */
export function registerTools(registry: Map<string, ToolHandler>, services: Services): void {
  registerNoteTools(registry, services);
  registerVaultTools(registry, services);
  registerFrontmatterTools(registry, services);
  registerSearchTools(registry, services);
  registerSchemaTools(registry, services);
  registerCreateNoteTool(registry, services);
  registerLinkTools(registry, services);
}
