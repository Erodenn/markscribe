import path from "node:path";
import { z } from "zod";
import type { ToolHandler, ToolResponse, Services } from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";

const log = createChildLog({ module: "note-tools" });

// ============================================================================
// read_note
// ============================================================================

const ReadNoteSchema = z.object({
  path: z.string().min(1, "path is required"),
});

function makeReadNoteTool(services: Services): ToolHandler {
  return {
    name: "read_note",
    description: "Read a note with parsed frontmatter and body content.",
    inputSchema: ReadNoteSchema,
    async handler(args): Promise<ToolResponse> {
      const { path } = ReadNoteSchema.parse(args);
      log.info({ path }, "read_note called");
      try {
        const note = await services.vault.readNote(path);
        log.info({ path }, "read_note complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                path: note.path,
                frontmatter: note.frontmatter,
                content: note.content,
              }),
            },
          ],
        };
      } catch (err) {
        log.error({ err, path }, "read_note failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// write_note
// ============================================================================

const WriteModeSchema = z.enum(["overwrite", "append", "prepend"]);

const WriteNoteSchema = z.object({
  path: z.string().min(1, "path is required"),
  content: z.string(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  mode: WriteModeSchema.optional().default("overwrite"),
});

function makeWriteNoteTool(services: Services): ToolHandler {
  return {
    name: "write_note",
    description:
      "Create or update a note. mode can be 'overwrite' (default), 'append', or 'prepend'.",
    inputSchema: WriteNoteSchema,
    async handler(args): Promise<ToolResponse> {
      const { path, content, frontmatter, mode } = WriteNoteSchema.parse(args);
      log.info({ path, mode }, "write_note called");
      try {
        await services.vault.writeNote(path, content, frontmatter, mode);
        log.info({ path, mode }, "write_note complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                path,
                message: `Note ${mode === "overwrite" ? "written" : mode + "ed"} successfully.`,
              }),
            },
          ],
        };
      } catch (err) {
        log.error({ err, path }, "write_note failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// patch_note
// ============================================================================

const PatchNoteSchema = z.object({
  path: z.string().min(1, "path is required"),
  oldString: z.string().min(1, "oldString is required"),
  newString: z.string(),
  replaceAll: z.boolean().optional().default(false),
});

function makePatchNoteTool(services: Services): ToolHandler {
  return {
    name: "patch_note",
    description: "Replace text within a note. Set replaceAll to true to replace every occurrence.",
    inputSchema: PatchNoteSchema,
    async handler(args): Promise<ToolResponse> {
      const { path, oldString, newString, replaceAll } = PatchNoteSchema.parse(args);
      log.info({ path, replaceAll }, "patch_note called");
      try {
        // Count occurrences before patching so we can report replacements
        const note = await services.vault.readNote(path);
        const occurrences = note.raw.split(oldString).length - 1;

        if (occurrences === 0) {
          return {
            content: [
              {
                type: "text",
                text: `String not found in "${path}".`,
              },
            ],
            isError: true,
          };
        }

        await services.vault.patchNote(path, oldString, newString, replaceAll);
        const replacements = replaceAll ? occurrences : 1;
        log.info({ path, replacements }, "patch_note complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ path, replacements }),
            },
          ],
        };
      } catch (err) {
        log.error({ err, path }, "patch_note failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// delete_note
// ============================================================================

const DeleteNoteSchema = z.object({
  path: z.string().min(1, "path is required"),
  confirmPath: z.string().min(1, "confirmPath is required"),
});

function makeDeleteNoteTool(services: Services): ToolHandler {
  return {
    name: "delete_note",
    description: "Delete a note. confirmPath must match path exactly as a safety check.",
    inputSchema: DeleteNoteSchema,
    async handler(args): Promise<ToolResponse> {
      const { path, confirmPath } = DeleteNoteSchema.parse(args);
      log.info({ path }, "delete_note called");
      try {
        await services.vault.deleteNote(path, confirmPath);
        log.info({ path }, "delete_note complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ path, success: true }),
            },
          ],
        };
      } catch (err) {
        log.error({ err, path }, "delete_note failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// move_note
// ============================================================================

const MoveNoteSchema = z.object({
  oldPath: z.string().min(1, "oldPath is required"),
  newPath: z.string().min(1, "newPath is required"),
  updateLinks: z.boolean().optional().default(false),
  overwrite: z.boolean().optional().default(false),
});

function makeMoveNoteTool(services: Services): ToolHandler {
  return {
    name: "move_note",
    description:
      "Move or rename a note within the vault. Set updateLinks to true to update all [[wikilinks]] referencing the old name. Errors if destination exists unless overwrite is true.",
    inputSchema: MoveNoteSchema,
    async handler(args): Promise<ToolResponse> {
      const { oldPath, newPath, updateLinks, overwrite } = MoveNoteSchema.parse(args);
      log.info({ oldPath, newPath, updateLinks, overwrite }, "move_note called");
      try {
        const result = await services.vault.moveNote(oldPath, newPath, overwrite);

        if (!updateLinks) {
          log.info({ oldPath, newPath }, "move_note complete");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ oldPath: result.oldPath, newPath: result.newPath }),
              },
            ],
          };
        }

        // Derive stems for propagateRename: filename without extension, leading _ stripped
        const oldStem = path.basename(oldPath, path.extname(oldPath)).replace(/^_/, "");
        const newStem = path.basename(newPath, path.extname(newPath)).replace(/^_/, "");

        const renameResult = await services.links.propagateRename(oldStem, newStem);
        log.info(
          { oldPath, newPath, filesUpdated: renameResult.filesUpdated },
          "move_note with updateLinks complete",
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                oldPath: result.oldPath,
                newPath: result.newPath,
                linksUpdated: {
                  filesUpdated: renameResult.filesUpdated,
                  linksUpdated: renameResult.linksUpdated,
                  modifiedFiles: renameResult.modifiedFiles,
                },
              }),
            },
          ],
        };
      } catch (err) {
        log.error({ err, oldPath, newPath }, "move_note failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// read_multiple_notes
// ============================================================================

const ReadMultipleNotesSchema = z.object({
  paths: z.array(z.string()).min(1, "at least one path required").max(10, "max 10 paths"),
});

function makeReadMultipleNotesTool(services: Services): ToolHandler {
  return {
    name: "read_multiple_notes",
    description: "Batch read up to 10 notes at once. Returns each note or an error per path.",
    inputSchema: ReadMultipleNotesSchema,
    async handler(args): Promise<ToolResponse> {
      const { paths } = ReadMultipleNotesSchema.parse(args);
      log.info({ count: paths.length }, "read_multiple_notes called");
      try {
        const batch = await services.vault.readMultipleNotes(paths);
        log.info({ count: paths.length }, "read_multiple_notes complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(batch),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "read_multiple_notes failed");
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

export function registerNoteTools(registry: Map<string, ToolHandler>, services: Services): void {
  const tools = [
    makeReadNoteTool(services),
    makeWriteNoteTool(services),
    makePatchNoteTool(services),
    makeDeleteNoteTool(services),
    makeMoveNoteTool(services),
    makeReadMultipleNotesTool(services),
  ];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
