import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FileServiceImpl } from "./file-service.js";
import { SearchServiceImpl } from "./search-service.js";
import { PathFilterImpl } from "./path-filter.js";

async function makeTempVault(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "markscribe-search-test-"));
}

async function writeFile(base: string, relPath: string, content: string): Promise<void> {
  const full = path.join(base, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

function makeServices(vaultPath: string) {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  const vault = new FileServiceImpl(vaultPath, filter);
  const search = new SearchServiceImpl(vault);
  return { vault, search };
}

describe("SearchServiceImpl", () => {
  let tmpDir: string;
  let search: SearchServiceImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ search } = makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // search — basic
  // =========================================================================

  describe("search — empty results", () => {
    it("returns empty array when vault is empty", async () => {
      const results = await search.search("hello");
      expect(results).toHaveLength(0);
    });

    it("returns empty array when no notes match", async () => {
      await writeFile(tmpDir, "note.md", "Content about apples and oranges");
      const results = await search.search("quantum mechanics");
      expect(results).toHaveLength(0);
    });

    it("returns empty array for empty query string", async () => {
      await writeFile(tmpDir, "note.md", "Some content");
      const results = await search.search("");
      expect(results).toHaveLength(0);
    });
  });

  // =========================================================================
  // search — BM25 ranking
  // =========================================================================

  describe("search — BM25 ranking", () => {
    it("ranks document with more term occurrences higher", async () => {
      // doc-high has 'banana' appearing many times; doc-low has it once
      await writeFile(
        tmpDir,
        "doc-high.md",
        "banana banana banana banana banana banana banana banana banana banana",
      );
      await writeFile(
        tmpDir,
        "doc-low.md",
        "banana and some other content about completely different things",
      );

      const results = await search.search("banana");
      expect(results.length).toBeGreaterThanOrEqual(2);
      const highIdx = results.findIndex((r) => r.path === "doc-high.md");
      const lowIdx = results.findIndex((r) => r.path === "doc-low.md");
      expect(highIdx).toBeLessThan(lowIdx);
      expect(results[highIdx].score).toBeGreaterThan(results[lowIdx].score);
    });

    it("returns results sorted by score descending", async () => {
      await writeFile(tmpDir, "a.md", "apple apple apple");
      await writeFile(tmpDir, "b.md", "apple");
      await writeFile(tmpDir, "c.md", "completely unrelated content");

      const results = await search.search("apple");
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
      }
    });

    it("returns path and positive score for matching notes", async () => {
      await writeFile(tmpDir, "note.md", "The quick brown fox jumps");
      const results = await search.search("fox");
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("note.md");
      expect(results[0].score).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // search — scope filtering
  // =========================================================================

  describe("search — scope filtering", () => {
    it("only searches within path prefix when scope is set", async () => {
      await writeFile(tmpDir, "folder-a/note.md", "unique keyword zebra");
      await writeFile(tmpDir, "folder-b/note.md", "unique keyword zebra");

      const results = await search.search("zebra", { scope: "folder-a" });
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("folder-a/note.md");
    });

    it("returns all matches when no scope set", async () => {
      await writeFile(tmpDir, "folder-a/note.md", "unique keyword pelican");
      await writeFile(tmpDir, "folder-b/note.md", "unique keyword pelican");

      const results = await search.search("pelican");
      expect(results).toHaveLength(2);
    });

    it("returns empty when scope prefix matches no files", async () => {
      await writeFile(tmpDir, "notes/note.md", "content moose");
      const results = await search.search("moose", { scope: "nonexistent" });
      expect(results).toHaveLength(0);
    });
  });

  // =========================================================================
  // search — limit
  // =========================================================================

  describe("search — limit", () => {
    it("respects limit option", async () => {
      for (let i = 0; i < 5; i++) {
        await writeFile(tmpDir, `note${i}.md`, `term content stuff ${i}`);
      }
      const results = await search.search("term", { limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("returns all results when limit not set", async () => {
      for (let i = 0; i < 5; i++) {
        await writeFile(tmpDir, `note${i}.md`, `term content`);
      }
      const results = await search.search("term");
      expect(results).toHaveLength(5);
    });

    it("returns fewer than limit when fewer matches exist", async () => {
      await writeFile(tmpDir, "note.md", "needle content");
      const results = await search.search("needle", { limit: 10 });
      expect(results).toHaveLength(1);
    });
  });

  // =========================================================================
  // search — searchContent option
  // =========================================================================

  describe("search — searchContent option", () => {
    it("matches body content by default", async () => {
      await writeFile(tmpDir, "note.md", "The term giraffe lives in body content");
      const results = await search.search("giraffe");
      expect(results).toHaveLength(1);
    });

    it("does not search body when searchContent=false", async () => {
      await writeFile(tmpDir, "note.md", "The term elephant lives in body content");
      const results = await search.search("elephant", {
        searchContent: false,
        searchFrontmatter: false,
      });
      expect(results).toHaveLength(0);
    });
  });

  // =========================================================================
  // search — searchFrontmatter option
  // =========================================================================

  describe("search — searchFrontmatter option", () => {
    it("searches frontmatter values when searchFrontmatter=true", async () => {
      await writeFile(
        tmpDir,
        "note.md",
        "---\ntitle: The Crocodile\nauthor: Dr. Jane\n---\nSome body content here",
      );

      const results = await search.search("crocodile", {
        searchContent: false,
        searchFrontmatter: true,
      });
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("note.md");
    });

    it("does not search frontmatter by default", async () => {
      await writeFile(
        tmpDir,
        "note.md",
        "---\ntitle: Unique Unicorn Title\n---\nBody content without the keyword",
      );

      const results = await search.search("unicorn");
      // searchFrontmatter defaults to false, body doesn't have 'unicorn'
      expect(results).toHaveLength(0);
    });

    it("includes matchedFields when frontmatter terms match", async () => {
      await writeFile(
        tmpDir,
        "note.md",
        "---\ntitle: Warthog Research\ncategory: animal\n---\nBody text",
      );

      const results = await search.search("warthog", {
        searchContent: false,
        searchFrontmatter: true,
      });
      expect(results).toHaveLength(1);
      expect(results[0].matchedFields).toContain("title");
    });
  });

  // =========================================================================
  // search — excerpt generation
  // =========================================================================

  describe("search — excerpt generation", () => {
    it("excerpt contains text around the match", async () => {
      await writeFile(
        tmpDir,
        "note.md",
        "Introduction paragraph here. Then the word walrus appears in context. End of note.",
      );

      const results = await search.search("walrus");
      expect(results).toHaveLength(1);
      expect(results[0].excerpt).toContain("walrus");
    });

    it("excerpt is non-empty even for short documents", async () => {
      await writeFile(tmpDir, "short.md", "Short note with owl");
      const results = await search.search("owl");
      expect(results[0].excerpt.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // searchByFrontmatter — equals operator
  // =========================================================================

  describe("searchByFrontmatter — equals", () => {
    it("matches exact field value", async () => {
      await writeFile(tmpDir, "note.md", "---\nstatus: published\n---\nContent");
      const results = await search.searchByFrontmatter("status", "published", "equals");
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("note.md");
    });

    it("does not match partial value with equals operator", async () => {
      await writeFile(tmpDir, "note.md", "---\nstatus: published\n---\nContent");
      const results = await search.searchByFrontmatter("status", "publish", "equals");
      expect(results).toHaveLength(0);
    });

    it("does not match when field is absent", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: Hello\n---\nContent");
      const results = await search.searchByFrontmatter("status", "published", "equals");
      expect(results).toHaveLength(0);
    });

    it("defaults to equals operator when omitted", async () => {
      await writeFile(tmpDir, "note.md", "---\ntype: article\n---\nContent");
      const results = await search.searchByFrontmatter("type", "article");
      expect(results).toHaveLength(1);
    });
  });

  // =========================================================================
  // searchByFrontmatter — contains operator
  // =========================================================================

  describe("searchByFrontmatter — contains", () => {
    it("matches when field value contains the query substring", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: Advanced JavaScript Guide\n---\nContent");
      const results = await search.searchByFrontmatter("title", "JavaScript", "contains");
      expect(results).toHaveLength(1);
    });

    it("is case-insensitive for contains", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: Advanced JavaScript Guide\n---\nContent");
      const results = await search.searchByFrontmatter("title", "javascript", "contains");
      expect(results).toHaveLength(1);
    });

    it("matches substring in array field", async () => {
      await writeFile(
        tmpDir,
        "note.md",
        "---\ntags:\n  - programming\n  - typescript\n---\nContent",
      );
      const results = await search.searchByFrontmatter("tags", "typescript", "contains");
      expect(results).toHaveLength(1);
    });

    it("does not match when field absent", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: Hello\n---\nContent");
      const results = await search.searchByFrontmatter("category", "tech", "contains");
      expect(results).toHaveLength(0);
    });
  });

  // =========================================================================
  // searchByFrontmatter — exists operator
  // =========================================================================

  describe("searchByFrontmatter — exists", () => {
    it("matches when field is present and non-empty", async () => {
      await writeFile(tmpDir, "note.md", "---\ndueDate: 2025-01-01\n---\nContent");
      const results = await search.searchByFrontmatter("dueDate", "", "exists");
      expect(results).toHaveLength(1);
    });

    it("does not match when field is absent", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: Hello\n---\nContent");
      const results = await search.searchByFrontmatter("dueDate", "", "exists");
      expect(results).toHaveLength(0);
    });

    it("includes matchedFields in results", async () => {
      await writeFile(tmpDir, "note.md", "---\ndueDate: 2025-06-01\n---\nContent");
      const results = await search.searchByFrontmatter("dueDate", "", "exists");
      expect(results[0].matchedFields).toContain("dueDate");
    });

    it("returns multiple matches across notes", async () => {
      await writeFile(tmpDir, "a.md", "---\ndueDate: 2025-01-01\n---\nContent");
      await writeFile(tmpDir, "b.md", "---\ndueDate: 2025-02-01\n---\nContent");
      await writeFile(tmpDir, "c.md", "---\ntitle: No due date\n---\nContent");
      const results = await search.searchByFrontmatter("dueDate", "", "exists");
      expect(results).toHaveLength(2);
    });
  });

  // =========================================================================
  // searchByFrontmatter — general
  // =========================================================================

  describe("searchByFrontmatter — general", () => {
    it("returns empty array when no notes have the field", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: Hello\n---\nContent");
      const results = await search.searchByFrontmatter("nonexistent", "value", "equals");
      expect(results).toHaveLength(0);
    });

    it("score is 1 for all frontmatter matches", async () => {
      await writeFile(tmpDir, "note.md", "---\nstatus: draft\n---\nContent");
      const results = await search.searchByFrontmatter("status", "draft", "equals");
      expect(results[0].score).toBe(1);
    });
  });

  // =========================================================================
  // Configurable search settings
  // =========================================================================

  describe("configurable maxResults and excerptChars", () => {
    it("applies default maxResults cap of 50 when limit is not specified", async () => {
      // Create 55 notes so we exceed default cap
      for (let i = 0; i < 55; i++) {
        await writeFile(tmpDir, `note-${i}.md`, `Common keyword in all notes ${i}`);
      }
      const results = await search.search("common keyword");
      expect(results.length).toBeLessThanOrEqual(50);
    });

    it("respects custom maxResults from config", async () => {
      const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
      const vault = new FileServiceImpl(tmpDir, filter);
      const customSearch = new SearchServiceImpl(vault, { maxResults: 3 });

      for (let i = 0; i < 10; i++) {
        await writeFile(tmpDir, `n-${i}.md`, `Shared term in note ${i}`);
      }
      const results = await customSearch.search("shared term");
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("explicit limit overrides maxResults config", async () => {
      const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
      const vault = new FileServiceImpl(tmpDir, filter);
      const customSearch = new SearchServiceImpl(vault, { maxResults: 100 });

      for (let i = 0; i < 10; i++) {
        await writeFile(tmpDir, `x-${i}.md`, `Targetword in note ${i}`);
      }
      const results = await customSearch.search("targetword", { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });
});
