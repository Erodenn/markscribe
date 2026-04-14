import type {
  SearchService,
  VaultService,
  SearchOptions,
  SearchResult,
  FrontmatterOperator,
} from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";
import { walkVaultFiles } from "../utils.js";

const log = createChildLog({ service: "SearchService" });

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const DEFAULT_EXCERPT_CHARS = 80;
const DEFAULT_MAX_RESULTS = 50;

/** Tokenize text into lowercase tokens by splitting on whitespace/punctuation. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter((t) => t.length > 0);
}

/** Build a term frequency map from a token array. */
function buildTermFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

/**
 * Extract an excerpt from text around the first occurrence of any query term.
 * Returns a snippet of ~EXCERPT_CONTEXT_CHARS on each side of the match.
 */
function extractExcerpt(text: string, queryTerms: string[], contextChars: number): string {
  const lower = text.toLowerCase();
  let matchIndex = -1;

  for (const term of queryTerms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
      matchIndex = idx;
    }
  }

  if (matchIndex === -1) {
    return text.slice(0, contextChars * 2).trim();
  }

  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(text.length, matchIndex + contextChars);
  const excerpt = text.slice(start, end).trim();

  return (start > 0 ? "..." : "") + excerpt + (end < text.length ? "..." : "");
}

export interface SearchServiceConfig {
  maxResults?: number;
  excerptChars?: number;
}

export class SearchServiceImpl implements SearchService {
  private readonly vault: VaultService;
  private readonly maxResults: number;
  private readonly excerptChars: number;

  constructor(
    vaultService: VaultService,
    config?: SearchServiceConfig,
  ) {
    this.vault = vaultService;
    this.maxResults = config?.maxResults ?? DEFAULT_MAX_RESULTS;
    this.excerptChars = config?.excerptChars ?? DEFAULT_EXCERPT_CHARS;
    log.info(
      { maxResults: this.maxResults, excerptChars: this.excerptChars },
      "SearchService initialized",
    );
  }

  // =========================================================================
  // Public API (implements SearchService)
  // =========================================================================

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const scope = options?.scope;
    const searchContent = options?.searchContent ?? true;
    const searchFrontmatterOpt = options?.searchFrontmatter ?? false;
    const limit = options?.limit;

    log.info(
      { query, scope, searchContent, searchFrontmatter: searchFrontmatterOpt, limit },
      "search",
    );

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) {
      log.debug("search: empty query terms, returning []");
      return [];
    }

    // Collect all notes in scope
    const allPaths = await this.collectPaths(scope);
    log.debug({ count: allPaths.length, scope }, "search: collected paths");

    type DocData = {
      path: string;
      tokens: string[];
      tf: Map<string, number>;
      contentText: string;
      frontmatterText: string;
      frontmatter: Record<string, unknown>;
    };

    const docs: DocData[] = [];

    for (const notePath of allPaths) {
      let note;
      try {
        note = await this.vault.readNote(notePath);
      } catch {
        log.debug({ path: notePath }, "search: skipping unreadable note");
        continue;
      }

      const contentText = note.content;
      const contentTokens = searchContent ? tokenize(contentText) : [];
      const contentTf = searchContent ? buildTermFreq(contentTokens) : new Map<string, number>();

      let frontmatterText = "";
      let frontmatterTokens: string[] = [];
      let frontmatterTf = new Map<string, number>();

      if (searchFrontmatterOpt) {
        frontmatterText = this.frontmatterToText(note.frontmatter);
        frontmatterTokens = tokenize(frontmatterText);
        frontmatterTf = buildTermFreq(frontmatterTokens);
      }

      const combinedTokens = [...contentTokens, ...frontmatterTokens];
      const combinedTf = this.mergeTf(contentTf, frontmatterTf);

      docs.push({
        path: notePath,
        tokens: combinedTokens,
        tf: combinedTf,
        contentText,
        frontmatterText,
        frontmatter: note.frontmatter,
      });
    }

    if (docs.length === 0) {
      return [];
    }

    // Compute document frequency across corpus
    const df = new Map<string, number>();
    for (const doc of docs) {
      const seen = new Set<string>();
      for (const token of doc.tokens) {
        if (!seen.has(token)) {
          seen.add(token);
          df.set(token, (df.get(token) ?? 0) + 1);
        }
      }
    }

    const N = docs.length;
    const avgDocLen = docs.reduce((sum, d) => sum + d.tokens.length, 0) / N;

    const results: SearchResult[] = [];

    for (const doc of docs) {
      const docLen = doc.tokens.length;
      let score = 0;

      for (const term of queryTerms) {
        const tf = doc.tf.get(term) ?? 0;
        if (tf === 0) continue;

        const dfVal = df.get(term) ?? 0;
        const idf = Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1);
        const termScore =
          (idf * (tf * (BM25_K1 + 1))) /
          (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen)));
        score += termScore;
      }

      if (score <= 0) continue;

      // Identify matched frontmatter fields
      const matchedFields: string[] = [];
      if (searchFrontmatterOpt) {
        for (const [field, fieldValue] of Object.entries(doc.frontmatter)) {
          const fieldText = Array.isArray(fieldValue)
            ? fieldValue.map(String).join(" ").toLowerCase()
            : String(fieldValue ?? "").toLowerCase();
          for (const term of queryTerms) {
            if (fieldText.includes(term)) {
              if (!matchedFields.includes(field)) {
                matchedFields.push(field);
              }
            }
          }
        }
      }

      const excerptSource = searchContent ? doc.contentText : doc.frontmatterText;
      const excerpt = extractExcerpt(
        excerptSource || doc.contentText,
        queryTerms,
        this.excerptChars,
      );

      const result: SearchResult = {
        path: doc.path,
        score,
        excerpt,
      };

      if (matchedFields.length > 0) {
        result.matchedFields = matchedFields;
      }

      results.push(result);
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    const effectiveLimit = limit ?? this.maxResults;
    const limited = results.slice(0, effectiveLimit);
    log.info({ query, resultCount: limited.length }, "search complete");
    return limited;
  }

  async searchByFrontmatter(
    field: string,
    value: string,
    operator: FrontmatterOperator = "equals",
  ): Promise<SearchResult[]> {
    log.info({ field, value, operator }, "searchByFrontmatter");

    const allPaths = await this.collectPaths();
    const results: SearchResult[] = [];

    for (const notePath of allPaths) {
      let note;
      try {
        note = await this.vault.readNote(notePath);
      } catch {
        log.debug({ path: notePath }, "searchByFrontmatter: skipping unreadable note");
        continue;
      }

      const fieldValue = note.frontmatter[field];
      const matches = this.matchesOperator(fieldValue, value, operator);

      if (!matches) continue;

      const fieldStr = fieldValue !== undefined ? String(fieldValue) : "";
      const excerpt = `${field}: ${fieldStr}`;

      results.push({
        path: notePath,
        score: 1,
        excerpt,
        matchedFields: [field],
      });
    }

    log.info(
      { field, value, operator, resultCount: results.length },
      "searchByFrontmatter complete",
    );
    return results;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Walk the vault and collect all note paths, optionally filtered to a scope prefix.
   */
  private async collectPaths(scope?: string): Promise<string[]> {
    return walkVaultFiles(this.vault, scope);
  }

  /** Convert frontmatter object to a flat text string for tokenization. */
  private frontmatterToText(frontmatter: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (Array.isArray(value)) {
        parts.push(key, ...value.map(String));
      } else if (value !== null && value !== undefined) {
        parts.push(key, String(value));
      }
    }
    return parts.join(" ");
  }

  /** Merge two TF maps, summing counts for shared terms. */
  private mergeTf(a: Map<string, number>, b: Map<string, number>): Map<string, number> {
    if (b.size === 0) return a;
    const merged = new Map(a);
    for (const [term, count] of b) {
      merged.set(term, (merged.get(term) ?? 0) + count);
    }
    return merged;
  }

  /** Check if a frontmatter field value matches the operator condition. */
  private matchesOperator(
    fieldValue: unknown,
    queryValue: string,
    operator: FrontmatterOperator,
  ): boolean {
    if (operator === "exists") {
      return fieldValue !== undefined && fieldValue !== null && fieldValue !== "";
    }

    if (fieldValue === undefined || fieldValue === null) return false;

    const strValue = Array.isArray(fieldValue)
      ? fieldValue.map(String).join(" ")
      : String(fieldValue);

    if (operator === "equals") {
      return strValue === queryValue;
    }

    if (operator === "contains") {
      return strValue.toLowerCase().includes(queryValue.toLowerCase());
    }

    return false;
  }
}
