import path from "node:path";
import { z } from "zod";
import type { ToolHandler, ToolResponse, ServiceContainer } from "../types.js";
import { requireServices, getRoot } from "./index.js";
import { createChildLog } from "../markscribe-log.js";

const log = createChildLog({ module: "note-tools" });

// ============================================================================
// read_note
// ============================================================================

const ReadNoteSchema = z.object({
  path: z.string().min(1, "path is required"),
});

function makeReadNoteTool(container: ServiceContainer): ToolHandler {
  return {
    name: "read_note",
    description: "Returns `{ root, path, frontmatter, content }`. Pass a relative path. Use `list_directory` first if unsure of the path.",
    inputSchema: ReadNoteSchema,
    async handler(args): Promise<ToolResponse> {
      const services = requireServices(container);
      const { path } = ReadNoteSchema.parse(args);
      log.info({ path }, "read_note called");
      try {
        const note = await services.file.readNote(path);
        log.info({ path }, "read_note complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                root: getRoot(container),
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
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the path with list_directory", "Verify the file exists with list_directory", "Ensure the path is vault-relative (not absolute)"],
          }) }],
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

function makeWriteNoteTool(container: ServiceContainer): ToolHandler {
  return {
    name: "write_note",
    description:
      "Writes content to a note. Pass `{ path, content }` and optionally `frontmatter` (object) and `mode` (`overwrite`|`append`|`prepend`, default `overwrite`). Returns `{ root, path, message }`. Creates parent directories automatically.",
    inputSchema: WriteNoteSchema,
    async handler(args): Promise<ToolResponse> {
      const services = requireServices(container);
      const { path, content, frontmatter, mode } = WriteNoteSchema.parse(args);
      log.info({ path, mode }, "write_note called");
      try {
        await services.file.writeNote(path, content, frontmatter, mode);
        log.info({ path, mode }, "write_note complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                root: getRoot(container),
                path,
                message: `Note ${mode === "overwrite" ? "written" : mode + "ed"} successfully.`,
              }),
            },
          ],
        };
      } catch (err) {
        log.error({ err, path }, "write_note failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the path is vault-relative", "Ensure the path is not blocked (.obsidian, .git)", "Use read_note to confirm an existing note's path"],
          }) }],
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

function makePatchNoteTool(container: ServiceContainer): ToolHandler {
  return {
    name: "patch_note",
    description: "Replaces a string within a note. Pass `{ path, oldString, newString }` and optionally `replaceAll` (boolean). Returns `{ root, path, replacements }`. Read the note first to confirm the exact string.",
    inputSchema: PatchNoteSchema,
    async handler(args): Promise<ToolResponse> {
      const services = requireServices(container);
      const { path, oldString, newString, replaceAll } = PatchNoteSchema.parse(args);
      log.info({ path, replaceAll }, "patch_note called");
      try {
        // Count occurrences before patching so we can report replacements
        const note = await services.file.readNote(path);
        const occurrences = note.raw.split(oldString).length - 1;

        if (occurrences === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  root: getRoot(container),
                  error: `String not found in "${path}".`,
                  possibleSolutions: ["Read the note first with read_note to confirm the exact string to replace"],
                }),
              },
            ],
            isError: true,
          };
        }

        await services.file.patchNote(path, oldString, newString, replaceAll);
        const replacements = replaceAll ? occurrences : 1;
        log.info({ path, replacements }, "patch_note complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ root: getRoot(container), path, replacements }),
            },
          ],
        };
      } catch (err) {
        log.error({ err, path }, "patch_note failed");
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
// delete_note
// ============================================================================

const DeleteNoteSchema = z.object({
  path: z.string().min(1, "path is required"),
  confirmPath: z.string().min(1, "confirmPath is required"),
});

function makeDeleteNoteTool(container: ServiceContainer): ToolHandler {
  return {
    name: "delete_note",
    description: "Deletes a note. Pass `{ path, confirmPath }` where both must match exactly. Returns `{ root, path, success }`. This is irreversible.",
    inputSchema: DeleteNoteSchema,
    async handler(args): Promise<ToolResponse> {
      const services = requireServices(container);
      const { path, confirmPath } = DeleteNoteSchema.parse(args);
      log.info({ path }, "delete_note called");
      try {
        await services.file.deleteNote(path, confirmPath);
        log.info({ path }, "delete_note complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ root: getRoot(container), path, success: true }),
            },
          ],
        };
      } catch (err) {
        log.error({ err, path }, "delete_note failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Verify the path exists with read_note", "Ensure confirmPath exactly matches path"],
          }) }],
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

function makeMoveNoteTool(container: ServiceContainer): ToolHandler {
  return {
    name: "move_note",
    description:
      "Moves or renames a note. Pass `{ oldPath, newPath }`. Optional: `overwrite` (boolean), `updateLinks` (boolean, propagates `[[wikilink]]` renames). Returns `{ root, oldPath, newPath }` and optionally `linksUpdated`.",
    inputSchema: MoveNoteSchema,
    async handler(args): Promise<ToolResponse> {
      const services = requireServices(container);
      const { oldPath, newPath, updateLinks, overwrite } = MoveNoteSchema.parse(args);
      log.info({ oldPath, newPath, updateLinks, overwrite }, "move_note called");
      try {
        const result = await services.file.moveNote(oldPath, newPath, overwrite);

        if (!updateLinks) {
          log.info({ oldPath, newPath }, "move_note complete");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ root: getRoot(container), oldPath: result.oldPath, newPath: result.newPath }),
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
                root: getRoot(container),
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
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Verify the source path exists with read_note", "Check the destination path is not blocked", "Use overwrite: true if destination already exists"],
          }) }],
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

function makeReadMultipleNotesTool(container: ServiceContainer): ToolHandler {
  return {
    name: "read_multiple_notes",
    description: "Batch-reads up to 10 notes. Pass `{ paths: string[] }`. Returns `{ root, results[] }` where each result has `path`, `note` (or null), and optional `error`.",
    inputSchema: ReadMultipleNotesSchema,
    async handler(args): Promise<ToolResponse> {
      const services = requireServices(container);
      const { paths } = ReadMultipleNotesSchema.parse(args);
      log.info({ count: paths.length }, "read_multiple_notes called");
      try {
        const batch = await services.file.readMultipleNotes(paths);
        log.info({ count: paths.length }, "read_multiple_notes complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ root: getRoot(container), ...batch }),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "read_multiple_notes failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check each path with list_directory", "Ensure paths are vault-relative", "Provide between 1 and 10 paths"],
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

export function registerNoteTools(
  registry: Map<string, ToolHandler>,
  container: ServiceContainer,
): void {
  const tools = [
    makeReadNoteTool(container),
    makeWriteNoteTool(container),
    makePatchNoteTool(container),
    makeDeleteNoteTool(container),
    makeMoveNoteTool(container),
    makeReadMultipleNotesTool(container),
  ];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
