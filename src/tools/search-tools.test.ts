import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import { registerSearchTools } from "./search-tools.js";
import { FileServiceImpl } from "../services/file-service.js";
import { PathFilterImpl } from "../services/path-filter.js";
import { FrontmatterServiceImpl } from "../services/frontmatter-service.js";
import { SearchServiceImpl } from "../services/search-service.js";
import type { ToolHandler, Services } from "../types.js";
import { makeTempDir, writeFile } from "../test-helpers.js";

function makeServices(vaultPath: string): Services {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  const vault = new FileServiceImpl(vaultPath, filter);
  const frontmatter = new FrontmatterServiceImpl(vault);
  const search = new SearchServiceImpl(vault);
  return {
    file: vault,
    frontmatter,
    search,
    schema: null as unknown as Services["schema"],
    links: null as unknown as Services["links"],
  };
}

function buildRegistry(services: Services): Map<string, ToolHandler> {
  const registry = new Map<string, ToolHandler>();
  registerSearchTools(registry, { services });
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

describe("registerSearchTools", () => {
  it("registers search_notes", () => {
    const vaultPath = os.tmpdir();
    const registry = buildRegistry(makeServices(vaultPath));
    expect(registry.has("search_notes")).toBe(true);
  });
});

describe("search_notes tool", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-search-tools-test-");
    registry = buildRegistry(makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns results for a basic query", async () => {
    await writeFile(tmpDir, "apple.md", "apple apple apple I love apple fruit.");
    await writeFile(tmpDir, "banana.md", "Bananas are yellow fruit found in tropical climates.");

    const result = await callTool(registry, "search_notes", { query: "apple" });
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.root).toBeDefined();
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBeGreaterThan(0);
    const paths = parsed.results.map((r: { path: string }) => r.path);
    expect(paths).toContain("apple.md");
  });

  it("ranks most relevant result first by BM25 score", async () => {
    await writeFile(tmpDir, "a.md", "The quick brown fox jumps over the lazy dog.");
    await writeFile(tmpDir, "b.md", "Fox fox fox fox fox. This document is about foxes.");

    const result = await callTool(registry, "search_notes", { query: "fox" });
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results.length).toBeGreaterThan(0);
    // b.md has more "fox" occurrences — should score higher
    expect(parsed.results[0].path).toBe("b.md");
  });

  it("returns empty array when no matches found", async () => {
    await writeFile(tmpDir, "note.md", "This is about astronomy and planets.");

    const result = await callTool(registry, "search_notes", { query: "xylophone" });
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toEqual([]);
  });

  it("filters results by scope", async () => {
    await writeFile(tmpDir, "projects/project-alpha.md", "Alpha project is about widgets.");
    await writeFile(tmpDir, "personal/diary.md", "Today I worked on widgets for fun.");

    const result = await callTool(registry, "search_notes", {
      query: "widgets",
      scope: "projects",
    });
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.content[0].text);
    const paths = parsed.results.map((r: { path: string }) => r.path);
    expect(paths).toContain("projects/project-alpha.md");
    expect(paths).not.toContain("personal/diary.md");
  });

  it("respects the limit parameter", async () => {
    await writeFile(tmpDir, "a.md", "common term here");
    await writeFile(tmpDir, "b.md", "common term also");
    await writeFile(tmpDir, "c.md", "common term too");

    const result = await callTool(registry, "search_notes", {
      query: "common term",
      limit: 2,
    });
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results.length).toBeLessThanOrEqual(2);
  });

  it("includes excerpt in results", async () => {
    await writeFile(tmpDir, "note.md", "The galaxy is vast and full of stars.");

    const result = await callTool(registry, "search_notes", { query: "galaxy" });
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(typeof parsed.results[0].excerpt).toBe("string");
    expect(parsed.results[0].excerpt.length).toBeGreaterThan(0);
  });

  it("includes score in results", async () => {
    await writeFile(tmpDir, "note.md", "Ocean waves crash on the shore.");

    const result = await callTool(registry, "search_notes", { query: "ocean" });
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(typeof parsed.results[0].score).toBe("number");
    expect(parsed.results[0].score).toBeGreaterThan(0);
  });

  it("searches frontmatter when searchFrontmatter=true", async () => {
    await writeFile(
      tmpDir,
      "note.md",
      "---\nproject: atlantis\n---\n\nThis body talks about something else entirely.",
    );

    // With searchFrontmatter=false (default), should not find frontmatter-only match
    const defaultResult = await callTool(registry, "search_notes", { query: "atlantis" });
    // With frontmatter search enabled, should find it
    const fmResult = await callTool(registry, "search_notes", {
      query: "atlantis",
      searchContent: false,
      searchFrontmatter: true,
    });
    expect(fmResult.isError).toBeFalsy();

    const fmParsed = JSON.parse(fmResult.content[0].text);
    const fmPaths = fmParsed.results.map((r: { path: string }) => r.path);
    expect(fmPaths).toContain("note.md");

    // Default result should not find it if the word only appears in frontmatter
    const defaultParsed = JSON.parse(defaultResult.content[0].text);
    const defaultPaths = defaultParsed.results.map((r: { path: string }) => r.path);
    expect(defaultPaths).not.toContain("note.md");
  });

  it("returns error for invalid arguments (missing query)", async () => {
    const result = await callTool(registry, "search_notes", {});
    expect(result.isError).toBe(true);
  });

  it("returns empty array for empty vault", async () => {
    const result = await callTool(registry, "search_notes", { query: "anything" });
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toEqual([]);
  });
});
