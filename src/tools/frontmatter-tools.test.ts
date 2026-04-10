import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { registerFrontmatterTools } from "./frontmatter-tools.js";
import { VaultServiceImpl } from "../services/vault-service.js";
import { PathFilterImpl } from "../services/path-filter.js";
import { FrontmatterServiceImpl } from "../services/frontmatter-service.js";
import type { ToolHandler, Services } from "../types.js";

async function makeTempVault(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "vaultscribe-fm-tools-test-"));
}

function makeServices(vaultPath: string): Services {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  const vault = new VaultServiceImpl(vaultPath, filter);
  const frontmatter = new FrontmatterServiceImpl(vault);
  return {
    vault,
    frontmatter,
    search: null as unknown as Services["search"],
    schema: null as unknown as Services["schema"],
    links: null as unknown as Services["links"],
  };
}

async function writeFile(base: string, relPath: string, content: string): Promise<void> {
  const full = path.join(base, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

function buildRegistry(services: Services): Map<string, ToolHandler> {
  const registry = new Map<string, ToolHandler>();
  registerFrontmatterTools(registry, services);
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

describe("registerFrontmatterTools", () => {
  it("registers get_frontmatter, update_frontmatter, manage_tags", () => {
    const vaultPath = os.tmpdir();
    const registry = buildRegistry(makeServices(vaultPath));
    expect(registry.has("get_frontmatter")).toBe(true);
    expect(registry.has("update_frontmatter")).toBe(true);
    expect(registry.has("manage_tags")).toBe(true);
  });
});

describe("get_frontmatter tool", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    registry = buildRegistry(makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns frontmatter for a note with frontmatter", async () => {
    await writeFile(tmpDir, "note.md", "---\ntitle: Hello\ntags: [foo, bar]\n---\n\nBody text.");

    const result = await callTool(registry, "get_frontmatter", { path: "note.md" });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("note.md");
    expect(data.frontmatter.title).toBe("Hello");
    expect(data.frontmatter.tags).toEqual(["foo", "bar"]);
  });

  it("returns empty frontmatter for a note with no frontmatter", async () => {
    await writeFile(tmpDir, "plain.md", "Just body content, no frontmatter.");

    const result = await callTool(registry, "get_frontmatter", { path: "plain.md" });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("plain.md");
    expect(data.frontmatter).toEqual({});
  });

  it("returns error for missing note", async () => {
    const result = await callTool(registry, "get_frontmatter", { path: "nonexistent.md" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/error/i);
  });

  it("returns error for invalid arguments (missing path)", async () => {
    const result = await callTool(registry, "get_frontmatter", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid arguments/i);
  });
});

describe("update_frontmatter tool", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    registry = buildRegistry(makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("merges new fields into existing frontmatter (default merge=true)", async () => {
    await writeFile(tmpDir, "note.md", "---\ntitle: Original\nauthor: Alice\n---\n\nBody.");

    const result = await callTool(registry, "update_frontmatter", {
      path: "note.md",
      fields: { title: "Updated", status: "draft" },
    });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.frontmatter.title).toBe("Updated");
    expect(data.frontmatter.author).toBe("Alice"); // preserved from existing
    expect(data.frontmatter.status).toBe("draft"); // new field added
  });

  it("replaces all frontmatter fields when merge=false", async () => {
    await writeFile(tmpDir, "note.md", "---\ntitle: Original\nauthor: Alice\n---\n\nBody.");

    const result = await callTool(registry, "update_frontmatter", {
      path: "note.md",
      fields: { title: "Replaced" },
      merge: false,
    });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.frontmatter.title).toBe("Replaced");
    expect(data.frontmatter.author).toBeUndefined(); // removed by replace
  });

  it("adds frontmatter to a note with no frontmatter", async () => {
    await writeFile(tmpDir, "plain.md", "Just body content.");

    const result = await callTool(registry, "update_frontmatter", {
      path: "plain.md",
      fields: { title: "Now Has Frontmatter" },
    });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.frontmatter.title).toBe("Now Has Frontmatter");
  });

  it("returns the updated frontmatter object in response", async () => {
    await writeFile(tmpDir, "note.md", "---\ntitle: Test\n---\n\nBody.");

    const result = await callTool(registry, "update_frontmatter", {
      path: "note.md",
      fields: { date: "2026-04-09" },
    });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("note.md");
    expect(data.frontmatter.date).toBe("2026-04-09");
    expect(data.frontmatter.title).toBe("Test");
  });

  it("returns error for missing note", async () => {
    const result = await callTool(registry, "update_frontmatter", {
      path: "missing.md",
      fields: { title: "x" },
    });
    expect(result.isError).toBe(true);
  });

  it("returns error for invalid arguments (missing path)", async () => {
    const result = await callTool(registry, "update_frontmatter", {
      fields: { title: "x" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid arguments/i);
  });
});

describe("manage_tags tool", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    registry = buildRegistry(makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('lists tags from YAML frontmatter (operation="list")', async () => {
    await writeFile(tmpDir, "note.md", "---\ntags: [foo, bar, baz]\n---\n\nBody.");

    const result = await callTool(registry, "manage_tags", {
      path: "note.md",
      operation: "list",
    });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.path).toBe("note.md");
    expect(data.tags).toContain("foo");
    expect(data.tags).toContain("bar");
    expect(data.tags).toContain("baz");
  });

  it("lists inline tags alongside YAML tags", async () => {
    await writeFile(tmpDir, "note.md", "---\ntags: [yaml-tag]\n---\n\nBody with #inline-tag here.");

    const result = await callTool(registry, "manage_tags", {
      path: "note.md",
      operation: "list",
    });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.tags).toContain("yaml-tag");
    expect(data.tags).toContain("inline-tag");
  });

  it("returns empty tags for note with no tags", async () => {
    await writeFile(tmpDir, "note.md", "Just plain content, no tags.");

    const result = await callTool(registry, "manage_tags", {
      path: "note.md",
      operation: "list",
    });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.tags).toEqual([]);
  });

  it('adds new tags to YAML frontmatter (operation="add")', async () => {
    await writeFile(tmpDir, "note.md", "---\ntags: [existing]\n---\n\nBody.");

    const result = await callTool(registry, "manage_tags", {
      path: "note.md",
      operation: "add",
      tags: ["new-tag", "another-tag"],
    });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.tags).toContain("existing");
    expect(data.tags).toContain("new-tag");
    expect(data.tags).toContain("another-tag");
    expect(data.added).toEqual(expect.arrayContaining(["new-tag", "another-tag"]));
  });

  it("does not duplicate existing tags on add", async () => {
    await writeFile(tmpDir, "note.md", "---\ntags: [existing]\n---\n\nBody.");

    const result = await callTool(registry, "manage_tags", {
      path: "note.md",
      operation: "add",
      tags: ["existing"],
    });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    const existingCount = data.tags.filter((t: string) => t === "existing").length;
    expect(existingCount).toBe(1);
    expect(data.added).toEqual([]);
  });

  it('removes tags from YAML frontmatter (operation="remove")', async () => {
    await writeFile(tmpDir, "note.md", "---\ntags: [keep, remove-me]\n---\n\nBody.");

    const result = await callTool(registry, "manage_tags", {
      path: "note.md",
      operation: "remove",
      tags: ["remove-me"],
    });
    expect(result.isError).toBeFalsy();

    const data = JSON.parse(result.content[0].text);
    expect(data.tags).toContain("keep");
    expect(data.tags).not.toContain("remove-me");
    expect(data.removed).toContain("remove-me");
  });

  it("returns error for missing note", async () => {
    const result = await callTool(registry, "manage_tags", {
      path: "missing.md",
      operation: "list",
    });
    expect(result.isError).toBe(true);
  });

  it("returns error for invalid operation", async () => {
    const result = await callTool(registry, "manage_tags", {
      path: "note.md",
      operation: "invalid-op",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid arguments/i);
  });

  it("returns error for invalid arguments (missing path)", async () => {
    const result = await callTool(registry, "manage_tags", {
      operation: "list",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid arguments/i);
  });
});
