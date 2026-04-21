import path from "node:path";
import type { PathFilter, PathFilterConfig } from "../types.js";
import { createChildLog } from "../markscribe-log.js";
import { normalizePath } from "../utils.js";

const log = createChildLog({ service: "PathFilter" });

/**
 * Immutable defaults — these paths are always blocked regardless of config.
 * Config can only extend this list, never shrink it.
 */
const IMMUTABLE_BLOCKED_SEGMENTS = [".obsidian", ".git", "node_modules"];
const IMMUTABLE_BLOCKED_NAMES = [".DS_Store", "Thumbs.db"];

export const DEFAULT_ALLOWED_EXTENSIONS = [".md", ".markdown", ".txt"];

export class PathFilterImpl implements PathFilter {
  private readonly blockedSegments: Set<string>;
  private readonly blockedNames: Set<string>;
  private readonly allowedExtensions: Set<string>;

  constructor(config: PathFilterConfig) {
    // Always start from immutable defaults
    this.blockedSegments = new Set(IMMUTABLE_BLOCKED_SEGMENTS);
    this.blockedNames = new Set(IMMUTABLE_BLOCKED_NAMES);

    // Add user-provided blocked paths, split into segment vs name checks
    for (const blocked of config.blockedPaths) {
      const normalized = normalizePath(blocked).replace(/\/$/, "");
      if (normalized.includes("/")) {
        // Multi-segment: treat the first segment as the blocking segment
        this.blockedSegments.add(normalized.split("/")[0]);
      } else {
        // Single name — could be a directory name or filename
        this.blockedNames.add(normalized);
        this.blockedSegments.add(normalized);
      }
    }

    this.allowedExtensions =
      config.allowedExtensions.length > 0
        ? new Set(config.allowedExtensions)
        : new Set(DEFAULT_ALLOWED_EXTENSIONS);

    log.debug(
      {
        blockedSegments: [...this.blockedSegments],
        blockedNames: [...this.blockedNames],
        allowedExtensions: [...this.allowedExtensions],
      },
      "PathFilter initialized",
    );
  }

  /**
   * Check if a path is allowed for read/write operations.
   * Verifies both the blocklist and the allowed extension list.
   */
  isAllowed(filePath: string): boolean {
    const normalized = this.normalize(filePath);

    if (this.isBlocked(normalized)) {
      return false;
    }

    const ext = path.extname(normalized).toLowerCase();
    if (!this.allowedExtensions.has(ext)) {
      log.debug({ path: normalized, ext }, "path rejected: extension not allowed");
      return false;
    }

    return true;
  }

  /**
   * Check if a path is allowed for directory listing.
   * Only checks the blocklist — no extension check.
   */
  isAllowedForListing(filePath: string): boolean {
    const normalized = this.normalize(filePath);
    return !this.isBlocked(normalized);
  }

  /**
   * Check if a path is blocked by any segment or name rule.
   * Works on normalized forward-slash paths.
   */
  private isBlocked(normalizedPath: string): boolean {
    // Reject traversal attempts
    if (normalizedPath.includes("..")) {
      log.debug({ path: normalizedPath }, "path rejected: traversal");
      return true;
    }

    const segments = normalizedPath.split("/");

    for (const segment of segments) {
      if (this.blockedSegments.has(segment) || this.blockedNames.has(segment)) {
        log.debug({ path: normalizedPath, segment }, "path rejected: blocked segment");
        return true;
      }
    }

    return false;
  }

  /** Normalize a path to forward slashes for consistent checking. */
  private normalize(filePath: string): string {
    return normalizePath(path.normalize(filePath));
  }
}
