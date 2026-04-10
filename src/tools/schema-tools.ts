import { z } from "zod";
import type { ToolHandler, Services, ToolResponse } from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";

const log = createChildLog({ module: "schema-tools" });

// ============================================================================
// lint_note
// ============================================================================

const lintNoteSchema = z.object({
  path: z.string().describe("Vault-relative path to the note to validate."),
});

function makeLintNoteHandler(services: Services): ToolHandler["handler"] {
  return async (args: Record<string, unknown>): Promise<ToolResponse> => {
    const parsed = lintNoteSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        isError: true,
      };
    }

    const { path: notePath } = parsed.data;
    const toolLog = createChildLog({ tool: "lint_note", path: notePath });
    toolLog.info({ notePath }, "lint_note called");

    try {
      const result = await services.schema.lintNote(notePath);
      toolLog.info(
        { schema: result.schema, pass: result.pass, checkCount: result.checks.length },
        "lint_note complete",
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolLog.error({ err, notePath }, "lint_note failed");
      return {
        content: [{ type: "text", text: `Error linting note: ${message}` }],
        isError: true,
      };
    }
  };
}

// ============================================================================
// validate_folder
// ============================================================================

const validateFolderSchema = z.object({
  path: z.string().describe("Vault-relative path to the folder to validate."),
});

function makeValidateFolderHandler(services: Services): ToolHandler["handler"] {
  return async (args: Record<string, unknown>): Promise<ToolResponse> => {
    const parsed = validateFolderSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        isError: true,
      };
    }

    const { path: folderPath } = parsed.data;
    const toolLog = createChildLog({ tool: "validate_folder", path: folderPath });
    toolLog.info({ folderPath }, "validate_folder called");

    try {
      const result = await services.schema.validateFolder(folderPath);
      toolLog.info(
        { schema: result.schema, folderType: result.folderType, pass: result.pass },
        "validate_folder complete",
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolLog.error({ err, folderPath }, "validate_folder failed");
      return {
        content: [{ type: "text", text: `Error validating folder: ${message}` }],
        isError: true,
      };
    }
  };
}

// ============================================================================
// validate_area
// ============================================================================

const validateAreaSchema = z.object({
  path: z.string().describe("Vault-relative path to the area (subtree) to validate recursively."),
});

function makeValidateAreaHandler(services: Services): ToolHandler["handler"] {
  return async (args: Record<string, unknown>): Promise<ToolResponse> => {
    const parsed = validateAreaSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        isError: true,
      };
    }

    const { path: areaPath } = parsed.data;
    const toolLog = createChildLog({ tool: "validate_area", path: areaPath });
    toolLog.info({ areaPath }, "validate_area called");

    try {
      const result = await services.schema.validateArea(areaPath);
      toolLog.info(
        { schema: result.schema, pass: result.pass, summary: result.summary },
        "validate_area complete",
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolLog.error({ err, areaPath }, "validate_area failed");
      return {
        content: [{ type: "text", text: `Error validating area: ${message}` }],
        isError: true,
      };
    }
  };
}

// ============================================================================
// list_schemas
// ============================================================================

const listSchemasSchema = z.object({});

function makeListSchemasHandler(services: Services): ToolHandler["handler"] {
  return async (_args: Record<string, unknown>): Promise<ToolResponse> => {
    const toolLog = createChildLog({ tool: "list_schemas" });
    toolLog.info("list_schemas called");

    try {
      const schemas = services.schema.listSchemas();
      toolLog.info({ count: schemas.length }, "list_schemas complete");

      return {
        content: [{ type: "text", text: JSON.stringify(schemas, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolLog.error({ err }, "list_schemas failed");
      return {
        content: [{ type: "text", text: `Error listing schemas: ${message}` }],
        isError: true,
      };
    }
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerSchemaTools(registry: Map<string, ToolHandler>, services: Services): void {
  log.info("registering schema tools");

  const lintNote: ToolHandler = {
    name: "lint_note",
    description:
      "Validate a note against its applicable schema. Returns a LintResult with pass/fail status, which schema was applied (null if none matched), and individual check results.",
    inputSchema: lintNoteSchema,
    handler: makeLintNoteHandler(services),
  };

  const validateFolder: ToolHandler = {
    name: "validate_folder",
    description:
      "Classify and validate a folder. Returns a FolderValidation with the folder type (packet, superfolder, supplemental, unclassified), per-note lint results, and structural check results.",
    inputSchema: validateFolderSchema,
    handler: makeValidateFolderHandler(services),
  };

  const validateArea: ToolHandler = {
    name: "validate_area",
    description:
      "Recursively validate a vault subtree. Returns an AreaValidation with per-folder results and a summary of total, passed, failed, and skipped folders.",
    inputSchema: validateAreaSchema,
    handler: makeValidateAreaHandler(services),
  };

  const listSchemas: ToolHandler = {
    name: "list_schemas",
    description:
      "List all loaded schemas with their names, descriptions, scopes, field counts, content rule counts, and whether folder configuration is present.",
    inputSchema: listSchemasSchema,
    handler: makeListSchemasHandler(services),
  };

  registry.set(lintNote.name, lintNote);
  registry.set(validateFolder.name, validateFolder);
  registry.set(validateArea.name, validateArea);
  registry.set(listSchemas.name, listSchemas);

  log.info(
    { tools: [lintNote.name, validateFolder.name, validateArea.name, listSchemas.name] },
    "schema tools registered",
  );
}
