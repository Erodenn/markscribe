import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolHandler, ServiceContainer, ToolResponse, Services } from "../types.js";
import { requireServices, getRoot } from "./index.js";
import { createChildLog } from "../markscribe-log.js";

export type RebuildServices = (rootPath: string) => Promise<Services>;

const log = createChildLog({ module: "directory-tools" });

// ============================================================================
// list_directory
// ============================================================================

const ListDirectorySchema = z.object({
  path: z
    .string()
    .default("")
    .describe("Relative directory path. Empty string or omitted = root directory."),
});

function makeListDirectoryTool(container: ServiceContainer): ToolHandler {
  return {
    name: "list_directory",
    description:
      "Returns `{ root, path, entries[] }`. Each entry has `name`, `type` (`file`|`directory`), and relative `path`. Omit `path` or pass `\"\"` to list the root. Blocked paths (.obsidian, .git, node_modules) are excluded automatically.",
    inputSchema: ListDirectorySchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        const { path: dirPath } = ListDirectorySchema.parse(args);
        log.info({ dirPath }, "list_directory called");
        const listing = await services.file.listDirectory(dirPath);
        log.info({ entryCount: listing.entries.length }, "list_directory complete");
        return {
          content: [{ type: "text", text: JSON.stringify({ root: getRoot(container), ...listing }, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "list_directory failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Check the path with list_directory", "Verify the directory exists", "Ensure the path is relative (not absolute)"],
          }) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// get_stats
// ============================================================================

const GetStatsSchema = z.object({});

function makeGetStatsTool(container: ServiceContainer): ToolHandler {
  return {
    name: "get_stats",
    description:
      "Returns `{ root, noteCount, totalBytes, recentFiles[] }`. No arguments needed. Use this to verify connectivity and get an overview of the active directory.",
    inputSchema: GetStatsSchema,
    async handler(_args): Promise<ToolResponse> {
      try {
        const services = requireServices(container);
        log.info("get_stats called");
        const stats = await services.file.getStats();
        log.info(
          { noteCount: stats.noteCount, totalBytes: stats.totalBytes },
          "get_stats complete",
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ root: getRoot(container), ...stats }, null, 2) }],
        };
      } catch (err) {
        log.error({ err }, "get_stats failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Verify the root directory is set with switch_directory", "Check directory permissions"],
          }) }],
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// switch_directory
// ============================================================================

const SwitchDirectorySchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Absolute path to the new root directory."),
});

function makeSwitchDirectoryTool(
  container: ServiceContainer,
  rebuildServices: RebuildServices,
): ToolHandler {
  return {
    name: "switch_directory",
    description:
      "Accepts `{ path }` (absolute path). Rebuilds all services for the new root directory. Returns `{ root, switched: true }` on success. Call `get_stats` after switching to verify.",
    inputSchema: SwitchDirectorySchema,
    async handler(args): Promise<ToolResponse> {
      try {
        const { path: dirPath } = SwitchDirectorySchema.parse(args);
        log.info({ path: dirPath }, "switch_directory called");

        if (!path.isAbsolute(dirPath)) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              root: getRoot(container),
              error: `Path must be absolute. Received: ${dirPath}`,
              possibleSolutions: ["Provide a full absolute path (e.g. /home/user/notes or C:\\Users\\user\\notes)"],
            }) }],
            isError: true,
          };
        }

        // Validate directory exists
        try {
          const stat = await fs.stat(dirPath);
          if (!stat.isDirectory()) {
            return {
              content: [{ type: "text", text: JSON.stringify({
                root: getRoot(container),
                error: `Path is not a directory: ${dirPath}`,
                possibleSolutions: ["Check the path points to a directory, not a file"],
              }) }],
              isError: true,
            };
          }
        } catch {
          return {
            content: [{ type: "text", text: JSON.stringify({
              root: getRoot(container),
              error: `Directory does not exist: ${dirPath}`,
              possibleSolutions: ["Verify the directory path is correct and the directory exists"],
            }) }],
            isError: true,
          };
        }

        const resolvedPath = path.resolve(dirPath);
        container.services = await rebuildServices(resolvedPath);

        log.info({ path: resolvedPath }, "switch_directory complete");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ root: resolvedPath, switched: true }),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, "switch_directory failed");
        return {
          content: [{ type: "text", text: JSON.stringify({
            root: getRoot(container),
            error: err instanceof Error ? err.message : String(err),
            possibleSolutions: ["Verify the directory path is correct", "Check that the directory exists and is accessible"],
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

export function registerDirectoryTools(
  registry: Map<string, ToolHandler>,
  container: ServiceContainer,
  rebuildServices: RebuildServices,
): void {
  const tools = [
    makeListDirectoryTool(container),
    makeGetStatsTool(container),
    makeSwitchDirectoryTool(container, rebuildServices),
  ];

  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
}
