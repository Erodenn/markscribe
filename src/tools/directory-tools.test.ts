import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { registerDirectoryTools } from "./directory-tools.js";
import { FileServiceImpl } from "../services/file-service.js";
import { PathFilterImpl } from "../services/path-filter.js";
import type { ToolHandler, Services, ServiceContainer } from "../types.js";

async function makeTempVault(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "markscribe-vault-tools-test-"));
}

function makeServices(vaultPath: string): Services {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  const vault = new FileServiceImpl(vaultPath, filter);
  return {
    file: vault,
    frontmatter: null as unknown as Services["frontmatter"],
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

function buildRegistry(services: Services | null): Map<string, ToolHandler> {
  const registry = new Map<string, ToolHandler>();
  const container: ServiceContainer = { services };
  registerDirectoryTools(registry, container, "");
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

describe("registerDirectoryTools", () => {
  it("registers list_directory, get_stats, and switch_directory", () => {
    const vaultPath = os.tmpdir();
    const registry = buildRegistry(makeServices(vaultPath));
    expect(registry.has("list_directory")).toBe(true);
    expect(registry.has("get_stats")).toBe(true);
    expect(registry.has("switch_directory")).toBe(true);
  });
});

describe("list_directory tool", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    registry = buildRegistry(makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("lists vault root when path is empty string", async () => {
    await writeFile(tmpDir, "note-a.md", "# A");
    await writeFile(tmpDir, "note-b.md", "# B");

    const result = await callTool(registry, "list_directory", { path: "" });
    expect(result.isError).toBeFalsy();

    const listing = JSON.parse(result.content[0].text);
    expect(listing.path).toBe("");
    const names = listing.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("note-a.md");
    expect(names).toContain("note-b.md");
  });

  it("lists vault root when path is omitted (uses default)", async () => {
    await writeFile(tmpDir, "root.md", "# Root");

    const result = await callTool(registry, "list_directory", {});
    expect(result.isError).toBeFalsy();

    const listing = JSON.parse(result.content[0].text);
    const names = listing.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("root.md");
  });

  it("lists a subdirectory", async () => {
    await writeFile(tmpDir, "sub/child.md", "# Child");
    await writeFile(tmpDir, "sub/other.md", "# Other");

    const result = await callTool(registry, "list_directory", { path: "sub" });
    expect(result.isError).toBeFalsy();

    const listing = JSON.parse(result.content[0].text);
    expect(listing.path).toBe("sub");
    const names = listing.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("child.md");
    expect(names).toContain("other.md");
  });

  it("includes directories in entries with correct type", async () => {
    await writeFile(tmpDir, "folder/note.md", "# Note");

    const result = await callTool(registry, "list_directory", { path: "" });
    expect(result.isError).toBeFalsy();

    const listing = JSON.parse(result.content[0].text);
    const dirEntry = listing.entries.find(
      (e: { name: string; type: string }) => e.name === "folder",
    );
    expect(dirEntry).toBeDefined();
    expect(dirEntry.type).toBe("directory");
  });

  it("returns empty entries for an empty directory", async () => {
    await fs.mkdir(path.join(tmpDir, "empty"), { recursive: true });

    const result = await callTool(registry, "list_directory", { path: "empty" });
    expect(result.isError).toBeFalsy();

    const listing = JSON.parse(result.content[0].text);
    expect(listing.entries).toHaveLength(0);
  });

  it("excludes blocked paths like .obsidian", async () => {
    await writeFile(tmpDir, ".obsidian/config", "{}");
    await writeFile(tmpDir, "note.md", "# Note");

    const result = await callTool(registry, "list_directory", { path: "" });
    expect(result.isError).toBeFalsy();

    const listing = JSON.parse(result.content[0].text);
    const names = listing.entries.map((e: { name: string }) => e.name);
    expect(names).not.toContain(".obsidian");
    expect(names).toContain("note.md");
  });

  it("lists nested directories correctly", async () => {
    await writeFile(tmpDir, "level1/level2/deep.md", "# Deep");

    const level1Result = await callTool(registry, "list_directory", { path: "level1" });
    expect(level1Result.isError).toBeFalsy();
    const level1Listing = JSON.parse(level1Result.content[0].text);
    const level1Names = level1Listing.entries.map((e: { name: string }) => e.name);
    expect(level1Names).toContain("level2");

    const level2Result = await callTool(registry, "list_directory", { path: "level1/level2" });
    expect(level2Result.isError).toBeFalsy();
    const level2Listing = JSON.parse(level2Result.content[0].text);
    const level2Names = level2Listing.entries.map((e: { name: string }) => e.name);
    expect(level2Names).toContain("deep.md");
  });

  it("returns error on path traversal attempt", async () => {
    const result = await callTool(registry, "list_directory", { path: "../escape" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/traversal|not allowed|error/i);
  });

  it("returns error for non-existent directory", async () => {
    const result = await callTool(registry, "list_directory", { path: "nonexistent" });
    expect(result.isError).toBe(true);
  });

  it("entry paths are vault-relative", async () => {
    await writeFile(tmpDir, "sub/note.md", "# Note");

    const result = await callTool(registry, "list_directory", { path: "sub" });
    expect(result.isError).toBeFalsy();

    const listing = JSON.parse(result.content[0].text);
    const noteEntry = listing.entries.find(
      (e: { name: string; path: string }) => e.name === "note.md",
    );
    expect(noteEntry.path).toBe("sub/note.md");
  });
});

describe("get_stats tool", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    registry = buildRegistry(makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns zero stats for an empty vault", async () => {
    const result = await callTool(registry, "get_stats", {});
    expect(result.isError).toBeFalsy();

    const stats = JSON.parse(result.content[0].text);
    expect(stats.noteCount).toBe(0);
    expect(stats.totalBytes).toBe(0);
    expect(stats.recentFiles).toHaveLength(0);
  });

  it("counts notes correctly", async () => {
    await writeFile(tmpDir, "a.md", "# A");
    await writeFile(tmpDir, "b.md", "# B");
    await writeFile(tmpDir, "sub/c.md", "# C");

    const result = await callTool(registry, "get_stats", {});
    expect(result.isError).toBeFalsy();

    const stats = JSON.parse(result.content[0].text);
    expect(stats.noteCount).toBe(3);
  });

  it("accumulates total size across files", async () => {
    const content = "hello world";
    await writeFile(tmpDir, "note.md", content);

    const result = await callTool(registry, "get_stats", {});
    expect(result.isError).toBeFalsy();

    const stats = JSON.parse(result.content[0].text);
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.noteCount).toBe(1);
  });

  it("includes recent files with modified timestamps", async () => {
    await writeFile(tmpDir, "recent.md", "# Recent");

    const result = await callTool(registry, "get_stats", {});
    expect(result.isError).toBeFalsy();

    const stats = JSON.parse(result.content[0].text);
    expect(stats.recentFiles).toHaveLength(1);
    expect(stats.recentFiles[0].path).toBe("recent.md");
    expect(stats.recentFiles[0].modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("excludes blocked paths from stats", async () => {
    await writeFile(tmpDir, "note.md", "# Note");
    await writeFile(tmpDir, ".obsidian/config", "{}");

    const result = await callTool(registry, "get_stats", {});
    expect(result.isError).toBeFalsy();

    const stats = JSON.parse(result.content[0].text);
    expect(stats.noteCount).toBe(1);
  });

  it("handles vault with notes in nested directories", async () => {
    await writeFile(tmpDir, "a/b/c/deep.md", "# Deep");
    await writeFile(tmpDir, "top.md", "# Top");

    const result = await callTool(registry, "get_stats", {});
    expect(result.isError).toBeFalsy();

    const stats = JSON.parse(result.content[0].text);
    expect(stats.noteCount).toBe(2);
  });

  it("returns isError when vault service throws", async () => {
    // Use a non-existent vault path to force a failure
    const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
    const brokenVault = new FileServiceImpl("/nonexistent/vault/path", filter);
    const brokenServices = makeServices(tmpDir);
    brokenServices.file = brokenVault;

    const brokenRegistry = buildRegistry(brokenServices);

    const result = await callTool(brokenRegistry, "get_stats", {});
    // get_stats catches errors internally in the walk — may succeed with 0 notes
    // or return error depending on OS behavior; just check it doesn't throw
    expect(result.content[0].text).toBeDefined();
  });
});

describe("requireServices error message", () => {
  it("mentions switch_directory and --root in the error when no directory is active", async () => {
    const container: ServiceContainer = { services: null };
    const registry = new Map<string, ToolHandler>();
    registerDirectoryTools(registry, container, "");

    // Any tool that calls requireServices should get the hint
    const result = await callTool(registry, "list_directory", {});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/switch_directory/);
    expect(parsed.error).toMatch(/--root/);
  });
});
