import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { buildVaultIndex } from "./vault-index.js";
import { FileServiceImpl } from "./file-service.js";
import { PathFilterImpl } from "./path-filter.js";
import { makeTempDir, writeFile } from "../test-helpers.js";

function makeFileService(vaultPath: string): FileServiceImpl {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  return new FileServiceImpl(vaultPath, filter);
}

describe("buildVaultIndex", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-vault-index-test-");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns all-false resolve for empty vault", async () => {
    const file = makeFileService(tmpDir);
    const index = await buildVaultIndex(file);
    expect(index.stems.size).toBe(0);
    expect(index.aliases.size).toBe(0);
    expect(index.resolve("Anything")).toBe(false);
  });

  it("resolves a basic stem", async () => {
    await writeFile(tmpDir, "Note.md", "Body.");
    const file = makeFileService(tmpDir);
    const index = await buildVaultIndex(file);
    expect(index.resolve("Note")).toBe(true);
  });

  it("resolves case-insensitively", async () => {
    await writeFile(tmpDir, "Note.md", "Body.");
    const file = makeFileService(tmpDir);
    const index = await buildVaultIndex(file);
    expect(index.resolve("note")).toBe(true);
    expect(index.resolve("NOTE")).toBe(true);
  });

  it("strips section anchor before lookup", async () => {
    await writeFile(tmpDir, "Note.md", "Body.");
    const file = makeFileService(tmpDir);
    const index = await buildVaultIndex(file);
    expect(index.resolve("Note#Section")).toBe(true);
  });

  it("strips folder prefix before lookup", async () => {
    await writeFile(tmpDir, "Folder/Note.md", "Body.");
    const file = makeFileService(tmpDir);
    const index = await buildVaultIndex(file);
    expect(index.resolve("Folder/Note")).toBe(true);
  });

  it("treats leading underscore as equivalent on both sides", async () => {
    await writeFile(tmpDir, "_Topic.md", "Body.");
    const file = makeFileService(tmpDir);
    const index = await buildVaultIndex(file);
    expect(index.resolve("_Topic")).toBe(true);
    expect(index.resolve("Topic")).toBe(true);
  });

  it("resolves an alias from frontmatter array", async () => {
    await writeFile(tmpDir, "Real.md", "---\naliases:\n  - Pseudonym\n  - Another\n---\nBody.");
    const file = makeFileService(tmpDir);
    const index = await buildVaultIndex(file);
    expect(index.resolve("Pseudonym")).toBe(true);
    expect(index.resolve("Another")).toBe(true);
    expect(index.resolve("pseudonym")).toBe(true);
  });

  it("safely skips scalar aliases (not array)", async () => {
    await writeFile(tmpDir, "Real.md", "---\naliases: NotAnArray\n---\nBody.");
    const file = makeFileService(tmpDir);
    const index = await buildVaultIndex(file);
    expect(index.resolve("Real")).toBe(true);
    expect(index.resolve("NotAnArray")).toBe(false);
  });

  it("returns false for missing targets", async () => {
    await writeFile(tmpDir, "A.md", "Body.");
    const file = makeFileService(tmpDir);
    const index = await buildVaultIndex(file);
    expect(index.resolve("Ghost")).toBe(false);
  });

  it("returns false for empty target", async () => {
    await writeFile(tmpDir, "A.md", "Body.");
    const file = makeFileService(tmpDir);
    const index = await buildVaultIndex(file);
    expect(index.resolve("")).toBe(false);
    expect(index.resolve("   ")).toBe(false);
  });

  it("filters by scope", async () => {
    await writeFile(tmpDir, "in/Scoped.md", "Body.");
    await writeFile(tmpDir, "out/Other.md", "Body.");
    const file = makeFileService(tmpDir);
    const index = await buildVaultIndex(file, "in");
    expect(index.resolve("Scoped")).toBe(true);
    expect(index.resolve("Other")).toBe(false);
  });
});
