import { describe, it, expect } from "vitest";
import { registerTools, LITE_TOOL_NAMES } from "./index.js";
import type { ToolHandler, ServiceContainer } from "../types.js";

const FULL_TOOL_NAMES: ReadonlySet<string> = new Set([
  // note-tools
  "read_note",
  "write_note",
  "patch_note",
  "delete_note",
  "move_note",
  "read_multiple_notes",
  // directory-tools
  "list_directory",
  "get_stats",
  "switch_directory",
  // frontmatter-tools
  "get_frontmatter",
  "update_frontmatter",
  "manage_tags",
  // search-tools
  "search_notes",
  // schema-tools
  "lint_note",
  "validate_folder",
  "validate_area",
  "list_schemas",
  "validate_all",
  // create-note-tool
  "create_note",
  // link-tools
  "get_backlinks",
  "find_unlinked_mentions",
  "find_broken_links",
  "find_orphans",
  "find_bidirectional_mentions",
]);

function buildRegistry(lite: boolean): Map<string, ToolHandler> {
  const registry = new Map<string, ToolHandler>();
  const container: ServiceContainer = { services: null };
  const stubRebuild = async () => {
    throw new Error("rebuild not wired in test");
  };
  registerTools(registry, container, stubRebuild, { lite });
  return registry;
}

describe("registerTools / LITE_TOOL_NAMES", () => {
  it("registers the full 24-tool surface in full mode", () => {
    const registry = buildRegistry(false);
    const names = new Set(registry.keys());
    expect(names).toEqual(FULL_TOOL_NAMES);
    expect(names.size).toBe(24);
  });

  it("registers exactly the lite allowlist in lite mode", () => {
    const registry = buildRegistry(true);
    const names = new Set(registry.keys());
    expect(names).toEqual(new Set(LITE_TOOL_NAMES));
    expect(names.size).toBe(12);
  });

  it("LITE_TOOL_NAMES is a strict subset of the full tool set", () => {
    for (const name of LITE_TOOL_NAMES) {
      expect(FULL_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(LITE_TOOL_NAMES.size).toBeLessThan(FULL_TOOL_NAMES.size);
  });
});
