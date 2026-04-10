import path from "node:path";
import fs from "node:fs/promises";
import yaml from "js-yaml";
import { markscribeLog } from "./markscribe-log.js";
import type { Services, PathFilterConfig, MarkScribeConfig } from "./types.js";
import { PathFilterImpl, DEFAULT_ALLOWED_EXTENSIONS } from "./services/path-filter.js";
import { FileServiceImpl } from "./services/file-service.js";
import { FrontmatterServiceImpl } from "./services/frontmatter-service.js";
import { SearchServiceImpl } from "./services/search-service.js";
import { SchemaEngineImpl } from "./services/schema-engine.js";
import { LinkEngineImpl } from "./services/link-engine.js";

/**
 * Load .markscribe/config.yaml from inside the root directory. Returns defaults for missing/invalid files.
 */
async function loadRootConfig(rootPath: string): Promise<MarkScribeConfig> {
  const configPath = path.join(rootPath, ".markscribe", "config.yaml");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = yaml.load(raw);
    if (!parsed || typeof parsed !== "object") {
      markscribeLog.debug({ configPath }, "config file empty or non-object, using defaults");
      return {};
    }
    markscribeLog.info({ configPath }, "root config loaded");
    return parsed as MarkScribeConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      markscribeLog.debug({ configPath }, "no root config file found, using defaults");
    } else {
      markscribeLog.warn({ err, configPath }, "failed to read root config, using defaults");
    }
    return {};
  }
}

/**
 * Build all services for a given root path and schemas directory.
 * Loads per-directory config, constructs services, loads schemas.
 */
export async function buildServices(rootPath: string, schemasDir: string): Promise<Services> {
  const config = await loadRootConfig(rootPath);

  const pathFilterConfig: PathFilterConfig = {
    blockedPaths: config.paths?.blocked ?? [],
    allowedExtensions: config.paths?.allowed_extensions ?? DEFAULT_ALLOWED_EXTENSIONS,
  };
  const pathFilter = new PathFilterImpl(pathFilterConfig);
  const file = new FileServiceImpl(rootPath, pathFilter);
  const frontmatter = new FrontmatterServiceImpl(file);
  const search = new SearchServiceImpl(file, {
    maxResults: config.search?.max_results,
    excerptChars: config.search?.excerpt_chars,
  });
  const schema = new SchemaEngineImpl(file);
  const links = new LinkEngineImpl(file);

  // Load schemas from the provided schemas directory
  await schema.loadSchemas(schemasDir);
  markscribeLog.info({ schemasDir }, "schemas loaded");

  // Load bundled default schemas (user schemas win on name collision)
  schema.loadBundledSchemas();

  // Discover _conventions.md notes for folder schema cascade
  await schema.discoverConventions();

  return { file, frontmatter, search, schema, links };
}
