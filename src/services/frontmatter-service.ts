import matter from "gray-matter";
import { escapeRegex } from "../utils.js";
import type {
  FrontmatterService,
  FileService,
  ParsedFrontmatter,
  TagOperation,
  TagResult,
} from "../types.js";
import { createChildLog } from "../markscribe-log.js";

const log = createChildLog({ service: "FrontmatterService" });

/**
 * Matches inline #tags in markdown content.
 * A valid inline tag starts with # followed by a non-space, non-# character.
 * It must be preceded by whitespace or start-of-line (not part of a heading).
 */
const INLINE_TAG_RE = /(?:^|\s)#([^\s#[\]!"'`]+)/g;

const tagRemovalRegexCache = new Map<string, RegExp>();
function getTagRemovalRegex(tag: string): RegExp {
  let re = tagRemovalRegexCache.get(tag);
  if (!re) {
    re = new RegExp(`(^|\\s)#${escapeRegex(tag)}(?=[\\s]|$)`, "gm");
    tagRemovalRegexCache.set(tag, re);
  }
  re.lastIndex = 0;
  return re;
}

export class FrontmatterServiceImpl implements FrontmatterService {
  private readonly file: FileService;

  constructor(fileService: FileService) {
    this.file = fileService;
    log.info("FrontmatterService initialized");
  }

  // =========================================================================
  // Public API (implements FrontmatterService)
  // =========================================================================

  parse(rawContent: string): ParsedFrontmatter {
    log.debug({ rawLength: rawContent.length }, "parse");
    const parsed = matter(rawContent);
    return {
      frontmatter: parsed.data as Record<string, unknown>,
      content: parsed.content,
      raw: rawContent,
    };
  }

  stringify(frontmatter: Record<string, unknown>, content: string): string {
    log.debug({ keys: Object.keys(frontmatter).length }, "stringify");

    if (Object.keys(frontmatter).length === 0) {
      return content;
    }

    return matter.stringify(content, frontmatter);
  }

  async updateFields(
    notePath: string,
    fields: Record<string, unknown>,
    merge = true,
  ): Promise<void> {
    log.info({ path: notePath, merge, fieldCount: Object.keys(fields).length }, "updateFields");

    const note = await this.file.readNote(notePath);
    const { frontmatter, content } = note;

    const updatedFrontmatter = merge ? { ...frontmatter, ...fields } : { ...fields };

    const newRaw = this.stringify(updatedFrontmatter, content);
    const fullPath = this.file.resolvePath(notePath);
    await this.file.atomicWrite(fullPath, newRaw);

    log.info({ path: notePath, merge }, "updateFields complete");
  }

  async manageTags(notePath: string, operation: TagOperation, tags?: string[]): Promise<TagResult> {
    log.info({ path: notePath, operation, tagCount: tags?.length }, "manageTags");

    const note = await this.file.readNote(notePath);
    const { frontmatter, content } = note;

    const yamlTags = this.extractYamlTags(frontmatter);
    const inlineTags = this.extractInlineTags(content);

    if (operation === "list") {
      const allTags = this.union(yamlTags, inlineTags);
      log.info({ path: notePath, tagCount: allTags.length }, "manageTags list complete");
      return { path: notePath, tags: allTags };
    }

    if (operation === "add") {
      const tagsToAdd = (tags ?? []).filter((t) => !yamlTags.includes(t));
      const newYamlTags = [...yamlTags, ...tagsToAdd];
      const updatedFrontmatter = { ...frontmatter, tags: newYamlTags };
      const newRaw = this.stringify(updatedFrontmatter, content);
      const fullPath = this.file.resolvePath(notePath);
      await this.file.atomicWrite(fullPath, newRaw);

      const allTags = this.union(newYamlTags, inlineTags);
      log.info({ path: notePath, added: tagsToAdd }, "manageTags add complete");
      return { path: notePath, tags: allTags, added: tagsToAdd };
    }

    // operation === "remove"
    const tagsToRemove = tags ?? [];
    const newYamlTags = yamlTags.filter((t) => !tagsToRemove.includes(t));
    const newContent = this.removeInlineTags(content, tagsToRemove);
    const updatedFrontmatter = { ...frontmatter, tags: newYamlTags };
    const newRaw = this.stringify(updatedFrontmatter, newContent);
    const fullPath = this.file.resolvePath(notePath);
    await this.file.atomicWrite(fullPath, newRaw);

    const remainingInline = this.extractInlineTags(newContent);
    const allTags = this.union(newYamlTags, remainingInline);
    const removed = tagsToRemove.filter((t) => yamlTags.includes(t) || inlineTags.includes(t));

    log.info({ path: notePath, removed }, "manageTags remove complete");
    return { path: notePath, tags: allTags, removed };
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private extractYamlTags(frontmatter: Record<string, unknown>): string[] {
    const raw = frontmatter["tags"];
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw.filter((t): t is string => typeof t === "string");
    }
    if (typeof raw === "string") {
      return [raw];
    }
    return [];
  }

  private extractInlineTags(content: string): string[] {
    const tags: string[] = [];
    // Reset lastIndex before each use since we use global flag
    INLINE_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_TAG_RE.exec(content)) !== null) {
      tags.push(match[1]);
    }
    return tags;
  }

  /**
   * Remove inline #tag occurrences from content for each tag in tagsToRemove.
   * Only removes the tag token, not surrounding whitespace or text.
   */
  private removeInlineTags(content: string, tagsToRemove: string[]): string {
    if (tagsToRemove.length === 0) return content;

    let result = content;
    for (const tag of tagsToRemove) {
      const re = getTagRemovalRegex(tag);
      result = result.replace(re, (_, prefix: string) => prefix);
    }
    return result;
  }

  /** Merge two tag arrays, deduplicating while preserving order. */
  private union(a: string[], b: string[]): string[] {
    const seen = new Set(a);
    const result = [...a];
    for (const tag of b) {
      if (!seen.has(tag)) {
        seen.add(tag);
        result.push(tag);
      }
    }
    return result;
  }
}
