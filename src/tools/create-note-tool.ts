import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolHandler, Services, ToolResponse, LintResult } from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";

const log = createChildLog({ module: "create-note-tool" });

// ============================================================================
// create_note
// ============================================================================

const createNoteSchema = z.object({
  path: z.string().describe("Vault-relative path for the new note (e.g. Knowledge/MyNote.md)"),
  content: z.string().default("").describe("Note body content (default: empty string)"),
  frontmatter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Frontmatter overrides merged on top of template defaults"),
  schema: z
    .string()
    .optional()
    .describe("Explicit schema name. If omitted, auto-detected from path via scope rules"),
});

function makeCreateNoteHandler(services: Services): ToolHandler["handler"] {
  return async (args: Record<string, unknown>): Promise<ToolResponse> => {
    const parsed = createNoteSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        isError: true,
      };
    }

    const { path: notePath, content, frontmatter: fmOverrides, schema: explicitSchema } = parsed.data;
    const toolLog = createChildLog({ tool: "create_note", path: notePath });
    toolLog.info({ notePath, explicitSchema }, "create_note called");

    // Step 1: Check if file already exists
    try {
      const absolutePath = services.vault.resolvePath(notePath);
      await fs.access(absolutePath);
      // File exists — error out
      return {
        content: [
          {
            type: "text",
            text: `Note already exists: "${notePath}". Use write_note with overwrite mode for existing files.`,
          },
        ],
        isError: true,
      };
    } catch (err) {
      // ENOENT means file doesn't exist — that's what we want
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // resolvePath or fs.access threw for a different reason (traversal, blocked, etc.)
        const message = err instanceof Error ? err.message : String(err);
        toolLog.error({ err, notePath }, "create_note: pre-existence check failed");
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    }

    // Step 2: Resolve schema
    let resolvedSchemaName: string | null;

    if (explicitSchema !== undefined) {
      // Explicit schema — verify it exists
      const knownSchemas = services.schema.listSchemas();
      const found = knownSchemas.find((s) => s.name === explicitSchema);
      if (!found) {
        toolLog.error({ explicitSchema }, "create_note: named schema not found");
        return {
          content: [
            {
              type: "text",
              text: `Schema "${explicitSchema}" not found. Available schemas: ${knownSchemas.map((s) => s.name).join(", ") || "(none)"}`,
            },
          ],
          isError: true,
        };
      }
      resolvedSchemaName = explicitSchema;
      toolLog.debug({ schema: resolvedSchemaName }, "create_note: explicit schema resolved");
    } else {
      // Auto-detect from path
      const matchedSchema = services.schema.getSchemaForPath(notePath);
      resolvedSchemaName = matchedSchema?.name ?? null;
      toolLog.debug({ schema: resolvedSchemaName }, "create_note: schema auto-detected from path");
    }

    // Step 3: Build final frontmatter
    let finalFrontmatter: Record<string, unknown> | undefined;

    if (resolvedSchemaName !== null) {
      // Schema found — get template and merge overrides on top
      const template = services.schema.getTemplate(resolvedSchemaName);
      finalFrontmatter = { ...template.frontmatter, ...(fmOverrides ?? {}) };
      toolLog.debug(
        { templateKeys: Object.keys(template.frontmatter), overrideKeys: Object.keys(fmOverrides ?? {}) },
        "create_note: template merged with overrides",
      );
    } else {
      // No schema — use overrides as-is (may be undefined if not provided)
      finalFrontmatter = fmOverrides;
      toolLog.debug("create_note: no schema, using provided frontmatter as-is");
    }

    // Step 4: Write note atomically via VaultService
    try {
      await services.vault.writeNote(notePath, content, finalFrontmatter, "overwrite");
      toolLog.info({ notePath }, "create_note: note written");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolLog.error({ err, notePath }, "create_note: write failed");
      return {
        content: [{ type: "text", text: `Error writing note: ${message}` }],
        isError: true,
      };
    }

    // Step 5: Lint if schema was applied
    let lintResult: LintResult | null = null;
    if (resolvedSchemaName !== null) {
      try {
        lintResult = await services.schema.lintNote(notePath);
        toolLog.info(
          { schema: resolvedSchemaName, pass: lintResult.pass, checkCount: lintResult.checks.length },
          "create_note: lint complete",
        );
      } catch (err) {
        toolLog.warn({ err, notePath }, "create_note: lint failed (note was written)");
        // Lint failure is not a write failure — don't error the response
      }
    }

    // Read back the frontmatter as written to return accurate data
    let writtenFrontmatter: Record<string, unknown> = finalFrontmatter ?? {};
    try {
      const note = await services.vault.readNote(notePath);
      writtenFrontmatter = note.frontmatter;
    } catch {
      // Fall back to what we intended to write
    }

    const ext = path.extname(notePath);
    toolLog.info({ notePath, ext, hasLint: lintResult !== null }, "create_note complete");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ path: notePath, frontmatter: writtenFrontmatter, lintResult }, null, 2),
        },
      ],
    } as ToolResponse;
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerCreateNoteTool(
  registry: Map<string, ToolHandler>,
  services: Services,
): void {
  log.info("registering create_note tool");

  const createNote: ToolHandler = {
    name: "create_note",
    description: [
      "Create a new note at the given vault-relative path.",
      "Automatically resolves the applicable schema from the path and applies its frontmatter template.",
      "Frontmatter overrides are merged on top of template defaults.",
      "If no schema matches, the note is created with the provided frontmatter as-is.",
      "Returns the created note path, final frontmatter, and lint result (null when no schema applied).",
      "Error if the path already exists — use write_note with overwrite mode for existing files.",
    ].join(" "),
    inputSchema: createNoteSchema,
    handler: makeCreateNoteHandler(services),
  };

  registry.set(createNote.name, createNote);
  log.info({ tool: createNote.name }, "create_note tool registered");
}
