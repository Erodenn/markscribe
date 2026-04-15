# VaultScribe

Convention-aware Obsidian vault server for the [Model Context Protocol](https://modelcontextprotocol.io/). VaultScribe lets AI agents read, write, search, and validate notes in an Obsidian vault — enforcing your vault's conventions through user-defined YAML schemas.

## Features

- Read, write, move, and delete notes with atomic file operations
- Full-text search (BM25 ranking) across vault content and frontmatter
- Wikilink-aware: backlinks, broken link detection, orphan finding, unlinked mention discovery
- YAML frontmatter parsing, validation, and bulk updates
- Tag management (frontmatter and inline)
- Convention enforcement via schemas — note schemas validate frontmatter/content, folder schemas enforce structural rules
- Convention cascade: `_conventions.md` files scope schemas to directory subtrees
- Multi-vault support with named vault aliases
- Path security: `.obsidian/`, `.git/`, `node_modules/` always blocked

## Installation

```bash
npm install -g vaultscribe
```

Or run directly:

```bash
npx vaultscribe
```

## Configuration

Add to your MCP client config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "vaultscribe": {
      "command": "npx",
      "args": ["vaultscribe"],
      "env": {
        "VAULT_PATH": "/path/to/your/obsidian/vault"
      }
    }
  }
}
```

### Multi-vault setup

Create `~/.vaultscribe/config.yaml` to define named vaults:

```yaml
vaults:
  personal:
    path: /path/to/personal/vault
  work:
    path: /path/to/work/vault
defaultVault: personal
```

Switch between vaults at runtime using the `switch_vault` tool.

## Schemas

VaultScribe enforces conventions through YAML schemas. Place schema files in a `.vaultscribe/schemas/` directory in your vault root.

**Note schemas** validate individual notes — required frontmatter fields, allowed values, content rules.

**Folder schemas** validate directory structure — which note schemas apply to which roles, structural constraints, hub configuration.

The **convention cascade** lets you scope schemas to subtrees by placing `_conventions.md` files with schema assignments in any directory.

## Development

```bash
npm install
npm test          # vitest
npm run lint      # eslint
npm run build     # tsc
```
