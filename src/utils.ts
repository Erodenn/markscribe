import path from "node:path";
import type { FileService, SchemaCondition, TemplateContext } from "./types.js";

/** Escape a string for safe use inside a RegExp constructor. */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// Stem extraction
// ============================================================================

/**
 * Get the canonical stem from a filename: strip extension and leading underscore.
 * Example: "_Topic.md" → "Topic", "Note.md" → "Note"
 */
export function getStem(filename: string): string {
  const base = path.basename(filename, path.extname(filename));
  return base.startsWith("_") ? base.slice(1) : base;
}

// ============================================================================
// Template variable expansion
// ============================================================================

const TEMPLATE_VAR_RE = /\{\{(stem|filename|folderName|today)\}\}/g;

export function expandTemplateVars(template: string, ctx: TemplateContext): string {
  TEMPLATE_VAR_RE.lastIndex = 0;
  return template.replace(TEMPLATE_VAR_RE, (_, key: string) => {
    switch (key) {
      case "stem":
        return ctx.stem;
      case "filename":
        return ctx.filename;
      case "folderName":
        return ctx.folderName;
      case "today":
        return ctx.today;
      default:
        return _;
    }
  });
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function buildTemplateContext(notePath: string): TemplateContext {
  const normalized = normalizePath(notePath);
  const basename = path.basename(normalized);
  const filename = path.basename(basename, path.extname(basename));
  const stem = filename.startsWith("_") ? filename.slice(1) : filename;
  const folderName = path.basename(path.dirname(normalized));
  const today = new Date().toISOString().slice(0, 10);

  return { stem, filename, folderName, today };
}

// ============================================================================
// Schema condition evaluation (pure function)
// ============================================================================

export function evalCondition(condition: SchemaCondition, fm: Record<string, unknown>): boolean {
  if ("tagPresent" in condition) {
    const tags = fm["tags"];
    if (Array.isArray(tags)) {
      return tags.some((t) => t === condition.tagPresent);
    }
    if (typeof tags === "string") {
      return tags === condition.tagPresent;
    }
    return false;
  }

  if ("fieldEquals" in condition) {
    const { field, value } = condition.fieldEquals;
    return String(fm[field] ?? "") === value;
  }

  if ("fieldExists" in condition) {
    const val = fm[condition.fieldExists];
    if (val === null || val === undefined) return false;
    if (typeof val === "string") return val.length > 0;
    if (Array.isArray(val)) return val.length > 0;
    return true;
  }

  return false;
}

// ============================================================================
// Wikilink extraction (minimal, for structural rules)
// ============================================================================

export const WIKILINK_RE = /\[\[([^\]|#]+?)(?:#([^\]|]+?))?(?:\|([^\]]+?))?\]\]/g;

export const CODE_FENCE_RE = /^```|^~~~/;

export interface ScannedLink {
  raw: string;
  target: string;
  section: string | null;
  display: string | null;
  line: number;    // 1-based
  column: number;  // 0-based character offset within line
}

export function* scanWikilinks(content: string): Generator<ScannedLink> {
  const lines = content.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (CODE_FENCE_RE.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    WIKILINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = WIKILINK_RE.exec(line)) !== null) {
      const target = match[1].trim();
      if (!target) continue;

      yield {
        raw: match[0],
        target,
        section: match[2]?.trim() ?? null,
        display: match[3]?.trim() ?? null,
        line: i + 1,
        column: match.index,
      };
    }
  }
}

const WIKILINK_STEM_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

export function extractWikilinkStems(content: string): Set<string> {
  const stems = new Set<string>();
  WIKILINK_STEM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_STEM_RE.exec(content)) !== null) {
    const target = match[1].trim();
    const base = target.includes("/") ? target.split("/").pop()! : target;
    const stem = base.startsWith("_") ? base.slice(1) : base;
    stems.add(stem);
    stems.add(base);
  }
  return stems;
}

/** Hub detection patterns use single-brace {folderName} — distinct from double-brace template vars */
export function expandHubPattern(pattern: string, folderName: string): string {
  return pattern.replace(/\{folderName\}/g, folderName);
}

/**
 * Recursively walk the root directory and collect all file paths,
 * optionally filtered to a scope prefix. Uses eager directory
 * pruning to skip subtrees that can't contain scoped paths.
 */
export async function walkFiles(file: FileService, scope?: string): Promise<string[]> {
  const paths: string[] = [];
  await walkDir(file, "", scope, paths);
  return paths;
}

async function walkDir(
  file: FileService,
  relDir: string,
  scope: string | undefined,
  paths: string[],
): Promise<void> {
  let listing;
  try {
    listing = await file.listDirectory(relDir);
  } catch {
    return;
  }

  for (const entry of listing.entries) {
    if (entry.type === "directory") {
      if (scope !== undefined) {
        const dirPrefix = entry.path + "/";
        // Skip dirs that can't possibly contain scoped paths
        if (
          !entry.path.startsWith(scope) &&
          !scope.startsWith(dirPrefix) &&
          scope !== entry.path
        ) {
          continue;
        }
      }
      await walkDir(file, entry.path, scope, paths);
    } else {
      if (scope !== undefined && !entry.path.startsWith(scope)) {
        continue;
      }
      paths.push(entry.path);
    }
  }
}
