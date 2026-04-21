import { z } from "zod";
import type { ToolHandler, ServiceContainer, ToolResponse } from "../types.js";
import { requireServices, getRoot } from "./index.js";
import { createChildLog } from "../markscribe-log.js";

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
      "Root-relative path prefix to restrict the search scope. Omit to search the entire directory.",
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

function makeSearchNotesTool(container: ServiceContainer): ToolHandler {
  return {
    name: "search_notes",
    description:
      "Full-text BM25 search. Pass `{ query }` and optionally `scope` (path prefix), `searchContent` (default true), `searchFrontmatter` (default false), `limit`. Returns `{ root, results[] }` sorted by relevance, each with `path`, `score`, `excerpt`.",
    inputSchema: SearchNotesSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
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
          content: [{ type: "text", text: JSON.stringify({ root: getRoot(container), results }, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "search_notes failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Try a different search query", "Use list_directory to browse the directory structure", "Check the scope path exists with list_directory"],
          }) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerSearchTools(
  registry: Map<string, ToolHandler>,
  container: ServiceContainer,
): void {
  const tools = [makeSearchNotesTool(container)];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
