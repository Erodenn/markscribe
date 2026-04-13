import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { VaultServiceImpl } from "./vault-service.js";
import { PathFilterImpl } from "./path-filter.js";

/**
 * All VaultService tests use a real temp directory — no mocks.
 * This ensures atomicWrite crash safety is actually exercised.
 */

async function makeTempVault(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "vaultscribe-test-"));
}

function makeService(vaultPath: string, extra: { blockedPaths?: string[] } = {}): VaultServiceImpl {
  const filter = new PathFilterImpl({
    blockedPaths: extra.blockedPaths ?? [],
    allowedExtensions: [],
  });
  return new VaultServiceImpl(vaultPath, filter);
}

async function writeFile(base: string, relPath: string, content: string): Promise<void> {
  const full = path.join(base, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

async function readFile(base: string, relPath: string): Promise<string> {
  return await fs.readFile(path.join(base, relPath), "utf-8");
}

describe("VaultServiceImpl", () => {
  let tmpDir: string;
  let svc: VaultServiceImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    svc = makeService(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // resolvePath
  // =========================================================================

  describe("resolvePath", () => {
    it("resolves a simple relative path", () => {
      const resolved = svc.resolvePath("notes/hello.md");
      expect(resolved).toBe(path.join(tmpDir, "notes", "hello.md"));
    });

    it("throws on path traversal above vault root", () => {
      expect(() => svc.resolvePath("../escape.md")).toThrow("Path traversal detected");
    });

    it("throws on nested traversal that escapes root", () => {
      expect(() => svc.resolvePath("notes/../../escape.md")).toThrow("Path traversal detected");
    });

    it("throws when PathFilter blocks the path", () => {
      expect(() => svc.resolvePath(".obsidian/config.md")).toThrow("Path not allowed");
    });

    it("throws on disallowed extension", () => {
      expect(() => svc.resolvePath("notes/script.js")).toThrow("Path not allowed");
    });
  });

  // =========================================================================
  // atomicWrite
  // =========================================================================

  describe("atomicWrite", () => {
    it("writes file content correctly", async () => {
      const fullPath = path.join(tmpDir, "notes", "test.md");
      await svc.atomicWrite(fullPath, "hello world");
      const content = await fs.readFile(fullPath, "utf-8");
      expect(content).toBe("hello world");
    });

    it("creates parent directories if they don't exist", async () => {
      const fullPath = path.join(tmpDir, "deep", "nested", "dir", "note.md");
      await svc.atomicWrite(fullPath, "content");
      const content = await fs.readFile(fullPath, "utf-8");
      expect(content).toBe("content");
    });

    it("overwrites existing file atomically", async () => {
      const fullPath = path.join(tmpDir, "note.md");
      await svc.atomicWrite(fullPath, "original");
      await svc.atomicWrite(fullPath, "updated");
      const content = await fs.readFile(fullPath, "utf-8");
      expect(content).toBe("updated");
    });

    it("leaves no temp files on success", async () => {
      const fullPath = path.join(tmpDir, "note.md");
      await svc.atomicWrite(fullPath, "content");
      const files = await fs.readdir(tmpDir);
      // Only the written file should be present
      const tmpFiles = files.filter((f) => f.startsWith(".vaultscribe-tmp-"));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  // =========================================================================
  // readNote
  // =========================================================================

  describe("readNote", () => {
    it("reads a note with frontmatter", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: Hello\ntags: [a, b]\n---\nBody content");
      const note = await svc.readNote("note.md");
      expect(note.path).toBe("note.md");
      expect(note.frontmatter).toEqual({ title: "Hello", tags: ["a", "b"] });
      expect(note.content.trim()).toBe("Body content");
      expect(note.raw).toContain("title: Hello");
    });

    it("reads a note without frontmatter", async () => {
      await writeFile(tmpDir, "plain.md", "Just plain content");
      const note = await svc.readNote("plain.md");
      expect(note.frontmatter).toEqual({});
      expect(note.content).toBe("Just plain content");
    });

    it("throws on path traversal", async () => {
      await expect(svc.readNote("../outside.md")).rejects.toThrow("Path traversal detected");
    });

    it("throws if file does not exist", async () => {
      await expect(svc.readNote("missing.md")).rejects.toThrow();
    });
  });

  // =========================================================================
  // writeNote
  // =========================================================================

  describe("writeNote — overwrite mode", () => {
    it("creates a new note with content", async () => {
      await svc.writeNote("new.md", "Hello world");
      const content = await readFile(tmpDir, "new.md");
      expect(content).toBe("Hello world");
    });

    it("overwrites existing note", async () => {
      await writeFile(tmpDir, "existing.md", "old content");
      await svc.writeNote("existing.md", "new content");
      const content = await readFile(tmpDir, "existing.md");
      expect(content).toBe("new content");
    });

    it("writes frontmatter correctly", async () => {
      await svc.writeNote("fm.md", "Body", { title: "Test", tags: ["x"] });
      const raw = await readFile(tmpDir, "fm.md");
      expect(raw).toContain("title: Test");
      expect(raw).toContain("- x");
      expect(raw).toContain("Body");
    });
  });

  describe("writeNote — append mode", () => {
    it("appends to existing note", async () => {
      await writeFile(tmpDir, "log.md", "First line");
      await svc.writeNote("log.md", "Second line", undefined, "append");
      const content = await readFile(tmpDir, "log.md");
      expect(content).toContain("First line");
      expect(content).toContain("Second line");
    });

    it("creates file if it doesn't exist in append mode", async () => {
      await svc.writeNote("new-append.md", "Content", undefined, "append");
      const content = await readFile(tmpDir, "new-append.md");
      expect(content).toBe("Content");
    });
  });

  describe("writeNote — prepend mode", () => {
    it("prepends to existing note", async () => {
      await writeFile(tmpDir, "doc.md", "Original");
      await svc.writeNote("doc.md", "Prepended", undefined, "prepend");
      const content = await readFile(tmpDir, "doc.md");
      expect(content.indexOf("Prepended")).toBeLessThan(content.indexOf("Original"));
    });

    it("creates file if it doesn't exist in prepend mode", async () => {
      await svc.writeNote("new-prepend.md", "Content", undefined, "prepend");
      const content = await readFile(tmpDir, "new-prepend.md");
      expect(content).toBe("Content");
    });
  });

  // =========================================================================
  // patchNote
  // =========================================================================

  describe("patchNote", () => {
    it("replaces first occurrence by default", async () => {
      await writeFile(tmpDir, "patch.md", "foo bar foo");
      await svc.patchNote("patch.md", "foo", "baz");
      const content = await readFile(tmpDir, "patch.md");
      expect(content).toBe("baz bar foo");
    });

    it("replaces all occurrences when replaceAll=true", async () => {
      await writeFile(tmpDir, "patch-all.md", "foo bar foo");
      await svc.patchNote("patch-all.md", "foo", "baz", true);
      const content = await readFile(tmpDir, "patch-all.md");
      expect(content).toBe("baz bar baz");
    });

    it("throws if oldString is not found", async () => {
      await writeFile(tmpDir, "no-match.md", "some content");
      await expect(svc.patchNote("no-match.md", "missing", "replacement")).rejects.toThrow(
        "string not found",
      );
    });

    it("throws on path traversal", async () => {
      await expect(svc.patchNote("../escape.md", "a", "b")).rejects.toThrow(
        "Path traversal detected",
      );
    });
  });

  // =========================================================================
  // deleteNote
  // =========================================================================

  describe("deleteNote", () => {
    it("deletes a file when confirmPath matches", async () => {
      await writeFile(tmpDir, "todelete.md", "content");
      await svc.deleteNote("todelete.md", "todelete.md");
      await expect(fs.access(path.join(tmpDir, "todelete.md"))).rejects.toThrow();
    });

    it("throws when confirmPath does not match path", async () => {
      await writeFile(tmpDir, "safe.md", "content");
      await expect(svc.deleteNote("safe.md", "wrong.md")).rejects.toThrow("confirmPath");
    });

    it("throws on path traversal", async () => {
      await expect(svc.deleteNote("../escape.md", "../escape.md")).rejects.toThrow(
        "Path traversal detected",
      );
    });
  });

  // =========================================================================
  // moveNote
  // =========================================================================

  describe("moveNote", () => {
    it("moves a note to a new path", async () => {
      await writeFile(tmpDir, "old.md", "content");
      const result = await svc.moveNote("old.md", "new.md");
      expect(result.oldPath).toBe("old.md");
      expect(result.newPath).toBe("new.md");
      await expect(fs.access(path.join(tmpDir, "old.md"))).rejects.toThrow();
      const content = await readFile(tmpDir, "new.md");
      expect(content).toBe("content");
    });

    it("creates destination directories as needed", async () => {
      await writeFile(tmpDir, "flat.md", "content");
      await svc.moveNote("flat.md", "nested/dir/flat.md");
      const content = await readFile(tmpDir, "nested/dir/flat.md");
      expect(content).toBe("content");
    });

    it("throws on traversal in source path", async () => {
      await expect(svc.moveNote("../escape.md", "safe.md")).rejects.toThrow(
        "Path traversal detected",
      );
    });

    it("throws on traversal in destination path", async () => {
      await writeFile(tmpDir, "note.md", "content");
      await expect(svc.moveNote("note.md", "../escape.md")).rejects.toThrow(
        "Path traversal detected",
      );
    });

    it("throws when destination already exists (default)", async () => {
      await writeFile(tmpDir, "source.md", "source content");
      await writeFile(tmpDir, "dest.md", "existing content");
      await expect(svc.moveNote("source.md", "dest.md")).rejects.toThrow(
        /destination.*already exists/i,
      );
      // Source should still exist — move was not performed
      const sourceContent = await readFile(tmpDir, "source.md");
      expect(sourceContent).toBe("source content");
      // Destination should be unchanged
      const destContent = await readFile(tmpDir, "dest.md");
      expect(destContent).toBe("existing content");
    });

    it("overwrites destination when overwrite=true", async () => {
      await writeFile(tmpDir, "source.md", "new content");
      await writeFile(tmpDir, "dest.md", "old content");
      const result = await svc.moveNote("source.md", "dest.md", true);
      expect(result.newPath).toBe("dest.md");
      const content = await readFile(tmpDir, "dest.md");
      expect(content).toBe("new content");
      await expect(fs.access(path.join(tmpDir, "source.md"))).rejects.toThrow();
    });
  });

  // =========================================================================
  // listDirectory
  // =========================================================================

  describe("listDirectory", () => {
    it("lists files and subdirectories", async () => {
      await writeFile(tmpDir, "note.md", "content");
      await writeFile(tmpDir, "sub/note2.md", "content");
      const listing = await svc.listDirectory("");
      const names = listing.entries.map((e) => e.name);
      expect(names).toContain("note.md");
      expect(names).toContain("sub");
    });

    it("filters out blocked paths from listing", async () => {
      await writeFile(tmpDir, "note.md", "content");
      // Create a .obsidian directory manually (bypassing the service)
      await fs.mkdir(path.join(tmpDir, ".obsidian"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, ".obsidian", "config"), "{}");
      const listing = await svc.listDirectory("");
      const names = listing.entries.map((e) => e.name);
      expect(names).not.toContain(".obsidian");
    });

    it("filters out files with disallowed extensions", async () => {
      await fs.writeFile(path.join(tmpDir, "script.js"), "code");
      await writeFile(tmpDir, "note.md", "content");
      const listing = await svc.listDirectory("");
      const names = listing.entries.map((e) => e.name);
      expect(names).not.toContain("script.js");
      expect(names).toContain("note.md");
    });

    it("returns correct entry types", async () => {
      await writeFile(tmpDir, "note.md", "content");
      await writeFile(tmpDir, "sub/note2.md", "content");
      const listing = await svc.listDirectory("");
      const noteEntry = listing.entries.find((e) => e.name === "note.md");
      const subEntry = listing.entries.find((e) => e.name === "sub");
      expect(noteEntry?.type).toBe("file");
      expect(subEntry?.type).toBe("directory");
    });

    it("throws on path traversal", async () => {
      await expect(svc.listDirectory("../outside")).rejects.toThrow("Path traversal detected");
    });
  });

  // =========================================================================
  // readMultipleNotes
  // =========================================================================

  describe("readMultipleNotes", () => {
    it("reads multiple notes at once", async () => {
      await writeFile(tmpDir, "a.md", "A content");
      await writeFile(tmpDir, "b.md", "B content");
      const result = await svc.readMultipleNotes(["a.md", "b.md"]);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].note?.content).toBe("A content");
      expect(result.results[1].note?.content).toBe("B content");
    });

    it("reports error for missing files without throwing", async () => {
      await writeFile(tmpDir, "exists.md", "content");
      const result = await svc.readMultipleNotes(["exists.md", "missing.md"]);
      expect(result.results[0].note).not.toBeNull();
      expect(result.results[1].note).toBeNull();
      expect(result.results[1].error).toBeTruthy();
    });

    it("throws if more than 10 paths are provided", async () => {
      const paths = Array.from({ length: 11 }, (_, i) => `note${i}.md`);
      await expect(svc.readMultipleNotes(paths)).rejects.toThrow("max 10");
    });

    it("allows exactly 10 paths", async () => {
      const paths = Array.from({ length: 10 }, (_, i) => `note${i}.md`);
      // Files don't exist — errors are reported but no throw
      const result = await svc.readMultipleNotes(paths);
      expect(result.results).toHaveLength(10);
      for (const entry of result.results) {
        expect(entry.note).toBeNull();
        expect(entry.error).toBeTruthy();
      }
    });
  });

  // =========================================================================
  // getVaultStats
  // =========================================================================

  describe("getVaultStats", () => {
    it("counts notes correctly", async () => {
      await writeFile(tmpDir, "a.md", "content");
      await writeFile(tmpDir, "sub/b.md", "content");
      const stats = await svc.getVaultStats();
      expect(stats.noteCount).toBe(2);
    });

    it("excludes blocked paths from stats", async () => {
      await writeFile(tmpDir, "a.md", "content");
      await fs.mkdir(path.join(tmpDir, ".obsidian"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, ".obsidian", "workspace"), "{}");
      const stats = await svc.getVaultStats();
      expect(stats.noteCount).toBe(1);
    });

    it("excludes files with disallowed extensions from stats", async () => {
      await writeFile(tmpDir, "note.md", "content");
      await fs.writeFile(path.join(tmpDir, "image.png"), "binary");
      const stats = await svc.getVaultStats();
      expect(stats.noteCount).toBe(1);
    });

    it("calculates total size", async () => {
      const content = "hello";
      await writeFile(tmpDir, "note.md", content);
      const stats = await svc.getVaultStats();
      expect(stats.totalSize).toBeGreaterThan(0);
    });

    it("returns recent files sorted by modification time", async () => {
      await writeFile(tmpDir, "older.md", "content");
      // Small delay to get distinct mtimes
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(tmpDir, "newer.md", "content");
      const stats = await svc.getVaultStats();
      expect(stats.recentFiles[0].path).toBe("newer.md");
    });

    it("returns empty stats for an empty vault", async () => {
      const stats = await svc.getVaultStats();
      expect(stats.noteCount).toBe(0);
      expect(stats.totalSize).toBe(0);
      expect(stats.recentFiles).toHaveLength(0);
    });
  });
});
