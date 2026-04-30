import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { registerLinkTools } from "./link-tools.js";
import { LinkEngineImpl } from "../services/link-engine.js";
import { FileServiceImpl } from "../services/file-service.js";
import { PathFilterImpl } from "../services/path-filter.js";
import type { ToolHandler, Services } from "../types.js";
import { makeTempDir, writeFile } from "../test-helpers.js";

/**
 * All link-tools tests use real temp vault directories — no mocks.
 * Services is partially constructed (only vault + links needed by these tools).
 */

function makeServices(vaultPath: string): Services {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  const vault = new FileServiceImpl(vaultPath, filter);
  const links = new LinkEngineImpl(vault);

  return {
    file: vault,
    links,
    // The other services are not exercised by link-tools — cast stubs
    frontmatter: null as unknown as Services["frontmatter"],
    search: null as unknown as Services["search"],
    schema: null as unknown as Services["schema"],
  };
}

function makeRegistry(services: Services): Map<string, ToolHandler> {
  const registry = new Map<string, ToolHandler>();
  registerLinkTools(registry, { services });
  return registry;
}

async function callTool(
  registry: Map<string, ToolHandler>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  const result = await tool.handler(args);
  return { text: result.content[0].text, isError: result.isError };
}

// ============================================================================
// Registration
// ============================================================================

describe("registerLinkTools", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-link-tools-test-");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("registers all five link tools", () => {
    const services = makeServices(tmpDir);
    const registry = makeRegistry(services);

    expect(registry.has("get_backlinks")).toBe(true);
    expect(registry.has("find_unlinked_mentions")).toBe(true);
    expect(registry.has("find_broken_links")).toBe(true);
    expect(registry.has("find_orphans")).toBe(true);
    expect(registry.has("find_bidirectional_mentions")).toBe(true);
  });

  it("each tool has name, description, inputSchema, and handler", () => {
    const services = makeServices(tmpDir);
    const registry = makeRegistry(services);

    for (const [, tool] of registry) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
      expect(typeof tool.handler).toBe("function");
    }
  });
});

// ============================================================================
// get_backlinks
// ============================================================================

describe("get_backlinks tool", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-link-tools-test-");
    registry = makeRegistry(makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns backlinks when other notes link to the target", async () => {
    await writeFile(tmpDir, "Hub.md", "The hub.");
    await writeFile(tmpDir, "Source.md", "See [[Hub]] for details.");

    const { text, isError } = await callTool(registry, "get_backlinks", { path: "Hub.md" });
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as { path: string; backlinks: unknown[] };
    expect(parsed.path).toBe("Hub.md");
    expect(parsed.backlinks).toHaveLength(1);
  });

  it("returns the correct source path and link details", async () => {
    await writeFile(tmpDir, "Target.md", "Content.");
    await writeFile(tmpDir, "A.md", "See [[Target|Alias Text]] here.");

    const { text } = await callTool(registry, "get_backlinks", { path: "Target.md" });
    const parsed = JSON.parse(text) as {
      backlinks: Array<{ sourcePath: string; link: { display: string | null }; line: number }>;
    };
    const bl = parsed.backlinks[0];
    expect(bl.sourcePath).toBe("A.md");
    expect(bl.link.display).toBe("Alias Text");
    expect(bl.line).toBe(1);
  });

  it("returns multiple backlinks from different files", async () => {
    await writeFile(tmpDir, "Hub.md", "Hub.");
    await writeFile(tmpDir, "A.md", "[[Hub]]");
    await writeFile(tmpDir, "B.md", "[[Hub]]");

    const { text } = await callTool(registry, "get_backlinks", { path: "Hub.md" });
    const parsed = JSON.parse(text) as { backlinks: unknown[] };
    expect(parsed.backlinks).toHaveLength(2);
  });

  it("returns empty backlinks array for a note with no incoming links", async () => {
    await writeFile(tmpDir, "Isolated.md", "Nobody links here.");

    const { text, isError } = await callTool(registry, "get_backlinks", { path: "Isolated.md" });
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as { backlinks: unknown[] };
    expect(parsed.backlinks).toHaveLength(0);
  });

  it("returns error response for missing path argument", async () => {
    const { isError } = await callTool(registry, "get_backlinks", {});
    expect(isError).toBe(true);
  });

  it("preserves section anchor in returned backlink", async () => {
    await writeFile(tmpDir, "Target.md", "Content.");
    await writeFile(tmpDir, "Src.md", "See [[Target#Intro]].");

    const { text } = await callTool(registry, "get_backlinks", { path: "Target.md" });
    const parsed = JSON.parse(text) as {
      backlinks: Array<{ link: { section: string | null } }>;
    };
    expect(parsed.backlinks[0].link.section).toBe("Intro");
  });
});

// ============================================================================
// find_unlinked_mentions
// ============================================================================

describe("find_unlinked_mentions tool", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-link-tools-test-");
    registry = makeRegistry(makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("finds plain-text mentions that are not wikilinks", async () => {
    await writeFile(tmpDir, "Target.md", "Content.");
    await writeFile(tmpDir, "Source.md", "I read Target today.");

    const { text, isError } = await callTool(registry, "find_unlinked_mentions", {
      path: "Target.md",
    });
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as { mentions: unknown[] };
    expect(parsed.mentions).toHaveLength(1);
  });

  it("does not report already-wikilinked mentions", async () => {
    await writeFile(tmpDir, "Target.md", "Content.");
    await writeFile(tmpDir, "Source.md", "See [[Target]] for details.");

    const { text } = await callTool(registry, "find_unlinked_mentions", { path: "Target.md" });
    const parsed = JSON.parse(text) as { mentions: unknown[] };
    expect(parsed.mentions).toHaveLength(0);
  });

  it("does not report mentions from the target note itself", async () => {
    await writeFile(tmpDir, "Target.md", "Target is mentioned here.");

    const { text } = await callTool(registry, "find_unlinked_mentions", { path: "Target.md" });
    const parsed = JSON.parse(text) as { mentions: unknown[] };
    expect(parsed.mentions).toHaveLength(0);
  });

  it("returns correct line and column for mention", async () => {
    await writeFile(tmpDir, "MyNote.md", "Content.");
    await writeFile(tmpDir, "Source.md", "Line 1\nSee MyNote here.");

    const { text } = await callTool(registry, "find_unlinked_mentions", { path: "MyNote.md" });
    const parsed = JSON.parse(text) as {
      mentions: Array<{ line: number; column: number; mentionText: string }>;
    };
    expect(parsed.mentions[0].line).toBe(2);
    expect(parsed.mentions[0].column).toBe(4);
    expect(parsed.mentions[0].mentionText).toBe("MyNote");
  });

  it("returns empty mentions array when none exist", async () => {
    await writeFile(tmpDir, "Target.md", "Content.");
    await writeFile(tmpDir, "Source.md", "Nothing related.");

    const { text, isError } = await callTool(registry, "find_unlinked_mentions", {
      path: "Target.md",
    });
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as { mentions: unknown[] };
    expect(parsed.mentions).toHaveLength(0);
  });

  it("returns error response for missing path argument", async () => {
    const { isError } = await callTool(registry, "find_unlinked_mentions", {});
    expect(isError).toBe(true);
  });
});

// ============================================================================
// find_broken_links
// ============================================================================

describe("find_broken_links tool", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-link-tools-test-");
    registry = makeRegistry(makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns broken links pointing to non-existent notes", async () => {
    await writeFile(tmpDir, "Source.md", "See [[Ghost]].");

    const { text, isError } = await callTool(registry, "find_broken_links", {});
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as {
      brokenLinks: Array<{ sourcePath: string; link: { target: string } }>;
    };
    expect(parsed.brokenLinks).toHaveLength(1);
    expect(parsed.brokenLinks[0].sourcePath).toBe("Source.md");
    expect(parsed.brokenLinks[0].link.target).toBe("Ghost");
  });

  it("returns empty array when all links resolve", async () => {
    await writeFile(tmpDir, "A.md", "See [[B]].");
    await writeFile(tmpDir, "B.md", "Content.");

    const { text, isError } = await callTool(registry, "find_broken_links", {});
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as { brokenLinks: unknown[] };
    expect(parsed.brokenLinks).toHaveLength(0);
  });

  it("applies scope filter — only reports broken links within scope", async () => {
    await writeFile(tmpDir, "folder/Source.md", "[[BrokenInFolder]]");
    await writeFile(tmpDir, "other/Source.md", "[[BrokenInOther]]");

    const { text } = await callTool(registry, "find_broken_links", { scope: "folder" });
    const parsed = JSON.parse(text) as {
      scope: string;
      brokenLinks: Array<{ sourcePath: string }>;
    };
    expect(parsed.scope).toBe("folder");
    expect(parsed.brokenLinks).toHaveLength(1);
    expect(parsed.brokenLinks[0].sourcePath).toBe("folder/Source.md");
  });

  it("includes scope: null in response when no scope provided", async () => {
    const { text } = await callTool(registry, "find_broken_links", {});
    const parsed = JSON.parse(text) as { scope: unknown };
    expect(parsed.scope).toBeNull();
  });

  it("reports multiple broken links from the same file", async () => {
    await writeFile(tmpDir, "Source.md", "[[Ghost1]] and [[Ghost2]].");

    const { text } = await callTool(registry, "find_broken_links", {});
    const parsed = JSON.parse(text) as { brokenLinks: unknown[] };
    expect(parsed.brokenLinks).toHaveLength(2);
  });

  it("reports correct line number for broken link", async () => {
    await writeFile(tmpDir, "Source.md", "Good line\n[[Broken]] here");

    const { text } = await callTool(registry, "find_broken_links", {});
    const parsed = JSON.parse(text) as { brokenLinks: Array<{ line: number }> };
    expect(parsed.brokenLinks[0].line).toBe(2);
  });
});

// ============================================================================
// find_orphans
// ============================================================================

describe("find_orphans tool", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-link-tools-test-");
    registry = makeRegistry(makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns notes with no incoming links", async () => {
    await writeFile(tmpDir, "Hub.md", "Links to [[Child]].");
    await writeFile(tmpDir, "Child.md", "No links.");
    await writeFile(tmpDir, "Orphan.md", "Nobody links here.");

    const { text, isError } = await callTool(registry, "find_orphans", {});
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as { orphans: string[] };
    expect(parsed.orphans).toContain("Orphan.md");
    expect(parsed.orphans).not.toContain("Child.md");
  });

  it("returns empty array when all notes are linked", async () => {
    await writeFile(tmpDir, "A.md", "Links to [[B]].");
    await writeFile(tmpDir, "B.md", "Links to [[A]].");

    const { text, isError } = await callTool(registry, "find_orphans", {});
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as { orphans: string[] };
    expect(parsed.orphans).toHaveLength(0);
  });

  it("returns all notes as orphans in a vault with no links", async () => {
    await writeFile(tmpDir, "A.md", "No links.");
    await writeFile(tmpDir, "B.md", "No links.");

    const { text } = await callTool(registry, "find_orphans", {});
    const parsed = JSON.parse(text) as { orphans: string[] };
    expect(parsed.orphans).toHaveLength(2);
    expect(parsed.orphans).toContain("A.md");
    expect(parsed.orphans).toContain("B.md");
  });

  it("applies scope filter — only considers notes within scope", async () => {
    await writeFile(tmpDir, "folder/A.md", "No links.");
    await writeFile(tmpDir, "folder/B.md", "Links to [[A]].");
    await writeFile(tmpDir, "other/C.md", "No links.");

    const { text } = await callTool(registry, "find_orphans", { scope: "folder" });
    const parsed = JSON.parse(text) as { scope: string; orphans: string[] };
    expect(parsed.scope).toBe("folder");
    // B links to A, so A has incoming links within the scope — not an orphan
    // B has no incoming links within the scope — is an orphan
    expect(parsed.orphans).not.toContain("folder/A.md");
    expect(parsed.orphans).toContain("folder/B.md");
    expect(parsed.orphans).not.toContain("other/C.md");
  });

  it("includes scope: null in response when no scope provided", async () => {
    const { text } = await callTool(registry, "find_orphans", {});
    const parsed = JSON.parse(text) as { scope: unknown };
    expect(parsed.scope).toBeNull();
  });
});

// ============================================================================
// find_bidirectional_mentions
// ============================================================================

describe("find_bidirectional_mentions tool", () => {
  let tmpDir: string;
  let registry: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-link-tools-test-");
    registry = makeRegistry(makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns both directions in a single call", async () => {
    await writeFile(tmpDir, "Existing.md", "I read NewNote yesterday.");
    await writeFile(tmpDir, "NewNote.md", "Reference to Existing here.");

    const { text, isError } = await callTool(registry, "find_bidirectional_mentions", {
      newNotes: ["NewNote.md"],
      terms: ["Existing"],
    });
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as {
      existing_to_new: Array<{ note: string; newTarget: string; term: string }>;
      new_to_existing: Array<{ note: string; target: string }>;
    };
    expect(parsed.existing_to_new).toHaveLength(1);
    expect(parsed.existing_to_new[0].note).toBe("Existing.md");
    expect(parsed.existing_to_new[0].newTarget).toBe("NewNote.md");
    expect(parsed.new_to_existing).toHaveLength(1);
    expect(parsed.new_to_existing[0].note).toBe("NewNote.md");
    expect(parsed.new_to_existing[0].target).toBe("Existing");
  });

  it("rejects empty newNotes via Zod min(1)", async () => {
    const { isError } = await callTool(registry, "find_bidirectional_mentions", {
      newNotes: [],
      terms: ["Anything"],
    });
    expect(isError).toBe(true);
  });

  it("echoes scope: null when omitted", async () => {
    await writeFile(tmpDir, "NewNote.md", "Body.");
    const { text } = await callTool(registry, "find_bidirectional_mentions", {
      newNotes: ["NewNote.md"],
    });
    const parsed = JSON.parse(text) as { scope: unknown };
    expect(parsed.scope).toBeNull();
  });
});
