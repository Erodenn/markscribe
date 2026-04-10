import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type {
  FileService,
  PathFilter,
  ParsedNote,
  WriteMode,
  MoveResult,
  DirectoryListing,
  DirectoryEntry,
  BatchResult,
  DirectoryStats,
} from "../types.js";
import { createChildLog } from "../markscribe-log.js";

const log = createChildLog({ service: "FileService" });

const MAX_BATCH_READ = 10;
const RECENT_FILES_COUNT = 10;

export class FileServiceImpl implements FileService {
  readonly rootPath: string;
  private readonly pathFilter: PathFilter;

  constructor(rootPath: string, pathFilter: PathFilter) {
    this.rootPath = path.resolve(rootPath);
    this.pathFilter = pathFilter;
    log.info({ rootPath: this.rootPath }, "FileService initialized");
  }

  // =========================================================================
  // Public API (implements FileService)
  // =========================================================================

  /**
   * Resolve a relative path to an absolute path.
   * Throws if the resolved path escapes the vault root or is blocked by PathFilter.
   */
  resolvePath(relativePath: string): string {
    const { absolute, normalized } = this.resolveAbsolute(relativePath);
    if (!this.pathFilter.isAllowed(normalized)) {
      throw new Error(`Path not allowed: "${relativePath}"`);
    }
    log.debug({ relativePath, absolute }, "resolvePath");
    return absolute;
  }

  /**
   * Write content to a file atomically: write to a temp file, then rename.
   * This ensures the target is never partially written on crash.
   */
  async atomicWrite(fullPath: string, content: string): Promise<void> {
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = path.join(dir, `.markscribe-tmp-${Date.now()}-${process.pid}`);
    try {
      await fs.writeFile(tmpPath, content, "utf-8");
      await fs.rename(tmpPath, fullPath);
      log.debug({ fullPath }, "atomicWrite complete");
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  async readNote(relativePath: string): Promise<ParsedNote> {
    const fullPath = this.resolvePath(relativePath);
    log.info({ path: relativePath }, "readNote");

    const raw = await fs.readFile(fullPath, "utf-8");
    const parsed = matter(raw);

    return {
      path: relativePath,
      frontmatter: parsed.data as Record<string, unknown>,
      content: parsed.content,
      raw,
    };
  }

  async writeNote(
    relativePath: string,
    content: string,
    frontmatter?: Record<string, unknown>,
    mode: WriteMode = "overwrite",
  ): Promise<void> {
    log.info({ path: relativePath, mode }, "writeNote");

    const newRaw = frontmatter
      ? matter.stringify(content, frontmatter as matter.GrayMatterFile<string>["data"])
      : content;

    if (mode === "overwrite") {
      const fullPath = this.resolvePath(relativePath);
      await this.atomicWrite(fullPath, newRaw);
      return;
    }

    // For append/prepend, read existing content first (file may not exist yet)
    let existingRaw = "";
    try {
      const fullPath = this.resolvePath(relativePath);
      existingRaw = await fs.readFile(fullPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    const combined =
      mode === "append"
        ? existingRaw
          ? existingRaw + "\n" + newRaw
          : newRaw
        : existingRaw
          ? newRaw + "\n" + existingRaw
          : newRaw;

    const fullPath = this.resolvePath(relativePath);
    await this.atomicWrite(fullPath, combined);
  }

  async patchNote(
    relativePath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<void> {
    log.info({ path: relativePath, replaceAll }, "patchNote");

    const fullPath = this.resolvePath(relativePath);
    const raw = await fs.readFile(fullPath, "utf-8");

    if (!raw.includes(oldString)) {
      throw new Error(`patchNote: string not found in "${relativePath}"`);
    }

    const patched = replaceAll
      ? raw.split(oldString).join(newString)
      : raw.replace(oldString, newString);
    await this.atomicWrite(fullPath, patched);
  }

  async deleteNote(relativePath: string, confirmPath: string): Promise<void> {
    log.info({ path: relativePath }, "deleteNote");

    if (relativePath !== confirmPath) {
      throw new Error(
        `deleteNote: confirmPath "${confirmPath}" does not match path "${relativePath}"`,
      );
    }

    const fullPath = this.resolvePath(relativePath);
    await fs.unlink(fullPath);
  }

  async moveNote(
    oldRelativePath: string,
    newRelativePath: string,
    overwrite = false,
  ): Promise<MoveResult> {
    log.info({ oldPath: oldRelativePath, newPath: newRelativePath, overwrite }, "moveNote");

    const oldFull = this.resolvePath(oldRelativePath);
    const newFull = this.resolvePath(newRelativePath);

    // Guard against silently overwriting an existing file
    if (!overwrite) {
      try {
        await fs.access(newFull);
        throw new Error(
          `moveNote: destination "${newRelativePath}" already exists. Set overwrite=true to replace it.`,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    await fs.mkdir(path.dirname(newFull), { recursive: true });

    const content = await fs.readFile(oldFull, "utf-8");
    await this.atomicWrite(newFull, content);
    await fs.unlink(oldFull);

    return { oldPath: oldRelativePath, newPath: newRelativePath };
  }

  async listDirectory(relativePath: string): Promise<DirectoryListing> {
    log.info({ path: relativePath }, "listDirectory");

    const fullPath =
      relativePath === "" || relativePath === "."
        ? this.rootPath
        : this.resolvePathForListing(relativePath);

    const dirents = await fs.readdir(fullPath, { withFileTypes: true });
    const entries: DirectoryEntry[] = [];

    for (const dirent of dirents) {
      const entryRelative = relativePath
        ? `${relativePath}/${dirent.name}`.replace(/^\//, "")
        : dirent.name;

      const isDirectory = dirent.isDirectory();

      if (isDirectory) {
        if (!this.pathFilter.isAllowedForListing(entryRelative)) continue;
      } else {
        if (!this.pathFilter.isAllowed(entryRelative)) continue;
      }

      entries.push({
        name: dirent.name,
        type: isDirectory ? "directory" : "file",
        path: entryRelative,
      });
    }

    return { path: relativePath, entries };
  }

  async readMultipleNotes(paths: string[]): Promise<BatchResult> {
    log.info({ count: paths.length }, "readMultipleNotes");

    if (paths.length > MAX_BATCH_READ) {
      throw new Error(`readMultipleNotes: max ${MAX_BATCH_READ} paths, got ${paths.length}`);
    }

    const results = await Promise.all(
      paths.map(async (p) => {
        try {
          const note = await this.readNote(p);
          return { path: p, note };
        } catch (err) {
          return {
            path: p,
            note: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    return { results };
  }

  async getStats(): Promise<DirectoryStats> {
    log.info("getStats");

    const allFiles: Array<{ path: string; size: number; mtime: Date }> = [];

    const walk = async (dir: string, relDir: string): Promise<void> => {
      let dirents: Dirent[];
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const dirent of dirents) {
        const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name;

        if (dirent.isDirectory()) {
          if (!this.pathFilter.isAllowedForListing(relPath)) continue;
          await walk(path.join(dir, dirent.name), relPath);
        } else if (dirent.isFile()) {
          if (!this.pathFilter.isAllowed(relPath)) continue;
          try {
            const stat = await fs.stat(path.join(dir, dirent.name));
            allFiles.push({ path: relPath, size: stat.size, mtime: stat.mtime });
          } catch {
            // Skip unreadable files
          }
        }
      }
    };

    await walk(this.rootPath, "");

    const noteCount = allFiles.length;
    const totalBytes = allFiles.reduce((sum, f) => sum + f.size, 0);

    const recentFiles = allFiles
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, RECENT_FILES_COUNT)
      .map((f) => ({ path: f.path, modified: f.mtime.toISOString() }));

    log.info({ noteCount, totalBytes }, "getStats complete");
    return { noteCount, totalBytes, recentFiles };
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private resolveAbsolute(relativePath: string): { absolute: string; normalized: string } {
    const absolute = path.resolve(this.rootPath, relativePath);

    const relative = path.relative(this.rootPath, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path traversal detected: "${relativePath}" escapes root directory`);
    }

    const normalized = relative.replace(/\\/g, "/");
    return { absolute, normalized };
  }

  /**
   * Resolve a relative path for directory listing (no extension check).
   */
  private resolvePathForListing(relativePath: string): string {
    const { absolute, normalized } = this.resolveAbsolute(relativePath);
    if (!this.pathFilter.isAllowedForListing(normalized)) {
      throw new Error(`Path not allowed for listing: "${relativePath}"`);
    }
    return absolute;
  }
}
