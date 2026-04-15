import path from "node:path";
import fs from "node:fs/promises";
import yaml from "js-yaml";
import { vaultscribeLog } from "./vaultscribe-log.js";
import type { Services, PathFilterConfig, VaultScribeConfig } from "./types.js";
import { PathFilterImpl, DEFAULT_ALLOWED_EXTENSIONS } from "./services/path-filter.js";
import { VaultServiceImpl } from "./services/vault-service.js";
import { FrontmatterServiceImpl } from "./services/frontmatter-service.js";
import { SearchServiceImpl } from "./services/search-service.js";
import { SchemaEngineImpl } from "./services/schema-engine.js";
import { LinkEngineImpl } from "./services/link-engine.js";

const DEFAULT_SCHEMAS_DIR = "schemas";

/**
 * Load .vaultscribe/config.yaml from inside a vault. Returns defaults for missing/invalid files.
 */
async function loadVaultConfig(vaultPath: string): Promise<VaultScribeConfig> {
  const configPath = path.join(vaultPath, ".vaultscribe", "config.yaml");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = yaml.load(raw);
    if (!parsed || typeof parsed !== "object") {
      vaultscribeLog.debug({ configPath }, "config file empty or non-object, using defaults");
      return {};
    }
    vaultscribeLog.info({ configPath }, "vault config loaded");
    return parsed as VaultScribeConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      vaultscribeLog.debug({ configPath }, "no vault config file found, using defaults");
    } else {
      vaultscribeLog.warn({ err, configPath }, "failed to read vault config, using defaults");
    }
    return {};
  }
}

/**
 * Build all services for a given vault path.
 * Loads per-vault config, constructs services, loads schemas.
 */
export async function buildServices(vaultPath: string): Promise<Services> {
  const config = await loadVaultConfig(vaultPath);

  const pathFilterConfig: PathFilterConfig = {
    blockedPaths: config.paths?.blocked ?? [],
    allowedExtensions: config.paths?.allowed_extensions ?? DEFAULT_ALLOWED_EXTENSIONS,
  };
  const pathFilter = new PathFilterImpl(pathFilterConfig);
  const vault = new VaultServiceImpl(vaultPath, pathFilter);
  const frontmatter = new FrontmatterServiceImpl(vault);
  const search = new SearchServiceImpl(vault, {
    maxResults: config.search?.max_results,
    excerptChars: config.search?.excerpt_chars,
  });
  const schema = new SchemaEngineImpl(vault);
  const links = new LinkEngineImpl(vault);

  // Load schemas from configured directory (default: .vaultscribe/schemas/)
  const schemasDirName = config.schemas?.directory ?? DEFAULT_SCHEMAS_DIR;
  const schemasDir = path.join(vaultPath, ".vaultscribe", schemasDirName);
  await schema.loadSchemas(schemasDir);
  vaultscribeLog.info({ schemasDir }, "schemas loaded");

  // Load bundled default schemas (user schemas win on name collision)
  schema.loadBundledSchemas();

  // Discover _conventions.md notes for folder schema cascade
  await schema.discoverConventions();

  return { vault, frontmatter, search, schema, links };
}
