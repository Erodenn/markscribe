import { z } from "zod";
import type { ToolHandler, Services, ToolResponse } from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";

const log = createChildLog({ module: "frontmatter-tools" });

// ============================================================================
// get_frontmatter
// ============================================================================

const getFrontmatterSchema = z.object({
  path: z.string().describe("Vault-relative path to the note."),
});

function makeGetFrontmatterHandler(services: Services): ToolHandler["handler"] {
  return async (args: Record<string, unknown>): Promise<ToolResponse> => {
    const parsed = getFrontmatterSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        isError: true,
      };
    }

    const { path: notePath } = parsed.data;
    const toolLog = createChildLog({ tool: "get_frontmatter", path: notePath });
    toolLog.info({ notePath }, "get_frontmatter called");

    try {
      const note = await services.vault.readNote(notePath);
      toolLog.info(
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
      const message = err instanceof Error ? err.message : String(err);
      toolLog.error({ err, notePath }, "get_frontmatter failed");
      return {
        content: [{ type: "text", text: `Error reading frontmatter: ${message}` }],
        isError: true,
      };
    }
  };
}

// ============================================================================
// update_frontmatter
// ============================================================================

const updateFrontmatterSchema = z.object({
  path: z.string().describe("Vault-relative path to the note."),
  fields: z.record(z.string(), z.unknown()).describe("Key-value pairs to set in the frontmatter."),
  merge: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true (default), merge with existing frontmatter. If false, replace all fields."),
});

function makeUpdateFrontmatterHandler(services: Services): ToolHandler["handler"] {
  return async (args: Record<string, unknown>): Promise<ToolResponse> => {
    const parsed = updateFrontmatterSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        isError: true,
      };
    }

    const { path: notePath, fields, merge } = parsed.data;
    const toolLog = createChildLog({ tool: "update_frontmatter", path: notePath });
    toolLog.info(
      { notePath, fieldCount: Object.keys(fields).length, merge },
      "update_frontmatter called",
    );

    try {
      await services.frontmatter.updateFields(notePath, fields, merge);

      // Read updated note to return the new frontmatter
      const updatedNote = await services.vault.readNote(notePath);
      toolLog.info({ path: notePath }, "update_frontmatter complete");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ path: notePath, frontmatter: updatedNote.frontmatter }, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolLog.error({ err, notePath }, "update_frontmatter failed");
      return {
        content: [{ type: "text", text: `Error updating frontmatter: ${message}` }],
        isError: true,
      };
    }
  };
}

// ============================================================================
// manage_tags
// ============================================================================

const manageTagsSchema = z.object({
  path: z.string().describe("Vault-relative path to the note."),
  operation: z
    .enum(["add", "remove", "list"])
    .describe('Tag operation: "add" new tags, "remove" existing tags, or "list" all tags.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Tags to add or remove. Not required for "list" operation.'),
});

function makeManageTagsHandler(services: Services): ToolHandler["handler"] {
  return async (args: Record<string, unknown>): Promise<ToolResponse> => {
    const parsed = manageTagsSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        isError: true,
      };
    }

    const { path: notePath, operation, tags } = parsed.data;
    const toolLog = createChildLog({ tool: "manage_tags", path: notePath });
    toolLog.info({ notePath, operation, tagCount: tags?.length }, "manage_tags called");

    try {
      const result = await services.frontmatter.manageTags(notePath, operation, tags);
      toolLog.info(
        { path: notePath, operation, tagCount: result.tags.length },
        "manage_tags complete",
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolLog.error({ err, notePath, operation }, "manage_tags failed");
      return {
        content: [{ type: "text", text: `Error managing tags: ${message}` }],
        isError: true,
      };
    }
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerFrontmatterTools(
  registry: Map<string, ToolHandler>,
  services: Services,
): void {
  log.info("registering frontmatter tools");

  const getFrontmatter: ToolHandler = {
    name: "get_frontmatter",
    description:
      "Read the YAML frontmatter of a note without returning the full content. Returns the path and a frontmatter object.",
    inputSchema: getFrontmatterSchema,
    handler: makeGetFrontmatterHandler(services),
  };

  const updateFrontmatter: ToolHandler = {
    name: "update_frontmatter",
    description:
      "Merge or replace frontmatter fields in a note. By default merges into existing frontmatter. Set merge=false to replace all fields.",
    inputSchema: updateFrontmatterSchema,
    handler: makeUpdateFrontmatterHandler(services),
  };

  const manageTags: ToolHandler = {
    name: "manage_tags",
    description:
      'Add, remove, or list tags on a note. Handles both YAML frontmatter tags arrays and inline #tags in content. Operations: "add" | "remove" | "list".',
    inputSchema: manageTagsSchema,
    handler: makeManageTagsHandler(services),
  };

  registry.set(getFrontmatter.name, getFrontmatter);
  registry.set(updateFrontmatter.name, updateFrontmatter);
  registry.set(manageTags.name, manageTags);

  log.info(
    { tools: [getFrontmatter.name, updateFrontmatter.name, manageTags.name] },
    "frontmatter tools registered",
  );
}
