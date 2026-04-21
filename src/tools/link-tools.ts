import { z } from "zod";
import type { ToolHandler, ToolResponse, ServiceContainer } from "../types.js";
import { requireServices, getRoot } from "./index.js";
import { createChildLog } from "../markscribe-log.js";

const log = createChildLog({ module: "link-tools" });

// ============================================================================
// get_backlinks
// ============================================================================

const GetBacklinksSchema = z.object({
  path: z.string().min(1, "path is required"),
});

function makeGetBacklinksTool(container: ServiceContainer): ToolHandler {
  return {
    name: "get_backlinks",
    description:
      "Finds all notes linking to a given note. Pass `{ path }`. Returns `{ root, path, backlinks[] }` where each backlink has `sourcePath`, `link`, `line`.",
    inputSchema: GetBacklinksSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        const { path } = GetBacklinksSchema.parse(args);
        log.info({ path }, "get_backlinks called");
        const backlinks = await services.links.getBacklinks(path);
        log.info({ path, count: backlinks.length }, "get_backlinks complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ root: getRoot(container), path, backlinks }),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "get_backlinks failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the path with list_directory", "Verify the file exists with read_note"],
          }) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// find_unlinked_mentions
// ============================================================================

const FindUnlinkedMentionsSchema = z.object({
  path: z.string().min(1, "path is required"),
});

function makeFindUnlinkedMentionsTool(container: ServiceContainer): ToolHandler {
  return {
    name: "find_unlinked_mentions",
    description:
      "Finds plain-text occurrences of a note's title that are not wikilinked. Pass `{ path }`. Returns `{ root, path, mentions[] }` with `sourcePath`, `mentionText`, `line`, `column`.",
    inputSchema: FindUnlinkedMentionsSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        const { path } = FindUnlinkedMentionsSchema.parse(args);
        log.info({ path }, "find_unlinked_mentions called");
        const mentions = await services.links.findUnlinkedMentions(path);
        log.info({ path, count: mentions.length }, "find_unlinked_mentions complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ root: getRoot(container), path, mentions }),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "find_unlinked_mentions failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the path with list_directory", "Verify the file exists with read_note"],
          }) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// find_broken_links
// ============================================================================

const FindBrokenLinksSchema = z.object({
  scope: z.string().optional(),
});

function makeFindBrokenLinksTool(container: ServiceContainer): ToolHandler {
  return {
    name: "find_broken_links",
    description:
      "Finds wikilinks pointing to non-existent notes. Optional `{ scope }` path prefix. Returns `{ root, scope, brokenLinks[] }` with `sourcePath`, `link`, `line`.",
    inputSchema: FindBrokenLinksSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        const { scope } = FindBrokenLinksSchema.parse(args);
        log.info({ scope }, "find_broken_links called");
        const brokenLinks = await services.links.findBrokenLinks(scope);
        log.info({ scope, count: brokenLinks.length }, "find_broken_links complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ root: getRoot(container), scope: scope ?? null, brokenLinks }),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "find_broken_links failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the scope path with list_directory", "Omit scope to scan the entire directory"],
          }) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// find_orphans
// ============================================================================

const FindOrphansSchema = z.object({
  scope: z.string().optional(),
});

function makeFindOrphansTool(container: ServiceContainer): ToolHandler {
  return {
    name: "find_orphans",
    description:
      "Finds notes with no incoming wikilinks. Optional `{ scope }` path prefix. Returns `{ root, scope, orphans[] }` (array of relative paths).",
    inputSchema: FindOrphansSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        const { scope } = FindOrphansSchema.parse(args);
        log.info({ scope }, "find_orphans called");
        const orphans = await services.links.findOrphans(scope);
        log.info({ scope, count: orphans.length }, "find_orphans complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ root: getRoot(container), scope: scope ?? null, orphans }),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "find_orphans failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the scope path with list_directory", "Omit scope to scan the entire directory"],
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

export function registerLinkTools(
  registry: Map<string, ToolHandler>,
  container: ServiceContainer,
): void {
  const tools = [
    makeGetBacklinksTool(container),
    makeFindUnlinkedMentionsTool(container),
    makeFindBrokenLinksTool(container),
    makeFindOrphansTool(container),
  ];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
