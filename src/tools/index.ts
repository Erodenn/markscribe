import type { ToolHandler, Services } from "../types.js";

/**
 * Register all tools into the registry.
 * Tools are added in later phases — this barrel is the integration point.
 */
export function registerTools(
  registry: Map<string, ToolHandler>,
  _services: Services,
): void {
  // Phase 1+ tools are registered here as they are implemented.
  void registry;
}
