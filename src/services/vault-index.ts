import type { FileService } from "../types.js";
import { getStem, walkFiles } from "../utils.js";
import { createChildLog } from "../markscribe-log.js";

const log = createChildLog({ service: "VaultIndex" });

/**
 * Lowercased lookup index over a vault: stems (filename without extension and
 * leading underscore) plus aliases declared in note frontmatter.
 *
 * Build cost is O(N) reads — one per note in the (optionally scoped) tree —
 * because `aliases:` lives in YAML frontmatter. Architecturally consistent
 * with the stateless model: the index is rebuilt per validation run, never
 * cached across calls.
 */
export interface VaultIndex {
  /** Lowercased stems of every note path in scope */
  stems: Set<string>;
  /** Lowercased aliases collected from `aliases:` frontmatter arrays */
  aliases: Set<string>;
  /**
   * Resolve a wikilink target string to whether it references something in the
   * vault. Strips section anchor (`Note#Section`), folder prefix
   * (`Folder/Note`), leading underscore, and lowercases before lookup.
   */
  resolve(target: string): boolean;
}

/**
 * Build a vault index by walking the tree and reading each note for aliases.
 * Partial I/O failures are non-fatal — a single unreadable note is logged at
 * `debug` and skipped.
 */
export async function buildVaultIndex(
  file: FileService,
  scope?: string,
): Promise<VaultIndex> {
  const stems = new Set<string>();
  const aliases = new Set<string>();

  const files = await walkFiles(file, scope);

  for (const filePath of files) {
    stems.add(getStem(filePath).toLowerCase());

    try {
      const note = await file.readNote(filePath);
      const fmAliases = note.frontmatter["aliases"];
      if (Array.isArray(fmAliases)) {
        for (const a of fmAliases) {
          if (typeof a === "string" && a.length > 0) {
            aliases.add(a.toLowerCase());
          }
        }
      }
    } catch (err) {
      log.debug({ err, path: filePath }, "buildVaultIndex: skipping unreadable note");
    }
  }

  log.debug(
    { scope, fileCount: files.length, stemCount: stems.size, aliasCount: aliases.size },
    "buildVaultIndex complete",
  );

  return {
    stems,
    aliases,
    resolve(target: string): boolean {
      if (!target) return false;
      let t = target.trim();

      // Strip section anchor
      const hashIdx = t.indexOf("#");
      if (hashIdx >= 0) t = t.slice(0, hashIdx);

      // Strip folder prefix
      if (t.includes("/")) {
        const parts = t.split("/");
        t = parts[parts.length - 1];
      }

      t = t.trim();
      if (!t) return false;

      // Strip leading underscore
      if (t.startsWith("_")) t = t.slice(1);

      const lower = t.toLowerCase();
      return stems.has(lower) || aliases.has(lower);
    },
  };
}
