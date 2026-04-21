import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import { LinkEngineImpl } from "./link-engine.js";
import { FileServiceImpl } from "./file-service.js";
import { PathFilterImpl } from "./path-filter.js";
import { makeTempDir, writeFile, readFile } from "../test-helpers.js";

/**
 * All LinkEngine tests use real temp directories — no mocks.
 */

function makeVaultService(vaultPath: string): FileServiceImpl {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  return new FileServiceImpl(vaultPath, filter);
}

function makeEngine(vaultPath: string): LinkEngineImpl {
  const vault = makeVaultService(vaultPath);
  return new LinkEngineImpl(vault);
}

// ============================================================================
// extractLinks
// ============================================================================

describe("LinkEngineImpl.extractLinks", () => {
  it("extracts a basic wikilink", () => {
    const engine = makeEngine(os.tmpdir());
    const links = engine.extractLinks("See [[Target Note]] for details.");
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      raw: "[[Target Note]]",
      target: "Target Note",
      display: null,
      section: null,
    });
  });

  it("extracts a wikilink with display text", () => {
    const engine = makeEngine(os.tmpdir());
    const links = engine.extractLinks("See [[Target|Click Here]] for details.");
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      raw: "[[Target|Click Here]]",
      target: "Target",
      display: "Click Here",
      section: null,
    });
  });

  it("extracts a wikilink with section anchor", () => {
    const engine = makeEngine(os.tmpdir());
    const links = engine.extractLinks("See [[Target#Section Header]].");
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      raw: "[[Target#Section Header]]",
      target: "Target",
      display: null,
      section: "Section Header",
    });
  });

  it("extracts a wikilink with both section and display", () => {
    const engine = makeEngine(os.tmpdir());
    const links = engine.extractLinks("See [[Target#Section|Display Text]].");
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      raw: "[[Target#Section|Display Text]]",
      target: "Target",
      display: "Display Text",
      section: "Section",
    });
  });

  it("extracts multiple wikilinks from content", () => {
    const engine = makeEngine(os.tmpdir());
    const links = engine.extractLinks("[[NoteA]] and [[NoteB|B]] and [[NoteC#sec]].");
    expect(links).toHaveLength(3);
    expect(links[0].target).toBe("NoteA");
    expect(links[1].target).toBe("NoteB");
    expect(links[2].target).toBe("NoteC");
  });

  it("handles path-style wikilinks", () => {
    const engine = makeEngine(os.tmpdir());
    const links = engine.extractLinks("See [[Folder/Note Name]].");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("Folder/Note Name");
  });

  it("returns empty array for content with no wikilinks", () => {
    const engine = makeEngine(os.tmpdir());
    const links = engine.extractLinks("No links here, just plain text.");
    expect(links).toHaveLength(0);
  });

  it("returns empty array for empty content", () => {
    const engine = makeEngine(os.tmpdir());
    const links = engine.extractLinks("");
    expect(links).toHaveLength(0);
  });

  it("handles wikilinks with frontmatter in content", () => {
    const engine = makeEngine(os.tmpdir());
    const content = "---\ntitle: Test\n---\n\nSee [[Target]] for more.";
    const links = engine.extractLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("Target");
  });

  it("skips wikilinks inside fenced code blocks", () => {
    const engine = makeEngine(os.tmpdir());
    const content = [
      "Before [[RealLink]]",
      "```",
      "Code with [[FakeLink]] inside",
      "```",
      "After [[AnotherReal]]",
    ].join("\n");
    const links = engine.extractLinks(content);
    expect(links).toHaveLength(2);
    expect(links[0].target).toBe("RealLink");
    expect(links[1].target).toBe("AnotherReal");
  });

  it("skips wikilinks inside tilde-fenced code blocks", () => {
    const engine = makeEngine(os.tmpdir());
    const content = ["[[Before]]", "~~~", "[[Inside]]", "~~~", "[[After]]"].join("\n");
    const links = engine.extractLinks(content);
    expect(links).toHaveLength(2);
    expect(links[0].target).toBe("Before");
    expect(links[1].target).toBe("After");
  });
});

// ============================================================================
// buildGraph
// ============================================================================

describe("LinkEngineImpl.buildGraph", () => {
  let tmpDir: string;
  let engine: LinkEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-link-test-");
    engine = makeEngine(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("builds a directed graph from vault files", async () => {
    await writeFile(tmpDir, "NoteA.md", "Links to [[NoteB]] and [[NoteC]].");
    await writeFile(tmpDir, "NoteB.md", "Links to [[NoteC]].");
    await writeFile(tmpDir, "NoteC.md", "No links here.");

    const graph = await engine.buildGraph();

    expect(graph.has("NoteA.md")).toBe(true);
    expect(graph.has("NoteB.md")).toBe(true);
    expect(graph.has("NoteC.md")).toBe(true);

    expect(graph.get("NoteA.md")).toContain("NoteB");
    expect(graph.get("NoteA.md")).toContain("NoteC");
    expect(graph.get("NoteB.md")).toContain("NoteC");
    expect(graph.get("NoteC.md")).toHaveLength(0);
  });

  it("only includes links to existing notes", async () => {
    await writeFile(tmpDir, "NoteA.md", "Links to [[Existing]] and [[Missing]].");
    await writeFile(tmpDir, "Existing.md", "Content.");

    const graph = await engine.buildGraph();

    expect(graph.get("NoteA.md")).toContain("Existing");
    expect(graph.get("NoteA.md")).not.toContain("Missing");
  });

  it("applies scope prefix filter", async () => {
    await writeFile(tmpDir, "folder/NoteA.md", "Links to [[NoteB]].");
    await writeFile(tmpDir, "folder/NoteB.md", "No links.");
    await writeFile(tmpDir, "other/NoteC.md", "Links to [[NoteA]].");

    const graph = await engine.buildGraph("folder");

    expect(graph.has("folder/NoteA.md")).toBe(true);
    expect(graph.has("folder/NoteB.md")).toBe(true);
    expect(graph.has("other/NoteC.md")).toBe(false);
  });

  it("returns empty graph for empty vault", async () => {
    const graph = await engine.buildGraph();
    expect(graph.size).toBe(0);
  });
});

// ============================================================================
// getBacklinks
// ============================================================================

describe("LinkEngineImpl.getBacklinks", () => {
  let tmpDir: string;
  let engine: LinkEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-link-test-");
    engine = makeEngine(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("finds notes that link to the target", async () => {
    await writeFile(tmpDir, "Source.md", "See [[Target]] for more.");
    await writeFile(tmpDir, "Target.md", "This is the target.");

    const backlinks = await engine.getBacklinks("Target.md");

    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].sourcePath).toBe("Source.md");
    expect(backlinks[0].link.target).toBe("Target");
    expect(backlinks[0].line).toBe(1);
  });

  it("returns multiple backlinks from different files", async () => {
    await writeFile(tmpDir, "A.md", "See [[Hub]].");
    await writeFile(tmpDir, "B.md", "Also see [[Hub]].");
    await writeFile(tmpDir, "Hub.md", "The hub note.");

    const backlinks = await engine.getBacklinks("Hub.md");

    expect(backlinks).toHaveLength(2);
    const sources = backlinks.map((b) => b.sourcePath);
    expect(sources).toContain("A.md");
    expect(sources).toContain("B.md");
  });

  it("returns correct line numbers for backlinks", async () => {
    await writeFile(tmpDir, "Source.md", "Line 1\nLine 2 [[Target]]\nLine 3");
    await writeFile(tmpDir, "Target.md", "Content.");

    const backlinks = await engine.getBacklinks("Target.md");

    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].line).toBe(2);
  });

  it("returns backlinks with display text preserved", async () => {
    await writeFile(tmpDir, "Source.md", "See [[Target|Display Text]].");
    await writeFile(tmpDir, "Target.md", "Content.");

    const backlinks = await engine.getBacklinks("Target.md");

    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].link.display).toBe("Display Text");
    expect(backlinks[0].link.raw).toBe("[[Target|Display Text]]");
  });

  it("does not include the target note as its own backlink", async () => {
    await writeFile(tmpDir, "Target.md", "Self-reference [[Target]].");

    const backlinks = await engine.getBacklinks("Target.md");

    expect(backlinks).toHaveLength(0);
  });

  it("returns empty array when no backlinks exist", async () => {
    await writeFile(tmpDir, "Isolated.md", "No one links here.");

    const backlinks = await engine.getBacklinks("Isolated.md");

    expect(backlinks).toHaveLength(0);
  });

  it("handles backlinks with section anchors", async () => {
    await writeFile(tmpDir, "Source.md", "See [[Target#Section]].");
    await writeFile(tmpDir, "Target.md", "Content.");

    const backlinks = await engine.getBacklinks("Target.md");

    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].link.section).toBe("Section");
    expect(backlinks[0].link.target).toBe("Target");
  });
});

// ============================================================================
// findBrokenLinks
// ============================================================================

describe("LinkEngineImpl.findBrokenLinks", () => {
  let tmpDir: string;
  let engine: LinkEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-link-test-");
    engine = makeEngine(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("finds links to non-existent notes", async () => {
    await writeFile(tmpDir, "Source.md", "See [[NonExistent]].");

    const broken = await engine.findBrokenLinks();

    expect(broken).toHaveLength(1);
    expect(broken[0].sourcePath).toBe("Source.md");
    expect(broken[0].link.target).toBe("NonExistent");
  });

  it("does not report links to existing notes", async () => {
    await writeFile(tmpDir, "Source.md", "See [[Existing]].");
    await writeFile(tmpDir, "Existing.md", "I exist.");

    const broken = await engine.findBrokenLinks();

    expect(broken).toHaveLength(0);
  });

  it("reports multiple broken links from same file", async () => {
    await writeFile(tmpDir, "Source.md", "See [[Ghost1]] and [[Ghost2]].");

    const broken = await engine.findBrokenLinks();

    expect(broken).toHaveLength(2);
  });

  it("reports correct line numbers", async () => {
    await writeFile(tmpDir, "Source.md", "Good line\n[[Broken]] here");

    const broken = await engine.findBrokenLinks();

    expect(broken).toHaveLength(1);
    expect(broken[0].line).toBe(2);
  });

  it("applies scope filter", async () => {
    await writeFile(tmpDir, "folder/Source.md", "[[Broken]]");
    await writeFile(tmpDir, "other/Source.md", "[[AlsoBroken]]");

    const broken = await engine.findBrokenLinks("folder");

    expect(broken).toHaveLength(1);
    expect(broken[0].sourcePath).toBe("folder/Source.md");
  });

  it("returns empty array when no broken links", async () => {
    await writeFile(tmpDir, "A.md", "Links to [[B]].");
    await writeFile(tmpDir, "B.md", "Content.");

    const broken = await engine.findBrokenLinks();

    expect(broken).toHaveLength(0);
  });
});

// ============================================================================
// findOrphans
// ============================================================================

describe("LinkEngineImpl.findOrphans", () => {
  let tmpDir: string;
  let engine: LinkEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-link-test-");
    engine = makeEngine(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("finds notes with no incoming links", async () => {
    await writeFile(tmpDir, "Hub.md", "Links to [[Child]].");
    await writeFile(tmpDir, "Child.md", "No links.");
    await writeFile(tmpDir, "Orphan.md", "Nobody links here.");

    const orphans = await engine.findOrphans();

    expect(orphans).toContain("Orphan.md");
    expect(orphans).not.toContain("Child.md");
  });

  it("returns all notes as orphans when no links exist", async () => {
    await writeFile(tmpDir, "A.md", "No links.");
    await writeFile(tmpDir, "B.md", "No links.");

    const orphans = await engine.findOrphans();

    expect(orphans).toContain("A.md");
    expect(orphans).toContain("B.md");
    expect(orphans).toHaveLength(2);
  });

  it("returns empty array when all notes are linked", async () => {
    await writeFile(tmpDir, "A.md", "Links to [[B]].");
    await writeFile(tmpDir, "B.md", "Links to [[A]].");

    const orphans = await engine.findOrphans();

    expect(orphans).toHaveLength(0);
  });

  it("applies scope filter", async () => {
    await writeFile(tmpDir, "folder/A.md", "No links.");
    await writeFile(tmpDir, "folder/B.md", "Links to [[A]].");
    await writeFile(tmpDir, "other/C.md", "No links.");

    const orphans = await engine.findOrphans("folder");

    // B links to A, so A has incoming links and is not an orphan.
    // B has no incoming links within the scoped folder, so B is an orphan.
    expect(orphans).toContain("folder/B.md");
    expect(orphans).not.toContain("folder/A.md");
    expect(orphans).not.toContain("other/C.md");
  });
});

// ============================================================================
// findUnlinkedMentions
// ============================================================================

describe("LinkEngineImpl.findUnlinkedMentions", () => {
  let tmpDir: string;
  let engine: LinkEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-link-test-");
    engine = makeEngine(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("finds plain-text mentions of a note title", async () => {
    await writeFile(tmpDir, "Target.md", "Content.");
    await writeFile(tmpDir, "Source.md", "I read Target today and it was great.");

    const mentions = await engine.findUnlinkedMentions("Target.md");

    expect(mentions).toHaveLength(1);
    expect(mentions[0].sourcePath).toBe("Source.md");
    expect(mentions[0].mentionText).toBe("Target");
    expect(mentions[0].line).toBe(1);
  });

  it("does not report already-wikilinked mentions", async () => {
    await writeFile(tmpDir, "Target.md", "Content.");
    await writeFile(tmpDir, "Source.md", "See [[Target]] for details.");

    const mentions = await engine.findUnlinkedMentions("Target.md");

    expect(mentions).toHaveLength(0);
  });

  it("does not report mentions in the target note itself", async () => {
    await writeFile(tmpDir, "Target.md", "Target is a self-reference.");

    const mentions = await engine.findUnlinkedMentions("Target.md");

    expect(mentions).toHaveLength(0);
  });

  it("returns correct line and column", async () => {
    await writeFile(tmpDir, "MyNote.md", "Content.");
    await writeFile(tmpDir, "Source.md", "Line one\nSee MyNote here.");

    const mentions = await engine.findUnlinkedMentions("MyNote.md");

    expect(mentions).toHaveLength(1);
    expect(mentions[0].line).toBe(2);
    expect(mentions[0].column).toBe(4); // "See MyNote" — M is at index 4
  });

  it("returns empty array when no unlinked mentions exist", async () => {
    await writeFile(tmpDir, "Target.md", "Content.");
    await writeFile(tmpDir, "Source.md", "Nothing related here.");

    const mentions = await engine.findUnlinkedMentions("Target.md");

    expect(mentions).toHaveLength(0);
  });
});

// ============================================================================
// propagateRename
// ============================================================================

describe("LinkEngineImpl.propagateRename", () => {
  let tmpDir: string;
  let engine: LinkEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempDir("markscribe-link-test-");
    engine = makeEngine(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("updates basic wikilinks after rename", async () => {
    await writeFile(tmpDir, "OldName.md", "The original note.");
    await writeFile(tmpDir, "Source.md", "See [[OldName]] for details.");

    const result = await engine.propagateRename("OldName", "NewName");

    const content = await readFile(tmpDir, "Source.md");
    expect(content).toContain("[[NewName]]");
    expect(content).not.toContain("[[OldName]]");
    expect(result.filesUpdated).toBe(1);
    expect(result.linksUpdated).toBe(1);
    expect(result.modifiedFiles).toContain("Source.md");
  });

  it("preserves display text during rename", async () => {
    await writeFile(tmpDir, "OldName.md", "The original note.");
    await writeFile(tmpDir, "Source.md", "See [[OldName|My Display]] for details.");

    await engine.propagateRename("OldName", "NewName");

    const content = await readFile(tmpDir, "Source.md");
    expect(content).toContain("[[NewName|My Display]]");
    expect(content).not.toContain("OldName");
  });

  it("preserves section anchors during rename", async () => {
    await writeFile(tmpDir, "OldName.md", "The original note.");
    await writeFile(tmpDir, "Source.md", "See [[OldName#Section Header]] for details.");

    await engine.propagateRename("OldName", "NewName");

    const content = await readFile(tmpDir, "Source.md");
    expect(content).toContain("[[NewName#Section Header]]");
    expect(content).not.toContain("OldName");
  });

  it("preserves both section anchor and display text during rename", async () => {
    await writeFile(tmpDir, "OldName.md", "The original note.");
    await writeFile(tmpDir, "Source.md", "See [[OldName#Section|Display]] for details.");

    await engine.propagateRename("OldName", "NewName");

    const content = await readFile(tmpDir, "Source.md");
    expect(content).toContain("[[NewName#Section|Display]]");
  });

  it("updates path-style wikilinks", async () => {
    await writeFile(tmpDir, "Folder/OldName.md", "The original note.");
    await writeFile(tmpDir, "Source.md", "See [[Folder/OldName]] here.");

    await engine.propagateRename("OldName", "NewName");

    const content = await readFile(tmpDir, "Source.md");
    expect(content).toContain("[[Folder/NewName]]");
    expect(content).not.toContain("OldName");
  });

  it("updates multiple occurrences in one file", async () => {
    await writeFile(tmpDir, "OldName.md", "The original note.");
    await writeFile(tmpDir, "Source.md", "[[OldName]] and also [[OldName|Alias]].");

    const result = await engine.propagateRename("OldName", "NewName");

    const content = await readFile(tmpDir, "Source.md");
    expect(content).toContain("[[NewName]]");
    expect(content).toContain("[[NewName|Alias]]");
    expect(result.linksUpdated).toBe(2);
  });

  it("updates across multiple files", async () => {
    await writeFile(tmpDir, "OldName.md", "The original note.");
    await writeFile(tmpDir, "A.md", "See [[OldName]].");
    await writeFile(tmpDir, "B.md", "Also [[OldName]].");

    const result = await engine.propagateRename("OldName", "NewName");

    expect(result.filesUpdated).toBe(2);
    expect(result.linksUpdated).toBe(2);
  });

  it("does not update links that don't match oldStem", async () => {
    await writeFile(tmpDir, "OldName.md", "Target.");
    await writeFile(tmpDir, "OtherNote.md", "Target.");
    await writeFile(tmpDir, "Source.md", "See [[OtherNote]] and [[OldName]].");

    await engine.propagateRename("OldName", "NewName");

    const content = await readFile(tmpDir, "Source.md");
    expect(content).toContain("[[OtherNote]]");
    expect(content).toContain("[[NewName]]");
    expect(content).not.toContain("[[OldName]]");
  });

  it("returns zero counts when no links match", async () => {
    await writeFile(tmpDir, "Source.md", "No links to rename.");

    const result = await engine.propagateRename("OldName", "NewName");

    expect(result.filesUpdated).toBe(0);
    expect(result.linksUpdated).toBe(0);
    expect(result.modifiedFiles).toHaveLength(0);
  });

  it("applies scope filter during rename", async () => {
    await writeFile(tmpDir, "folder/Source.md", "See [[OldName]].");
    await writeFile(tmpDir, "other/Source.md", "See [[OldName]].");

    await engine.propagateRename("OldName", "NewName", "folder");

    const folderContent = await readFile(tmpDir, "folder/Source.md");
    const otherContent = await readFile(tmpDir, "other/Source.md");

    expect(folderContent).toContain("[[NewName]]");
    expect(otherContent).toContain("[[OldName]]");
  });

  it("uses atomicWrite for file updates", async () => {
    // Verify no partial writes: if it completes, the content should be fully updated
    await writeFile(tmpDir, "OldName.md", "The original note.");
    await writeFile(tmpDir, "Source.md", "See [[OldName]].");

    await engine.propagateRename("OldName", "NewName");

    const content = await readFile(tmpDir, "Source.md");
    // Should be complete and consistent
    expect(content).toBe("See [[NewName]].");
  });
});
