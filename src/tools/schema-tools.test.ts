import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { registerSchemaTools } from "./schema-tools.js";
import { SchemaEngineImpl } from "../services/schema-engine.js";
import { VaultServiceImpl } from "../services/vault-service.js";
import { FrontmatterServiceImpl } from "../services/frontmatter-service.js";
import { PathFilterImpl } from "../services/path-filter.js";
import type { ToolHandler, Services } from "../types.js";

// =============================================================================
// Helpers
// =============================================================================

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(base: string, relPath: string, content: string): Promise<void> {
  const full = path.join(base, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

async function writeSchema(schemasDir: string, filename: string, content: string): Promise<void> {
  await fs.mkdir(schemasDir, { recursive: true });
  await fs.writeFile(path.join(schemasDir, filename), content, "utf-8");
}

function makeServices(vaultPath: string): { services: Services; schema: SchemaEngineImpl } {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  const vault = new VaultServiceImpl(vaultPath, filter);
  const frontmatter = new FrontmatterServiceImpl(vault);
  const schema = new SchemaEngineImpl(vault, frontmatter);
  return {
    schema,
    services: {
      vault,
      frontmatter,
      search: null as unknown as Services["search"],
      schema,
      links: null as unknown as Services["links"],
    },
  };
}

function buildRegistry(services: Services): Map<string, ToolHandler> {
  const registry = new Map<string, ToolHandler>();
  registerSchemaTools(registry, services);
  return registry;
}

async function callTool(
  registry: Map<string, ToolHandler>,
  name: string,
  args: Record<string, unknown>,
) {
  const handler = registry.get(name);
  if (!handler) throw new Error(`Tool not found: ${name}`);
  return handler.handler(args);
}

// =============================================================================
// Fixture schemas
// =============================================================================

const BASIC_SCHEMA_YAML = `
name: basic
description: Basic schema requiring title and tags
scope:
  paths: ["Notes/"]
  exclude: []
frontmatter:
  fields:
    title:
      type: string
      required: true
    tags:
      type: list
      required: true
content:
  rules: []
`;

const FOLDER_SCHEMA_YAML = `
name: folder-schema
description: Schema with folder configuration
scope:
  paths: ["Projects/"]
  exclude: []
frontmatter:
  fields:
    status:
      type: string
      required: true
content:
  rules:
    - name: has-content
      check: minWordCount
      count: 5
folders:
  classification:
    supplemental: ["Assets"]
    skip: ["Archive"]
  structural: []
`;

// =============================================================================
// Registration
// =============================================================================

describe("registerSchemaTools", () => {
  it("registers all four schema tools", () => {
    const vaultPath = os.tmpdir();
    const { services } = makeServices(vaultPath);
    const registry = buildRegistry(services);

    expect(registry.has("lint_note")).toBe(true);
    expect(registry.has("validate_folder")).toBe(true);
    expect(registry.has("validate_area")).toBe(true);
    expect(registry.has("list_schemas")).toBe(true);
  });
});

// =============================================================================
// lint_note
// =============================================================================

describe("lint_note tool", () => {
  let vaultPath: string;
  let schemasDir: string;
  let registry: Map<string, ToolHandler>;
  let schema: SchemaEngineImpl;
  let services: Services;

  beforeEach(async () => {
    vaultPath = await makeTempDir("vaultscribe-schema-tools-lint-");
    schemasDir = path.join(vaultPath, ".vaultscribe", "schemas");
    const result = makeServices(vaultPath);
    schema = result.schema;
    services = result.services;
    registry = buildRegistry(services);
  });

  afterEach(async () => {
    await fs.rm(vaultPath, { recursive: true, force: true });
  });

  it("returns pass=true with schema=null when no schema matches", async () => {
    await writeFile(vaultPath, "Unscoped/note.md", "# Hello\nSome content.");

    const result = await callTool(registry, "lint_note", { path: "Unscoped/note.md" });
    expect(result.isError).toBeFalsy();

    const lint = JSON.parse(result.content[0].text);
    expect(lint.path).toBe("Unscoped/note.md");
    expect(lint.pass).toBe(true);
    expect(lint.schema).toBeNull();
    expect(lint.checks).toHaveLength(0);
  });

  it("returns pass=true when note satisfies all schema requirements", async () => {
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    await writeFile(
      vaultPath,
      "Notes/valid.md",
      "---\ntitle: Valid Note\ntags:\n  - research\n---\n# Valid",
    );

    const result = await callTool(registry, "lint_note", { path: "Notes/valid.md" });
    expect(result.isError).toBeFalsy();

    const lint = JSON.parse(result.content[0].text);
    expect(lint.pass).toBe(true);
    expect(lint.schema).toBe("basic");
    expect(lint.checks.every((c: { pass: boolean }) => c.pass)).toBe(true);
  });

  it("returns pass=false when required fields are missing", async () => {
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    await writeFile(vaultPath, "Notes/invalid.md", "# No Frontmatter\nContent here.");

    const result = await callTool(registry, "lint_note", { path: "Notes/invalid.md" });
    expect(result.isError).toBeFalsy();

    const lint = JSON.parse(result.content[0].text);
    expect(lint.pass).toBe(false);
    expect(lint.schema).toBe("basic");
    const failedChecks = lint.checks.filter((c: { pass: boolean }) => !c.pass);
    expect(failedChecks.length).toBeGreaterThan(0);
  });

  it("returns error response when note does not exist", async () => {
    const result = await callTool(registry, "lint_note", { path: "Notes/nonexistent.md" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/error/i);
  });

  it("returns error on invalid arguments", async () => {
    const result = await callTool(registry, "lint_note", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid arguments/i);
  });

  it("includes per-check details on failure", async () => {
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    await writeFile(vaultPath, "Notes/missing-tags.md", "---\ntitle: Has Title\n---\nContent.");

    const result = await callTool(registry, "lint_note", { path: "Notes/missing-tags.md" });
    const lint = JSON.parse(result.content[0].text);

    const tagsCheck = lint.checks.find(
      (c: { name: string }) => c.name === "field_tags_required",
    );
    expect(tagsCheck).toBeDefined();
    expect(tagsCheck.pass).toBe(false);
    expect(tagsCheck.detail).toMatch(/tags/i);
  });
});

// =============================================================================
// validate_folder
// =============================================================================

describe("validate_folder tool", () => {
  let vaultPath: string;
  let schemasDir: string;
  let registry: Map<string, ToolHandler>;
  let schema: SchemaEngineImpl;
  let services: Services;

  beforeEach(async () => {
    vaultPath = await makeTempDir("vaultscribe-schema-tools-folder-");
    schemasDir = path.join(vaultPath, ".vaultscribe", "schemas");
    const result = makeServices(vaultPath);
    schema = result.schema;
    services = result.services;
    registry = buildRegistry(services);
  });

  afterEach(async () => {
    await fs.rm(vaultPath, { recursive: true, force: true });
  });

  it("classifies a folder with notes only as a packet", async () => {
    await writeSchema(schemasDir, "folder.yaml", FOLDER_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    await writeFile(
      vaultPath,
      "Projects/proj-a/note.md",
      "---\nstatus: active\n---\nThis is a project note with enough words in it.",
    );

    const result = await callTool(registry, "validate_folder", {
      path: "Projects/proj-a",
    });
    expect(result.isError).toBeFalsy();

    const validation = JSON.parse(result.content[0].text);
    expect(validation.path).toBe("Projects/proj-a");
    expect(validation.folderType).toBe("packet");
    expect(validation.schema).toBe("folder-schema");
  });

  it("classifies supplemental folder as supplemental and auto-passes", async () => {
    await writeSchema(schemasDir, "folder.yaml", FOLDER_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    await writeFile(vaultPath, "Projects/Assets/image.md", "# Image reference");

    const result = await callTool(registry, "validate_folder", { path: "Projects/Assets" });
    expect(result.isError).toBeFalsy();

    const validation = JSON.parse(result.content[0].text);
    expect(validation.folderType).toBe("supplemental");
    expect(validation.pass).toBe(true);
    expect(Object.keys(validation.notes)).toHaveLength(0);
  });

  it("classifies a superfolder (has subdirs, no direct md files) correctly", async () => {
    await writeSchema(schemasDir, "folder.yaml", FOLDER_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    await writeFile(vaultPath, "Projects/sub-a/note.md", "---\nstatus: active\n---\nContent here words.");
    await writeFile(vaultPath, "Projects/sub-b/note.md", "---\nstatus: active\n---\nContent here words.");

    const result = await callTool(registry, "validate_folder", { path: "Projects" });
    expect(result.isError).toBeFalsy();

    const validation = JSON.parse(result.content[0].text);
    expect(validation.folderType).toBe("superfolder");
  });

  it("returns pass=false when notes fail lint within a packet folder", async () => {
    await writeSchema(schemasDir, "folder.yaml", FOLDER_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    await writeFile(vaultPath, "Projects/bad-project/note.md", "# Missing status field");

    const result = await callTool(registry, "validate_folder", { path: "Projects/bad-project" });
    expect(result.isError).toBeFalsy();

    const validation = JSON.parse(result.content[0].text);
    expect(validation.pass).toBe(false);
  });

  it("returns notes keyed by vault-relative path", async () => {
    await writeSchema(schemasDir, "folder.yaml", FOLDER_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    await writeFile(
      vaultPath,
      "Projects/myproject/note.md",
      "---\nstatus: done\n---\nThis note has sufficient content words here.",
    );

    const result = await callTool(registry, "validate_folder", { path: "Projects/myproject" });
    const validation = JSON.parse(result.content[0].text);

    const noteKeys = Object.keys(validation.notes);
    expect(noteKeys).toHaveLength(1);
    expect(noteKeys[0]).toContain("note.md");
  });

  it("returns error on invalid arguments (missing path)", async () => {
    const result = await callTool(registry, "validate_folder", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid arguments/i);
  });

  it("returns error when folder does not exist", async () => {
    const result = await callTool(registry, "validate_folder", { path: "NonExistent/Folder" });
    expect(result.isError).toBe(true);
  });
});

// =============================================================================
// validate_area
// =============================================================================

describe("validate_area tool", () => {
  let vaultPath: string;
  let schemasDir: string;
  let registry: Map<string, ToolHandler>;
  let schema: SchemaEngineImpl;
  let services: Services;

  beforeEach(async () => {
    vaultPath = await makeTempDir("vaultscribe-schema-tools-area-");
    schemasDir = path.join(vaultPath, ".vaultscribe", "schemas");
    const result = makeServices(vaultPath);
    schema = result.schema;
    services = result.services;
    registry = buildRegistry(services);
  });

  afterEach(async () => {
    await fs.rm(vaultPath, { recursive: true, force: true });
  });

  it("returns a summary with total, passed, failed, skipped counts", async () => {
    await writeSchema(schemasDir, "folder.yaml", FOLDER_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    // Two valid packets, one invalid
    await writeFile(
      vaultPath,
      "Projects/proj-pass/note.md",
      "---\nstatus: active\n---\nThis note passes with enough words.",
    );
    await writeFile(
      vaultPath,
      "Projects/proj-fail/bad.md",
      "# No frontmatter no status",
    );

    const result = await callTool(registry, "validate_area", { path: "Projects" });
    expect(result.isError).toBeFalsy();

    const area = JSON.parse(result.content[0].text);
    expect(area.path).toBe("Projects");
    expect(area.summary).toBeDefined();
    expect(area.summary.total).toBeGreaterThanOrEqual(2);
    expect(area.summary.failed).toBeGreaterThan(0);
  });

  it("returns pass=true when all folders pass", async () => {
    await writeSchema(schemasDir, "folder.yaml", FOLDER_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    await writeFile(
      vaultPath,
      "Projects/proj-a/note.md",
      "---\nstatus: active\n---\nThis note passes validation checks here.",
    );

    const result = await callTool(registry, "validate_area", { path: "Projects" });
    const area = JSON.parse(result.content[0].text);
    expect(area.pass).toBe(area.summary.failed === 0);
  });

  it("includes per-folder results keyed by path", async () => {
    await writeSchema(schemasDir, "folder.yaml", FOLDER_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    await writeFile(
      vaultPath,
      "Projects/sub/note.md",
      "---\nstatus: active\n---\nThis is a project with enough words.",
    );

    const result = await callTool(registry, "validate_area", { path: "Projects" });
    const area = JSON.parse(result.content[0].text);

    expect(area.folders).toBeDefined();
    expect(typeof area.folders).toBe("object");
    const folderKeys = Object.keys(area.folders);
    expect(folderKeys.length).toBeGreaterThan(0);
  });

  it("returns error on invalid arguments (missing path)", async () => {
    const result = await callTool(registry, "validate_area", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid arguments/i);
  });

  it("returns schema field in result", async () => {
    await writeSchema(schemasDir, "folder.yaml", FOLDER_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    await writeFile(
      vaultPath,
      "Projects/p/note.md",
      "---\nstatus: active\n---\nNote with enough words here.",
    );

    const result = await callTool(registry, "validate_area", { path: "Projects" });
    const area = JSON.parse(result.content[0].text);
    expect(area.schema).toBe("folder-schema");
  });
});

// =============================================================================
// list_schemas
// =============================================================================

describe("list_schemas tool", () => {
  let vaultPath: string;
  let schemasDir: string;
  let registry: Map<string, ToolHandler>;
  let schema: SchemaEngineImpl;
  let services: Services;

  beforeEach(async () => {
    vaultPath = await makeTempDir("vaultscribe-schema-tools-list-");
    schemasDir = path.join(vaultPath, ".vaultscribe", "schemas");
    const result = makeServices(vaultPath);
    schema = result.schema;
    services = result.services;
    registry = buildRegistry(services);
  });

  afterEach(async () => {
    await fs.rm(vaultPath, { recursive: true, force: true });
  });

  it("returns empty array when no schemas are loaded", async () => {
    const result = await callTool(registry, "list_schemas", {});
    expect(result.isError).toBeFalsy();

    const schemas = JSON.parse(result.content[0].text);
    expect(Array.isArray(schemas)).toBe(true);
    expect(schemas).toHaveLength(0);
  });

  it("returns loaded schemas with correct SchemaInfo fields", async () => {
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    const result = await callTool(registry, "list_schemas", {});
    expect(result.isError).toBeFalsy();

    const schemas = JSON.parse(result.content[0].text);
    expect(schemas).toHaveLength(1);

    const info = schemas[0];
    expect(info.name).toBe("basic");
    expect(info.description).toBe("Basic schema requiring title and tags");
    expect(info.fieldCount).toBe(2);
    expect(info.contentRuleCount).toBe(0);
    expect(info.hasFolderConfig).toBe(false);
    expect(info.scope).toBeDefined();
    expect(info.scope.paths).toContain("Notes/");
  });

  it("returns multiple schemas when multiple are loaded", async () => {
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await writeSchema(schemasDir, "folder.yaml", FOLDER_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    const result = await callTool(registry, "list_schemas", {});
    const schemas = JSON.parse(result.content[0].text);
    expect(schemas).toHaveLength(2);
  });

  it("reports hasFolderConfig=true for schema with folder configuration", async () => {
    await writeSchema(schemasDir, "folder.yaml", FOLDER_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    const result = await callTool(registry, "list_schemas", {});
    const schemas = JSON.parse(result.content[0].text);
    expect(schemas[0].hasFolderConfig).toBe(true);
  });

  it("reports correct content rule count", async () => {
    await writeSchema(schemasDir, "folder.yaml", FOLDER_SCHEMA_YAML);
    await schema.loadSchemas(schemasDir);

    const result = await callTool(registry, "list_schemas", {});
    const schemas = JSON.parse(result.content[0].text);
    const folderSchema = schemas.find((s: { name: string }) => s.name === "folder-schema");
    expect(folderSchema.contentRuleCount).toBe(1);
  });
});
