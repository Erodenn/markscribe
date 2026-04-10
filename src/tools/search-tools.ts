import { z } from "zod";
import type { ToolHandler, Services, ToolResponse } from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";

const log = createChildLog({ module: "search-tools" });

// ============================================================================
// search_notes
// ============================================================================

const searchNotesSchema = z.object({
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
    .describe("Maximum number of results to return. Omit for all matching results."),
});

function makeSearchNotesHandler(services: Services): ToolHandler["handler"] {
  return async (args: Record<string, unknown>): Promise<ToolResponse> => {
    const parsed = searchNotesSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        isError: true,
      };
    }

    const { query, scope, searchContent, searchFrontmatter, limit } = parsed.data;
    const toolLog = createChildLog({ tool: "search_notes", query });
    toolLog.info({ query, scope, searchContent, searchFrontmatter, limit }, "search_notes called");

    try {
      const results = await services.search.search(query, {
        scope,
        searchContent,
        searchFrontmatter,
        limit,
      });

      toolLog.info({ query, resultCount: results.length }, "search_notes complete");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolLog.error({ err, query }, "search_notes failed");
      return {
        content: [{ type: "text", text: `Error searching notes: ${message}` }],
        isError: true,
      };
    }
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerSearchTools(registry: Map<string, ToolHandler>, services: Services): void {
  log.info("registering search tools");

  const searchNotes: ToolHandler = {
    name: "search_notes",
    description:
      "Full-text search across the vault using BM25 ranking. Optionally restrict to a path scope, search frontmatter fields, and limit result count. Returns SearchResult[] sorted by relevance score.",
    inputSchema: searchNotesSchema,
    handler: makeSearchNotesHandler(services),
  };

  registry.set(searchNotes.name, searchNotes);

  log.info({ tools: [searchNotes.name] }, "search tools registered");
}
