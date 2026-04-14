import { z } from "zod";
import type { ToolHandler, Services, ToolResponse, LintResult } from "../types.js";
import { expandTemplateVars, buildTemplateContext } from "../utils.js";
import { createChildLog } from "../vaultscribe-log.js";

const log = createChildLog({ module: "create-note-tool" });

// ============================================================================
// create_note
// ============================================================================

const CreateNoteSchema = z.object({
  path: z.string().describe("Vault-relative path for the new note (e.g. Knowledge/MyNote.md)"),
  content: z.string().default("").describe("Note body content (default: empty string)"),
  frontmatter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Frontmatter overrides merged on top of template defaults"),
  noteSchema: z
    .string()
    .optional()
    .describe("Explicit note schema name. If omitted, resolved from the convention cascade for the note's folder"),
});

function makeCreateNoteTool(services: Services): ToolHandler {
  return {
    name: "create_note",
    description: [
      "Create a new note at the given vault-relative path.",
      "Automatically resolves the applicable schema from the convention cascade and applies its frontmatter template.",
      "Frontmatter overrides are merged on top of template defaults.",
      "If no schema matches, the note is created with the provided frontmatter as-is.",
      "Returns the created note path, final frontmatter, and lint result (null when no schema applied).",
      "Error if the path already exists — use write_note with overwrite mode for existing files.",
    ].join(" "),
    inputSchema: CreateNoteSchema,
    async handler(args): Promise<ToolResponse> {
      let notePath: string;
      let content: string;
      let fmOverrides: Record<string, unknown> | undefined;
      let explicitSchema: string | undefined;
      try {
        const parsed = CreateNoteSchema.parse(args);
        notePath = parsed.path;
        content = parsed.content;
        fmOverrides = parsed.frontmatter;
        explicitSchema = parsed.noteSchema;
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
      log.info({ notePath, explicitSchema }, "create_note called");
      await services.schema.refresh();

      try {
        await services.vault.readNote(notePath);
        // If readNote succeeds, file already exists
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
        // ENOENT = file doesn't exist, which is what we want — proceed
        // "Path not allowed" = path filter blocks it — writeNote will also fail, proceed
        const code = (err as NodeJS.ErrnoException).code;
        const isPathError = err instanceof Error && err.message.includes("Path not allowed");
        if (code !== "ENOENT" && !isPathError) {
          log.error({ err, notePath }, "create_note: pre-existence check failed");
          return {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      }

      let resolvedSchemaName: string | null;

      if (explicitSchema !== undefined) {
        const knownSchemas = services.schema.listSchemas();
        const noteSchemas = knownSchemas.filter((s) => s.type === "note");
        const found = noteSchemas.find((s) => s.name === explicitSchema);
        if (!found) {
          log.error({ explicitSchema }, "create_note: note schema not found");
          return {
            content: [
              {
                type: "text",
                text: `Note schema "${explicitSchema}" not found. Available note schemas: ${noteSchemas.map((s) => s.name).join(", ") || "(none)"}`,
              },
            ],
            isError: true,
          };
        }
        resolvedSchemaName = explicitSchema;
      } else {
        const matchedSchema = services.schema.resolveNoteSchema(notePath);
        resolvedSchemaName = matchedSchema?.name ?? null;
      }

      let finalFrontmatter: Record<string, unknown> | undefined;

      if (resolvedSchemaName !== null) {
        const template = services.schema.getTemplate(resolvedSchemaName);
        const merged = { ...template.frontmatter, ...(fmOverrides ?? {}) };

        const overrideKeys = new Set(Object.keys(fmOverrides ?? {}));
        const ctx = buildTemplateContext(notePath);

        for (const [key, value] of Object.entries(merged)) {
          if (!overrideKeys.has(key) && typeof value === "string") {
            merged[key] = expandTemplateVars(value, ctx);
          }
        }

        finalFrontmatter = merged;
        log.debug(
          {
            templateKeys: Object.keys(template.frontmatter),
            overrideKeys: Object.keys(fmOverrides ?? {}),
          },
          "create_note: template merged with overrides and expanded",
        );
      } else {
        finalFrontmatter = fmOverrides;
      }

      try {
        await services.vault.writeNote(notePath, content, finalFrontmatter, "overwrite");
        log.info({ notePath }, "create_note: note written");
      } catch (err) {
        log.error({ err, notePath }, "create_note: write failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }

      let lintResult: LintResult | null = null;
      if (resolvedSchemaName !== null) {
        try {
          lintResult = await services.schema.lintNote(notePath);
          log.info(
            {
              schema: resolvedSchemaName,
              pass: lintResult.pass,
              checkCount: lintResult.checks.length,
            },
            "create_note: lint complete",
          );
        } catch (err) {
          log.warn({ err, notePath }, "create_note: lint failed (note was written)");
        }
      }

      // Read back to capture any YAML round-trip normalization (e.g. date coercion)
      let writtenFrontmatter: Record<string, unknown> = finalFrontmatter ?? {};
      try {
        const note = await services.vault.readNote(notePath);
        writtenFrontmatter = note.frontmatter;
      } catch {
        // Fall back to intended values
      }

      log.info({ notePath, hasLint: lintResult !== null }, "create_note complete");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { path: notePath, frontmatter: writtenFrontmatter, lintResult },
              null,
              2,
            ),
          },
        ],
      };
    },
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerCreateNoteTool(
  registry: Map<string, ToolHandler>,
  services: Services,
): void {
  const tools = [makeCreateNoteTool(services)];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
