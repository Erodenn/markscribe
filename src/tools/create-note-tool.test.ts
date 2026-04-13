import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { registerCreateNoteTool } from "./create-note-tool.js";
import { VaultServiceImpl } from "../services/vault-service.js";
import { FrontmatterServiceImpl } from "../services/frontmatter-service.js";
import { PathFilterImpl } from "../services/path-filter.js";
import { SchemaEngineImpl } from "../services/schema-engine.js";
import type {
  ToolHandler,
  Services,
  SchemaEngine,
  LintResult,
  NoteTemplate,
  Schema,
  SchemaInfo,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempVault(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "vaultscribe-create-note-test-"));
}

async function writeFile(base: string, relPath: string, content: string): Promise<void> {
  const full = path.join(base, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

async function readFile(base: string, relPath: string): Promise<string> {
  return fs.readFile(path.join(base, relPath), "utf-8");
}

async function fileExists(base: string, relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(base, relPath));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Schema fixtures
// ---------------------------------------------------------------------------

const JOURNAL_SCHEMA_YAML = `
name: journal
description: Daily journal notes
scope:
  paths:
    - "Journal/"
  exclude: []
frontmatter:
  fields:
    date:
      type: string
      required: true
      format: "\\\\d{4}-\\\\d{2}-\\\\d{2}"
    tags:
      type: list
      required: true
content:
  rules: []
`;

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

function makeServices(vaultPath: string, schemaOverride?: SchemaEngine): Services {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  const vault = new VaultServiceImpl(vaultPath, filter);
  const frontmatter = new FrontmatterServiceImpl(vault);
  const schemaEngine = schemaOverride ?? new SchemaEngineImpl(vault, frontmatter);
  return {
    vault,
    frontmatter,
    search: null as unknown as Services["search"],
    schema: schemaEngine,
    links: null as unknown as Services["links"],
  };
}

function buildRegistry(services: Services): Map<string, ToolHandler> {
  const registry = new Map<string, ToolHandler>();
  registerCreateNoteTool(registry, services);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerCreateNoteTool", () => {
  it("registers create_note", () => {
    const registry = buildRegistry(makeServices(os.tmpdir()));
    expect(registry.has("create_note")).toBe(true);
  });
});

describe("create_note tool — no schema", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    // No schemas loaded — all notes are unmanaged
    registry = buildRegistry(makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a plain note with no frontmatter when no schema matches", async () => {
    const result = await callTool(registry, "create_note", {
      path: "plain.md",
      content: "Hello world",
    });

    expect(result.isError).toBeFalsy();
    expect(await fileExists(tmpDir, "plain.md")).toBe(true);

    const body = await readFile(tmpDir, "plain.md");
    expect(body).toContain("Hello world");

    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("plain.md");
    expect(data.lintResult).toBeNull();
  });

  it("creates a note with explicit frontmatter when no schema matches", async () => {
    const result = await callTool(registry, "create_note", {
      path: "with-fm.md",
      content: "Body text",
      frontmatter: { author: "Owen", draft: true },
    });

    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.frontmatter.author).toBe("Owen");
    expect(data.frontmatter.draft).toBe(true);
    expect(data.lintResult).toBeNull();
  });

  it("creates note with empty content when content is omitted", async () => {
    const result = await callTool(registry, "create_note", {
      path: "empty.md",
    });

    expect(result.isError).toBeFalsy();
    expect(await fileExists(tmpDir, "empty.md")).toBe(true);

    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("empty.md");
  });

  it("creates note in a nested directory (creates parent dirs)", async () => {
    const result = await callTool(registry, "create_note", {
      path: "deep/nested/dir/note.md",
      content: "Nested",
    });

    expect(result.isError).toBeFalsy();
    expect(await fileExists(tmpDir, "deep/nested/dir/note.md")).toBe(true);
  });

  it("errors if the path already exists", async () => {
    await writeFile(tmpDir, "existing.md", "# Existing");

    const result = await callTool(registry, "create_note", {
      path: "existing.md",
      content: "New content",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already exists/i);
    expect(result.content[0].text).toMatch(/write_note/i);

    // File must not have been overwritten
    const body = await readFile(tmpDir, "existing.md");
    expect(body).toContain("# Existing");
  });

  it("returns isError for path traversal attempt", async () => {
    const result = await callTool(registry, "create_note", {
      path: "../escape.md",
    });

    expect(result.isError).toBe(true);
  });
});

describe("create_note tool — with schema (real SchemaEngine)", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;
  let services: Services;

  beforeEach(async () => {
    tmpDir = await makeTempVault();

    // Write a schema YAML into the schemas dir
    const schemasDir = path.join(tmpDir, ".vaultscribe", "schemas");
    await fs.mkdir(schemasDir, { recursive: true });
    await fs.writeFile(path.join(schemasDir, "journal.yaml"), JOURNAL_SCHEMA_YAML, "utf-8");

    services = makeServices(tmpDir);
    await services.schema.loadSchemas(schemasDir);
    registry = buildRegistry(services);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("applies schema template when path matches scope", async () => {
    const result = await callTool(registry, "create_note", {
      path: "Journal/2026-04-09.md",
      content: "Today's entry",
    });

    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("Journal/2026-04-09.md");
    // Schema requires date (string) and tags (list) — template provides empty defaults
    expect(data.frontmatter).toHaveProperty("date");
    expect(data.frontmatter).toHaveProperty("tags");
    // lint result should be present (may fail since date is empty)
    expect(data.lintResult).not.toBeNull();
    expect(data.lintResult.schema).toBe("journal");
  });

  it("includes lint result with checks when schema is applied", async () => {
    const result = await callTool(registry, "create_note", {
      path: "Journal/entry.md",
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.lintResult).not.toBeNull();
    expect(Array.isArray(data.lintResult.checks)).toBe(true);
  });

  it("merges frontmatter overrides on top of template defaults", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = await callTool(registry, "create_note", {
      path: "Journal/override.md",
      content: "Override test",
      frontmatter: { date: today, tags: ["journal/daily"] },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.frontmatter.date).toBe(today);
    expect(data.frontmatter.tags).toEqual(["journal/daily"]);
  });

  it("overrides produce a passing lint when all required fields are provided", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = await callTool(registry, "create_note", {
      path: "Journal/valid.md",
      content: "Valid entry",
      frontmatter: { date: today, tags: ["journal/daily"] },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.lintResult.pass).toBe(true);
  });

  it("lintResult is null for notes outside the schema scope", async () => {
    const result = await callTool(registry, "create_note", {
      path: "Notes/unmanaged.md",
      content: "Unmanaged note",
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.lintResult).toBeNull();
  });
});

describe("create_note tool — explicit schema param", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;
  let services: Services;

  beforeEach(async () => {
    tmpDir = await makeTempVault();

    const schemasDir = path.join(tmpDir, ".vaultscribe", "schemas");
    await fs.mkdir(schemasDir, { recursive: true });
    await fs.writeFile(path.join(schemasDir, "journal.yaml"), JOURNAL_SCHEMA_YAML, "utf-8");

    services = makeServices(tmpDir);
    await services.schema.loadSchemas(schemasDir);
    registry = buildRegistry(services);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("uses explicit schema even when path is outside its scope", async () => {
    const result = await callTool(registry, "create_note", {
      path: "RandomFolder/note.md",
      schema: "journal",
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    // Template from journal schema should have been applied (date + tags fields)
    expect(data.frontmatter).toHaveProperty("date");
    expect(data.frontmatter).toHaveProperty("tags");
    // lintResult: lintNote auto-detects schema from path. Since path is outside
    // journal scope, schema resolves to null in lint — but the note was created
    // with the template. This is expected behavior.
    expect(data.lintResult).not.toBeUndefined();
  });

  it("errors if explicit schema name does not exist", async () => {
    const result = await callTool(registry, "create_note", {
      path: "Journal/note.md",
      schema: "nonexistent-schema",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
    expect(result.content[0].text).toMatch(/nonexistent-schema/i);

    // File must not have been created
    expect(await fileExists(tmpDir, "Journal/note.md")).toBe(false);
  });

  it("errors if path already exists even with explicit schema", async () => {
    await writeFile(tmpDir, "Journal/exists.md", "# Exists");

    const result = await callTool(registry, "create_note", {
      path: "Journal/exists.md",
      schema: "journal",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already exists/i);
  });
});

describe("create_note tool — mock SchemaEngine for unit isolation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("uses getTemplate result and merges overrides correctly", async () => {
    const template: NoteTemplate = {
      frontmatter: { type: "note", status: "draft" },
      content: "",
    };

    const mockLintResult: LintResult = {
      path: "Docs/note.md",
      pass: true,
      schema: "mock-schema",
      checks: [],
    };

    const mockSchema: SchemaEngine = {
      loadSchemas: vi.fn(),
      getSchemaForPath: vi
        .fn()
        .mockReturnValue({ name: "mock-schema" } as Partial<Schema> as Schema),
      lintNote: vi.fn().mockResolvedValue(mockLintResult),
      validateFolder: vi.fn(),
      validateArea: vi.fn(),
      getTemplate: vi.fn().mockReturnValue(template),
      listSchemas: vi.fn().mockReturnValue([{ name: "mock-schema" } as SchemaInfo]),
    };

    const services = makeServices(tmpDir, mockSchema);
    const registry = buildRegistry(services);

    const result = await callTool(registry, "create_note", {
      path: "Docs/note.md",
      content: "Content",
      frontmatter: { status: "published", extra: "yes" },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);

    // Template defaults should be present
    expect(data.frontmatter.type).toBe("note");
    // Override should win over template default
    expect(data.frontmatter.status).toBe("published");
    // Extra override key should be present
    expect(data.frontmatter.extra).toBe("yes");

    // lintNote should have been called
    expect(mockSchema.lintNote).toHaveBeenCalledWith("Docs/note.md");

    // Lint result in response
    expect(data.lintResult.pass).toBe(true);
    expect(data.lintResult.schema).toBe("mock-schema");
  });

  it("does not call lintNote when no schema matches", async () => {
    const mockSchema: SchemaEngine = {
      loadSchemas: vi.fn(),
      getSchemaForPath: vi.fn().mockReturnValue(null),
      lintNote: vi.fn(),
      validateFolder: vi.fn(),
      validateArea: vi.fn(),
      getTemplate: vi.fn(),
      listSchemas: vi.fn().mockReturnValue([]),
    };

    const services = makeServices(tmpDir, mockSchema);
    const registry = buildRegistry(services);

    const result = await callTool(registry, "create_note", {
      path: "unmanaged.md",
      content: "No schema here",
    });

    expect(result.isError).toBeFalsy();
    expect(mockSchema.lintNote).not.toHaveBeenCalled();
    expect(mockSchema.getTemplate).not.toHaveBeenCalled();

    const data = JSON.parse(result.content[0].text);
    expect(data.lintResult).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Template variable expansion
// ---------------------------------------------------------------------------

describe("create_note tool — template variable expansion", () => {
  let tmpDir: string;
  let schemasDir: string;
  let registry: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    schemasDir = path.join(tmpDir, ".vaultscribe", "schemas");
    await fs.mkdir(schemasDir, { recursive: true });

    const schemaYaml = `
name: tmpl-test
description: Schema with template var defaults
scope:
  paths:
    - "Notes/"
  exclude: []
frontmatter:
  fields:
    title:
      type: string
      required: true
      default: "{{stem}}"
    created:
      type: string
      required: true
      default: "{{today}}"
    folder:
      type: string
      required: true
      default: "{{folderName}}"
    status:
      type: string
      required: true
      default: "draft"
content:
  rules: []
`;
    await fs.writeFile(path.join(schemasDir, "tmpl.yaml"), schemaYaml, "utf-8");

    const services = makeServices(tmpDir);
    const schemaEngine = services.schema as SchemaEngineImpl;
    await schemaEngine.loadSchemas(schemasDir);
    registry = buildRegistry(services);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("expands {{stem}} in template defaults", async () => {
    const result = await callTool(registry, "create_note", {
      path: "Notes/MyProject.md",
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.frontmatter.title).toBe("MyProject");
  });

  it("expands {{today}} in template defaults", async () => {
    const result = await callTool(registry, "create_note", {
      path: "Notes/DateTest.md",
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.frontmatter.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("expands {{folderName}} in template defaults", async () => {
    const result = await callTool(registry, "create_note", {
      path: "Notes/FolderTest.md",
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.frontmatter.folder).toBe("Notes");
  });

  it("does not expand template vars in user-provided overrides", async () => {
    const result = await callTool(registry, "create_note", {
      path: "Notes/Override.md",
      frontmatter: { title: "{{stem}} literal" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.frontmatter.title).toBe("{{stem}} literal");
  });

  it("preserves non-template defaults as-is", async () => {
    const result = await callTool(registry, "create_note", {
      path: "Notes/StaticDefault.md",
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.frontmatter.status).toBe("draft");
  });
});
