import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import type { GlobalConfig } from "./types.js";
import { loadGlobalConfig, saveGlobalConfig } from "./global-config.js";

describe("saveGlobalConfig / loadGlobalConfig", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultscribe-global-config-test-"));
    configPath = path.join(tmpDir, "config.yaml");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("saves and loads config roundtrip", async () => {
    const config: GlobalConfig = {
      vaults: { work: "/path/to/work", personal: "/path/to/personal" },
      default: "work",
    };

    await saveGlobalConfig(config, configPath);
    const loaded = await loadGlobalConfig(configPath);

    expect(loaded).not.toBeNull();
    expect(loaded!.vaults?.work).toBe("/path/to/work");
    expect(loaded!.vaults?.personal).toBe("/path/to/personal");
    expect(loaded!.default).toBe("work");
  });

  it("creates directory if it does not exist", async () => {
    const nestedPath = path.join(tmpDir, "nested", "dir", "config.yaml");
    const config: GlobalConfig = { vaults: { test: "/test" }, default: "test" };

    await saveGlobalConfig(config, nestedPath);

    const stat = await fs.stat(nestedPath);
    expect(stat.isFile()).toBe(true);
  });

  it("overwrites existing config atomically", async () => {
    const initial: GlobalConfig = { vaults: { a: "/a" }, default: "a" };
    await saveGlobalConfig(initial, configPath);

    const updated: GlobalConfig = { vaults: { a: "/a", b: "/b" }, default: "b" };
    await saveGlobalConfig(updated, configPath);

    const loaded = await loadGlobalConfig(configPath);
    expect(loaded!.vaults?.b).toBe("/b");
    expect(loaded!.default).toBe("b");

    // No leftover temp files
    const files = await fs.readdir(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("config.yaml");
  });

  it("returns null when config file does not exist", async () => {
    const result = await loadGlobalConfig(path.join(tmpDir, "nonexistent.yaml"));
    expect(result).toBeNull();
  });

  it("returns null for empty config file", async () => {
    await fs.writeFile(configPath, "", "utf-8");
    const result = await loadGlobalConfig(configPath);
    expect(result).toBeNull();
  });
});
