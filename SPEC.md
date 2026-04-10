# VaultScribe — Convention-Aware Obsidian MCP Server

## Summary

An MCP server for Obsidian vaults that goes beyond file CRUD — it understands vault conventions. Users define schemas that describe how their vault is structured (required frontmatter, folder types, hub files, linking rules), and the server validates, enforces, and assists with those conventions through MCP tools. The differentiator over every existing server: convention awareness is a first-class feature, not something bolted on by the AI client.

## Goals by Phase

### Phase 1 — Core Vault Operations

- Full note CRUD (read, write, patch, delete, move) with atomic writes
- Frontmatter parse/update/merge
- Tag management (add, remove, list — both YAML and inline)
- Directory listing, vault stats, batch reads
- BM25 full-text search with frontmatter-aware filtering
- Path security (traversal prevention, configurable blocklist/allowlist)
- Token-efficient response format (compact by default, pretty-print opt-in)

### Phase 2 — Convention Engine

- YAML schema format for defining vault conventions
- Schema loading from `.vaultscribe/schemas/` at startup (no hot-reload — restart to pick up schema changes)
- Note-level validation: required fields, types, formats, conditional rules, tag constraints
- Folder-level validation: folder type classification, hub detection, structural checks (hub covers children, no orphans)
- Validate-on-demand tools: lint a note, validate a folder/packet, scan a vault area
- Convention-aware note creation: apply the right template + frontmatter based on target folder's schema
- Ship with bundled example schemas (knowledge-packet, zettelkasten, journal, etc.)

### Phase 3 — Link Intelligence

- Wikilink extraction and graph building (forward links, backlinks per note)
- Unlinked mention detection: find plain-text references to note titles that aren't wikilinked
- Broken link detection: wikilinks pointing to non-existent notes
- Wikilink-aware move/rename: when a note moves, update all `[[references]]` across the vault
- Orphan detection: notes with no incoming links within a scope
- Hub coverage analysis: which notes in a folder aren't linked from the hub

### Phase 4 — Distribution & Onboarding

- `npx` distribution via npm
- `init` tool or CLI command: interactive schema scaffolding (guided questions that produce a schema file)
- MCP prompts: bundled prompt templates that teach AI clients how to use conventions
- Documentation, README, project page content

## Tech Stack

- **Runtime:** Node.js (TypeScript, compiled to JS for distribution)
- **MCP SDK:** `@modelcontextprotocol/sdk` (official, no wrapper)
- **Transport:** stdio only
- **Dependencies (runtime):**
  - `@modelcontextprotocol/sdk` — MCP protocol
  - `gray-matter` — YAML frontmatter parse/stringify
  - `zod` — schema validation (bundled with SDK, also used for tool params)
- **Dependencies (dev):** TypeScript, Vitest, tsx

## Architecture Overview

- **Single process, stdio transport.** The server is a Node.js process that speaks MCP over stdin/stdout. No HTTP, no WebSocket, no REST API dependency — pure filesystem access.
- **Service layer architecture.** A thin tool registration layer maps MCP tool calls to service methods. Services are injected at startup, not global singletons. Five services: `VaultService` (file ops), `FrontmatterService` (YAML), `SearchService` (indexing/query), `SchemaEngine` (convention loading/validation), `LinkEngine` (graph/wikilinks).
- **Tool registry pattern.** Tools register themselves in a `Map<string, ToolHandler>` rather than a switch block. Each tool is a self-contained definition (name, schema, handler). Tool files can be grouped by phase/concern.
- **Schema-driven conventions.** Convention rules are defined in YAML schema files, loaded at startup, and compiled into validators. The server never hard-codes vault-specific rules — all convention knowledge comes from schemas.
- **Vault path as config root.** The vault path is the single required argument. Schema files live inside the vault at `.vaultscribe/schemas/`, keeping conventions co-located with the vault they describe. A `config.yaml` at `.vaultscribe/config.yaml` holds server-level settings (path filters, search options).
- **Atomic writes everywhere.** All write operations use write-to-temp-then-rename to prevent corruption on crash and maintain Obsidian Sync compatibility.
- **Fully stateless at runtime.** No persistent index, no SQLite, no file watchers, no in-memory caches. Search and link graph scan on demand every call. Always correct, never stale. Trade-off is speed on large vaults — acceptable for personal use (sub-100ms for ~hundreds of notes).
- **Path security: hardcoded defaults + user extensions.** `.obsidian/`, `.git/`, `node_modules/`, `.DS_Store`, `Thumbs.db` are always blocked and cannot be unblocked. Users can add to the blocklist via `config.yaml` but never remove the defaults.

## Component Map

### Server (`server.ts`)

**Type:** module (entry point)
**Responsibility:** Parse CLI args, instantiate services, register MCP tools, connect transport.

- Tool registry: `Map<string, ToolHandler>` — tools self-register, no switch block
- Service construction with dependency injection
- `StdioServerTransport` connection

### VaultService

**Type:** class
**Responsibility:** All filesystem operations scoped to the vault. Path resolution, security, atomic writes.

- `readNote(path): ParsedNote` — read + frontmatter parse
- `writeNote(path, content, frontmatter?, mode?): void` — atomic write, overwrite/append/prepend
- `patchNote(path, oldString, newString, replaceAll?): void` — string replacement on raw file
- `deleteNote(path, confirmPath): void` — safety-confirmed delete
- `moveNote(oldPath, newPath): MoveResult` — atomic move
- `listDirectory(path): DirectoryListing`
- `readMultipleNotes(paths): BatchResult`
- `getVaultStats(): VaultStats`
- `resolvePath(relativePath): string` — path resolution + traversal check
- `atomicWrite(fullPath, content): void` — write-to-temp-then-rename primitive

### FrontmatterService

**Type:** class
**Responsibility:** YAML frontmatter parsing, serialization, and field manipulation. Wraps `gray-matter`.

- `parse(rawContent): { frontmatter, content, raw }`
- `stringify(frontmatter, content): string`
- `updateFields(path, fields, merge?): void` — update specific keys without touching content
- `manageTags(path, operation, tags?): TagResult` — add/remove/list, handles YAML + inline

### SearchService

**Type:** class
**Responsibility:** Full-text search with BM25 ranking. No persistent index.

- `search(query, options?): SearchResult[]` — options: scope (path prefix), searchContent, searchFrontmatter, limit
- `searchByFrontmatter(field, value, operator?): SearchResult[]` — field-level queries

### SchemaEngine

**Type:** class
**Responsibility:** Load convention schemas, classify folders, validate notes and packets against schemas.

- `loadSchemas(schemasDir): void` — parse YAML schema files, compile into validators
- `getSchemaForPath(notePath): Schema | null` — resolve which schema applies to a given path
- `lintNote(path): LintResult` — validate a single note against its applicable schema
- `validateFolder(path): FolderValidation` — classify folder type, run structural checks
- `validateArea(path): AreaValidation` — recursive validation of a vault subtree
- `getTemplate(schemaName, noteType?): NoteTemplate` — return frontmatter + content template for convention-aware creation
- `listSchemas(): SchemaInfo[]` — list loaded schemas with their scopes

### LinkEngine

**Type:** class
**Responsibility:** Wikilink parsing, vault-wide link graph, mention detection, reference updates.

- `extractLinks(content): WikiLink[]` — parse `[[target|display]]` and `[[target#section]]` from markdown
- `buildGraph(scope?): LinkGraph` — scan files, build directed adjacency map
- `getBacklinks(notePath): BacklinkEntry[]` — who links to this note
- `findUnlinkedMentions(notePath): UnlinkedMention[]` — plain-text references that should be wikilinks
- `findBrokenLinks(scope?): BrokenLink[]` — wikilinks to non-existent notes
- `findOrphans(scope?): string[]` — notes with no incoming links
- `propagateRename(oldStem, newStem, scope?): RenameResult` — update all `[[oldStem]]` references vault-wide

### PathFilter

**Type:** class
**Responsibility:** Path security and access control. Blocklist/allowlist evaluation.

- `isAllowed(path): boolean` — for read/write operations (extension-restricted)
- `isAllowedForListing(path): boolean` — for directory traversal (any extension)
- Default blocklist: `.obsidian/`, `.git/`, `node_modules/`, `.DS_Store`, `Thumbs.db`
- Configurable via `.vaultscribe/config.yaml`

## Central Contracts

### Schema Format

The schema format is the core abstraction — it's what makes conventions portable and user-definable instead of hard-coded. Every Phase 2+ feature depends on it.

#### Schema File Structure

```yaml
name: string # unique identifier, used in tool responses and cross-references
description: string # human-readable purpose
scope:
  paths: string[] # vault-relative prefixes this schema governs (e.g. "Knowledge/")
  exclude: string[] # opt-out prefixes within scope (e.g. "Knowledge/_Inbox/")

frontmatter:
  fields:
    <fieldName>:
      type: string | list | number | boolean # YAML type
      required: boolean # default false
      format: string # regex pattern the value must match (strings only)
      when: <Condition> # field is only required/validated when condition is true
      constraints: <Constraint[]> # additional validation rules (primarily for lists)

content:
  rules: <ContentRule[]> # checks applied to note body (frontmatter stripped)

folders: # optional — omit if schema only validates individual notes
  classification: <FolderClassification>
  hub: <HubConfig>
  structural: <StructuralRule[]>
```

#### Scope Resolution

A note's path is matched against all loaded schemas. Rules:

1. A schema matches if the note's path starts with any `scope.paths` prefix AND does not start with any `scope.exclude` prefix.
2. **Most specific wins.** When multiple schemas match, the one with the longest matching `scope.paths` prefix is selected. Example: a schema scoped to `Knowledge/Programming/` beats one scoped to `Knowledge/` for a note at `Knowledge/Programming/Rust/note.md`.
3. **Ties are an error.** If two schemas have equally-long matching prefixes, the server logs a warning at startup and the first loaded (alphabetical by filename) wins. This is a misconfiguration — schemas should not have overlapping scopes at equal specificity.
4. A note with no matching schema is unmanaged — CRUD tools work normally, validation tools return `schema: null` with no checks.

#### Field Types

| Type      | YAML representation   | Validation                                |
| --------- | --------------------- | ----------------------------------------- |
| `string`  | Scalar string         | Must be a string, non-empty if `required` |
| `list`    | YAML sequence `[...]` | Must be an array                          |
| `number`  | Numeric scalar        | Must be a number                          |
| `boolean` | `true` / `false`      | Must be boolean                           |

#### Conditions (`when`)

Conditions gate whether a field is required or validated. If the condition is false, the field is skipped entirely (not flagged as missing even if `required: true`).

| Condition    | Syntax                                                | Semantics                                                    |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------ |
| Tag present  | `{ tagPresent: "hub" }`                               | True if the note's `tags` list contains the value            |
| Field equals | `{ fieldEquals: { field: "type", value: "source" } }` | True if the named frontmatter field equals the value         |
| Field exists | `{ fieldExists: "related" }`                          | True if the named frontmatter field is present and non-empty |

#### Constraints (for fields)

Constraints are an array applied to a field's value. All constraints must pass.

| Constraint         | Syntax                             | Applies to     | Semantics                                                                      |
| ------------------ | ---------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| Min items          | `minItems: N`                      | list           | List must have >= N items                                                      |
| Max items          | `maxItems: N`                      | list           | List must have <= N items                                                      |
| Exact items        | `exactItems: N`                    | list           | List must have exactly N items                                                 |
| At least one match | `atLeastOne: { matches: "regex" }` | list           | At least one item matches the regex                                            |
| All match          | `allMatch: "regex"`                | list           | Every item matches the regex                                                   |
| First equals       | `firstEquals: "template"`          | list           | First item equals the template string (after variable expansion)               |
| Enum               | `enum: [values]`                   | string, number | Value must be one of the listed values                                         |
| Pattern            | `pattern: "regex"`                 | string         | Value must match the regex (equivalent to `format` but in constraint position) |

#### Template Variables

Used in `firstEquals`, hub detection patterns, and `create_note` templates. Expanded at validation/creation time.

| Variable         | Expansion                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `{{stem}}`       | Filename without extension, leading `_` stripped. `_CompilerDesign.md` → `CompilerDesign` |
| `{{filename}}`   | Filename without extension, as-is. `_CompilerDesign.md` → `_CompilerDesign`               |
| `{{folderName}}` | Name of the immediate parent folder                                                       |
| `{{today}}`      | Current date as `YYYY-MM-DD`                                                              |

#### Content Rules (built-in checks)

Content rules run against the note body with frontmatter stripped. Each rule has a `name` (user-chosen, appears in lint results) and a `check` (built-in check identifier).

| Check ID               | Parameters         | Semantics                                                                             |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `hasPattern`           | `pattern: "regex"` | Body must contain at least one match for the regex                                    |
| `noPattern`            | `pattern: "regex"` | Body must not contain any match for the regex                                         |
| `noSelfWikilink`       | none               | Body must not contain `[[stem]]` or `[[stem\|...]]` where stem is the note's own stem |
| `noMalformedWikilinks` | none               | No empty links `[[]]`, `[[                                                            | ]]`, `[[#]]`; no unterminated `[[` without matching `]]` on the same line |
| `minWordCount`         | `count: N`         | Body must contain at least N words                                                    |

#### Folder Classification

```yaml
folders:
  classification:
    supplemental: ["Resources", "References"] # folder names that auto-pass validation
    skip: ["_Inbox"] # folder names excluded from validation entirely
    # superfolder: auto-detected — has subdirectories but no direct .md files
    # packet: default — has direct .md files
```

#### Hub Configuration

```yaml
folders:
  hub:
    detection: # tried in order, first match wins
      - pattern: "_{folderName}.md" # preferred naming convention
      - pattern: "{folderName}.md" # legacy/alternate
      - fallback: { tagPresent: "hub" } # any file with hub tag
    required: true # if true, missing hub = validation failure
```

**Multi-candidate resolution:** Detection patterns are tried in order. If `_{folderName}.md` exists, it is the hub regardless of whether `{folderName}.md` also exists. The `fallback` only runs if no pattern matches. If the fallback finds multiple files with the `hub` tag, this is a validation error: "multiple hub candidates found" with the conflicting paths listed.

#### Structural Rules (built-in checks)

Structural rules validate relationships between notes within a classified folder. Only run on `packet` type folders.

| Check ID            | Semantics                                                                                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hubCoversChildren` | Hub file must contain wikilinks (after stripping display text and section anchors) to: every sibling `.md` file in the folder, and the hub file of each immediate subdirectory. Link matching uses stem comparison with leading `_` stripped. |
| `noOrphansInFolder` | Every non-hub note in the folder must be referenced by at least one wikilink from any other note in the same folder (hub or sibling).                                                                                                         |

#### Full Example

```yaml
# .vaultscribe/schemas/knowledge-packet.yaml
name: knowledge-packet
description: Structured knowledge packets with hub files
scope:
  paths: ["Knowledge/"]
  exclude: ["Knowledge/_Inbox/"]

frontmatter:
  fields:
    tags:
      type: list
      required: true
      constraints:
        - minItems: 1
        - atLeastOne: { matches: ".*/.+" }
    created:
      type: string
      required: true
      format: "\\d{4}-\\d{2}-\\d{2}"
    updated:
      type: string
      required: true
      format: "\\d{4}-\\d{2}-\\d{2}"
    source:
      type: string
      required: true
    aliases:
      type: list
      required: true
      when: { tagPresent: "hub" }
      constraints:
        - exactItems: 1
        - firstEquals: "{{stem}}"

content:
  rules:
    - name: has-outgoing-link
      check: hasPattern
      pattern: "\\[\\[.+?\\]\\]|\\[.+?\\]\\(https?://.+?\\)"
    - name: no-self-links
      check: noSelfWikilink
    - name: no-malformed-wikilinks
      check: noMalformedWikilinks

folders:
  classification:
    supplemental: ["Resources", "References"]
    skip: ["_Inbox"]
  hub:
    detection:
      - pattern: "_{folderName}.md"
      - pattern: "{folderName}.md"
      - fallback: { tagPresent: "hub" }
    required: true
  structural:
    - name: hub-links-all-children
      check: hubCoversChildren
    - name: no-orphan-notes
      check: noOrphansInFolder
```

### Error Response Contract

Tools return two categories of response:

**MCP errors** (`isError: true`) — the operation could not be performed. The client asked for something that failed.

- Path does not exist (read, patch, delete, move source)
- Path traversal attempt (any operation)
- Path blocked by PathFilter (any operation)
- `patch_note` `oldString` not found in file
- `patch_note` `oldString` has multiple matches but `replaceAll` is false
- `delete_note` `confirmPath` does not match `path`
- `move_note` destination already exists
- Malformed schema file at startup → logged to stderr, schema skipped (server continues)
- Invalid vault path at startup → server exits with error

**Successful responses with embedded status** — the operation completed and is reporting results.

- `lint_note` returns `LintResult` with `pass: false` — the note was read and validated, it just didn't pass
- `validate_folder` returns `FolderValidation` with `pass: false` — same
- `create_note` returns the created note + its `LintResult` (which may have `pass: false` if overrides produced invalid frontmatter)
- `search_notes` returns empty results — not an error, just no matches
- `find_broken_links` returns a list — empty list means no broken links, not an error

**Rule of thumb:** If the tool did what it was asked and is reporting what it found, it's a success. If it couldn't do what it was asked, it's an error.

### Validation Result Shapes

Validation results flow through every tool that checks conventions. A consistent shape means clients can render results uniformly.

```typescript
interface LintResult {
  path: string;
  pass: boolean;
  schema: string | null; // which schema was applied, null if none matched
  checks: Check[];
}

interface Check {
  name: string; // e.g. "field_tags_present", "has_outgoing_link"
  pass: boolean;
  detail: string; // human-readable explanation on failure
}

interface FolderValidation {
  path: string;
  pass: boolean;
  folderType: "packet" | "superfolder" | "supplemental" | "unclassified";
  schema: string | null;
  notes: Record<string, LintResult>;
  structural: Check[]; // folder-level checks (hub coverage, orphans)
}

interface AreaValidation {
  path: string;
  pass: boolean;
  schema: string | null;
  folders: Record<string, FolderValidation>; // keyed by folder path
  summary: {
    total: number; // total folders scanned
    passed: number;
    failed: number;
    skipped: number; // supplemental + skip folders
  };
}
```

## Tool Inventory

### Phase 1 Tools

| Tool                  | Description                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `read_note`           | Read note with parsed frontmatter and content                                             |
| `write_note`          | Create or overwrite/append/prepend to a note (atomic)                                     |
| `patch_note`          | String replacement within a note                                                          |
| `delete_note`         | Delete with path confirmation                                                             |
| `move_note`           | Move/rename a note (atomic). Phase 1: no link updates. Phase 3: gains `updateLinks` param |
| `read_multiple_notes` | Batch read (max 10)                                                                       |
| `list_directory`      | List files and subdirectories                                                             |
| `get_vault_stats`     | Note count, size, recent files                                                            |
| `search_notes`        | BM25 full-text search                                                                     |
| `get_frontmatter`     | Read frontmatter only                                                                     |
| `update_frontmatter`  | Merge or replace frontmatter fields                                                       |
| `manage_tags`         | Add/remove/list tags (YAML + inline)                                                      |

### Phase 2 Tools

| Tool              | Description                                      |
| ----------------- | ------------------------------------------------ |
| `lint_note`       | Validate a note against its applicable schema    |
| `validate_folder` | Classify + validate a folder/packet              |
| `validate_area`   | Recursive validation of a vault subtree          |
| `list_schemas`    | List loaded schemas with scopes and descriptions |
| `create_note`     | Convention-aware creation (see spec below)       |

#### `create_note` Specification

Convention-aware note creation. Resolves the applicable schema, applies template frontmatter, and validates the result.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Vault-relative path for the new note |
| `content` | string | no | Note body content (default: empty) |
| `frontmatter` | object | no | Frontmatter overrides — merged on top of template defaults |
| `schema` | string | no | Explicit schema name. If omitted, resolved from `path` via scope rules |

**Behavior:**

1. Resolve schema: use explicit `schema` param, or auto-detect from `path` via scope rules.
2. If schema found: build template frontmatter from the schema's required fields (e.g. `created: {{today}}`, `updated: {{today}}`). Merge `frontmatter` overrides on top.
3. If no schema matches: behave like `write_note` — create the note with the provided content and frontmatter as-is. No validation.
4. Write the note atomically.
5. If schema was applied: run `lint_note` on the created file and include the `LintResult` in the response.

**Returns:** `{ path, frontmatter, lintResult: LintResult | null }`

**Errors:** Path already exists (use `write_note` with overwrite mode for existing files). Named schema not found.

### Phase 3 Tools

| Tool                     | Description                                    |
| ------------------------ | ---------------------------------------------- |
| `get_backlinks`          | Find all notes linking to a given note         |
| `find_unlinked_mentions` | Plain-text references that should be wikilinks |
| `find_broken_links`      | Wikilinks to non-existent notes                |
| `find_orphans`           | Notes with no incoming links in a scope        |

#### `move_note` Link Update (Phase 3 Enhancement)

Phase 3 adds an `updateLinks` parameter (boolean, default `false`) to the existing `move_note` tool. When `true`, after moving the file, `LinkEngine.propagateRename` updates all `[[oldStem]]` references vault-wide. This handles:

- `[[OldName]]` → `[[NewName]]`
- `[[OldName|Display Text]]` → `[[NewName|Display Text]]` (display text preserved)
- `[[OldName#Section]]` → `[[NewName#Section]]` (section anchors preserved)
- `[[Folder/OldName]]` → `[[NewFolder/NewName]]` (path-style wikilinks updated)

No separate `move_note_with_links` tool — it's one tool with a progressive capability.

### Phase 4 Additions

| Addition      | Description                                                   |
| ------------- | ------------------------------------------------------------- |
| `init_schema` | Guided schema scaffolding tool                                |
| MCP Prompts   | System prompt fragments teaching AI clients vault conventions |
| MCP Resources | Expose loaded schemas as readable resources                   |

## Config Structure

```
vault-root/
├── .vaultscribe/
│   ├── config.yaml         # server-level settings
│   └── schemas/
│       ├── my-schema.yaml  # user-defined convention schemas
│       └── ...
├── .obsidian/              # blocked by default
└── ... vault content ...
```

### config.yaml

```yaml
# .vaultscribe/config.yaml
schemas:
  directory: schemas/ # relative to .vaultscribe/
  # Or absolute path for schemas stored outside the vault

paths:
  blocked: # added to default blocklist
    - "Archive/"
    - ".trash/"
  allowed_extensions: # for read/write (default: .md, .markdown, .txt)
    - ".md"
    - ".markdown"
    - ".txt"

search:
  max_results: 50 # default result cap
  excerpt_chars: 40 # context window around matches

responses:
  compact: true # minified keys by default
```

## Resolved Decisions

| Decision                | Resolution                          | Rationale                                                                                 |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Server name             | `vaultscribe`                       | Available on npm. Combines vault + scribe (convention enforcer). No brand conflicts.      |
| Config directory        | `.vaultscribe/` in vault root       | Branded, avoids collision with other MCP servers, co-located with vault.                  |
| Schema reload           | Startup-only                        | Schemas rarely change. Restart to pick up edits. No file watcher complexity.              |
| Path blocklist          | Hardcoded defaults + config extends | `.obsidian/`, `.git/`, etc. always blocked. Config can only add, never remove defaults.   |
| Graph caching           | No cache — rebuild per call         | Stateless, always correct. Personal vault scale makes full scans trivially fast (<100ms). |
| MCP Resources & Prompts | Deferred to Phase 4+                | Need user guidance on these features before designing them.                               |

## Open Decisions

- **Search index persistence.** Phase 1 does scan-on-demand (no index). If this proves too slow on larger vaults, a future enhancement could add an optional persistent index. Decision deferred — build stateless first, optimize if needed.
