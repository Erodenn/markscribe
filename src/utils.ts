import type { VaultService } from "./types.js";

/** Escape a string for safe use inside a RegExp constructor. */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Recursively walk the vault and collect all file paths,
 * optionally filtered to a scope prefix. Uses eager directory
 * pruning to skip subtrees that can't contain scoped paths.
 */
export async function walkVaultFiles(vault: VaultService, scope?: string): Promise<string[]> {
  const paths: string[] = [];
  await walkDir(vault, "", scope, paths);
  return paths;
}

async function walkDir(
  vault: VaultService,
  relDir: string,
  scope: string | undefined,
  paths: string[],
): Promise<void> {
  let listing;
  try {
    listing = await vault.listDirectory(relDir);
  } catch {
    return;
  }

  for (const entry of listing.entries) {
    if (entry.type === "directory") {
      if (scope !== undefined) {
        const dirPrefix = entry.path + "/";
        // Skip dirs that can't possibly contain scoped paths
        if (
          !entry.path.startsWith(scope) &&
          !scope.startsWith(dirPrefix) &&
          scope !== entry.path
        ) {
          continue;
        }
      }
      await walkDir(vault, entry.path, scope, paths);
    } else {
      if (scope !== undefined && !entry.path.startsWith(scope)) {
        continue;
      }
      paths.push(entry.path);
    }
  }
}
