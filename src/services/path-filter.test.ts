import { describe, it, expect, beforeEach } from "vitest";
import { PathFilterImpl } from "./path-filter.js";
import type { PathFilterConfig } from "../types.js";

function makeFilter(overrides: Partial<PathFilterConfig> = {}): PathFilterImpl {
  return new PathFilterImpl({
    blockedPaths: [],
    allowedExtensions: [],
    ...overrides,
  });
}

describe("PathFilterImpl", () => {
  describe("isAllowed", () => {
    let filter: PathFilterImpl;

    beforeEach(() => {
      filter = makeFilter();
    });

    it("allows a plain markdown file", () => {
      expect(filter.isAllowed("notes/hello.md")).toBe(true);
    });

    it("allows .markdown extension", () => {
      expect(filter.isAllowed("notes/hello.markdown")).toBe(true);
    });

    it("allows .txt extension", () => {
      expect(filter.isAllowed("notes/hello.txt")).toBe(true);
    });

    it("blocks files with disallowed extensions", () => {
      expect(filter.isAllowed("notes/script.js")).toBe(false);
      expect(filter.isAllowed("notes/image.png")).toBe(false);
      expect(filter.isAllowed("config.yaml")).toBe(false);
    });

    it("blocks .obsidian/ paths", () => {
      expect(filter.isAllowed(".obsidian/config.md")).toBe(false);
      expect(filter.isAllowed(".obsidian/plugins/my-plugin/data.md")).toBe(false);
    });

    it("blocks .git/ paths", () => {
      expect(filter.isAllowed(".git/config")).toBe(false);
      expect(filter.isAllowed(".git/COMMIT_EDITMSG")).toBe(false);
    });

    it("blocks node_modules/ paths", () => {
      expect(filter.isAllowed("node_modules/package/index.md")).toBe(false);
    });

    it("blocks .DS_Store", () => {
      expect(filter.isAllowed(".DS_Store")).toBe(false);
      expect(filter.isAllowed("folder/.DS_Store")).toBe(false);
    });

    it("blocks Thumbs.db", () => {
      expect(filter.isAllowed("Thumbs.db")).toBe(false);
      expect(filter.isAllowed("folder/Thumbs.db")).toBe(false);
    });

    it("blocks path traversal with ../", () => {
      expect(filter.isAllowed("../secrets.md")).toBe(false);
      expect(filter.isAllowed("notes/../../../etc/passwd")).toBe(false);
    });

    it("blocks deeply nested blocked paths", () => {
      expect(filter.isAllowed("projects/code/.git/config")).toBe(false);
      expect(filter.isAllowed("area/sub/.obsidian/workspace.md")).toBe(false);
    });

    it("is case-sensitive for blocked names", () => {
      // On case-sensitive systems, .Obsidian is different from .obsidian
      // The defaults only block exactly .obsidian, .git, node_modules
      expect(filter.isAllowed(".obsidian/config.md")).toBe(false);
    });

    it("respects custom blocked paths from config", () => {
      const customFilter = makeFilter({ blockedPaths: ["_private", "archive"] });
      expect(customFilter.isAllowed("_private/note.md")).toBe(false);
      expect(customFilter.isAllowed("archive/old.md")).toBe(false);
      expect(customFilter.isAllowed("notes/note.md")).toBe(true);
    });

    it("respects custom allowed extensions", () => {
      const customFilter = makeFilter({ allowedExtensions: [".md", ".json"] });
      expect(customFilter.isAllowed("notes/data.json")).toBe(true);
      expect(customFilter.isAllowed("notes/data.txt")).toBe(false);
    });

    it("immutable defaults cannot be overridden by config", () => {
      // Even if someone passes empty blockedPaths, the defaults still apply
      const customFilter = makeFilter({ blockedPaths: [] });
      expect(customFilter.isAllowed(".obsidian/workspace.md")).toBe(false);
      expect(customFilter.isAllowed(".git/index")).toBe(false);
      expect(customFilter.isAllowed("node_modules/foo/bar.md")).toBe(false);
    });

    it("extension check is case-insensitive", () => {
      expect(filter.isAllowed("notes/Note.MD")).toBe(true);
      expect(filter.isAllowed("notes/Note.Md")).toBe(true);
    });
  });

  describe("isAllowedForListing", () => {
    let filter: PathFilterImpl;

    beforeEach(() => {
      filter = makeFilter();
    });

    it("allows listing of a regular directory", () => {
      expect(filter.isAllowedForListing("notes")).toBe(true);
      expect(filter.isAllowedForListing("projects/my-project")).toBe(true);
    });

    it("blocks listing of .obsidian/", () => {
      expect(filter.isAllowedForListing(".obsidian")).toBe(false);
      expect(filter.isAllowedForListing(".obsidian/plugins")).toBe(false);
    });

    it("blocks listing of .git/", () => {
      expect(filter.isAllowedForListing(".git")).toBe(false);
    });

    it("blocks listing of node_modules/", () => {
      expect(filter.isAllowedForListing("node_modules")).toBe(false);
    });

    it("does NOT check extension for listing — allows directories without extensions", () => {
      // A folder named 'archive' has no extension, but should be listable
      expect(filter.isAllowedForListing("archive")).toBe(true);
    });

    it("does NOT check extension — a .json path in a normal folder is listable", () => {
      expect(filter.isAllowedForListing("config/settings.json")).toBe(true);
    });

    it("blocks path traversal in listing", () => {
      expect(filter.isAllowedForListing("../secrets")).toBe(false);
    });

    it("blocks nested blocked paths for listing", () => {
      expect(filter.isAllowedForListing("projects/.git")).toBe(false);
    });

    it("respects custom blocked paths for listing", () => {
      const customFilter = makeFilter({ blockedPaths: ["_archive"] });
      expect(customFilter.isAllowedForListing("_archive")).toBe(false);
      expect(customFilter.isAllowedForListing("notes")).toBe(true);
    });

    it("immutable defaults cannot be removed by config for listing", () => {
      const customFilter = makeFilter({ blockedPaths: [] });
      expect(customFilter.isAllowedForListing(".obsidian")).toBe(false);
      expect(customFilter.isAllowedForListing(".git")).toBe(false);
    });
  });
});
