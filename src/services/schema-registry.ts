import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type {
  NoteSchema,
  FolderSchema,
  SchemaInfo,
  SchemaFrontmatter,
  SchemaContent,
  SchemaField,
  SchemaCondition,
  SchemaConstraint,
  ContentRule,
  FolderClassification,
  HubConfig,
  HubDetectionRule,
  StructuralRule,
  RoleBasedNoteSchemas,
  FolderSchemaOverrides,
} from "../types.js";
import { createChildLog } from "../markscribe-log.js";

const log = createChildLog({ service: "SchemaRegistry" });

// ============================================================================
// Zod schemas for YAML validation (shared)
// ============================================================================

export const ZodSchemaCondition = z.union([
  z.object({ tagPresent: z.string() }).strict(),
  z.object({ fieldEquals: z.object({ field: z.string(), value: z.string() }).strict() }).strict(),
  z.object({ fieldExists: z.string() }).strict(),
]);

export const ZodSchemaConstraint = z.union([
  z.object({ minItems: z.number() }).strict(),
  z.object({ maxItems: z.number() }).strict(),
  z.object({ exactItems: z.number() }).strict(),
  z.object({ atLeastOne: z.object({ matches: z.string() }).strict() }).strict(),
  z.object({ allMatch: z.string() }).strict(),
  z.object({ firstEquals: z.string() }).strict(),
  z.object({ enum: z.array(z.union([z.string(), z.number()])) }).strict(),
  z.object({ pattern: z.string() }).strict(),
]);

export const ZodSchemaField = z.object({
  type: z.enum(["string", "list", "number", "boolean", "date"]),
  required: z.boolean().default(false),
  format: z.string().optional(),
  default: z.unknown().optional(),
  when: ZodSchemaCondition.optional(),
  constraints: z.array(ZodSchemaConstraint).optional(),
});

export const ZodContentRule = z.object({
  check: z.enum([
    "hasPattern",
    "noPattern",
    "noSelfWikilink",
    "noMalformedWikilinks",
    "noBrokenWikilinks",
    "minWordCount",
  ]),
  name: z.string().optional(),
  pattern: z.string().optional(),
  count: z.number().optional(),
});

export const ZodHubDetectionRule = z.union([
  z.object({ pattern: z.string() }).strict(),
  z.object({ fallback: ZodSchemaCondition }).strict(),
]);

export const ZodStructuralRule = z.object({
  check: z.enum([
    "hubCoversChildren",
    "noOrphansInFolder",
    "noSubdirectories",
    "requiredFile",
    "filenamePattern",
    "minFileCount",
    "maxFileCount",
    "minOutgoingLinks",
    "allNotesMatch",
    "someNoteMatches",
  ]),
  name: z.string().optional(),
  pattern: z.string().optional(),
  count: z.number().optional(),
  when: ZodSchemaCondition.optional(),
});

// ============================================================================
// Note schema Zod validator
// ============================================================================

const ZodNoteSchemaRaw = z.object({
  name: z.string().min(1),
  description: z.string(),
  type: z.literal("note"),
  frontmatter: z
    .object({
      fields: z.record(z.string(), ZodSchemaField).default({}),
    })
    .default({ fields: {} }),
  content: z
    .object({
      rules: z.array(ZodContentRule).default([]),
    })
    .default({ rules: [] }),
});

// ============================================================================
// Folder schema Zod validator
// ============================================================================

const ZodRoleBasedNoteSchemas = z.record(z.string(), z.string()).default({});

const ZodFolderSchemaOverrides = z
  .object({
    classification: z
      .object({
        supplemental: z.array(z.string()).optional(),
        skip: z.array(z.string()).optional(),
      })
      .optional(),
    hub: z
      .object({
        detection: z.array(ZodHubDetectionRule).optional(),
        required: z.boolean().optional(),
      })
      .optional(),
    structural: z.array(ZodStructuralRule).optional(),
    noteSchemas: ZodRoleBasedNoteSchemas.optional(),
  })
  .optional();

const ZodFolderSchemaRaw = z.object({
  name: z.string().min(1),
  description: z.string(),
  type: z.literal("folder"),
  noteSchemas: ZodRoleBasedNoteSchemas,
  classification: z
    .object({
      supplemental: z.array(z.string()).default([]),
      skip: z.array(z.string()).default([]),
    })
    .default({ supplemental: [], skip: [] }),
  hub: z
    .object({
      detection: z.array(ZodHubDetectionRule).default([]),
      required: z.boolean().default(false),
    })
    .optional(),
  structural: z.array(ZodStructuralRule).optional(),
  includes: z.array(z.string()).optional(),
  overrides: ZodFolderSchemaOverrides,
});

// ============================================================================
// Legacy schema Zod validator (scope-based, pre-refactor)
// ============================================================================

// ============================================================================
// SchemaRegistryImpl
// ============================================================================

export class SchemaRegistryImpl {
  private noteSchemas = new Map<string, NoteSchema>();
  private folderSchemas = new Map<string, FolderSchema>();
  private resolvedCache = new Map<string, FolderSchema>();

  async loadFromDirectory(schemasDir: string): Promise<void> {
    log.info({ schemasDir }, "loadFromDirectory start");
    this.resolvedCache.clear();

    let entries: string[];
    try {
      const dirents = await fs.readdir(schemasDir);
      entries = dirents.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
    } catch (err) {
      log.warn({ schemasDir, err }, "loadFromDirectory: could not read directory");
      return;
    }

    for (const filename of entries) {
      const filePath = path.join(schemasDir, filename);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        this.parseAndRegister(content, filename);
      } catch (err) {
        log.warn({ filename, err }, "loadFromDirectory: malformed schema file — skipping");
      }
    }

    log.info(
      { noteCount: this.noteSchemas.size, folderCount: this.folderSchemas.size },
      "loadFromDirectory complete",
    );
  }

  loadBundled(schemas: Array<NoteSchema | FolderSchema>): void {
    this.resolvedCache.clear();
    for (const schema of schemas) {
      if (schema.type === "note") {
        // User schemas win — only register if not already present
        if (!this.noteSchemas.has(schema.name)) {
          this.noteSchemas.set(schema.name, schema);
          log.info({ name: schema.name, type: "note" }, "registered bundled schema");
        }
      } else {
        if (!this.folderSchemas.has(schema.name)) {
          this.folderSchemas.set(schema.name, schema);
          log.info({ name: schema.name, type: "folder" }, "registered bundled schema");
        }
      }
    }
  }

  getNoteSchema(name: string): NoteSchema | null {
    return this.noteSchemas.get(name) ?? null;
  }

  getFolderSchema(name: string): FolderSchema | null {
    return this.folderSchemas.get(name) ?? null;
  }

  /**
   * Resolve a folder schema by name, applying includes and overrides.
   * Cycle detection via visited set.
   */
  resolveFolderSchema(name: string): FolderSchema | null {
    const cached = this.resolvedCache.get(name);
    if (cached) return cached;

    const resolved = this.resolveRecursive(name, new Set<string>());
    if (resolved) {
      this.resolvedCache.set(name, resolved);
    }
    return resolved;
  }

  listAll(): SchemaInfo[] {
    const infos: SchemaInfo[] = [];

    for (const s of this.noteSchemas.values()) {
      infos.push({
        name: s.name,
        description: s.description,
        type: "note",
        fieldCount: Object.keys(s.frontmatter.fields).length,
        contentRuleCount: s.content.rules.length,
      });
    }

    for (const s of this.folderSchemas.values()) {
      infos.push({
        name: s.name,
        description: s.description,
        type: "folder",
        noteSchemaRoles: Object.fromEntries(
          Object.entries(s.noteSchemas).filter(([, v]) => v !== undefined) as [string, string][],
        ),
        structuralRuleCount: s.structural?.length ?? 0,
        hasHubConfig: !!s.hub,
      });
    }

    return infos;
  }

  /** Clear all schemas (used for reload) */
  clear(): void {
    this.noteSchemas.clear();
    this.folderSchemas.clear();
    this.resolvedCache.clear();
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private parseAndRegister(content: string, filename: string): void {
    const rawYaml = yaml.load(content);
    if (!rawYaml || typeof rawYaml !== "object") {
      throw new Error(`${filename}: empty or non-object YAML`);
    }

    const obj = rawYaml as Record<string, unknown>;

    // Discriminate by type field
    if (obj.type === "note") {
      const parsed = ZodNoteSchemaRaw.parse(rawYaml);
      const schema = this.buildNoteSchema(parsed);
      this.noteSchemas.set(schema.name, schema);
      log.info({ name: schema.name, type: "note", filename }, "registered note schema");
    } else if (obj.type === "folder") {
      const parsed = ZodFolderSchemaRaw.parse(rawYaml);
      const schema = this.buildFolderSchema(parsed);
      this.folderSchemas.set(schema.name, schema);
      log.info({ name: schema.name, type: "folder", filename }, "registered folder schema");
    } else {
      // Unknown type — skip silently
      log.warn({ type: obj.type, filename }, "unknown schema type — skipping");
    }
  }

  private buildNoteSchema(parsed: z.infer<typeof ZodNoteSchemaRaw>): NoteSchema {
    const fields: Record<string, SchemaField> = {};
    for (const [fieldName, fieldRaw] of Object.entries(parsed.frontmatter.fields)) {
      const field: SchemaField = {
        type: fieldRaw.type,
        required: fieldRaw.required,
      };
      if (fieldRaw.format !== undefined) field.format = fieldRaw.format;
      if (fieldRaw.default !== undefined) field.default = fieldRaw.default;
      if (fieldRaw.when !== undefined) field.when = fieldRaw.when as SchemaCondition;
      if (fieldRaw.constraints !== undefined)
        field.constraints = fieldRaw.constraints as SchemaConstraint[];
      fields[fieldName] = field;
    }

    const rules: ContentRule[] = parsed.content.rules.map((r) => ({
      name: r.name ?? String(r.check),
      check: r.check,
      pattern: r.pattern,
      count: r.count,
    }));

    return {
      name: parsed.name,
      description: parsed.description,
      type: "note",
      frontmatter: { fields } as SchemaFrontmatter,
      content: { rules } as SchemaContent,
    };
  }

  private buildFolderSchema(parsed: z.infer<typeof ZodFolderSchemaRaw>): FolderSchema {
    const classification: FolderClassification = {
      supplemental: parsed.classification.supplemental,
      skip: parsed.classification.skip,
    };

    const hub: HubConfig | undefined = parsed.hub
      ? {
          detection: parsed.hub.detection as HubDetectionRule[],
          required: parsed.hub.required,
        }
      : undefined;

    const structural: StructuralRule[] | undefined = parsed.structural?.map((r) => ({
      name: r.name ?? String(r.check),
      check: r.check,
      pattern: r.pattern,
      count: r.count,
      when: r.when as SchemaCondition | undefined,
    }));

    const overrides: FolderSchemaOverrides | undefined = parsed.overrides
      ? {
          classification: parsed.overrides.classification,
          hub: parsed.overrides.hub
            ? {
                detection: parsed.overrides.hub.detection as HubDetectionRule[] | undefined,
                required: parsed.overrides.hub.required,
              }
            : undefined,
          structural: parsed.overrides.structural?.map((r) => ({
            name: r.name ?? String(r.check),
            check: r.check,
            pattern: r.pattern,
            count: r.count,
            when: r.when as SchemaCondition | undefined,
          })),
          noteSchemas: parsed.overrides.noteSchemas as RoleBasedNoteSchemas | undefined,
        }
      : undefined;

    return {
      name: parsed.name,
      description: parsed.description,
      type: "folder",
      noteSchemas: parsed.noteSchemas as RoleBasedNoteSchemas,
      classification,
      hub,
      structural,
      includes: parsed.includes,
      overrides,
    };
  }

  private resolveRecursive(name: string, visited: Set<string>): FolderSchema | null {
    if (visited.has(name)) {
      log.warn({ name, visited: [...visited] }, "cycle detected in folder schema includes");
      return null;
    }
    visited.add(name);

    const schema = this.folderSchemas.get(name);
    if (!schema) return null;

    if (!schema.includes || schema.includes.length === 0) {
      return this.applyOverrides(schema);
    }

    // Resolve includes left-to-right, last wins
    let merged: FolderSchema = {
      name: schema.name,
      description: schema.description,
      type: "folder",
      noteSchemas: {},
      classification: { supplemental: [], skip: [] },
    };

    for (const includeName of schema.includes) {
      const included = this.resolveRecursive(includeName, new Set(visited));
      if (included) {
        merged = this.mergeFolderSchemas(merged, included);
      }
    }

    // Apply own fields on top of includes
    merged = this.mergeFolderSchemas(merged, schema);

    return this.applyOverrides(merged);
  }

  private mergeFolderSchemas(base: FolderSchema, overlay: FolderSchema): FolderSchema {
    const supplemental = [
      ...new Set([
        ...base.classification.supplemental,
        ...overlay.classification.supplemental,
      ]),
    ];
    const skip = [
      ...new Set([...base.classification.skip, ...overlay.classification.skip]),
    ];

    return {
      name: overlay.name,
      description: overlay.description,
      type: "folder",
      noteSchemas: { ...base.noteSchemas, ...overlay.noteSchemas },
      classification: { supplemental, skip },
      hub: overlay.hub ?? base.hub,
      structural: [...(base.structural ?? []), ...(overlay.structural ?? [])],
      includes: overlay.includes,
      overrides: overlay.overrides,
    };
  }

  private applyOverrides(schema: FolderSchema): FolderSchema {
    if (!schema.overrides) return schema;
    const o = schema.overrides;

    const supplemental = o.classification?.supplemental
      ? [...new Set([...schema.classification.supplemental, ...o.classification.supplemental])]
      : schema.classification.supplemental;
    const skip = o.classification?.skip
      ? [...new Set([...schema.classification.skip, ...o.classification.skip])]
      : schema.classification.skip;

    return {
      ...schema,
      noteSchemas: o.noteSchemas
        ? { ...schema.noteSchemas, ...o.noteSchemas }
        : schema.noteSchemas,
      classification: { supplemental, skip },
      hub: o.hub ? { ...schema.hub, ...o.hub } as HubConfig : schema.hub,
      structural: o.structural ?? schema.structural,
    };
  }
}
