# VaultScribe Build Plan

## Dependency Graph

```
PathFilter (no deps)
    |
VaultService (depends on PathFilter)
    |
    +-- FrontmatterService (depends on VaultService)
    |       |
    |       +-- SearchService (depends on VaultService, FrontmatterService)
    |       +-- SchemaEngine (depends on VaultService, FrontmatterService)
    |
    +-- LinkEngine (depends on VaultService)

server.ts (constructs all services, registers all tools)
```

Tools depend on services but never the reverse. ESLint enforces this boundary.

---

## Phase 0: Foundation

**Goal:** Install runtime deps, define shared types, scaffold server entry point.

**Milestone:** `npm install` succeeds. `npx tsc --noEmit` passes with new files. `npm test` still passes.

### Task 0A: Install runtime dependencies

- **What:** `npm install @modelcontextprotocol/sdk gray-matter zod`
- **Files:** `package.json`, `package-lock.json`
- **Parallel:** None — gates everything else
- **Notes:** One-command task. Conductor can do this directly.

### Task 0B: Define shared types (`src/types.ts`)

- **What:** Create `src/types.ts` with all shared interfaces from `docs/contracts.ts`. This is the single source of truth for all type definitions across services and tools.
- **Files:** `src/types.ts`
- **Depends on:** 0A
- **Parallel with:** 0C

### Task 0C: Scaffold server entry point and tool registry

- **What:** Create `src/server.ts` with CLI arg parsing (vault path from `process.argv`), MCP `Server` instantiation, `StdioServerTransport` connection, `tools/list` and `tools/call` handlers delegating to a `Map<string, ToolHandler>`. Create `src/tools/index.ts` as barrel exporting `registerTools(registry, services)`. Server should be startable even with no tools registered.
- **Files:** `src/server.ts`, `src/tools/index.ts`
- **Depends on:** 0A
- **Parallel with:** 0B

**Gate:** `npx tsc --noEmit` passes, `npm test` passes.

---

## Phase 1: Core Services

**Goal:** Build PathFilter and VaultService — the foundation everything else depends on.

**Milestone:** Both services pass unit tests. atomicWrite verified. Path traversal attacks blocked.

### Task 1A: Implement PathFilter

- **What:** `src/services/path-filter.ts` + `src/services/path-filter.test.ts`
- Constructor takes `PathFilterConfig` (blocked paths, allowed extensions)
- Hardcoded immutable defaults: `.obsidian/`, `.git/`, `node_modules/`, `.DS_Store`, `Thumbs.db`
- `isAllowed(path): boolean` — read/write ops (checks extension + blocklist)
- `isAllowedForListing(path): boolean` — directory traversal (no extension check)
- **Tests:** traversal (`../`), case sensitivity, immutable defaults can't be overridden, nested blocked paths
- **Files:** `src/services/path-filter.ts`, `src/services/path-filter.test.ts`
- **Parallel:** None — first task in phase

### Task 1B: Implement VaultService

- **What:** `src/services/vault-service.ts` + `src/services/vault-service.test.ts`
- Constructor takes `vaultPath: string` and `pathFilter: PathFilter`
- Methods: `resolvePath()`, `atomicWrite()`, `readNote()`, `writeNote()` (overwrite/append/prepend), `patchNote()`, `deleteNote()` (confirmPath safety), `moveNote()`, `listDirectory()`, `readMultipleNotes()` (max 10), `getVaultStats()`
- **Tests:** atomicWrite crash safety, all write modes, patch edge cases (no match, multiple matches), path traversal rejection, readMultiple cap enforcement
- **Files:** `src/services/vault-service.ts`, `src/services/vault-service.test.ts`
- **Depends on:** 1A
- **Parallel:** Sequential after 1A

**Gate:** `npm test` passes (PathFilter + VaultService tests), `npm run lint` passes, `npx tsc --noEmit` passes.

---

## Phase 2: Remaining Services

**Goal:** Build FrontmatterService, LinkEngine, SearchService, SchemaEngine.

**Milestone:** All 6 services pass tests. Schema loading and validation work.

### Task 2A: Implement FrontmatterService

- **What:** `src/services/frontmatter-service.ts` + test
- Constructor takes `VaultService`
- Methods: `parse()` (wraps gray-matter), `stringify()`, `updateFields()` (merge or replace via atomicWrite), `manageTags()` (add/remove/list, YAML + inline `#tag`)
- **Tests:** round-trip parse/stringify, merge vs replace, tag ops on YAML-only/inline-only/mixed, empty/missing frontmatter
- **Files:** `src/services/frontmatter-service.ts`, `src/services/frontmatter-service.test.ts`
- **Depends on:** Phase 1
- **Parallel with:** 2B

### Task 2B: Implement LinkEngine

- **What:** `src/services/link-engine.ts` + test
- Constructor takes `VaultService`
- Methods: `extractLinks()`, `buildGraph()`, `getBacklinks()`, `findUnlinkedMentions()`, `findBrokenLinks()`, `findOrphans()`, `propagateRename()`
- **Tests:** wikilink parsing edge cases (`[[target]]`, `[[target|display]]`, `[[target#section]]`), graph building, broken link detection, rename propagation across files
- **Files:** `src/services/link-engine.ts`, `src/services/link-engine.test.ts`
- **Depends on:** Phase 1
- **Parallel with:** 2A

### Task 2C: Implement SearchService

- **What:** `src/services/search-service.ts` + test
- Constructor takes `VaultService`, `FrontmatterService`
- Methods: `search()` with BM25 ranking (implement from scratch, no external dep), `searchByFrontmatter()`
- Options: scope (path prefix), searchContent/searchFrontmatter booleans, limit
- **Tests:** BM25 ranking correctness, scope filtering, frontmatter-specific search, empty results
- **Files:** `src/services/search-service.ts`, `src/services/search-service.test.ts`
- **Depends on:** 2A (needs FrontmatterService)
- **Parallel with:** 2B, 2D

### Task 2D: Implement SchemaEngine

- **What:** `src/services/schema-engine.ts` + test
- Constructor takes `VaultService`, `FrontmatterService`
- Methods: `loadSchemas()`, `getSchemaForPath()` (longest-prefix-wins), `lintNote()`, `validateFolder()`, `validateArea()`, `getTemplate()`, `listSchemas()`
- Implements: scope resolution, field validation (all 4 types), conditions (`when`), constraints (minItems/maxItems/exactItems/atLeastOne/allMatch/firstEquals/enum/pattern), content rules, folder classification, hub detection, structural rules
- **Tests:** scope resolution (longest match, ties), all field types, conditional rules, all constraints, content rules, folder classification, hub detection
- **Files:** `src/services/schema-engine.ts`, `src/services/schema-engine.test.ts`
- **Depends on:** 2A (needs FrontmatterService)
- **Parallel with:** 2B, 2C
- **Mode:** `plan` recommended — this is the most complex service

**Parallelism:**

```
Phase 1 done
    |
    +-- 2A (FrontmatterService) --+-- 2C (SearchService)
    |                             +-- 2D (SchemaEngine)
    +-- 2B (LinkEngine) ----------+
```

**Gate:** All service tests pass, `npm run lint` passes, `npx tsc --noEmit` passes.

---

## Phase 3: Phase 1 Tools (12 tools)

**Goal:** Implement all 12 Phase 1 tools, wire registry, server starts and responds.

**Milestone:** Server starts, `tools/list` returns 12 tools, all tool tests pass.

### Task 3A: CRUD tools (6 tools)

- **What:** `src/tools/note-tools.ts` + test
- Tools: `read_note`, `write_note`, `patch_note`, `delete_note`, `move_note`, `read_multiple_notes`
- Each: Zod input schema, handler calling VaultService, formatted response
- **Tests:** happy paths + error cases (not found, traversal, blocked, patch no match, delete wrong confirm, move dest exists)
- **Files:** `src/tools/note-tools.ts`, `src/tools/note-tools.test.ts`
- **Parallel with:** 3B, 3C

### Task 3B: Directory and stats tools (2 tools)

- **What:** `src/tools/vault-tools.ts` + test
- Tools: `list_directory`, `get_vault_stats`
- **Files:** `src/tools/vault-tools.ts`, `src/tools/vault-tools.test.ts`
- **Parallel with:** 3A, 3C

### Task 3C: Frontmatter and search tools (4 tools)

- **What:** `src/tools/frontmatter-tools.ts` + test, `src/tools/search-tools.ts` + test
- Tools: `get_frontmatter`, `update_frontmatter`, `manage_tags`, `search_notes`
- **Files:** `src/tools/frontmatter-tools.ts`, `src/tools/frontmatter-tools.test.ts`, `src/tools/search-tools.ts`, `src/tools/search-tools.test.ts`
- **Parallel with:** 3A, 3B

### Task 3D: Wire Phase 1 tool registry

- **What:** Update `src/tools/index.ts` to import and register all 12 tools. Update `src/server.ts` to construct PathFilter -> VaultService -> FrontmatterService -> SearchService with DI and pass to registration.
- **Files:** `src/tools/index.ts`, `src/server.ts`
- **Depends on:** 3A, 3B, 3C
- **Parallel:** Sequential — integration task after all tools merge

**Gate:** `npm run build` succeeds, all tests pass, lint passes, server starts and lists 12 tools.

---

## Phase 4: Phase 2 Tools (Convention Engine, 5 tools)

**Goal:** Expose SchemaEngine through MCP tools.

**Milestone:** `lint_note` validates against schemas, `create_note` applies templates, 17 tools in registry.

### Task 4A: Schema and validation tools (4 tools)

- **What:** `src/tools/schema-tools.ts` + test
- Tools: `lint_note`, `validate_folder`, `validate_area`, `list_schemas`
- **Tests:** with fixture schema YAML files
- **Files:** `src/tools/schema-tools.ts`, `src/tools/schema-tools.test.ts`
- **Parallel with:** 4B

### Task 4B: Convention-aware create_note tool

- **What:** `src/tools/create-note-tool.ts` + test
- Implements: schema resolution, template frontmatter, merge overrides, atomic write, lint result
- **Tests:** creation with/without schema, with overrides, path exists error
- **Files:** `src/tools/create-note-tool.ts`, `src/tools/create-note-tool.test.ts`
- **Parallel with:** 4A

### Task 4C: Wire Phase 2 tool registry

- **What:** Update `src/tools/index.ts` and `src/server.ts` to construct SchemaEngine, load schemas at startup, register 5 new tools.
- **Files:** `src/tools/index.ts`, `src/server.ts`
- **Depends on:** 4A, 4B

**Gate:** 17 tools listed, all tests pass, schema validation works end-to-end.

---

## Phase 5: Phase 3 Tools (Link Intelligence, 4 tools + enhancement)

**Goal:** Link analysis tools and move_note link propagation.

**Milestone:** All 21 tools registered. Backlinks, broken links, orphans, unlinked mentions work. move_note with updateLinks updates references.

### Task 5A: Link analysis tools (4 tools)

- **What:** `src/tools/link-tools.ts` + test
- Tools: `get_backlinks`, `find_unlinked_mentions`, `find_broken_links`, `find_orphans`
- **Tests:** multi-file vault fixtures
- **Files:** `src/tools/link-tools.ts`, `src/tools/link-tools.test.ts`
- **Parallel with:** 5B

### Task 5B: Enhance move_note with updateLinks

- **What:** Add `updateLinks: boolean` param to `move_note` in `src/tools/note-tools.ts`. When true, call `LinkEngine.propagateRename()` after move.
- **Tests:** link propagation (display text preserved, section anchors preserved, path-style wikilinks)
- **Files:** `src/tools/note-tools.ts`, `src/tools/note-tools.test.ts`
- **Parallel with:** 5A (different files)

### Task 5C: Final tool registry wiring

- **What:** Update `src/tools/index.ts` and `src/server.ts` to construct LinkEngine, register 4 new link tools, all 21 tools listed.
- **Files:** `src/tools/index.ts`, `src/server.ts`
- **Depends on:** 5A, 5B

**Gate:** All 21 tools listed, all tests pass, `npm run build` succeeds, `npm run lint` passes, `npm run format:check` passes.

---

## File Ownership Table

No file is touched by two workers within the same phase.

| File                                  | Tasks                       |
| ------------------------------------- | --------------------------- |
| `package.json`                        | 0A                          |
| `src/types.ts`                        | 0B                          |
| `src/server.ts`                       | 0C, 3D, 4C, 5C (sequential) |
| `src/tools/index.ts`                  | 0C, 3D, 4C, 5C (sequential) |
| `src/services/path-filter.ts`         | 1A                          |
| `src/services/vault-service.ts`       | 1B                          |
| `src/services/frontmatter-service.ts` | 2A                          |
| `src/services/link-engine.ts`         | 2B                          |
| `src/services/search-service.ts`      | 2C                          |
| `src/services/schema-engine.ts`       | 2D                          |
| `src/tools/note-tools.ts`             | 3A, 5B (different phases)   |
| `src/tools/vault-tools.ts`            | 3B                          |
| `src/tools/frontmatter-tools.ts`      | 3C                          |
| `src/tools/search-tools.ts`           | 3C                          |
| `src/tools/schema-tools.ts`           | 4A                          |
| `src/tools/create-note-tool.ts`       | 4B                          |
| `src/tools/link-tools.ts`             | 5A                          |
