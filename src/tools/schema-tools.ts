import { z } from "zod";
import type { ToolHandler, ServiceContainer, ToolResponse } from "../types.js";
import { requireServices, getRoot } from "./index.js";
import { createChildLog } from "../markscribe-log.js";

const log = createChildLog({ module: "schema-tools" });

// ============================================================================
// lint_note
// ============================================================================

const LintNoteSchema = z.object({
  path: z.string().describe("Vault-relative path to the note to validate."),
});

function makeLintNoteTool(container: ServiceContainer): ToolHandler {
  return {
    name: "lint_note",
    description:
      "Validates a note against its resolved schema. Pass `{ path }`. Returns `{ root, path, pass, schema, checks[] }`. Each check has `name`, `pass`, `detail`. Returns `schema: null` if no schema matches.",
    inputSchema: LintNoteSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        const { path: notePath } = LintNoteSchema.parse(args);
        log.info({ notePath }, "lint_note called");
        await services.schema.refresh();
        const result = await services.schema.lintNote(notePath);
        log.info(
          { schema: result.schema, pass: result.pass, checkCount: result.checks.length },
          "lint_note complete",
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ root: getRoot(container), ...result }, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "lint_note failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the path with list_directory", "Verify the file exists with read_note", "Use list_schemas to see available schemas"],
          }) }],
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

function makeValidateFolderTool(container: ServiceContainer): ToolHandler {
  return {
    name: "validate_folder",
    description:
      "Classifies and validates a folder. Pass `{ path }`. Returns `{ root, summary, path, pass, folderType, schema, notes, structural }`. Folder types: `packet`, `superfolder`, `supplemental`, `unclassified`.",
    inputSchema: ValidateFolderSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        const { path: folderPath } = ValidateFolderSchema.parse(args);
        log.info({ folderPath }, "validate_folder called");
        await services.schema.refresh();
        const result = await services.schema.validateFolder(folderPath);
        log.info(
          { schema: result.schema, folderType: result.folderType, pass: result.pass },
          "validate_folder complete",
        );
        const folderSummary = `${result.pass ? "PASS" : "FAIL"}: ${result.folderType} folder${result.schema ? `, schema: ${result.schema}` : ", no schema"}`;
        return {
          content: [{ type: "text", text: JSON.stringify({ root: getRoot(container), summary: folderSummary, ...result }, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "validate_folder failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the path with list_directory", "Use list_schemas to see available schemas", "Use lint_note for individual note validation"],
          }) }],
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

function makeValidateAreaTool(container: ServiceContainer): ToolHandler {
  return {
    name: "validate_area",
    description:
      "Recursively validates a subtree. Pass `{ path }`. Returns `{ root, summaryText, path, pass, folders, summary }`. Use for checking a section of the directory.",
    inputSchema: ValidateAreaSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        const { path: areaPath } = ValidateAreaSchema.parse(args);
        log.info({ areaPath }, "validate_area called");
        await services.schema.refresh();
        const result = await services.schema.validateArea(areaPath);
        log.info(
          { pass: result.pass, summary: result.summary },
          "validate_area complete",
        );
        const { total, passed, failed, skipped } = result.summary;
        const summaryText = `${passed}/${total} folders passed, ${failed} failed, ${skipped} skipped`;
        return {
          content: [{ type: "text", text: JSON.stringify({ root: getRoot(container), summaryText, ...result }, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "validate_area failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the path with list_directory", "Use validate_folder for a single folder", "Use list_schemas to see available schemas"],
          }) }],
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

function makeListSchemasTool(container: ServiceContainer): ToolHandler {
  return {
    name: "list_schemas",
    description:
      "Lists all loaded schemas. No arguments. Returns `{ root, schemas[] }` where each schema has `name`, `description`, `type` (`note`|`folder`), and type-specific details.",
    inputSchema: ListSchemasSchema,
    async handler(_args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        log.info("list_schemas called");
        await services.schema.refresh();
        const schemas = services.schema.listSchemas();
        log.info({ count: schemas.length }, "list_schemas complete");
        return {
          content: [{ type: "text", text: JSON.stringify({ root: getRoot(container), schemas }, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "list_schemas failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the schemas directory is configured correctly", "Verify schema YAML files are valid"],
          }) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// validate_all
// ============================================================================

const ValidateAllSchema = z.object({});

function makeValidateAllTool(container: ServiceContainer): ToolHandler {
  return {
    name: "validate_all",
    description:
      "Validates the entire directory tree using the convention cascade. No arguments. Returns `{ root, summaryText, pass, conventionSources, folders, summary }`. Discovers `_conventions.md` notes and resolves folder schemas.",
    inputSchema: ValidateAllSchema,
    async handler(_args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        log.info("validate_all called");
        await services.schema.refresh();
        const result = await services.schema.validateAll();
        log.info(
          { pass: result.pass, summary: result.summary },
          "validate_all complete",
        );
        const { total, passed, failed, skipped } = result.summary;
        const summaryText = `${passed}/${total} folders passed, ${failed} failed, ${skipped} skipped`;
        return {
          content: [{ type: "text", text: JSON.stringify({ root: getRoot(container), summaryText, ...result }, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "validate_all failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Use list_schemas to verify schemas are loaded", "Use validate_folder on a specific folder", "Use lint_note for individual note validation"],
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

export function registerSchemaTools(
  registry: Map<string, ToolHandler>,
  container: ServiceContainer,
): void {
  const tools = [
    makeLintNoteTool(container),
    makeValidateFolderTool(container),
    makeValidateAreaTool(container),
    makeValidateAllTool(container),
    makeListSchemasTool(container),
  ];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
