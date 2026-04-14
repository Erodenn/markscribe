import { z } from "zod";

// ============================================================================
// Tool Infrastructure
// ============================================================================

/**
 * Shape of a registered MCP tool handler.
 * Tools self-register in a Map<string, ToolHandler>.
 */
export interface ToolHandler {
  /** Tool name as exposed via MCP tools/list */
  name: string;
  /** Human-readable description for the AI client */
  description: string;
  /** Zod schema for input validation */
  inputSchema: z.ZodType;
  /** Handler function — receives validated args, returns MCP content response */
  handler: (args: Record<string, unknown>) => Promise<ToolResponse>;
}

/** MCP tool response shape */
export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ============================================================================
// Service Container (passed to tool registration)
// ============================================================================

/**
 * Services constructed in server.ts and injected into tool handlers.
 * Tools receive this bag — they never construct services themselves.
 */
export interface Services {
  vault: VaultService;
  frontmatter: FrontmatterService;
  search: SearchService;
  schema: SchemaEngine;
  links: LinkEngine;
}

// ============================================================================
// PathFilter
// ============================================================================

export interface PathFilterConfig {
  /** Additional paths to block (added to immutable defaults) */
  blockedPaths: string[];
  /** Allowed file extensions for read/write (default: [".md", ".markdown", ".txt"]) */
  allowedExtensions: string[];
}

/**
 * Path security and access control.
 *
 * Immutable defaults (always blocked, config cannot remove):
 *   .obsidian/, .git/, node_modules/, .DS_Store, Thumbs.db
 */
export interface PathFilter {
  /** Check if path is allowed for read/write (checks extension + blocklist) */
  isAllowed(path: string): boolean;
  /** Check if path is allowed for directory listing (no extension check) */
  isAllowedForListing(path: string): boolean;
}

// ============================================================================
// VaultService
// ============================================================================

export interface ParsedNote {
  /** Vault-relative path */
  path: string;
  /** Parsed YAML frontmatter (empty object if none) */
  frontmatter: Record<string, unknown>;
  /** Note body content (frontmatter stripped) */
  content: string;
  /** Raw file content including frontmatter delimiters */
  raw: string;
}

export type WriteMode = "overwrite" | "append" | "prepend";

export interface MoveResult {
  /** Original vault-relative path */
  oldPath: string;
  /** New vault-relative path */
  newPath: string;
}

export interface DirectoryEntry {
  /** Entry name (filename or directory name) */
  name: string;
  /** "file" or "directory" */
  type: "file" | "directory";
  /** Vault-relative path */
  path: string;
}

export interface DirectoryListing {
  /** Vault-relative path of the listed directory */
  path: string;
  entries: DirectoryEntry[];
}

export interface BatchReadEntry {
  /** Vault-relative path */
  path: string;
  /** Parsed note if successful, null if read failed */
  note: ParsedNote | null;
  /** Error message if read failed */
  error?: string;
}

export interface BatchResult {
  results: BatchReadEntry[];
}

export interface VaultStats {
  /** Total number of markdown files */
  noteCount: number;
  /** Total vault size in bytes */
  totalSize: number;
  /** Most recently modified notes (vault-relative paths) */
  recentFiles: Array<{ path: string; modified: string }>;
}

/**
 * All filesystem operations scoped to the vault.
 * Constructor: (vaultPath: string, pathFilter: PathFilter)
 */
export interface VaultService {
  /** Vault root absolute path */
  readonly vaultPath: string;

  /** Resolve vault-relative path to absolute, with traversal check + PathFilter */
  resolvePath(relativePath: string): string;

  /** Write-to-temp-then-rename primitive. Never call fs.writeFile directly. */
  atomicWrite(fullPath: string, content: string): Promise<void>;

  /** Read note with parsed frontmatter */
  readNote(path: string): Promise<ParsedNote>;

  /** Create or overwrite/append/prepend to a note */
  writeNote(
    path: string,
    content: string,
    frontmatter?: Record<string, unknown>,
    mode?: WriteMode,
  ): Promise<void>;

  /** String replacement within a note */
  patchNote(
    path: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<void>;

  /** Delete with path confirmation safety */
  deleteNote(path: string, confirmPath: string): Promise<void>;

  /** Atomic move/rename. Errors if destination exists unless overwrite is true. */
  moveNote(oldPath: string, newPath: string, overwrite?: boolean): Promise<MoveResult>;

  /** List files and subdirectories */
  listDirectory(path: string): Promise<DirectoryListing>;

  /** Batch read (max 10) */
  readMultipleNotes(paths: string[]): Promise<BatchResult>;

  /** Note count, total size, recent files */
  getVaultStats(): Promise<VaultStats>;
}

// ============================================================================
// FrontmatterService
// ============================================================================

export interface ParsedFrontmatter {
  /** Parsed YAML frontmatter object */
  frontmatter: Record<string, unknown>;
  /** Note body content (frontmatter stripped) */
  content: string;
  /** Raw file content */
  raw: string;
}

export type TagOperation = "add" | "remove" | "list";

export interface TagResult {
  /** Vault-relative path */
  path: string;
  /** Current tags after operation */
  tags: string[];
  /** Tags that were added (for "add" op) */
  added?: string[];
  /** Tags that were removed (for "remove" op) */
  removed?: string[];
}

/**
 * YAML frontmatter parsing, serialization, and field manipulation.
 * Constructor: (vaultService: VaultService)
 */
export interface FrontmatterService {
  /** Parse raw file content into frontmatter + body */
  parse(rawContent: string): ParsedFrontmatter;

  /** Serialize frontmatter + body back to raw content */
  stringify(frontmatter: Record<string, unknown>, content: string): string;

  /** Update specific frontmatter keys without touching content */
  updateFields(path: string, fields: Record<string, unknown>, merge?: boolean): Promise<void>;

  /** Add/remove/list tags (handles both YAML tags array and inline #tags) */
  manageTags(path: string, operation: TagOperation, tags?: string[]): Promise<TagResult>;
}

// ============================================================================
// SearchService
// ============================================================================

export interface SearchOptions {
  /** Path prefix to scope the search */
  scope?: string;
  /** Search within note body content (default: true) */
  searchContent?: boolean;
  /** Search within frontmatter values (default: false) */
  searchFrontmatter?: boolean;
  /** Max results to return */
  limit?: number;
}

export type FrontmatterOperator = "equals" | "contains" | "exists";

export interface SearchResult {
  /** Vault-relative path */
  path: string;
  /** BM25 relevance score */
  score: number;
  /** Excerpt with match context */
  excerpt: string;
  /** Matched frontmatter fields (if searchFrontmatter enabled) */
  matchedFields?: string[];
}

/**
 * Full-text search with BM25 ranking. No persistent index — scans on demand.
 * Constructor: (vaultService: VaultService, frontmatterService: FrontmatterService)
 */
export interface SearchService {
  /** BM25 full-text search with optional scope and filters */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;

  /** Field-level frontmatter queries */
  searchByFrontmatter(
    field: string,
    value: string,
    operator?: FrontmatterOperator,
  ): Promise<SearchResult[]>;
}

// ============================================================================
// SchemaEngine
// ============================================================================

export interface SchemaScope {
  /** Vault-relative path prefixes this schema governs */
  paths: string[];
  /** Opt-out prefixes within scope */
  exclude: string[];
}

export interface SchemaFrontmatter {
  fields: Record<string, SchemaField>;
}

export interface SchemaField {
  /** YAML type */
  type: "string" | "list" | "number" | "boolean";
  /** Whether field is required (default: false) */
  required: boolean;
  /** Regex pattern the value must match (strings only) */
  format?: string;
  /** Default value for templates. Supports template vars: {{stem}}, {{today}}, etc. */
  default?: unknown;
  /** Condition gating whether field is validated */
  when?: SchemaCondition;
  /** Additional validation rules */
  constraints?: SchemaConstraint[];
}

/** Conditions gate whether a field is required or validated */
export type SchemaCondition =
  | { tagPresent: string }
  | { fieldEquals: { field: string; value: string } }
  | { fieldExists: string };

/** Constraints applied to a field's value */
export type SchemaConstraint =
  | { minItems: number }
  | { maxItems: number }
  | { exactItems: number }
  | { atLeastOne: { matches: string } }
  | { allMatch: string }
  | { firstEquals: string }
  | { enum: Array<string | number> }
  | { pattern: string };

export interface SchemaContent {
  rules: ContentRule[];
}

export interface ContentRule {
  /** User-chosen name, appears in lint results */
  name: string;
  /** Built-in check identifier */
  check: "hasPattern" | "noPattern" | "noSelfWikilink" | "noMalformedWikilinks" | "minWordCount";
  /** Pattern for hasPattern/noPattern */
  pattern?: string;
  /** Count for minWordCount */
  count?: number;
}

export interface SchemaFolders {
  classification: FolderClassification;
  hub?: HubConfig;
  structural?: StructuralRule[];
}

export interface FolderClassification {
  /** Folder names that auto-pass validation */
  supplemental: string[];
  /** Folder names excluded from validation entirely */
  skip: string[];
}

export interface HubConfig {
  /** Detection strategies tried in order */
  detection: HubDetectionRule[];
  /** If true, missing hub = validation failure */
  required: boolean;
}

export type HubDetectionRule = { pattern: string } | { fallback: SchemaCondition };

/** Built-in structural check identifiers */
export type StructuralCheckType =
  | "hubCoversChildren"
  | "noOrphansInFolder"
  | "noSubdirectories"
  | "requiredFile"
  | "filenamePattern"
  | "minFileCount"
  | "maxFileCount"
  | "minOutgoingLinks"
  | "allNotesMatch"
  | "someNoteMatches";

export interface StructuralRule {
  /** User-chosen name */
  name: string;
  /** Built-in check identifier */
  check: StructuralCheckType;
  /** Pattern for requiredFile, filenamePattern */
  pattern?: string;
  /** Count for minFileCount, maxFileCount, minOutgoingLinks, someNoteMatches */
  count?: number;
  /** Condition for allNotesMatch, someNoteMatches */
  when?: SchemaCondition;
}

// ============================================================================
// Note Schema (portable definition, no path binding)
// ============================================================================

export interface NoteSchema {
  name: string;
  description: string;
  type: "note";
  frontmatter: SchemaFrontmatter;
  content: SchemaContent;
}

// ============================================================================
// Folder Schema (structural rules, bound via _conventions.md)
// ============================================================================

export interface FolderSchema {
  name: string;
  description: string;
  type: "folder";
  noteSchemas: RoleBasedNoteSchemas;
  classification: FolderClassification;
  hub?: HubConfig;
  structural?: StructuralRule[];
  includes?: string[];
  overrides?: FolderSchemaOverrides;
}

export interface RoleBasedNoteSchemas {
  default?: string;
  hub?: string;
  [role: string]: string | undefined;
}

export interface FolderSchemaOverrides {
  classification?: Partial<FolderClassification>;
  hub?: Partial<HubConfig>;
  structural?: StructuralRule[];
  noteSchemas?: Partial<RoleBasedNoteSchemas>;
}

// ============================================================================
// Convention Cascade
// ============================================================================

export interface ConventionBinding {
  folderSchema: string;
  inherit?: boolean;
}

export interface ResolvedConvention {
  path: string;
  folderSchemaName: string;
  folderSchema: FolderSchema;
  source: string;
}

// ============================================================================
// Vault Validation
// ============================================================================

export interface VaultValidation {
  pass: boolean;
  conventionSources: string[];
  folders: Record<string, FolderValidation>;
  summary: { total: number; passed: number; failed: number; skipped: number };
}

// ============================================================================
// Schema Info (updated for note/folder distinction)
// ============================================================================

/** Summary info about a loaded schema */
export interface SchemaInfo {
  name: string;
  description: string;
  type: "note" | "folder";
  /** Scope rules (legacy schemas only) */
  scope?: SchemaScope;
  /** Number of frontmatter field definitions (note schemas) */
  fieldCount?: number;
  /** Number of content rules (note schemas) */
  contentRuleCount?: number;
  /** Whether folder validation is configured (legacy schemas) */
  hasFolderConfig?: boolean;
  /** Note schema role assignments (folder schemas) */
  noteSchemaRoles?: Record<string, string>;
  /** Number of structural rules (folder schemas) */
  structuralRuleCount?: number;
  /** Whether hub config is present (folder schemas) */
  hasHubConfig?: boolean;
}

/** Template for convention-aware note creation */
export interface NoteTemplate {
  /** Default frontmatter fields from schema */
  frontmatter: Record<string, unknown>;
  /** Default content (usually empty) */
  content: string;
}

// ============================================================================
// Validation Result Types
// ============================================================================

/** Result of validating a single note against its schema */
export interface LintResult {
  /** Vault-relative path */
  path: string;
  /** Whether all checks passed */
  pass: boolean;
  /** Which schema was applied (null if no schema matched) */
  schema: string | null;
  /** Individual check results */
  checks: Check[];
}

/** Single validation check result */
export interface Check {
  /** Check identifier (e.g. "field_tags_present", "has_outgoing_link") */
  name: string;
  /** Whether this check passed */
  pass: boolean;
  /** Human-readable explanation on failure */
  detail: string;
}

export type FolderType = "packet" | "superfolder" | "supplemental" | "unclassified";

/** Result of validating a folder/packet */
export interface FolderValidation {
  /** Vault-relative path */
  path: string;
  /** Whether all checks passed */
  pass: boolean;
  /** Classified folder type */
  folderType: FolderType;
  /** Which schema was applied */
  schema: string | null;
  /** Per-note lint results keyed by vault-relative path */
  notes: Record<string, LintResult>;
  /** Folder-level structural check results */
  structural: Check[];
}

/** Result of recursive area validation */
export interface AreaValidation {
  /** Vault-relative path of the scanned area */
  path: string;
  /** Whether all folders passed */
  pass: boolean;
  /** Which schema was applied */
  schema: string | null;
  /** Per-folder results keyed by vault-relative path */
  folders: Record<string, FolderValidation>;
  summary: {
    total: number;
    passed: number;
    failed: number;
    /** supplemental + skip folders */
    skipped: number;
  };
}

/**
 * Convention schema loading, validation, and template resolution.
 * Constructor: (vaultService: VaultService)
 */
export interface SchemaEngine {
  /** Load and compile YAML schema files from directory */
  loadSchemas(schemasDir: string): Promise<void>;

  /** Load bundled default schemas */
  loadBundledSchemas(): void;

  /** Discover _conventions.md notes and resolve cascade */
  discoverConventions(): Promise<void>;

  /** Resolve the note schema for a given note path (3-step resolution) */
  resolveNoteSchema(notePath: string): NoteSchema | null;

  /** Validate a single note against its applicable schema */
  lintNote(path: string): Promise<LintResult>;

  /** Classify and validate a folder/packet */
  validateFolder(path: string): Promise<FolderValidation>;

  /** Recursive validation of a vault subtree */
  validateArea(path: string): Promise<AreaValidation>;

  /** Validate entire vault using convention cascade */
  validateVault(): Promise<VaultValidation>;

  /** Get template frontmatter + content for convention-aware creation */
  getTemplate(schemaName: string): NoteTemplate;

  /** List loaded schemas with summary info */
  listSchemas(): SchemaInfo[];
}

// ============================================================================
// LinkEngine
// ============================================================================

export interface WikiLink {
  /** The full raw match (e.g. "[[Target|Display]]") */
  raw: string;
  /** Link target (e.g. "Target") */
  target: string;
  /** Display text if present (e.g. "Display"), null otherwise */
  display: string | null;
  /** Section anchor if present (e.g. "Section"), null otherwise */
  section: string | null;
}

/**
 * Directed adjacency map.
 * Key: vault-relative path of the source note.
 * Value: array of vault-relative paths the source links to.
 */
export type LinkGraph = Map<string, string[]>;

export interface BacklinkEntry {
  /** Path of the note that contains the link */
  sourcePath: string;
  /** The wikilink that references the target */
  link: WikiLink;
  /** Line number where the link appears (1-based) */
  line: number;
}

export interface UnlinkedMention {
  /** Path of the note containing the plain-text mention */
  sourcePath: string;
  /** The plain text that matches a note title */
  mentionText: string;
  /** Line number (1-based) */
  line: number;
  /** Character offset within the line */
  column: number;
}

export interface BrokenLink {
  /** Path of the note containing the broken link */
  sourcePath: string;
  /** The wikilink pointing to a non-existent note */
  link: WikiLink;
  /** Line number (1-based) */
  line: number;
}

export interface RenameResult {
  /** Number of files updated */
  filesUpdated: number;
  /** Number of individual link references updated */
  linksUpdated: number;
  /** Paths of files that were modified */
  modifiedFiles: string[];
}

/**
 * Wikilink parsing, graph building, mention detection, reference updates.
 * Constructor: (vaultService: VaultService)
 */
export interface LinkEngine {
  /** Parse wikilinks from markdown content */
  extractLinks(content: string): WikiLink[];

  /** Scan vault files and build directed adjacency map */
  buildGraph(scope?: string): Promise<LinkGraph>;

  /** Find all notes linking to a given note */
  getBacklinks(notePath: string): Promise<BacklinkEntry[]>;

  /** Find plain-text references that should be wikilinks */
  findUnlinkedMentions(notePath: string): Promise<UnlinkedMention[]>;

  /** Find wikilinks pointing to non-existent notes */
  findBrokenLinks(scope?: string): Promise<BrokenLink[]>;

  /** Find notes with no incoming links in scope */
  findOrphans(scope?: string): Promise<string[]>;

  /** Update all [[oldStem]] references vault-wide after a rename */
  propagateRename(oldStem: string, newStem: string, scope?: string): Promise<RenameResult>;
}

// ============================================================================
// Config
// ============================================================================

/** Shape of .vaultscribe/config.yaml */
export interface VaultScribeConfig {
  schemas?: {
    /** Directory relative to .vaultscribe/ (default: "schemas/") */
    directory?: string;
  };
  paths?: {
    /** Additional blocked paths (added to immutable defaults) */
    blocked?: string[];
    /** Allowed extensions for read/write (default: [".md", ".markdown", ".txt"]) */
    allowed_extensions?: string[];
  };
  search?: {
    /** Default result cap (default: 50) */
    max_results?: number;
    /** Context chars around matches (default: 40) */
    excerpt_chars?: number;
  };
  responses?: {
    /** Minified keys by default (default: true) */
    compact?: boolean;
  };
}

// ============================================================================
// Template Variables
// ============================================================================

/**
 * Template variables expanded at validation/creation time.
 *
 * {{stem}}       — Filename without extension, leading _ stripped
 * {{filename}}   — Filename without extension, as-is
 * {{folderName}} — Name of the immediate parent folder
 * {{today}}      — Current date as YYYY-MM-DD
 */
export interface TemplateContext {
  stem: string;
  filename: string;
  folderName: string;
  today: string;
}
