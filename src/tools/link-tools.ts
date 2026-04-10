import { z } from "zod";
import type { ToolHandler, ToolResponse, Services } from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";

const log = createChildLog({ module: "link-tools" });

// ============================================================================
// get_backlinks
// ============================================================================

const GetBacklinksSchema = z.object({
  path: z.string().min(1, "path is required"),
});

function makeGetBacklinksTool(services: Services): ToolHandler {
  return {
    name: "get_backlinks",
    description:
      "Find all notes that contain wikilinks pointing to a given note. Returns source path, link details, and line number.",
    inputSchema: GetBacklinksSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { path } = GetBacklinksSchema.parse(args);
        log.info({ path }, "get_backlinks called");
        const backlinks = await services.links.getBacklinks(path);
        log.info({ path, count: backlinks.length }, "get_backlinks complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ path, backlinks }),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "get_backlinks failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
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

function makeFindUnlinkedMentionsTool(services: Services): ToolHandler {
  return {
    name: "find_unlinked_mentions",
    description:
      "Find plain-text occurrences of a note's title across the vault that are not yet wikilinked. Returns source path, mention text, line, and column.",
    inputSchema: FindUnlinkedMentionsSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { path } = FindUnlinkedMentionsSchema.parse(args);
        log.info({ path }, "find_unlinked_mentions called");
        const mentions = await services.links.findUnlinkedMentions(path);
        log.info({ path, count: mentions.length }, "find_unlinked_mentions complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ path, mentions }),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "find_unlinked_mentions failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
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

function makeFindBrokenLinksTool(services: Services): ToolHandler {
  return {
    name: "find_broken_links",
    description:
      "Find wikilinks that point to notes that do not exist. Optionally scoped to a vault path prefix.",
    inputSchema: FindBrokenLinksSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { scope } = FindBrokenLinksSchema.parse(args);
        log.info({ scope }, "find_broken_links called");
        const brokenLinks = await services.links.findBrokenLinks(scope);
        log.info({ scope, count: brokenLinks.length }, "find_broken_links complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ scope: scope ?? null, brokenLinks }),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "find_broken_links failed");
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
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

function makeFindOrphansTool(services: Services): ToolHandler {
  return {
    name: "find_orphans",
    description:
      "Find notes that have no incoming wikilinks from other notes. Optionally scoped to a vault path prefix.",
    inputSchema: FindOrphansSchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { scope } = FindOrphansSchema.parse(args);
        log.info({ scope }, "find_orphans called");
        const orphans = await services.links.findOrphans(scope);
        log.info({ scope, count: orphans.length }, "find_orphans complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ scope: scope ?? null, orphans }),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "find_orphans failed");
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

export function registerLinkTools(
  registry: Map<string, ToolHandler>,
  services: Services,
): void {
  const tools = [
    makeGetBacklinksTool(services),
    makeFindUnlinkedMentionsTool(services),
    makeFindBrokenLinksTool(services),
    makeFindOrphansTool(services),
  ];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
