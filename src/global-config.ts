import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import yaml from "js-yaml";
import { vaultscribeLog } from "./vaultscribe-log.js";
import type { GlobalConfig } from "./types.js";

const CONFIG_DIR = ".vaultscribe";
const CONFIG_FILE = "config.yaml";

/** Resolve the global config directory path (~/.vaultscribe/) */
export function getGlobalConfigDir(): string {
  return path.join(os.homedir(), CONFIG_DIR);
}

/** Resolve the global config file path (~/.vaultscribe/config.yaml) */
export function getGlobalConfigPath(): string {
  return path.join(getGlobalConfigDir(), CONFIG_FILE);
}

/**
 * Load the global config from ~/.vaultscribe/config.yaml.
 * Returns null if the file doesn't exist.
 * Throws on parse errors so the caller can decide how to handle.
 */
export async function loadGlobalConfig(): Promise<GlobalConfig | null> {
  const configPath = getGlobalConfigPath();
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = yaml.load(raw);
    if (!parsed || typeof parsed !== "object") {
      vaultscribeLog.warn({ configPath }, "global config empty or non-object");
      return null;
    }
    const config = parsed as GlobalConfig;
    vaultscribeLog.info(
      { configPath, vaultCount: Object.keys(config.vaults ?? {}).length },
      "global config loaded",
    );
    return config;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      vaultscribeLog.debug({ configPath }, "no global config found");
      return null;
    }
    throw err;
  }
}

/**
 * Resolve a vault identifier to an absolute path.
 * Accepts either a config alias ("everything") or an absolute path.
 */
export function resolveVaultPath(
  vault: string,
  globalConfig: GlobalConfig | null,
): string | null {
  // Check if it's a named alias in the config
  if (globalConfig?.vaults?.[vault]) {
    return path.resolve(globalConfig.vaults[vault]);
  }
  // Check if it's an absolute path
  if (path.isAbsolute(vault)) {
    return path.resolve(vault);
  }
  return null;
}
