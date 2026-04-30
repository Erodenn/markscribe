import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { NoteSchemaEngineImpl } from "./note-schema-engine.js";
import { SchemaEngineImpl } from "./schema-engine.js";
import { FileServiceImpl } from "./file-service.js";
import { PathFilterImpl } from "./path-filter.js";
import { buildVaultIndex } from "./vault-index.js";
import type { NoteSchema } from "../types.js";
import { makeTempDir, writeFile } from "../test-helpers.js";

function makeFile(vaultPath: string): FileServiceImpl {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  return new FileServiceImpl(vaultPath, filter);
}

function brokenLinksSchema(): NoteSchema {
  return {
    name: "broken-links",
    description: "test",
    type: "note",
    frontmatter: { fields: {} },
    content: {
      rules: [
        {
          name: "no-broken-wikilinks",
          check: "noBrokenWikilinks",
        },
      ],
    },
  };
}

describe("NoteSchemaEngineImpl checkContentRule noBrokenWikilinks", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-note-schema-test-");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("passes when all wikilinks resolve", async () => {
    await writeFile(tmpDir, "Source.md", "Has [[Existing]] and [[Other]] links.");
    await writeFile(tmpDir, "Existing.md", "");
    await writeFile(tmpDir, "Other.md", "");

    const file = makeFile(tmpDir);
    const engine = new NoteSchemaEngineImpl(file);
    const index = await buildVaultIndex(file);
    const result = await engine.lintNote("Source.md", brokenLinksSchema(), undefined, index);

    expect(result.pass).toBe(true);
    const check = result.checks.find((c) => c.name === "no-broken-wikilinks");
    expect(check?.pass).toBe(true);
  });

  it("fails listing every broken target in detail", async () => {
    await writeFile(tmpDir, "Source.md", "[[Ghost1]] and [[Ghost2]] and [[Real]].");
    await writeFile(tmpDir, "Real.md", "");

    const file = makeFile(tmpDir);
    const engine = new NoteSchemaEngineImpl(file);
    const index = await buildVaultIndex(file);
    const result = await engine.lintNote("Source.md", brokenLinksSchema(), undefined, index);

    expect(result.pass).toBe(false);
    const check = result.checks.find((c) => c.name === "no-broken-wikilinks");
    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain("[[Ghost1]]");
    expect(check?.detail).toContain("[[Ghost2]]");
    expect(check?.detail).not.toContain("[[Real]]");
  });

  it("resolves anchor variants", async () => {
    await writeFile(tmpDir, "Source.md", "[[Note#Section]]");
    await writeFile(tmpDir, "Note.md", "");

    const file = makeFile(tmpDir);
    const engine = new NoteSchemaEngineImpl(file);
    const index = await buildVaultIndex(file);
    const result = await engine.lintNote("Source.md", brokenLinksSchema(), undefined, index);
    expect(result.pass).toBe(true);
  });

  it("resolves path-prefix variants", async () => {
    await writeFile(tmpDir, "Source.md", "[[Folder/Note]]");
    await writeFile(tmpDir, "Folder/Note.md", "");

    const file = makeFile(tmpDir);
    const engine = new NoteSchemaEngineImpl(file);
    const index = await buildVaultIndex(file);
    const result = await engine.lintNote("Source.md", brokenLinksSchema(), undefined, index);
    expect(result.pass).toBe(true);
  });

  it("is case-insensitive", async () => {
    await writeFile(tmpDir, "Source.md", "[[note]]");
    await writeFile(tmpDir, "Note.md", "");

    const file = makeFile(tmpDir);
    const engine = new NoteSchemaEngineImpl(file);
    const index = await buildVaultIndex(file);
    const result = await engine.lintNote("Source.md", brokenLinksSchema(), undefined, index);
    expect(result.pass).toBe(true);
  });

  it("resolves aliases declared in frontmatter", async () => {
    await writeFile(tmpDir, "Source.md", "[[Pseudonym]]");
    await writeFile(tmpDir, "Real.md", "---\naliases:\n  - Pseudonym\n---\n");

    const file = makeFile(tmpDir);
    const engine = new NoteSchemaEngineImpl(file);
    const index = await buildVaultIndex(file);
    const result = await engine.lintNote("Source.md", brokenLinksSchema(), undefined, index);
    expect(result.pass).toBe(true);
  });

  it("ignores wikilinks inside fenced code blocks", async () => {
    await writeFile(
      tmpDir,
      "Source.md",
      "```\n[[FakeGhost]]\n```\nReal: [[Real]]",
    );
    await writeFile(tmpDir, "Real.md", "");

    const file = makeFile(tmpDir);
    const engine = new NoteSchemaEngineImpl(file);
    const index = await buildVaultIndex(file);
    const result = await engine.lintNote("Source.md", brokenLinksSchema(), undefined, index);
    expect(result.pass).toBe(true);
  });

  it("integrates via SchemaEngineImpl.lintNote with note_schema frontmatter", async () => {
    await writeFile(
      tmpDir,
      "Source.md",
      "---\nnote_schema: broken-links\n---\n[[Ghost]]",
    );

    const file = makeFile(tmpDir);
    const engine = new SchemaEngineImpl(file);
    // Register schema directly via internal registry: simulate user-loaded schema
    // by loading bundled, then injecting via private (test-only) cast.
    // Here we use the public surface: load a YAML file into a schemas dir.
    const schemasDir = await makeTempDir("markscribe-schemas-");
    await writeFile(
      schemasDir,
      "broken-links.yaml",
      [
        "name: broken-links",
        "description: test",
        "type: note",
        "frontmatter:",
        "  fields: {}",
        "content:",
        "  rules:",
        "    - name: no-broken-wikilinks",
        "      check: noBrokenWikilinks",
      ].join("\n"),
    );

    try {
      await engine.loadSchemas(schemasDir);
      const result = await engine.lintNote("Source.md");
      expect(result.schema).toBe("broken-links");
      expect(result.pass).toBe(false);
      const check = result.checks.find((c) => c.name === "no-broken-wikilinks");
      expect(check?.detail).toContain("[[Ghost]]");
    } finally {
      await fs.rm(schemasDir, { recursive: true, force: true });
    }
  });
});
