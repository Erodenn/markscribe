import { z } from "zod";
import type { ToolHandler, Services, ToolResponse } from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";

const log = createChildLog({ module: "schema-tools" });

// ============================================================================
// lint_note
// ============================================================================

const LintNoteSchema = z.object({
  path: z.string().describe("Vault-relative path to the note to validate."),
});

function makeLintNoteTool(services: Services): ToolHandler {
  return {
    name: "lint_note",
    description:
      "Validate a note against its applicable schema. Returns a LintResult with pass/fail status, which schema was applied (null if none matched), and individual check results.",
    inputSchema: LintNoteSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { path: notePath } = LintNoteSchema.parse(args);
        log.info({ notePath }, "lint_note called");
        const result = await services.schema.lintNote(notePath);
        log.info(
          { schema: result.schema, pass: result.pass, checkCount: result.checks.length },
          "lint_note complete",
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "lint_note failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// validate_folder
// ============================================================================

const ValidateFolderSchema = z.object({
  path: z.string().describe("Vault-relative path to the folder to validate."),
});

function makeValidateFolderTool(services: Services): ToolHandler {
  return {
    name: "validate_folder",
    description:
      "Classify and validate a folder. Returns a FolderValidation with the folder type (packet, superfolder, supplemental, unclassified), per-note lint results, and structural check results.",
    inputSchema: ValidateFolderSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { path: folderPath } = ValidateFolderSchema.parse(args);
        log.info({ folderPath }, "validate_folder called");
        const result = await services.schema.validateFolder(folderPath);
        log.info(
          { schema: result.schema, folderType: result.folderType, pass: result.pass },
          "validate_folder complete",
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "validate_folder failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// validate_area
// ============================================================================

const ValidateAreaSchema = z.object({
  path: z.string().describe("Vault-relative path to the area (subtree) to validate recursively."),
});

function makeValidateAreaTool(services: Services): ToolHandler {
  return {
    name: "validate_area",
    description:
      "Recursively validate a vault subtree. Returns an AreaValidation with per-folder results and a summary of total, passed, failed, and skipped folders.",
    inputSchema: ValidateAreaSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { path: areaPath } = ValidateAreaSchema.parse(args);
        log.info({ areaPath }, "validate_area called");
        const result = await services.schema.validateArea(areaPath);
        log.info(
          { schema: result.schema, pass: result.pass, summary: result.summary },
          "validate_area complete",
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "validate_area failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// list_schemas
// ============================================================================

const ListSchemasSchema = z.object({});

function makeListSchemasTool(services: Services): ToolHandler {
  return {
    name: "list_schemas",
    description:
      "List all loaded schemas with their names, descriptions, scopes, field counts, content rule counts, and whether folder configuration is present.",
    inputSchema: ListSchemasSchema,
    async handler(_args): Promise<ToolResponse> {
      try {
        log.info("list_schemas called");
        const schemas = services.schema.listSchemas();
        log.info({ count: schemas.length }, "list_schemas complete");
        return {
          content: [{ type: "text", text: JSON.stringify(schemas, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "list_schemas failed");
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

export function registerSchemaTools(registry: Map<string, ToolHandler>, services: Services): void {
  const tools = [
    makeLintNoteTool(services),
    makeValidateFolderTool(services),
    makeValidateAreaTool(services),
    makeListSchemasTool(services),
  ];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
