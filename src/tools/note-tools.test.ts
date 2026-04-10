import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FileServiceImpl } from "../services/file-service.js";
import { PathFilterImpl } from "../services/path-filter.js";
import { LinkEngineImpl } from "../services/link-engine.js";
import type { Services, ToolHandler, FileService } from "../types.js";
import { registerNoteTools } from "./note-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempVault(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "markscribe-note-tools-"));
}

function makeFileService(rootPath: string): FileService {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  return new FileServiceImpl(rootPath, filter);
}

function makeServices(file: FileService): Services {
  const links = new LinkEngineImpl(file);
  return { file, links } as unknown as Services;
}

function makeRegistry(services: Services): Map<string, ToolHandler> {
  const registry = new Map<string, ToolHandler>();
  registerNoteTools(registry, { services });
  return registry;
}

async function writeFile(base: string, relPath: string, content: string): Promise<void> {
  const full = path.join(base, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let file: FileService;
let services: Services;
let registry: Map<string, ToolHandler>;

beforeEach(async () => {
  tmpDir = await makeTempVault();
  file = makeFileService(tmpDir);
  services = makeServices(file);
  registry = makeRegistry(services);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers for calling tools
// ---------------------------------------------------------------------------

async function call(toolName: string, args: Record<string, unknown>) {
  const handler = registry.get(toolName);
  if (!handler) throw new Error(`Tool not found: ${toolName}`);
  return handler.handler(args);
}

function parseText(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as unknown;
}

// ===========================================================================
// read_note
// ===========================================================================

describe("read_note", () => {
  it("reads a note with frontmatter and content", async () => {
    await writeFile(tmpDir, "notes/hello.md", "---\ntitle: Hello\n---\nBody text");

    const result = await call("read_note", { path: "notes/hello.md" });

    expect(result.isError).toBeFalsy();
    const data = parseText(result) as {
      path: string;
      frontmatter: Record<string, unknown>;
      content: string;
    };
    expect(data.path).toBe("notes/hello.md");
    expect(data.frontmatter.title).toBe("Hello");
    expect(data.content.trim()).toBe("Body text");
  });

  it("reads a note with no frontmatter", async () => {
    await writeFile(tmpDir, "notes/plain.md", "Just content");

    const result = await call("read_note", { path: "notes/plain.md" });

    expect(result.isError).toBeFalsy();
    const data = parseText(result) as { frontmatter: Record<string, unknown>; content: string };
    expect(data.frontmatter).toEqual({});
    expect(data.content.trim()).toBe("Just content");
  });

  it("returns isError when note does not exist", async () => {
    const result = await call("read_note", { path: "nonexistent.md" });

    expect(result.isError).toBe(true);
  });

  it("returns isError on path traversal", async () => {
    const result = await call("read_note", { path: "../escape.md" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/traversal/i);
  });

  it("returns isError for blocked path", async () => {
    const result = await call("read_note", { path: ".obsidian/config.md" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/not allowed/i);
  });
});

// ===========================================================================
// write_note
// ===========================================================================

describe("write_note", () => {
  it("creates a new note in overwrite mode", async () => {
    const result = await call("write_note", {
      path: "notes/new.md",
      content: "Hello world",
    });

    expect(result.isError).toBeFalsy();
    const raw = await fs.readFile(path.join(tmpDir, "notes/new.md"), "utf-8");
    expect(raw).toBe("Hello world");
  });

  it("creates a note with frontmatter", async () => {
    const result = await call("write_note", {
      path: "notes/fm.md",
      content: "Body",
      frontmatter: { title: "Test", tags: ["a", "b"] },
    });

    expect(result.isError).toBeFalsy();
    const raw = await fs.readFile(path.join(tmpDir, "notes/fm.md"), "utf-8");
    expect(raw).toContain("title: Test");
    expect(raw).toContain("Body");
  });

  it("appends content to an existing note", async () => {
    await writeFile(tmpDir, "notes/append.md", "First line");

    const result = await call("write_note", {
      path: "notes/append.md",
      content: "Second line",
      mode: "append",
    });

    expect(result.isError).toBeFalsy();
    const raw = await fs.readFile(path.join(tmpDir, "notes/append.md"), "utf-8");
    expect(raw).toContain("First line");
    expect(raw).toContain("Second line");
    expect(raw.indexOf("First line")).toBeLessThan(raw.indexOf("Second line"));
  });

  it("prepends content to an existing note", async () => {
    await writeFile(tmpDir, "notes/prepend.md", "Second line");

    const result = await call("write_note", {
      path: "notes/prepend.md",
      content: "First line",
      mode: "prepend",
    });

    expect(result.isError).toBeFalsy();
    const raw = await fs.readFile(path.join(tmpDir, "notes/prepend.md"), "utf-8");
    expect(raw.indexOf("First line")).toBeLessThan(raw.indexOf("Second line"));
  });

  it("returns isError for blocked path", async () => {
    const result = await call("write_note", {
      path: ".git/COMMIT_EDITMSG",
      content: "bad",
    });

    expect(result.isError).toBe(true);
  });
});

// ===========================================================================
// patch_note
// ===========================================================================

describe("patch_note", () => {
  it("replaces the first occurrence by default", async () => {
    await writeFile(tmpDir, "notes/patch.md", "foo bar foo");

    const result = await call("patch_note", {
      path: "notes/patch.md",
      oldString: "foo",
      newString: "baz",
    });

    expect(result.isError).toBeFalsy();
    const data = parseText(result) as { replacements: number };
    expect(data.replacements).toBe(1);
    const raw = await fs.readFile(path.join(tmpDir, "notes/patch.md"), "utf-8");
    expect(raw).toBe("baz bar foo");
  });

  it("replaces all occurrences when replaceAll is true", async () => {
    await writeFile(tmpDir, "notes/patch.md", "foo bar foo");

    const result = await call("patch_note", {
      path: "notes/patch.md",
      oldString: "foo",
      newString: "baz",
      replaceAll: true,
    });

    expect(result.isError).toBeFalsy();
    const data = parseText(result) as { replacements: number };
    expect(data.replacements).toBe(2);
    const raw = await fs.readFile(path.join(tmpDir, "notes/patch.md"), "utf-8");
    expect(raw).toBe("baz bar baz");
  });

  it("returns isError when oldString not found", async () => {
    await writeFile(tmpDir, "notes/patch.md", "hello world");

    const result = await call("patch_note", {
      path: "notes/patch.md",
      oldString: "nothere",
      newString: "replaced",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/not found/i);
  });

  it("returns isError when note does not exist", async () => {
    const result = await call("patch_note", {
      path: "notes/missing.md",
      oldString: "foo",
      newString: "bar",
    });

    expect(result.isError).toBe(true);
  });

  it("returns isError for blocked path", async () => {
    const result = await call("patch_note", {
      path: ".obsidian/workspace.md",
      oldString: "a",
      newString: "b",
    });

    expect(result.isError).toBe(true);
  });
});

// ===========================================================================
// delete_note
// ===========================================================================

describe("delete_note", () => {
  it("deletes a note when confirmPath matches", async () => {
    await writeFile(tmpDir, "notes/delete-me.md", "content");

    const result = await call("delete_note", {
      path: "notes/delete-me.md",
      confirmPath: "notes/delete-me.md",
    });

    expect(result.isError).toBeFalsy();
    const data = parseText(result) as { success: boolean };
    expect(data.success).toBe(true);

    await expect(fs.access(path.join(tmpDir, "notes/delete-me.md"))).rejects.toThrow();
  });

  it("returns isError when confirmPath does not match", async () => {
    await writeFile(tmpDir, "notes/keep.md", "content");

    const result = await call("delete_note", {
      path: "notes/keep.md",
      confirmPath: "notes/wrong.md",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/does not match/i);

    // File should still exist
    await expect(fs.access(path.join(tmpDir, "notes/keep.md"))).resolves.toBeUndefined();
  });

  it("returns isError when note does not exist", async () => {
    const result = await call("delete_note", {
      path: "notes/ghost.md",
      confirmPath: "notes/ghost.md",
    });

    expect(result.isError).toBe(true);
  });

  it("returns isError for blocked path", async () => {
    const result = await call("delete_note", {
      path: ".git/config",
      confirmPath: ".git/config",
    });

    expect(result.isError).toBe(true);
  });
});

// ===========================================================================
// move_note
// ===========================================================================

describe("move_note", () => {
  it("moves a note to a new path", async () => {
    await writeFile(tmpDir, "notes/src.md", "# Source");

    const result = await call("move_note", {
      oldPath: "notes/src.md",
      newPath: "archive/src.md",
    });

    expect(result.isError).toBeFalsy();
    const data = parseText(result) as { oldPath: string; newPath: string };
    expect(data.oldPath).toBe("notes/src.md");
    expect(data.newPath).toBe("archive/src.md");

    await expect(fs.access(path.join(tmpDir, "notes/src.md"))).rejects.toThrow();
    const moved = await fs.readFile(path.join(tmpDir, "archive/src.md"), "utf-8");
    expect(moved).toBe("# Source");
  });

  it("returns isError when source does not exist", async () => {
    const result = await call("move_note", {
      oldPath: "notes/ghost.md",
      newPath: "archive/ghost.md",
    });

    expect(result.isError).toBe(true);
  });

  it("returns isError for blocked destination path", async () => {
    await writeFile(tmpDir, "notes/src.md", "content");

    const result = await call("move_note", {
      oldPath: "notes/src.md",
      newPath: ".obsidian/src.md",
    });

    expect(result.isError).toBe(true);
  });

  it("returns isError for path traversal in oldPath", async () => {
    const result = await call("move_note", {
      oldPath: "../outside.md",
      newPath: "notes/inside.md",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/traversal/i);
  });

  it("updateLinks=false (default) does not modify references in other files", async () => {
    await writeFile(tmpDir, "OldNote.md", "# Old Note");
    await writeFile(tmpDir, "other.md", "See [[OldNote]] for details.");

    await call("move_note", {
      oldPath: "OldNote.md",
      newPath: "NewNote.md",
      updateLinks: false,
    });

    const otherContent = await fs.readFile(path.join(tmpDir, "other.md"), "utf-8");
    expect(otherContent).toContain("[[OldNote]]");
  });

  it("updateLinks=true updates plain wikilinks after rename", async () => {
    await writeFile(tmpDir, "OldNote.md", "# Old Note");
    await writeFile(tmpDir, "other.md", "See [[OldNote]] for details.");

    const result = await call("move_note", {
      oldPath: "OldNote.md",
      newPath: "NewNote.md",
      updateLinks: true,
    });

    expect(result.isError).toBeFalsy();
    const data = parseText(result) as {
      oldPath: string;
      newPath: string;
      linksUpdated: { filesUpdated: number; linksUpdated: number; modifiedFiles: string[] };
    };
    expect(data.linksUpdated.filesUpdated).toBe(1);
    expect(data.linksUpdated.linksUpdated).toBe(1);

    const otherContent = await fs.readFile(path.join(tmpDir, "other.md"), "utf-8");
    expect(otherContent).toContain("[[NewNote]]");
    expect(otherContent).not.toContain("[[OldNote]]");
  });

  it("updateLinks=true preserves display text after rename", async () => {
    await writeFile(tmpDir, "OldNote.md", "# Old Note");
    await writeFile(tmpDir, "other.md", "See [[OldNote|click here]] for details.");

    await call("move_note", {
      oldPath: "OldNote.md",
      newPath: "NewNote.md",
      updateLinks: true,
    });

    const otherContent = await fs.readFile(path.join(tmpDir, "other.md"), "utf-8");
    expect(otherContent).toContain("[[NewNote|click here]]");
    expect(otherContent).not.toContain("[[OldNote");
  });

  it("updateLinks=true preserves section anchors after rename", async () => {
    await writeFile(tmpDir, "OldNote.md", "# Old Note");
    await writeFile(tmpDir, "other.md", "See [[OldNote#Introduction]] for context.");

    await call("move_note", {
      oldPath: "OldNote.md",
      newPath: "NewNote.md",
      updateLinks: true,
    });

    const otherContent = await fs.readFile(path.join(tmpDir, "other.md"), "utf-8");
    expect(otherContent).toContain("[[NewNote#Introduction]]");
    expect(otherContent).not.toContain("[[OldNote");
  });

  it("updateLinks=true includes RenameResult in response", async () => {
    await writeFile(tmpDir, "Alpha.md", "# Alpha");
    await writeFile(tmpDir, "ref1.md", "[[Alpha]] and some text.");
    await writeFile(tmpDir, "ref2.md", "[[Alpha|Alpha Note]] referenced here.");

    const result = await call("move_note", {
      oldPath: "Alpha.md",
      newPath: "Beta.md",
      updateLinks: true,
    });

    expect(result.isError).toBeFalsy();
    const data = parseText(result) as {
      oldPath: string;
      newPath: string;
      linksUpdated: { filesUpdated: number; linksUpdated: number; modifiedFiles: string[] };
    };
    expect(data.oldPath).toBe("Alpha.md");
    expect(data.newPath).toBe("Beta.md");
    expect(data.linksUpdated.filesUpdated).toBe(2);
    expect(data.linksUpdated.linksUpdated).toBe(2);
    expect(data.linksUpdated.modifiedFiles).toContain("ref1.md");
    expect(data.linksUpdated.modifiedFiles).toContain("ref2.md");
  });

  it("updateLinks=true reports zero updates when no files reference moved note", async () => {
    await writeFile(tmpDir, "Isolated.md", "# Isolated");
    await writeFile(tmpDir, "other.md", "No references here.");

    const result = await call("move_note", {
      oldPath: "Isolated.md",
      newPath: "StillIsolated.md",
      updateLinks: true,
    });

    expect(result.isError).toBeFalsy();
    const data = parseText(result) as {
      linksUpdated: { filesUpdated: number; linksUpdated: number };
    };
    expect(data.linksUpdated.filesUpdated).toBe(0);
    expect(data.linksUpdated.linksUpdated).toBe(0);
  });
});

// ===========================================================================
// read_multiple_notes
// ===========================================================================

describe("read_multiple_notes", () => {
  it("reads multiple notes in one batch", async () => {
    await writeFile(tmpDir, "a.md", "# A");
    await writeFile(tmpDir, "b.md", "# B");

    const result = await call("read_multiple_notes", { paths: ["a.md", "b.md"] });

    expect(result.isError).toBeFalsy();
    const data = parseText(result) as {
      results: Array<{ path: string; note: unknown; error?: string }>;
    };
    expect(data.results).toHaveLength(2);
    expect(data.results[0].note).not.toBeNull();
    expect(data.results[1].note).not.toBeNull();
  });

  it("returns partial success when some notes are missing", async () => {
    await writeFile(tmpDir, "exists.md", "content");

    const result = await call("read_multiple_notes", {
      paths: ["exists.md", "missing.md"],
    });

    expect(result.isError).toBeFalsy();
    const data = parseText(result) as {
      results: Array<{ path: string; note: unknown; error?: string }>;
    };
    expect(data.results).toHaveLength(2);

    const found = data.results.find((r) => r.path === "exists.md");
    const missing = data.results.find((r) => r.path === "missing.md");
    expect(found?.note).not.toBeNull();
    expect(missing?.note).toBeNull();
    expect(missing?.error).toBeTruthy();
  });

  it("throws when more than 10 paths are provided", async () => {
    const paths = Array.from({ length: 11 }, (_, i) => `note${i}.md`);

    await expect(call("read_multiple_notes", { paths })).rejects.toThrow();
  });
});
