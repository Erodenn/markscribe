# MarkScribe

[![npm version](https://img.shields.io/npm/v/markscribe)](https://www.npmjs.com/package/markscribe)
[![License: MIT](https://badgen.net/github/license/Erodenn/markscribe)](LICENSE)
[![Node.js](https://img.shields.io/node/v/markscribe)](https://nodejs.org/)

A convention-aware markdown [MCP](https://modelcontextprotocol.io/) server for AI assistants. Point it at a directory of markdown files and it gives the AI read, write, search, wikilink, and validation tools, enforcing your conventions through user-defined YAML schemas rather than hard-coded vault assumptions.

Works with Obsidian vaults, Foam workspaces, Logseq graphs, digital gardens, documentation repos, or any plain markdown directory. Nothing about the format is assumed. If your directory has its own rules — required frontmatter, hub notes, filename patterns, link constraints — you express them as schemas and MarkScribe enforces them.

**The distinction matters:** conventions are enforced, not assumed. A schema-less directory still gets the full read/write/search/link toolkit; a schema-driven directory additionally gets structural validation, convention-aware note creation, and lint feedback on every file.

## What It Does

**Read, write, search.** 22 tools for AI assistants to operate on markdown: atomic read/write/move/delete, batch reads, frontmatter-aware patching, and full-text BM25 search across body and frontmatter.

**Wikilink graph.** Backlinks, broken link detection, orphan finding, and plain-text mention discovery. The graph rebuilds on every call, so there is no stale index or cache to invalidate.

**Schema validation.** User-defined YAML note and folder schemas. Note schemas validate frontmatter fields and content rules; folder schemas classify directories, assign note schemas by role, and enforce structural constraints. `_conventions.md` files scope schemas to subtrees so the same directory can host multiple conventions.

**Path security.** `.obsidian/`, `.git/`, `node_modules/`, `.DS_Store`, and `Thumbs.db` are always blocked. User config can extend the blocklist, never shrink it. Atomic writes everywhere, so a crashed process never leaves a torn file.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- A directory of markdown files

### Install

```bash
npm install -g markscribe
```

Or run directly via `npx`, no install step. The MCP config below shows both.

### Configure Your MCP Client

Add the following to your MCP client config. Works with Claude Code, Claude Desktop, Cursor, or any MCP-compatible client.

**Zero-install via npx (recommended):**

```json
{
  "mcpServers": {
    "markscribe": {
      "command": "npx",
      "args": ["-y", "markscribe", "--root", "/path/to/your/notes"]
    }
  }
}
```

**Or install globally:**

```json
{
  "mcpServers": {
    "markscribe": {
      "command": "markscribe",
      "args": ["--root", "/path/to/your/notes"]
    }
  }
}
```

`--root` is the directory MarkScribe will serve. To load your own schemas, add `"--schemas-dir", "/path/to/schemas"`. Otherwise `~/.markscribe/schemas/` is used.

### Verify

Ask your AI assistant to call `get_stats`. If it returns a note count and recent files, you're connected.

## CLI flags

| Flag | Default | Description |
|---|---|---|
| `--root <path>` | Current working directory | Root directory to serve |
| `--schemas-dir <path>` | `~/.markscribe/schemas/` | Directory to load schema YAML files from |
| `--log-level <level>` | `info` | Log level (`debug`, `info`, `warn`, `error`, `fatal`) |

## Per-directory config

Place a `.markscribe/config.yaml` in your root directory:

```yaml
paths:
  blocked:
    - private/
    - drafts/
  allowed_extensions:
    - .md
    - .markdown
    - .txt
search:
  max_results: 50
  excerpt_chars: 40
```

The built-in security blocklist (`.obsidian/`, `.git/`, `node_modules/`, `.DS_Store`, `Thumbs.db`) is always enforced on top of user config.

## Schemas (the short version)

Schemas are YAML files defining conventions for notes and folders. Note schemas validate frontmatter and content; folder schemas classify directories and assign note schemas by role.

**Note schema.** Validates frontmatter fields and content rules:

```yaml
name: blog-post
description: Blog post with required metadata
type: note
frontmatter:
  fields:
    title: { type: string, required: true }
    tags: { type: list, required: true }
content:
  rules:
    - name: has-outgoing-link
      check: hasPattern
      pattern: "\\[\\[.+?\\]\\]"
```

**Folder schema.** Enforces structural rules on directories:

```yaml
name: project-folder
description: Project folder with hub note
type: folder
noteSchemas:
  default: blog-post
  hub: project-hub
classification:
  supplemental: [assets, templates]
  skip: [archive]
hub:
  detection:
    - pattern: "_{{folderName}}"
  required: true
```

Notes opt into a schema via `note_schema: <name>` in frontmatter, or inherit one from a `_conventions.md` file higher in the tree. The convention cascade resolves schema on a per-note basis.

> Full schema reference, all field types, all check types, and the cascade resolution order: [docs/schemas.md](docs/schemas.md).

## Tools

| Tool | Description |
|---|---|
| `list_directory` | List files and subdirectories |
| `get_stats` | Note count, total size, recent files |
| `switch_directory` | Change the active root directory |
| `read_note` | Read a note with parsed frontmatter |
| `write_note` | Create or update a note |
| `patch_note` | String replacement within a note |
| `delete_note` | Delete a note (with confirmation) |
| `move_note` | Move/rename with optional link updates |
| `read_multiple_notes` | Batch read up to 10 notes |
| `create_note` | Convention-aware note creation |
| `get_frontmatter` | Read YAML frontmatter only |
| `update_frontmatter` | Merge or replace frontmatter fields |
| `manage_tags` | Add, remove, or list tags |
| `search_notes` | Full-text BM25 search |
| `lint_note` | Validate a note against its schema |
| `validate_folder` | Classify and validate a folder |
| `validate_area` | Recursive subtree validation |
| `validate_all` | Full directory tree validation |
| `list_schemas` | List all loaded schemas |
| `get_backlinks` | Find notes linking to a note |
| `find_broken_links` | Find wikilinks to non-existent notes |
| `find_orphans` | Find notes with no incoming links |
| `find_unlinked_mentions` | Find plain-text mentions that should be wikilinks |

## Compatible viewers

MarkScribe works with any tool that reads markdown files:

- [Obsidian](https://obsidian.md/): PKM app with graph view and community plugins
- [Foam](https://foambubble.github.io/foam/): VS Code extension for linked notes
- [Logseq](https://logseq.com/): outliner with bidirectional links
- Any text editor or static site generator

## Architecture

MarkScribe is stateless at runtime. There are no persistent indexes, caches, or file watchers; search and the link graph rebuild on every call, so results are always correct and never stale. Services (file, frontmatter, search, schema engine, link graph) are constructed via `buildServices()` and injected through a mutable `ServiceContainer`, which lets `switch_directory` rebuild the full service stack at runtime without re-registering tools. All file writes go through `atomicWrite` (write-to-temp-then-rename) so a crashed process never leaves a torn file. Convention knowledge is schema-driven: the server hard-codes no directory assumptions, only the inviolable path-security defaults.

## Development

```bash
# Build
npm run build

# Test (vitest)
npm test
npm run test:watch
npm run test:coverage

# Lint and format
npm run lint
npm run lint:fix
npm run format
npm run format:check

# Type check
npx tsc --noEmit
```

Stdio transport: stdout is reserved for JSON-RPC, all human/debug output goes to stderr. Run tests after changes to services (`src/services/`) or the schema engine.

## Acknowledgements

Built with [Claude Code](https://claude.ai/code).

## License

[MIT](LICENSE)
