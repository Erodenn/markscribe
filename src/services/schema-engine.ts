import path from "node:path";
import type {
  SchemaEngine,
  SchemaInfo,
  NoteSchema,
  FolderSchema,
  NoteTemplate,
  LintResult,
  FolderValidation,
  AreaValidation,
  FullValidation,
  FileService,
  ParsedNote,
} from "../types.js";
import { createChildLog } from "../markscribe-log.js";
import { expandHubPattern, normalizePath } from "../utils.js";
import { SchemaRegistryImpl } from "./schema-registry.js";
import { bundledSchemas } from "../bundled-schemas/index.js";
import { NoteSchemaEngineImpl } from "./note-schema-engine.js";
import { FolderSchemaEngineImpl } from "./folder-schema-engine.js";
import { ConventionCascadeImpl } from "./convention-cascade.js";

const log = createChildLog({ service: "SchemaEngine" });

// ============================================================================
// SchemaEngineImpl — thin facade over sub-engines
// ============================================================================

export class SchemaEngineImpl implements SchemaEngine {
  private readonly file: FileService;
  private readonly registry: SchemaRegistryImpl;
  private readonly noteEngine: NoteSchemaEngineImpl;
  private readonly folderEngine: FolderSchemaEngineImpl;
  private readonly cascade: ConventionCascadeImpl;
  private schemasDir: string | null = null;

  constructor(fileService: FileService) {
    this.file = fileService;
    this.registry = new SchemaRegistryImpl();
    this.noteEngine = new NoteSchemaEngineImpl(fileService);
    this.folderEngine = new FolderSchemaEngineImpl(fileService);
    this.cascade = new ConventionCascadeImpl(fileService, this.registry);
    log.info("SchemaEngine initialized");
  }

  // ==========================================================================
  // Schema loading
  // ==========================================================================

  async loadSchemas(schemasDir: string): Promise<void> {
    this.schemasDir = schemasDir;
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
  // Runtime refresh — clear all state and reload from disk
  // ==========================================================================

  async refresh(): Promise<void> {
    log.info("refresh start");
    this.registry.clear();
    if (this.schemasDir) {
      await this.loadSchemas(this.schemasDir);
    }
    this.loadBundledSchemas();
    await this.discoverConventions();
    log.info("refresh complete");
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
  // Note validation
  // ==========================================================================

  async lintNote(notePath: string): Promise<LintResult> {
    log.info({ path: notePath }, "lintNote start");

    // Read note once
    const note = await this.file.readNote(notePath);

    // Check explicit schema tag in frontmatter
    let schema: NoteSchema | null = null;
    if (typeof note.frontmatter.note_schema === "string") {
      schema = this.registry.getNoteSchema(note.frontmatter.note_schema);
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
      async (p, preReadNote) => this.lintNoteWithPreRead(p, preReadNote),
    );
  }

  async validateArea(areaPath: string): Promise<AreaValidation> {
    return this.folderEngine.validateArea(
      areaPath,
      this.cascade,
      async (p, preReadNote) => this.lintNoteWithPreRead(p, preReadNote),
      (folderPath) => this.cascade.getForFolder(folderPath)?.folderSchema ?? null,
    );
  }

  async validateAll(): Promise<FullValidation> {
    log.info("validateAll start");

    const areaResult = await this.folderEngine.validateArea(
      "",
      this.cascade,
      async (p, preReadNote) => this.lintNoteWithPreRead(p, preReadNote),
      (folderPath) => this.cascade.getForFolder(folderPath)?.folderSchema ?? null,
    );

    const pass = areaResult.summary.failed === 0;
    log.info({ ...areaResult.summary, pass }, "validateAll complete");

    return {
      pass,
      conventionSources: this.cascade.getAllSources(),
      folders: areaResult.folders,
      summary: areaResult.summary,
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

  private async lintNoteWithPreRead(notePath: string, preReadNote?: ParsedNote): Promise<LintResult> {
    if (preReadNote) {
      let schema: NoteSchema | null = null;
      if (typeof preReadNote.frontmatter.note_schema === "string") {
        schema = this.registry.getNoteSchema(preReadNote.frontmatter.note_schema);
      }
      if (!schema) {
        schema = this.resolveNoteSchema(notePath);
      }
      return this.noteEngine.lintNote(notePath, schema, preReadNote);
    }
    return this.lintNote(notePath);
  }

  private isLikelyHub(notePath: string, folderSchema: FolderSchema): boolean {
    if (!folderSchema.hub?.detection) return false;
    const folderName = path.basename(path.dirname(normalizePath(notePath)));
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

}
