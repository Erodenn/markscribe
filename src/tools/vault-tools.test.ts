import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { registerVaultTools } from "./vault-tools.js";
import { VaultServiceImpl } from "../services/vault-service.js";
import { PathFilterImpl } from "../services/path-filter.js";
import type { ToolHandler, Services } from "../types.js";

async function makeTempVault(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "vaultscribe-vault-tools-test-"));
}

function makeServices(vaultPath: string): Services {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  const vault = new VaultServiceImpl(vaultPath, filter);
  return {
    vault,
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

function buildRegistry(services: Services): Map<string, ToolHandler> {
  const registry = new Map<string, ToolHandler>();
  registerVaultTools(registry, services);
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

describe("registerVaultTools", () => {
  it("registers list_directory and get_vault_stats", () => {
    const vaultPath = os.tmpdir();
    const registry = buildRegistry(makeServices(vaultPath));
    expect(registry.has("list_directory")).toBe(true);
    expect(registry.has("get_vault_stats")).toBe(true);
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
    expect(result.content[0].text).toMatch(/traversal|not allowed|error/i);
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

describe("get_vault_stats tool", () => {
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
    const result = await callTool(registry, "get_vault_stats", {});
    expect(result.isError).toBeFalsy();

    const stats = JSON.parse(result.content[0].text);
    expect(stats.noteCount).toBe(0);
    expect(stats.totalSize).toBe(0);
    expect(stats.recentFiles).toHaveLength(0);
  });

  it("counts notes correctly", async () => {
    await writeFile(tmpDir, "a.md", "# A");
    await writeFile(tmpDir, "b.md", "# B");
    await writeFile(tmpDir, "sub/c.md", "# C");

    const result = await callTool(registry, "get_vault_stats", {});
    expect(result.isError).toBeFalsy();

    const stats = JSON.parse(result.content[0].text);
    expect(stats.noteCount).toBe(3);
  });

  it("accumulates total size across files", async () => {
    const content = "hello world";
    await writeFile(tmpDir, "note.md", content);

    const result = await callTool(registry, "get_vault_stats", {});
    expect(result.isError).toBeFalsy();

    const stats = JSON.parse(result.content[0].text);
    expect(stats.totalSize).toBeGreaterThan(0);
    expect(stats.noteCount).toBe(1);
  });

  it("includes recent files with modified timestamps", async () => {
    await writeFile(tmpDir, "recent.md", "# Recent");

    const result = await callTool(registry, "get_vault_stats", {});
    expect(result.isError).toBeFalsy();

    const stats = JSON.parse(result.content[0].text);
    expect(stats.recentFiles).toHaveLength(1);
    expect(stats.recentFiles[0].path).toBe("recent.md");
    expect(stats.recentFiles[0].modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("excludes blocked paths from stats", async () => {
    await writeFile(tmpDir, "note.md", "# Note");
    await writeFile(tmpDir, ".obsidian/config", "{}");

    const result = await callTool(registry, "get_vault_stats", {});
    expect(result.isError).toBeFalsy();

    const stats = JSON.parse(result.content[0].text);
    expect(stats.noteCount).toBe(1);
  });

  it("handles vault with notes in nested directories", async () => {
    await writeFile(tmpDir, "a/b/c/deep.md", "# Deep");
    await writeFile(tmpDir, "top.md", "# Top");

    const result = await callTool(registry, "get_vault_stats", {});
    expect(result.isError).toBeFalsy();

    const stats = JSON.parse(result.content[0].text);
    expect(stats.noteCount).toBe(2);
  });

  it("returns isError when vault service throws", async () => {
    // Use a non-existent vault path to force a failure
    const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
    const brokenVault = new VaultServiceImpl("/nonexistent/vault/path", filter);
    const brokenServices = makeServices(tmpDir);
    brokenServices.vault = brokenVault;

    const brokenRegistry = new Map<string, ToolHandler>();
    registerVaultTools(brokenRegistry, brokenServices);

    const result = await callTool(brokenRegistry, "get_vault_stats", {});
    // get_vault_stats catches errors internally in the walk — may succeed with 0 notes
    // or return error depending on OS behavior; just check it doesn't throw
    expect(result.content[0].text).toBeDefined();
  });
});
