import { z } from "zod";
import type { ToolHandler, Services, ToolResponse } from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";

const log = createChildLog({ module: "search-tools" });

// ============================================================================
// search_notes
// ============================================================================

const SearchNotesSchema = z.object({
  query: z
    .string()
    .describe("Full-text search query. Supports multiple words; results ranked by BM25."),
  scope: z
    .string()
    .optional()
    .describe(
      "Vault-relative path prefix to restrict the search scope. Omit to search entire vault.",
    ),
  searchContent: z
    .boolean()
    .optional()
    .default(true)
    .describe("Search within note body content. Default: true."),
  searchFrontmatter: z
    .boolean()
    .optional()
    .default(false)
    .describe("Search within frontmatter field values. Default: false."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of results to return. Omit for default limit."),
});

function makeSearchNotesTool(services: Services): ToolHandler {
  return {
    name: "search_notes",
    description:
      "Full-text search across the vault using BM25 ranking. Optionally restrict to a path scope, search frontmatter fields, and limit result count. Returns SearchResult[] sorted by relevance score.",
    inputSchema: SearchNotesSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { query, scope, searchContent, searchFrontmatter, limit } =
          SearchNotesSchema.parse(args);
        log.info({ query, scope, searchContent, searchFrontmatter, limit }, "search_notes called");
        const results = await services.search.search(query, {
          scope,
          searchContent,
          searchFrontmatter,
          limit,
        });
        log.info({ query, resultCount: results.length }, "search_notes complete");
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "search_notes failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerSearchTools(registry: Map<string, ToolHandler>, services: Services): void {
  const tools = [makeSearchNotesTool(services)];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
