import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FrontmatterServiceImpl } from "./frontmatter-service.js";
import { FileServiceImpl } from "./file-service.js";
import { PathFilterImpl } from "./path-filter.js";

/**
 * All FrontmatterService tests use a real temp directory — no mocks.
 */

async function makeTempVault(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "markscribe-fm-test-"));
}

function makeServices(vaultPath: string): {
  frontmatter: FrontmatterServiceImpl;
} {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  const vault = new FileServiceImpl(vaultPath, filter);
  const frontmatter = new FrontmatterServiceImpl(vault);
  return { frontmatter };
}

async function writeFile(base: string, relPath: string, content: string): Promise<void> {
  const full = path.join(base, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

async function readFile(base: string, relPath: string): Promise<string> {
  return fs.readFile(path.join(base, relPath), "utf-8");
}

describe("FrontmatterServiceImpl", () => {
  let tmpDir: string;
  let svc: FrontmatterServiceImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ frontmatter: svc } = makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // parse
  // =========================================================================

  describe("parse", () => {
    it("parses frontmatter and content from raw string", () => {
      const raw = "---\ntitle: Hello\ntags: [a, b]\n---\nBody text";
      const result = svc.parse(raw);
      expect(result.frontmatter).toEqual({ title: "Hello", tags: ["a", "b"] });
      expect(result.content.trim()).toBe("Body text");
      expect(result.raw).toBe(raw);
    });

    it("returns empty frontmatter when no YAML block present", () => {
      const raw = "Just plain content";
      const result = svc.parse(raw);
      expect(result.frontmatter).toEqual({});
      expect(result.content).toBe("Just plain content");
    });

    it("handles empty string input", () => {
      const result = svc.parse("");
      expect(result.frontmatter).toEqual({});
      expect(result.content).toBe("");
    });

    it("handles frontmatter with complex nested values", () => {
      const raw = "---\nnested:\n  key: value\n  list:\n    - a\n    - b\n---\nContent";
      const result = svc.parse(raw);
      expect(result.frontmatter).toEqual({ nested: { key: "value", list: ["a", "b"] } });
    });

    it("handles frontmatter with no content body", () => {
      const raw = "---\ntitle: Only FM\n---\n";
      const result = svc.parse(raw);
      expect(result.frontmatter).toEqual({ title: "Only FM" });
    });
  });

  // =========================================================================
  // stringify
  // =========================================================================

  describe("stringify", () => {
    it("produces raw content with YAML delimiters when frontmatter is present", () => {
      const fm = { title: "Test", tags: ["x", "y"] };
      const result = svc.stringify(fm, "Body content");
      expect(result).toMatch(/^---\n/);
      expect(result).toContain("title: Test");
      expect(result).toContain("Body content");
    });

    it("returns bare content when frontmatter is empty", () => {
      const result = svc.stringify({}, "Plain body");
      expect(result).toBe("Plain body");
      expect(result).not.toContain("---");
    });

    it("round-trips parse → stringify preserving frontmatter keys", () => {
      const raw = "---\ntitle: Hello\nstatus: active\ntags:\n  - a\n  - b\n---\nBody text";
      const { frontmatter, content } = svc.parse(raw);
      const reserialised = svc.stringify(frontmatter, content);
      // Re-parse and check keys are preserved
      const reparsed = svc.parse(reserialised);
      expect(reparsed.frontmatter["title"]).toBe("Hello");
      expect(reparsed.frontmatter["status"]).toBe("active");
      expect(reparsed.frontmatter["tags"]).toEqual(["a", "b"]);
      // Content body is preserved (gray-matter may strip trailing newlines)
      expect(reparsed.content.trim()).toBe("Body text");
    });

    it("round-trips a note with no frontmatter", () => {
      const raw = "Just plain content without frontmatter";
      const { frontmatter, content } = svc.parse(raw);
      const result = svc.stringify(frontmatter, content);
      expect(result).toBe(raw);
    });
  });

  // =========================================================================
  // updateFields — merge mode
  // =========================================================================

  describe("updateFields — merge mode (default)", () => {
    it("adds new fields without removing existing ones", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: Original\n---\nBody");
      await svc.updateFields("note.md", { status: "active" });
      const raw = await readFile(tmpDir, "note.md");
      const reparsed = svc.parse(raw);
      expect(reparsed.frontmatter["title"]).toBe("Original");
      expect(reparsed.frontmatter["status"]).toBe("active");
    });

    it("overwrites an existing field in merge mode", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: Old\n---\nBody");
      await svc.updateFields("note.md", { title: "New" });
      const raw = await readFile(tmpDir, "note.md");
      const reparsed = svc.parse(raw);
      expect(reparsed.frontmatter["title"]).toBe("New");
    });

    it("preserves content body unchanged", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: T\n---\nMy content here");
      await svc.updateFields("note.md", { tags: ["x"] });
      const raw = await readFile(tmpDir, "note.md");
      expect(raw).toContain("My content here");
    });

    it("merges into a note with no existing frontmatter", async () => {
      await writeFile(tmpDir, "bare.md", "No frontmatter");
      await svc.updateFields("bare.md", { title: "Added" });
      const raw = await readFile(tmpDir, "bare.md");
      const reparsed = svc.parse(raw);
      expect(reparsed.frontmatter["title"]).toBe("Added");
    });
  });

  // =========================================================================
  // updateFields — replace mode
  // =========================================================================

  describe("updateFields — replace mode (merge=false)", () => {
    it("replaces all frontmatter with provided fields", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: Old\nstatus: draft\n---\nBody");
      await svc.updateFields("note.md", { title: "New" }, false);
      const raw = await readFile(tmpDir, "note.md");
      const reparsed = svc.parse(raw);
      expect(reparsed.frontmatter["title"]).toBe("New");
      expect(reparsed.frontmatter["status"]).toBeUndefined();
    });

    it("preserves content body in replace mode", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: T\n---\nKeep this body");
      await svc.updateFields("note.md", { x: 1 }, false);
      const raw = await readFile(tmpDir, "note.md");
      expect(raw).toContain("Keep this body");
    });

    it("replaces with empty object removes all frontmatter", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: T\n---\nBody");
      await svc.updateFields("note.md", {}, false);
      const raw = await readFile(tmpDir, "note.md");
      const reparsed = svc.parse(raw);
      expect(Object.keys(reparsed.frontmatter)).toHaveLength(0);
    });
  });

  // =========================================================================
  // manageTags — list
  // =========================================================================

  describe("manageTags — list", () => {
    it("lists YAML-only tags", async () => {
      await writeFile(tmpDir, "note.md", "---\ntags:\n  - alpha\n  - beta\n---\nNo inline");
      const result = await svc.manageTags("note.md", "list");
      expect(result.tags).toEqual(expect.arrayContaining(["alpha", "beta"]));
    });

    it("lists inline-only tags", async () => {
      await writeFile(tmpDir, "note.md", "No frontmatter\n\nHere is #inline and #tag");
      const result = await svc.manageTags("note.md", "list");
      expect(result.tags).toEqual(expect.arrayContaining(["inline", "tag"]));
    });

    it("lists union of YAML and inline tags without duplicates", async () => {
      await writeFile(
        tmpDir,
        "note.md",
        "---\ntags:\n  - shared\n  - yaml-only\n---\nContent with #shared and #inline-only",
      );
      const result = await svc.manageTags("note.md", "list");
      // shared appears in both, should appear once
      const shared = result.tags.filter((t) => t === "shared");
      expect(shared).toHaveLength(1);
      expect(result.tags).toEqual(expect.arrayContaining(["yaml-only", "shared", "inline-only"]));
    });

    it("returns empty array for note with no tags", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: NoTags\n---\nNo tags here");
      const result = await svc.manageTags("note.md", "list");
      expect(result.tags).toHaveLength(0);
    });

    it("returns empty array for note with no frontmatter and no inline tags", async () => {
      await writeFile(tmpDir, "note.md", "Just plain content");
      const result = await svc.manageTags("note.md", "list");
      expect(result.tags).toHaveLength(0);
    });
  });

  // =========================================================================
  // manageTags — add
  // =========================================================================

  describe("manageTags — add", () => {
    it("adds tags to YAML frontmatter", async () => {
      await writeFile(tmpDir, "note.md", "---\ntags:\n  - existing\n---\nBody");
      const result = await svc.manageTags("note.md", "add", ["new-tag"]);
      expect(result.added).toEqual(["new-tag"]);
      expect(result.tags).toEqual(expect.arrayContaining(["existing", "new-tag"]));
    });

    it("does not duplicate tags already in YAML", async () => {
      await writeFile(tmpDir, "note.md", "---\ntags:\n  - alpha\n---\nBody");
      const result = await svc.manageTags("note.md", "add", ["alpha"]);
      expect(result.added).toHaveLength(0);
      const raw = await readFile(tmpDir, "note.md");
      const alphaMatches = (raw.match(/alpha/g) ?? []).length;
      // "alpha" should appear only once in the tags array
      expect(alphaMatches).toBe(1);
    });

    it("adds tags to a note with no existing frontmatter", async () => {
      await writeFile(tmpDir, "bare.md", "Bare content");
      const result = await svc.manageTags("bare.md", "add", ["fresh"]);
      expect(result.tags).toContain("fresh");
      const raw = await readFile(tmpDir, "bare.md");
      const reparsed = svc.parse(raw);
      expect(reparsed.frontmatter["tags"]).toContain("fresh");
    });

    it("persists tags to disk", async () => {
      await writeFile(tmpDir, "note.md", "---\ntags: []\n---\nBody");
      await svc.manageTags("note.md", "add", ["saved"]);
      const raw = await readFile(tmpDir, "note.md");
      expect(raw).toContain("saved");
    });

    it("adds multiple tags at once", async () => {
      await writeFile(tmpDir, "note.md", "---\ntags: []\n---\nBody");
      const result = await svc.manageTags("note.md", "add", ["a", "b", "c"]);
      expect(result.tags).toEqual(expect.arrayContaining(["a", "b", "c"]));
    });
  });

  // =========================================================================
  // manageTags — remove
  // =========================================================================

  describe("manageTags — remove", () => {
    it("removes tags from YAML frontmatter", async () => {
      await writeFile(tmpDir, "note.md", "---\ntags:\n  - keep\n  - remove-me\n---\nBody");
      const result = await svc.manageTags("note.md", "remove", ["remove-me"]);
      expect(result.removed).toContain("remove-me");
      expect(result.tags).not.toContain("remove-me");
      expect(result.tags).toContain("keep");
    });

    it("removes inline tags from content", async () => {
      await writeFile(tmpDir, "note.md", "No frontmatter\n\nContent with #remove-me and #keep");
      await svc.manageTags("note.md", "remove", ["remove-me"]);
      const raw = await readFile(tmpDir, "note.md");
      expect(raw).not.toContain("#remove-me");
      expect(raw).toContain("#keep");
    });

    it("removes tags from both YAML and inline", async () => {
      await writeFile(
        tmpDir,
        "note.md",
        "---\ntags:\n  - shared\n---\nContent with #shared inline",
      );
      const result = await svc.manageTags("note.md", "remove", ["shared"]);
      expect(result.removed).toContain("shared");
      const raw = await readFile(tmpDir, "note.md");
      // Should be removed from both YAML and inline
      expect(raw).not.toContain("#shared");
      const reparsed = svc.parse(raw);
      expect(reparsed.frontmatter["tags"]).not.toContain("shared");
    });

    it("reports only actually-removed tags in removed array", async () => {
      await writeFile(tmpDir, "note.md", "---\ntags:\n  - present\n---\nBody");
      const result = await svc.manageTags("note.md", "remove", ["present", "not-there"]);
      expect(result.removed).toContain("present");
      expect(result.removed).not.toContain("not-there");
    });

    it("handles removing from a note with no tags gracefully", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: T\n---\nBody");
      const result = await svc.manageTags("note.md", "remove", ["nonexistent"]);
      expect(result.removed).toHaveLength(0);
      expect(result.tags).toHaveLength(0);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("parse handles frontmatter with number/boolean values", () => {
      const raw = "---\ncount: 42\nactive: true\n---\nBody";
      const { frontmatter } = svc.parse(raw);
      expect(frontmatter["count"]).toBe(42);
      expect(frontmatter["active"]).toBe(true);
    });

    it("inline tag extraction does not match heading # characters", async () => {
      await writeFile(tmpDir, "note.md", "# Heading\n\n## Another\n\nReal #tag here");
      const result = await svc.manageTags("note.md", "list");
      expect(result.tags).toContain("tag");
      // Headings should not be mistaken for tags
      expect(result.tags).not.toContain("Heading");
      expect(result.tags).not.toContain("Another");
    });

    it("updateFields uses atomicWrite (no partial state on subsequent read)", async () => {
      await writeFile(tmpDir, "note.md", "---\ntitle: Safe\n---\nContent");
      await svc.updateFields("note.md", { updated: true });
      // If atomicWrite succeeded, read must yield complete content
      const raw = await readFile(tmpDir, "note.md");
      const reparsed = svc.parse(raw);
      expect(reparsed.frontmatter["updated"]).toBe(true);
      expect(reparsed.frontmatter["title"]).toBe("Safe");
    });

    it("manageTags add returns correct union including inline tags in result", async () => {
      await writeFile(tmpDir, "note.md", "---\ntags: []\n---\nContent with #inline");
      const result = await svc.manageTags("note.md", "add", ["yaml-added"]);
      expect(result.tags).toEqual(expect.arrayContaining(["yaml-added", "inline"]));
    });
  });
});
