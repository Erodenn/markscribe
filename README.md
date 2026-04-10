# MarkScribe

Convention-aware markdown MCP server for the [Model Context Protocol](https://modelcontextprotocol.io/). MarkScribe lets AI agents read, write, search, and validate markdown files — enforcing conventions through user-defined YAML schemas. Works with any markdown directory: Obsidian vaults, Foam workspaces, digital gardens, documentation repos.

## Features

- Read, write, move, and delete notes with atomic file operations
- Full-text search (BM25 ranking) across content and frontmatter
- Wikilink-aware: backlinks, broken link detection, orphan finding, unlinked mention discovery
- YAML frontmatter parsing, validation, and bulk updates
- Tag management (frontmatter and inline)
- Convention enforcement via schemas — note schemas validate frontmatter/content, folder schemas enforce structural rules
- Convention cascade: `_conventions.md` files scope schemas to directory subtrees
- Path security: `.obsidian/`, `.git/`, `node_modules/` always blocked

## Installation

```bash
npm install -g markscribe
```

## Usage

### As an MCP server

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

### CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--root <path>` | Current working directory | Root directory to serve |
| `--schemas-dir <path>` | `~/.markscribe/schemas/` | Directory to load schema YAML files from |
| `--log-level <level>` | `info` | Log level (`debug`, `info`, `warn`, `error`, `fatal`) |

### Per-directory config

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

### Schemas

Schemas define conventions for your notes and folders. Place them in your schemas directory (`~/.markscribe/schemas/` by default).

**Note schema** — validates frontmatter fields and content rules:

```yaml
name: blog-post
description: Blog post with required metadata
type: note
frontmatter:
  fields:
    title:
      type: string
      required: true
    tags:
      type: list
      required: true
content:
  rules:
    - name: has-outgoing-link
      check: hasPattern
      pattern: "\\[\\[.+?\\]\\]"
```

**Folder schema** — enforces structural rules on directories:

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

Notes opt into schemas via `note_schema: <name>` in frontmatter, or automatically via the convention cascade (`_conventions.md` files).

## Tools

| Tool | Description |
|------|-------------|
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

- [Obsidian](https://obsidian.md/) — PKM app with graph view and community plugins
- [Foam](https://foambubble.github.io/foam/) — VS Code extension for linked notes
- [Logseq](https://logseq.com/) — Outliner with bidirectional links
- Any text editor or static site generator

## Acknowledgements

Built with [Claude Code](https://github.com/anthropics/claude-code).

## License

MIT
