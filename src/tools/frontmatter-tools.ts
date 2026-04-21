import { z } from "zod";
import type { ToolHandler, ServiceContainer, ToolResponse } from "../types.js";
import { requireServices, getRoot } from "./index.js";
import { createChildLog } from "../markscribe-log.js";

const log = createChildLog({ module: "frontmatter-tools" });

// ============================================================================
// get_frontmatter
// ============================================================================

const GetFrontmatterSchema = z.object({
  path: z.string().describe("Root-relative path to the note."),
});

function makeGetFrontmatterTool(container: ServiceContainer): ToolHandler {
  return {
    name: "get_frontmatter",
    description:
      "Returns `{ root, path, frontmatter }` for a note. Reads only the YAML frontmatter block, not the body.",
    inputSchema: GetFrontmatterSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        const { path: notePath } = GetFrontmatterSchema.parse(args);
        log.info({ notePath }, "get_frontmatter called");
        const note = await services.file.readNote(notePath);
        log.info(
          { path: notePath, fieldCount: Object.keys(note.frontmatter).length },
          "get_frontmatter complete",
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ root: getRoot(container), path: notePath, frontmatter: note.frontmatter }, null, 2),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "get_frontmatter failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the path with list_directory", "Verify the file exists with read_note"],
          }) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// update_frontmatter
// ============================================================================

const UpdateFrontmatterSchema = z.object({
  path: z.string().describe("Root-relative path to the note."),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .default({})
    .describe("Key-value pairs to set in the frontmatter. `null` is a valid value (not a delete sentinel) — use `remove` to drop keys."),
  remove: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Keys to delete from the frontmatter. Runs after the merge/replace step, so a key in both `fields` and `remove` ends up removed."),
  merge: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true (default), merge with existing frontmatter. If false, replace all fields."),
});

function makeUpdateFrontmatterTool(container: ServiceContainer): ToolHandler {
  return {
    name: "update_frontmatter",
    description:
      "Sets and/or removes frontmatter keys. Pass `{ path, fields?, remove?, merge? }`. `fields` sets key-value pairs (null is a real value, pass-through to schema validation). `remove` is a list of keys to delete. `merge` (default true) merges with existing frontmatter; false replaces all fields. Returns `{ root, path, frontmatter }`.",
    inputSchema: UpdateFrontmatterSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        const { path: notePath, fields, remove, merge } = UpdateFrontmatterSchema.parse(args);
        log.info(
          {
            notePath,
            fieldCount: Object.keys(fields).length,
            removeCount: remove.length,
            merge,
          },
          "update_frontmatter called",
        );
        await services.frontmatter.updateFields(notePath, fields, merge, remove);
        const updatedNote = await services.file.readNote(notePath);
        log.info({ path: notePath }, "update_frontmatter complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { root: getRoot(container), path: notePath, frontmatter: updatedNote.frontmatter },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "update_frontmatter failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the path with list_directory", "Verify the file exists with read_note", "Ensure field values are valid YAML types"],
          }) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// manage_tags
// ============================================================================

const ManageTagsSchema = z.object({
  path: z.string().describe("Root-relative path to the note."),
  operation: z
    .enum(["add", "remove", "list"])
    .describe('Tag operation: "add" new tags, "remove" existing tags, or "list" all tags.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Tags to add or remove. Not required for "list" operation.'),
});

function makeManageTagsTool(container: ServiceContainer): ToolHandler {
  return {
    name: "manage_tags",
    description:
      'Add, remove, or list tags on a note. Pass `{ path, operation, tags? }` where `operation` is `add`|`remove`|`list`. Handles both YAML `tags` arrays and inline `#tags`. Returns `{ root, path, tags, added?, removed? }`.',
    inputSchema: ManageTagsSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        const { path: notePath, operation, tags } = ManageTagsSchema.parse(args);
        log.info({ notePath, operation, tagCount: tags?.length }, "manage_tags called");
        const result = await services.frontmatter.manageTags(notePath, operation, tags);
        log.info(
          { path: notePath, operation, tagCount: result.tags.length },
          "manage_tags complete",
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ root: getRoot(container), ...result }, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "manage_tags failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the path with list_directory", "Verify the file exists with read_note", "Use operation: 'list' to see current tags first"],
          }) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerFrontmatterTools(
  registry: Map<string, ToolHandler>,
  container: ServiceContainer,
): void {
  const tools = [
    makeGetFrontmatterTool(container),
    makeUpdateFrontmatterTool(container),
    makeManageTagsTool(container),
  ];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
