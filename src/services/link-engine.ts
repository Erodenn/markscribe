import path from "node:path";
import type {
  LinkEngine,
  VaultService,
  WikiLink,
  LinkGraph,
  BacklinkEntry,
  UnlinkedMention,
  BrokenLink,
  RenameResult,
} from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";

const log = createChildLog({ service: "LinkEngine" });

/**
 * Regex for wikilink extraction.
 * Matches: [[target]], [[target|display]], [[target#section]], [[target#section|display]]
 * Non-greedy to handle multiple links on one line.
 */
const WIKILINK_RE = /\[\[([^\]|#]+?)(?:#([^\]|]+?))?(?:\|([^\]]+?))?\]\]/g;

/**
 * Regex for code block detection (fenced ``` or ~~~).
 */
const CODE_FENCE_RE = /^```|^~~~/;

export class LinkEngineImpl implements LinkEngine {
  private readonly vault: VaultService;

  constructor(vaultService: VaultService) {
    this.vault = vaultService;
    log.info("LinkEngine initialized");
  }

  // =========================================================================
  // Public API (implements LinkEngine)
  // =========================================================================

  extractLinks(content: string): WikiLink[] {
    log.debug({ contentLength: content.length }, "extractLinks");
    const links: WikiLink[] = [];
    const regex = new RegExp(WIKILINK_RE.source, "g");
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const raw = match[0];
      const target = match[1].trim();
      const section = match[2]?.trim() ?? null;
      const display = match[3]?.trim() ?? null;

      // Skip empty or malformed links
      if (!target) continue;

      links.push({ raw, target, display, section });
    }

    log.debug({ linkCount: links.length }, "extractLinks complete");
    return links;
  }

  async buildGraph(scope?: string): Promise<LinkGraph> {
    log.info({ scope }, "buildGraph");
    const graph: LinkGraph = new Map();

    const files = await this.collectFiles(scope);
    const existingStems = await this.buildStemSet(files);

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
    const targetStem = this.stemFromPath(notePath);
    const backlinks: BacklinkEntry[] = [];

    const files = await this.collectFiles();

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

        const regex = new RegExp(WIKILINK_RE.source, "g");
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
          const raw = match[0];
          const target = match[1].trim();
          const section = match[2]?.trim() ?? null;
          const display = match[3]?.trim() ?? null;

          if (!target) continue;

          const linkStem = this.stemFromTarget(target);
          if (linkStem === targetStem) {
            backlinks.push({
              sourcePath: filePath,
              link: { raw, target, display, section },
              line: i + 1,
            });
          }
        }
      }
    }

    log.info({ notePath, backlinkCount: backlinks.length }, "getBacklinks complete");
    return backlinks;
  }

  async findUnlinkedMentions(notePath: string): Promise<UnlinkedMention[]> {
    log.info({ notePath }, "findUnlinkedMentions");
    const targetStem = this.stemFromPath(notePath);
    const mentions: UnlinkedMention[] = [];

    const files = await this.collectFiles();

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
        const searchRegex = new RegExp(`(?<![\\[|])\\b${this.escapeRegex(targetStem)}\\b(?![\\]|])`, "g");
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
    const existingStems = await this.buildStemSet(files);

    for (const filePath of files) {
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

        const regex = new RegExp(WIKILINK_RE.source, "g");
        let match: RegExpExecArray | null;

        while ((match = regex.exec(line)) !== null) {
          const raw = match[0];
          const target = match[1].trim();
          const section = match[2]?.trim() ?? null;
          const display = match[3]?.trim() ?? null;

          if (!target) continue;

          const stem = this.stemFromTarget(target);
          if (!existingStems.has(stem)) {
            brokenLinks.push({
              sourcePath: filePath,
              link: { raw, target, display, section },
              line: i + 1,
            });
          }
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

    const existingStems = await this.buildStemSet(files);

    for (const filePath of files) {
      const links = await this.getLinksForFile(filePath);

      for (const link of links) {
        const stem = this.stemFromTarget(link.target);
        if (!existingStems.has(stem)) continue;

        // Find the file(s) matching this stem and increment their in-degree
        for (const f of files) {
          if (this.stemFromPath(f) === stem) {
            inDegree.set(f, (inDegree.get(f) ?? 0) + 1);
          }
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

      // Replace wikilinks matching oldStem
      // We handle: [[oldStem]], [[oldStem|display]], [[oldStem#section]], [[oldStem#section|display]]
      // Also path-style: [[folder/oldStem]], [[folder/oldStem|display]], etc.
      const regex = new RegExp(WIKILINK_RE.source, "g");
      updated = updated.replace(regex, (raw, target, section, display) => {
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
        const absPath = this.vault.resolvePath(filePath);
        await this.vault.atomicWrite(absPath, updated);
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
   * Collect all vault file paths (vault-relative), optionally filtered by scope prefix.
   */
  private async collectFiles(scope?: string): Promise<string[]> {
    const files: string[] = [];
    await this.walkDirectory("", files);

    if (scope) {
      const scopePrefix = scope.endsWith("/") ? scope : scope + "/";
      return files.filter((f) => f.startsWith(scopePrefix) || f === scope);
    }

    return files;
  }

  /**
   * Recursively walk the vault directory and collect all allowed file paths.
   */
  private async walkDirectory(relDir: string, acc: string[]): Promise<void> {
    let listing;
    try {
      listing = await this.vault.listDirectory(relDir);
    } catch {
      return;
    }

    for (const entry of listing.entries) {
      if (entry.type === "directory") {
        await this.walkDirectory(entry.path, acc);
      } else {
        acc.push(entry.path);
      }
    }
  }

  /**
   * Build a Set of stems from a list of vault-relative file paths.
   */
  private async buildStemSet(files: string[]): Promise<Set<string>> {
    const stems = new Set<string>();
    for (const f of files) {
      stems.add(this.stemFromPath(f));
    }
    return stems;
  }

  /**
   * Read the raw content of a vault-relative file path. Returns null on error.
   */
  private async readFileContent(relPath: string): Promise<string | null> {
    try {
      const note = await this.vault.readNote(relPath);
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
   * Get the stem of a vault-relative path (filename without extension).
   * Example: "folder/Note Name.md" → "Note Name"
   */
  private stemFromPath(relPath: string): string {
    return path.basename(relPath, path.extname(relPath));
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
   * Escape a string for use in a regex.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Get all wikilink character ranges in a line (for exclusion in mention search).
   * Returns array of [start, end] index pairs.
   */
  private getWikilinkRanges(line: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const regex = /\[\[.*?\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
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
