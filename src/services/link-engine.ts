import type {
  LinkEngine,
  FileService,
  WikiLink,
  LinkGraph,
  BacklinkEntry,
  UnlinkedMention,
  BrokenLink,
  RenameResult,
} from "../types.js";
import { createChildLog } from "../markscribe-log.js";
import { escapeRegex, getStem, walkFiles, scanWikilinks, WIKILINK_RE, CODE_FENCE_RE } from "../utils.js";

const log = createChildLog({ service: "LinkEngine" });

const WIKILINK_RANGE_RE = /\[\[.*?\]\]/g;

export class LinkEngineImpl implements LinkEngine {
  private readonly file: FileService;

  constructor(fileService: FileService) {
    this.file = fileService;
    log.info("LinkEngine initialized");
  }

  // =========================================================================
  // Public API (implements LinkEngine)
  // =========================================================================

  extractLinks(content: string): WikiLink[] {
    log.debug({ contentLength: content.length }, "extractLinks");
    const links: WikiLink[] = [];
    for (const scanned of scanWikilinks(content)) {
      links.push({
        raw: scanned.raw,
        target: scanned.target,
        display: scanned.display,
        section: scanned.section,
      });
    }
    log.debug({ linkCount: links.length }, "extractLinks complete");
    return links;
  }

  async buildGraph(scope?: string): Promise<LinkGraph> {
    log.info({ scope }, "buildGraph");
    const graph: LinkGraph = new Map();

    const files = await this.collectFiles(scope);
    const existingStems = this.buildStemSet(files);

    for (const filePath of files) {
      const links = await this.getLinksForFile(filePath);
      const resolvedTargets: string[] = [];

      for (const link of links) {
        const stem = this.stemFromTarget(link.target);
        if (existingStems.has(stem)) {
          resolvedTargets.push(stem);
        }
      }

      graph.set(filePath, resolvedTargets);
    }

    log.info({ fileCount: files.length, graphSize: graph.size }, "buildGraph complete");
    return graph;
  }

  async getBacklinks(notePath: string): Promise<BacklinkEntry[]> {
    log.info({ notePath }, "getBacklinks");
    const targetStem = getStem(notePath);
    const backlinks: BacklinkEntry[] = [];

    const files = await this.collectFiles();

    for (const filePath of files) {
      if (filePath === notePath) continue;

      const content = await this.readFileContent(filePath);
      if (!content) continue;

      for (const scanned of scanWikilinks(content)) {
        const linkStem = this.stemFromTarget(scanned.target);
        if (linkStem === targetStem) {
          backlinks.push({
            sourcePath: filePath,
            link: { raw: scanned.raw, target: scanned.target, display: scanned.display, section: scanned.section },
            line: scanned.line,
          });
        }
      }
    }

    log.info({ notePath, backlinkCount: backlinks.length }, "getBacklinks complete");
    return backlinks;
  }

  async findUnlinkedMentions(notePath: string): Promise<UnlinkedMention[]> {
    log.info({ notePath }, "findUnlinkedMentions");
    const targetStem = getStem(notePath);
    const mentions: UnlinkedMention[] = [];

    const files = await this.collectFiles();

    const searchRegex = new RegExp(
      `(?<![\\[|])\\b${escapeRegex(targetStem)}\\b(?![\\]|])`,
      "g",
    );

    for (const filePath of files) {
      if (filePath === notePath) continue;

      const content = await this.readFileContent(filePath);
      if (!content) continue;

      const lines = content.split("\n");
      let inCodeBlock = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (CODE_FENCE_RE.test(line.trim())) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (inCodeBlock) continue;

        // Find all wikilink ranges on this line to skip over them
        const wikilinkRanges = this.getWikilinkRanges(line);

        // Search for plain-text occurrences of the stem
        searchRegex.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = searchRegex.exec(line)) !== null) {
          const col = match.index;

          // Skip if this occurrence is inside a wikilink
          if (this.isInsideWikilink(col, match[0].length, wikilinkRanges)) continue;

          mentions.push({
            sourcePath: filePath,
            mentionText: match[0],
            line: i + 1,
            column: col,
          });
        }
      }
    }

    log.info({ notePath, mentionCount: mentions.length }, "findUnlinkedMentions complete");
    return mentions;
  }

  async findBrokenLinks(scope?: string): Promise<BrokenLink[]> {
    log.info({ scope }, "findBrokenLinks");
    const brokenLinks: BrokenLink[] = [];

    const files = await this.collectFiles(scope);
    const existingStems = this.buildStemSet(files);

    for (const filePath of files) {
      const content = await this.readFileContent(filePath);
      if (!content) continue;

      for (const scanned of scanWikilinks(content)) {
        const stem = this.stemFromTarget(scanned.target);
        if (!existingStems.has(stem)) {
          brokenLinks.push({
            sourcePath: filePath,
            link: { raw: scanned.raw, target: scanned.target, display: scanned.display, section: scanned.section },
            line: scanned.line,
          });
        }
      }
    }

    log.info({ scope, brokenCount: brokenLinks.length }, "findBrokenLinks complete");
    return brokenLinks;
  }

  async findOrphans(scope?: string): Promise<string[]> {
    log.info({ scope }, "findOrphans");

    const files = await this.collectFiles(scope);

    // Build in-degree map
    const inDegree = new Map<string, number>();
    for (const f of files) {
      inDegree.set(f, 0);
    }

    // Map each stem to the file paths that share it (for O(1) lookup)
    const stemToFiles = new Map<string, string[]>();
    for (const f of files) {
      const stem = getStem(f);
      const existing = stemToFiles.get(stem);
      if (existing) {
        existing.push(f);
      } else {
        stemToFiles.set(stem, [f]);
      }
    }

    for (const filePath of files) {
      const links = await this.getLinksForFile(filePath);

      for (const link of links) {
        const stem = this.stemFromTarget(link.target);
        const targets = stemToFiles.get(stem);
        if (!targets) continue;

        for (const f of targets) {
          inDegree.set(f, (inDegree.get(f) ?? 0) + 1);
        }
      }
    }

    const orphans = files.filter((f) => (inDegree.get(f) ?? 0) === 0);
    log.info({ scope, orphanCount: orphans.length }, "findOrphans complete");
    return orphans;
  }

  async propagateRename(oldStem: string, newStem: string, scope?: string): Promise<RenameResult> {
    log.info({ oldStem, newStem, scope }, "propagateRename");

    const files = await this.collectFiles(scope);
    let filesUpdated = 0;
    let linksUpdated = 0;
    const modifiedFiles: string[] = [];

    for (const filePath of files) {
      const content = await this.readFileContent(filePath);
      if (!content) continue;

      let updated = content;
      let fileChanged = false;
      let fileLinksUpdated = 0;

      // We handle: [[oldStem]], [[oldStem|display]], [[oldStem#section]], [[oldStem#section|display]]
      // Also path-style: [[folder/oldStem]], [[folder/oldStem|display]], etc.
      updated = updated.replace(WIKILINK_RE, (raw, target, section, display) => {
        const trimmedTarget = target.trim();
        const linkStem = this.stemFromTarget(trimmedTarget);

        if (linkStem !== oldStem) return raw;

        // Build updated target: preserve folder prefix if path-style
        let newTarget: string;
        if (trimmedTarget.includes("/")) {
          const prefix = trimmedTarget.slice(0, trimmedTarget.lastIndexOf("/") + 1);
          newTarget = prefix + newStem;
        } else {
          newTarget = newStem;
        }

        // Reconstruct the wikilink preserving section and display
        let rebuilt = `[[${newTarget}`;
        if (section) rebuilt += `#${section}`;
        if (display) rebuilt += `|${display}`;
        rebuilt += "]]";

        fileChanged = true;
        fileLinksUpdated++;
        return rebuilt;
      });

      if (fileChanged) {
        const absPath = this.file.resolvePath(filePath);
        await this.file.atomicWrite(absPath, updated);
        filesUpdated++;
        linksUpdated += fileLinksUpdated;
        modifiedFiles.push(filePath);
      }
    }

    log.info({ oldStem, newStem, filesUpdated, linksUpdated }, "propagateRename complete");
    return { filesUpdated, linksUpdated, modifiedFiles };
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Collect all root-relative file paths, optionally filtered by scope prefix.
   */
  private async collectFiles(scope?: string): Promise<string[]> {
    return walkFiles(this.file, scope);
  }

  /**
   * Build a Set of stems from a list of root-relative file paths.
   */
  private buildStemSet(files: string[]): Set<string> {
    const stems = new Set<string>();
    for (const f of files) {
      stems.add(getStem(f));
    }
    return stems;
  }

  /**
   * Read the raw content of a root-relative file path. Returns null on error.
   */
  private async readFileContent(relPath: string): Promise<string | null> {
    try {
      const note = await this.file.readNote(relPath);
      return note.raw;
    } catch {
      return null;
    }
  }

  /**
   * Extract wikilinks from a file and return them.
   */
  private async getLinksForFile(filePath: string): Promise<WikiLink[]> {
    const content = await this.readFileContent(filePath);
    if (!content) return [];
    return this.extractLinks(content);
  }

  /**
   * Get the stem from a wikilink target.
   * Handles path-style targets: "folder/Note Name" → "Note Name"
   * Handles plain targets: "Note Name" → "Note Name"
   */
  private stemFromTarget(target: string): string {
    const basename = target.includes("/") ? target.split("/").pop()! : target;
    return basename.trim();
  }


  /**
   * Get all wikilink character ranges in a line (for exclusion in mention search).
   * Returns array of [start, end] index pairs.
   */
  private getWikilinkRanges(line: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    WIKILINK_RANGE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKILINK_RANGE_RE.exec(line)) !== null) {
      ranges.push([match.index, match.index + match[0].length]);
    }
    return ranges;
  }

  /**
   * Check if a text occurrence at [col, col+len) overlaps any wikilink range.
   */
  private isInsideWikilink(col: number, len: number, ranges: Array<[number, number]>): boolean {
    for (const [start, end] of ranges) {
      if (col >= start && col + len <= end) return true;
    }
    return false;
  }
}
