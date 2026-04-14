import path from "node:path";
import type {
  SchemaEngine,
  Schema,
  SchemaInfo,
  NoteSchema,
  FolderSchema,
  NoteTemplate,
  LintResult,
  FolderValidation,
  AreaValidation,
  VaultValidation,
  VaultService,
} from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";
import { expandHubPattern } from "../utils.js";
import { SchemaRegistryImpl } from "./schema-registry.js";
import { bundledSchemas } from "../bundled-schemas/index.js";
import { NoteSchemaEngineImpl } from "./note-schema-engine.js";
import { FolderSchemaEngineImpl } from "./folder-schema-engine.js";
import { ConventionCascadeImpl } from "./convention-cascade.js";

// Re-export for backwards compatibility (create-note-tool imports from here)
export { expandTemplateVars, buildTemplateContext } from "../utils.js";

const log = createChildLog({ service: "SchemaEngine" });

// ============================================================================
// SchemaEngineImpl — thin facade over sub-engines
// ============================================================================

export class SchemaEngineImpl implements SchemaEngine {
  private readonly vault: VaultService;
  private readonly registry: SchemaRegistryImpl;
  private readonly noteEngine: NoteSchemaEngineImpl;
  private readonly folderEngine: FolderSchemaEngineImpl;
  private readonly cascade: ConventionCascadeImpl;

  constructor(vaultService: VaultService) {
    this.vault = vaultService;
    this.registry = new SchemaRegistryImpl();
    this.noteEngine = new NoteSchemaEngineImpl(vaultService);
    this.folderEngine = new FolderSchemaEngineImpl(vaultService, this.registry, this.noteEngine);
    this.cascade = new ConventionCascadeImpl(vaultService, this.registry);
    log.info("SchemaEngine initialized");
  }

  // ==========================================================================
  // Schema loading
  // ==========================================================================

  async loadSchemas(schemasDir: string): Promise<void> {
    await this.registry.loadFromDirectory(schemasDir);
  }

  loadBundledSchemas(): void {
    this.registry.loadBundled(bundledSchemas);
    log.info({ count: bundledSchemas.length }, "loadBundledSchemas complete");
  }

  // ==========================================================================
  // Convention cascade
  // ==========================================================================

  async discoverConventions(): Promise<void> {
    await this.cascade.discover();
  }

  // ==========================================================================
  // Note schema resolution (3-step)
  // ==========================================================================

  resolveNoteSchema(notePath: string): NoteSchema | null {
    // 0. Exclude _conventions.md
    if (path.basename(notePath) === ConventionCascadeImpl.CONVENTIONS_FILENAME) return null;

    // 1. Folder schema role-based assignment via convention cascade
    const convention = this.cascade.getForNote(notePath);
    if (convention) {
      const { folderSchema } = convention;
      const isHub = this.isLikelyHub(notePath, folderSchema);
      const role = isHub ? "hub" : "default";
      const noteSchemaName = folderSchema.noteSchemas[role];
      if (noteSchemaName) return this.registry.getNoteSchema(noteSchemaName);
    }

    // 2. Unmanaged
    return null;
  }

  // ==========================================================================
  // Legacy API — getSchemaForPath (no longer used internally, kept for interface)
  // ==========================================================================

  getSchemaForPath(_notePath: string): Schema | null {
    return null;
  }

  // ==========================================================================
  // Note validation
  // ==========================================================================

  async lintNote(notePath: string): Promise<LintResult> {
    log.info({ path: notePath }, "lintNote start");

    // Read note once
    const note = await this.vault.readNote(notePath);

    // Check explicit schema tag in frontmatter
    let schema: NoteSchema | null = null;
    if (typeof note.frontmatter.schema === "string") {
      schema = this.registry.getNoteSchema(note.frontmatter.schema);
    }

    // Fall back to convention cascade resolution
    if (!schema) {
      schema = this.resolveNoteSchema(notePath);
    }

    // Delegate to note engine, passing pre-read note
    return this.noteEngine.lintNote(notePath, schema, note);
  }

  // ==========================================================================
  // Folder validation
  // ==========================================================================

  async validateFolder(folderPath: string): Promise<FolderValidation> {
    const convention = this.cascade.getForFolder(folderPath);
    const folderSchema = convention?.folderSchema ?? null;
    return this.folderEngine.validateFolder(
      folderPath,
      folderSchema,
      (p) => this.lintNote(p),
    );
  }

  async validateArea(areaPath: string): Promise<AreaValidation> {
    return this.folderEngine.validateArea(
      areaPath,
      this.cascade,
      (p) => this.lintNote(p),
      (folderPath) => this.cascade.getForFolder(folderPath)?.folderSchema ?? null,
    );
  }

  async validateVault(): Promise<VaultValidation> {
    log.info("validateVault start");
    await this.cascade.discover(); // refresh

    const folders: Record<string, FolderValidation> = {};
    const summary = { total: 0, passed: 0, failed: 0, skipped: 0 };

    await this.walkAllDirectories("", folders, summary);

    const pass = summary.failed === 0;
    log.info({ ...summary, pass }, "validateVault complete");

    return {
      pass,
      conventionSources: this.cascade.getAllSources(),
      folders,
      summary,
    };
  }

  // ==========================================================================
  // Templates
  // ==========================================================================

  getTemplate(schemaName: string): NoteTemplate {
    const schema = this.registry.getNoteSchema(schemaName);
    if (!schema) {
      throw new Error(`getTemplate: schema "${schemaName}" not found`);
    }
    return this.noteEngine.getTemplate(schema);
  }

  // ==========================================================================
  // Schema listing
  // ==========================================================================

  listSchemas(): SchemaInfo[] {
    return this.registry.listAll();
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private isLikelyHub(notePath: string, folderSchema: FolderSchema): boolean {
    if (!folderSchema.hub?.detection) return false;
    const folderName = path.basename(path.dirname(notePath.replace(/\\/g, "/")));
    const filename = path.basename(notePath);
    for (const rule of folderSchema.hub.detection) {
      if ("pattern" in rule) {
        const target = expandHubPattern(rule.pattern, folderName);
        if (filename === target) return true;
      }
      // Skip fallback rules — full detection runs during validateFolder
    }
    return false;
  }

  private async walkAllDirectories(
    dirPath: string,
    folders: Record<string, FolderValidation>,
    summary: { total: number; passed: number; failed: number; skipped: number },
  ): Promise<void> {
    let listing;
    try {
      listing = await this.vault.listDirectory(dirPath);
    } catch (err) {
      log.warn({ dirPath, err }, "walkAllDirectories: could not list directory");
      return;
    }

    const convention = this.cascade.getForFolder(dirPath);
    if (convention) {
      const folderResult = await this.folderEngine.validateFolder(
        dirPath,
        convention.folderSchema,
        (p) => this.lintNote(p),
      );
      folders[dirPath] = folderResult;
      summary.total++;

      if (folderResult.folderType === "supplemental") {
        summary.skipped++;
      } else if (
        folderResult.folderType === "unclassified" &&
        Object.keys(folderResult.notes).length === 0 &&
        folderResult.structural.length === 0
      ) {
        summary.skipped++;
      } else if (folderResult.pass) {
        summary.passed++;
      } else {
        summary.failed++;
      }
    }

    for (const entry of listing.entries) {
      if (entry.type === "directory") {
        await this.walkAllDirectories(entry.path, folders, summary);
      }
    }
  }
}
