import { z } from "zod";
import type { ToolHandler, Services, ToolResponse } from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";

const log = createChildLog({ module: "frontmatter-tools" });

// ============================================================================
// get_frontmatter
// ============================================================================

const GetFrontmatterSchema = z.object({
  path: z.string().describe("Vault-relative path to the note."),
});

function makeGetFrontmatterTool(services: Services): ToolHandler {
  return {
    name: "get_frontmatter",
    description:
      "Read the YAML frontmatter of a note without returning the full content. Returns the path and a frontmatter object.",
    inputSchema: GetFrontmatterSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { path: notePath } = GetFrontmatterSchema.parse(args);
        log.info({ notePath }, "get_frontmatter called");
        const note = await services.vault.readNote(notePath);
        log.info(
          { path: notePath, fieldCount: Object.keys(note.frontmatter).length },
          "get_frontmatter complete",
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ path: notePath, frontmatter: note.frontmatter }, null, 2),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "get_frontmatter failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
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
  path: z.string().describe("Vault-relative path to the note."),
  fields: z.record(z.string(), z.unknown()).describe("Key-value pairs to set in the frontmatter."),
  merge: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true (default), merge with existing frontmatter. If false, replace all fields."),
});

function makeUpdateFrontmatterTool(services: Services): ToolHandler {
  return {
    name: "update_frontmatter",
    description:
      "Merge or replace frontmatter fields in a note. By default merges into existing frontmatter. Set merge=false to replace all fields.",
    inputSchema: UpdateFrontmatterSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { path: notePath, fields, merge } = UpdateFrontmatterSchema.parse(args);
        log.info(
          { notePath, fieldCount: Object.keys(fields).length, merge },
          "update_frontmatter called",
        );
        await services.frontmatter.updateFields(notePath, fields, merge);
        const updatedNote = await services.vault.readNote(notePath);
        log.info({ path: notePath }, "update_frontmatter complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { path: notePath, frontmatter: updatedNote.frontmatter },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "update_frontmatter failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
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
  path: z.string().describe("Vault-relative path to the note."),
  operation: z
    .enum(["add", "remove", "list"])
    .describe('Tag operation: "add" new tags, "remove" existing tags, or "list" all tags.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Tags to add or remove. Not required for "list" operation.'),
});

function makeManageTagsTool(services: Services): ToolHandler {
  return {
    name: "manage_tags",
    description:
      'Add, remove, or list tags on a note. Handles both YAML frontmatter tags arrays and inline #tags in content. Operations: "add" | "remove" | "list".',
    inputSchema: ManageTagsSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { path: notePath, operation, tags } = ManageTagsSchema.parse(args);
        log.info({ notePath, operation, tagCount: tags?.length }, "manage_tags called");
        const result = await services.frontmatter.manageTags(notePath, operation, tags);
        log.info(
          { path: notePath, operation, tagCount: result.tags.length },
          "manage_tags complete",
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "manage_tags failed");
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

export function registerFrontmatterTools(
  registry: Map<string, ToolHandler>,
  services: Services,
): void {
  const tools = [
    makeGetFrontmatterTool(services),
    makeUpdateFrontmatterTool(services),
    makeManageTagsTool(services),
  ];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
