import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { SchemaEngineImpl } from "./schema-engine.js";
import { FileServiceImpl } from "./file-service.js";
import { PathFilterImpl } from "./path-filter.js";
import { makeTempDir, writeFile } from "../test-helpers.js";

/**
 * Tests for SchemaEngineImpl.refresh() — verifies that schemas and conventions
 * are reloaded from disk on every call, matching the "always correct, never stale" principle.
 */

const MINIMAL_NOTE_SCHEMA_YAML = `
name: test-note
description: A test note schema
type: note
frontmatter:
  fields:
    title:
      type: string
      required: true
content:
  rules: []
`;

const UPDATED_NOTE_SCHEMA_YAML = `
name: test-note
description: Updated test note schema
type: note
frontmatter:
  fields:
    title:
      type: string
      required: true
    category:
      type: string
      required: false
content:
  rules: []
`;

function makeVaultService(vaultPath: string): FileServiceImpl {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  return new FileServiceImpl(vaultPath, filter);
}

describe("SchemaEngineImpl.refresh()", () => {
  let tmpDir: string;
  let schemasDir: string;
  let vaultSvc: FileServiceImpl;
  let engine: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-schema-test-");
    schemasDir = path.join(tmpDir, ".markscribe", "schemas");
    await fs.mkdir(schemasDir, { recursive: true });
    vaultSvc = makeVaultService(tmpDir);
    engine = new SchemaEngineImpl(vaultSvc);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("picks up a new schema file written after initial load", async () => {
    // Initial load with no user schemas
    await engine.loadSchemas(schemasDir);
    engine.loadBundledSchemas();
    await engine.discoverConventions();

    const before = engine.listSchemas();
    const hadTestNote = before.some((s) => s.name === "test-note");
    expect(hadTestNote).toBe(false);

    // Write a new schema to disk
    await writeFile(tmpDir, ".markscribe/schemas/test-note.yaml", MINIMAL_NOTE_SCHEMA_YAML);

    // Refresh picks it up
    await engine.refresh();
    const after = engine.listSchemas();
    const testNote = after.find((s) => s.name === "test-note");
    expect(testNote).toBeDefined();
    expect(testNote!.description).toBe("A test note schema");
  });

  it("removes a schema that was deleted from disk", async () => {
    // Seed a schema
    await writeFile(tmpDir, ".markscribe/schemas/test-note.yaml", MINIMAL_NOTE_SCHEMA_YAML);
    await engine.loadSchemas(schemasDir);
    engine.loadBundledSchemas();
    await engine.discoverConventions();

    const before = engine.listSchemas();
    expect(before.some((s) => s.name === "test-note")).toBe(true);

    // Delete the schema file
    await fs.unlink(path.join(schemasDir, "test-note.yaml"));

    // Refresh drops it
    await engine.refresh();
    const after = engine.listSchemas();
    expect(after.some((s) => s.name === "test-note")).toBe(false);
  });

  it("reflects updated schema content after refresh", async () => {
    await writeFile(tmpDir, ".markscribe/schemas/test-note.yaml", MINIMAL_NOTE_SCHEMA_YAML);
    await engine.loadSchemas(schemasDir);
    engine.loadBundledSchemas();
    await engine.discoverConventions();

    const before = engine.listSchemas().find((s) => s.name === "test-note");
    expect(before!.fieldCount).toBe(1);

    // Update schema on disk
    await writeFile(tmpDir, ".markscribe/schemas/test-note.yaml", UPDATED_NOTE_SCHEMA_YAML);

    await engine.refresh();
    const after = engine.listSchemas().find((s) => s.name === "test-note");
    expect(after!.fieldCount).toBe(2);
    expect(after!.description).toBe("Updated test note schema");
  });

  it("preserves user-wins-on-collision with bundled schemas", async () => {
    // Write a user schema that collides with a bundled name
    const userOverride = `
name: daily-note
description: User override of daily-note
type: note
frontmatter:
  fields:
    mood:
      type: string
      required: true
content:
  rules: []
`;
    await writeFile(tmpDir, ".markscribe/schemas/daily-note.yaml", userOverride);
    await engine.loadSchemas(schemasDir);
    engine.loadBundledSchemas();
    await engine.discoverConventions();

    // User version wins
    const before = engine.listSchemas().find((s) => s.name === "daily-note");
    expect(before!.description).toBe("User override of daily-note");

    // After refresh, user version still wins
    await engine.refresh();
    const after = engine.listSchemas().find((s) => s.name === "daily-note");
    expect(after!.description).toBe("User override of daily-note");
  });

  it("re-discovers conventions on refresh", async () => {
    // Initial load with no conventions
    await engine.loadSchemas(schemasDir);
    engine.loadBundledSchemas();
    await engine.discoverConventions();

    // Write a folder schema and _conventions.md
    const folderSchemaYaml = `
name: project-folder
description: A project folder schema
type: folder
noteSchemas:
  default: test-note
`;
    await writeFile(tmpDir, ".markscribe/schemas/project-folder.yaml", folderSchemaYaml);
    await writeFile(tmpDir, ".markscribe/schemas/test-note.yaml", MINIMAL_NOTE_SCHEMA_YAML);
    await writeFile(
      tmpDir,
      "Projects/_conventions.md",
      "---\nfolder_schema: project-folder\ninherit: true\n---\n",
    );
    // Create a note so the directory is walkable
    await writeFile(tmpDir, "Projects/SomeProject/note.md", "---\ntitle: Test\n---\nContent\n");

    // Refresh picks up both schemas and the convention
    await engine.refresh();
    const schemas = engine.listSchemas();
    expect(schemas.some((s) => s.name === "project-folder")).toBe(true);
    expect(schemas.some((s) => s.name === "test-note")).toBe(true);

    // The convention should resolve the note schema for a file under Projects/
    const resolved = engine.resolveNoteSchema("Projects/SomeProject/note.md");
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe("test-note");
  });

  it("works correctly when called with no schemasDir (no user schemas)", async () => {
    // Don't call loadSchemas — simulate a vault with no .markscribe/schemas
    engine.loadBundledSchemas();
    await engine.discoverConventions();

    // refresh should still work — only bundled schemas remain
    await engine.refresh();
    const schemas = engine.listSchemas();
    expect(schemas.length).toBeGreaterThan(0);
    // All should be bundled
    const names = schemas.map((s) => s.name);
    expect(names).toContain("daily-note");
  });
});
