import path from "node:path";
import type {
  FileService,
  ResolvedConvention,
} from "../types.js";
import { createChildLog } from "../markscribe-log.js";
import type { SchemaRegistryImpl } from "./schema-registry.js";

const log = createChildLog({ service: "ConventionCascade" });

interface CollectedDir {
  path: string;
  conventionsPath: string | null;
}

export class ConventionCascadeImpl {
  static readonly CONVENTIONS_FILENAME = "_conventions.md";

  /** Explicit bindings from _conventions.md files: dirPath → binding info */
  private explicitBindings = new Map<
    string,
    { folderSchemaName: string; inherit: boolean; source: string }
  >();

  /** Resolved convention for each directory */
  private conventions = new Map<string, ResolvedConvention>();

  constructor(
    private readonly vault: FileService,
    private readonly registry: SchemaRegistryImpl,
  ) {}

  /**
   * Walk the vault, find all _conventions.md files, parse their frontmatter,
   * and resolve the cascade for every directory.
   */
  async discover(): Promise<void> {
    log.info("discover start");
    this.explicitBindings.clear();
    this.conventions.clear();

    // Collect all directories and check for _conventions.md
    const allDirs: CollectedDir[] = [];
    await this.collectDirectories("", allDirs);

    // Sort by depth (shallowest first) for stable cascade resolution
    allDirs.sort((a, b) => {
      const depthA = a.path === "" ? 0 : a.path.split("/").length;
      const depthB = b.path === "" ? 0 : b.path.split("/").length;
      return depthA - depthB;
    });

    // For each directory with a _conventions.md, parse the binding
    for (const dir of allDirs) {
      if (dir.conventionsPath) {
        try {
          const note = await this.vault.readNote(dir.conventionsPath);
          const fm = note.frontmatter;

          if (fm.inherit === false) {
            this.explicitBindings.set(dir.path, {
              folderSchemaName: "",
              inherit: false,
              source: dir.conventionsPath,
            });
            log.debug({ dirPath: dir.path, source: dir.conventionsPath }, "cascade opt-out");
          } else if (typeof fm.folder_schema === "string" && fm.folder_schema.length > 0) {
            this.explicitBindings.set(dir.path, {
              folderSchemaName: fm.folder_schema,
              inherit: fm.inherit !== false,
              source: dir.conventionsPath,
            });
            log.debug(
              { dirPath: dir.path, folderSchema: fm.folder_schema, source: dir.conventionsPath },
              "explicit binding found",
            );
          }
        } catch (err) {
          log.warn({ dirPath: dir.path, err }, "failed to read _conventions.md");
        }
      }
    }

    // Resolve effective convention for each directory by walking up
    for (const dir of allDirs) {
      this.resolveForDir(dir.path);
    }

    log.info(
      { explicitCount: this.explicitBindings.size, resolvedCount: this.conventions.size },
      "discover complete",
    );
  }

  getForFolder(folderPath: string): ResolvedConvention | null {
    const normalized = folderPath.replace(/\\/g, "/").replace(/\/$/, "");
    return this.conventions.get(normalized) ?? null;
  }

  getForNote(notePath: string): ResolvedConvention | null {
    const normalized = notePath.replace(/\\/g, "/");
    const dirPath = path.dirname(normalized).replace(/\\/g, "/");
    const effectiveDir = dirPath === "." ? "" : dirPath;
    return this.conventions.get(effectiveDir) ?? null;
  }

  getAllSources(): string[] {
    return [...this.explicitBindings.values()].map((b) => b.source);
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private async collectDirectories(dirPath: string, result: CollectedDir[]): Promise<void> {
    let listing;
    try {
      listing = await this.vault.listDirectory(dirPath);
    } catch {
      return;
    }

    const conventionsEntry = listing.entries.find(
      (e) => e.type === "file" && e.name === ConventionCascadeImpl.CONVENTIONS_FILENAME,
    );
    result.push({
      path: dirPath,
      conventionsPath: conventionsEntry?.path ?? null,
    });

    for (const entry of listing.entries) {
      if (entry.type === "directory") {
        await this.collectDirectories(entry.path, result);
      }
    }
  }

  private resolveForDir(dirPath: string): void {
    // Check if already resolved
    if (this.conventions.has(dirPath)) return;

    // Check for explicit binding
    const explicit = this.explicitBindings.get(dirPath);
    if (explicit) {
      if (!explicit.inherit && !explicit.folderSchemaName) {
        // Opt-out: unmanaged
        return;
      }
      const folderSchema = this.registry.resolveFolderSchema(explicit.folderSchemaName);
      if (folderSchema) {
        this.conventions.set(dirPath, {
          path: dirPath,
          folderSchemaName: explicit.folderSchemaName,
          folderSchema,
          source: explicit.source,
        });
      }
      return;
    }

    // Walk up to find nearest ancestor with a binding
    const segments = dirPath.split("/").filter((s) => s.length > 0);
    for (let i = segments.length - 1; i >= 0; i--) {
      const ancestorPath = segments.slice(0, i).join("/");
      const ancestorExplicit = this.explicitBindings.get(ancestorPath);

      if (ancestorExplicit) {
        if (!ancestorExplicit.inherit) {
          // Ancestor opted out — this dir is unmanaged
          return;
        }
        // Inherit from ancestor
        const folderSchema = this.registry.resolveFolderSchema(ancestorExplicit.folderSchemaName);
        if (folderSchema) {
          this.conventions.set(dirPath, {
            path: dirPath,
            folderSchemaName: ancestorExplicit.folderSchemaName,
            folderSchema,
            source: ancestorExplicit.source,
          });
        }
        return;
      }
    }

    // No ancestor has a binding — unmanaged
  }
}
