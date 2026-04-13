import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type {
  SchemaEngine,
  Schema,
  SchemaScope,
  SchemaField,
  SchemaCondition,
  SchemaConstraint,
  SchemaContent,
  SchemaFolders,
  SchemaInfo,
  NoteTemplate,
  LintResult,
  FolderValidation,
  FolderType,
  AreaValidation,
  Check,
  StructuralRule,
  ContentRule,
  HubDetectionRule,
  VaultService,
  FrontmatterService,
  TemplateContext,
} from "../types.js";
import { createChildLog } from "../vaultscribe-log.js";
import { escapeRegex } from "../utils.js";

const log = createChildLog({ service: "SchemaEngine" });

// ============================================================================
// Template variable expansion
// ============================================================================

const TEMPLATE_VAR_RE = /\{\{(stem|filename|folderName|today)\}\}/g;

export function expandTemplateVars(template: string, ctx: TemplateContext): string {
  TEMPLATE_VAR_RE.lastIndex = 0;
  return template.replace(TEMPLATE_VAR_RE, (_, key: string) => {
    switch (key) {
      case "stem":
        return ctx.stem;
      case "filename":
        return ctx.filename;
      case "folderName":
        return ctx.folderName;
      case "today":
        return ctx.today;
      default:
        return _;
    }
  });
}

/** Hub detection patterns use single-brace {folderName} — distinct from double-brace template vars */
function expandHubPattern(pattern: string, folderName: string): string {
  return pattern.replace(/\{folderName\}/g, folderName);
}

// ============================================================================
// Wikilink extraction (minimal, for structural rules)
// ============================================================================

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

function extractWikilinkStems(content: string): Set<string> {
  const stems = new Set<string>();
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(content)) !== null) {
    const target = match[1].trim();
    // Strip path components — keep only the filename part
    const base = target.includes("/") ? target.split("/").pop()! : target;
    // Strip leading underscore to get stem
    const stem = base.startsWith("_") ? base.slice(1) : base;
    stems.add(stem);
    // Also add the raw base in case files are matched without stripping
    stems.add(base);
  }
  return stems;
}

function getStem(filename: string): string {
  const base = path.basename(filename, path.extname(filename));
  return base.startsWith("_") ? base.slice(1) : base;
}

// ============================================================================
// Template context (shared with create-note-tool)
// ============================================================================

export function buildTemplateContext(notePath: string): TemplateContext {
  const normalized = notePath.replace(/\\/g, "/");
  const basename = path.basename(normalized);
  const filename = path.basename(basename, path.extname(basename));
  const stem = filename.startsWith("_") ? filename.slice(1) : filename;
  const folderName = path.basename(path.dirname(normalized));
  const today = new Date().toISOString().slice(0, 10);

  return { stem, filename, folderName, today };
}

// ============================================================================
// SchemaEngineImpl
// ============================================================================

export class SchemaEngineImpl implements SchemaEngine {
  private readonly vault: VaultService;
  private readonly frontmatter: FrontmatterService;
  private schemas: Schema[] = [];

  constructor(vaultService: VaultService, frontmatterService: FrontmatterService) {
    this.vault = vaultService;
    this.frontmatter = frontmatterService;
    log.info("SchemaEngine initialized");
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  async loadSchemas(schemasDir: string): Promise<void> {
    log.info({ schemasDir }, "loadSchemas start");
    this.schemas = [];

    let entries: string[];
    try {
      const dirents = await fs.readdir(schemasDir);
      entries = dirents.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort(); // alphabetical for stable tie-breaking
    } catch (err) {
      log.warn(
        { schemasDir, err },
        "loadSchemas: could not read schemas directory — no schemas loaded",
      );
      return;
    }

    for (const filename of entries) {
      const filePath = path.join(schemasDir, filename);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const schema = this.parseSchemaFile(content, filename);
        this.schemas.push(schema);
        log.info({ name: schema.name, filename }, "loadSchemas: loaded schema");
      } catch (err) {
        log.warn({ filename, err }, "loadSchemas: malformed schema file — skipping");
      }
    }

    log.info({ count: this.schemas.length }, "loadSchemas complete");
  }

  getSchemaForPath(notePath: string): Schema | null {
    const normalized = notePath.replace(/\\/g, "/");

    let bestSchema: Schema | null = null;
    let bestPrefixLen = -1;

    for (const schema of this.schemas) {
      // Find the longest matching scope.paths prefix
      let matchLen = -1;
      for (const prefix of schema.scope.paths) {
        const normalizedPrefix = prefix.replace(/\\/g, "/");
        if (normalized.startsWith(normalizedPrefix)) {
          if (normalizedPrefix.length > matchLen) {
            matchLen = normalizedPrefix.length;
          }
        }
      }

      if (matchLen < 0) continue; // no prefix matched

      // Check exclusions
      const isExcluded = schema.scope.exclude.some((ex) => {
        const normalizedEx = ex.replace(/\\/g, "/");
        return normalized.startsWith(normalizedEx);
      });
      if (isExcluded) continue;

      if (matchLen > bestPrefixLen) {
        bestPrefixLen = matchLen;
        bestSchema = schema;
      } else if (matchLen === bestPrefixLen && bestSchema !== null) {
        // Tie — first loaded (alphabetical filename) wins; log warning
        log.warn(
          { path: notePath, winner: bestSchema.name, loser: schema.name },
          "getSchemaForPath: tie in scope resolution — first loaded wins (misconfiguration)",
        );
      }
    }

    log.debug({ path: notePath, schema: bestSchema?.name ?? null }, "getSchemaForPath resolved");
    return bestSchema;
  }

  async lintNote(notePath: string): Promise<LintResult> {
    log.info({ path: notePath }, "lintNote start");

    const note = await this.vault.readNote(notePath);
    const { frontmatter: fm, content } = this.frontmatter.parse(note.raw);
    const schema = this.getSchemaForPath(notePath);

    if (!schema) {
      log.info({ path: notePath }, "lintNote: no schema matched");
      return { path: notePath, pass: true, schema: null, checks: [] };
    }

    const ctx = buildTemplateContext(notePath);
    const checks: Check[] = [];

    // Frontmatter field checks
    for (const [fieldName, fieldDef] of Object.entries(schema.frontmatter.fields)) {
      const fieldChecks = this.checkField(fieldName, fieldDef, fm, ctx);
      checks.push(...fieldChecks);
    }

    // Content rule checks
    for (const rule of schema.content.rules) {
      checks.push(this.checkContentRule(rule, content, ctx));
    }

    const pass = checks.every((c) => c.pass);
    log.info(
      { path: notePath, schema: schema.name, pass, checkCount: checks.length },
      "lintNote complete",
    );

    return { path: notePath, pass, schema: schema.name, checks };
  }

  async validateFolder(folderPath: string): Promise<FolderValidation> {
    const listing = await this.vault.listDirectory(folderPath);
    return this.validateFolderWithListing(folderPath, listing);
  }

  async validateArea(areaPath: string): Promise<AreaValidation> {
    log.info({ path: areaPath }, "validateArea start");

    const schema = this.getSchemaForPath(`${areaPath.replace(/\\/g, "/").replace(/\/$/, "")}/x.md`);

    const folders: Record<string, FolderValidation> = {};
    const summary = { total: 0, passed: 0, failed: 0, skipped: 0 };

    // Recursively walk directory tree
    await this.walkDirectories(areaPath, folders, summary);

    const pass = summary.failed === 0;
    log.info({ path: areaPath, ...summary }, "validateArea complete");

    return {
      path: areaPath,
      pass,
      schema: schema?.name ?? null,
      folders,
      summary,
    };
  }

  getTemplate(schemaName: string): NoteTemplate {
    log.info({ schemaName }, "getTemplate");

    const schema = this.schemas.find((s) => s.name === schemaName);
    if (!schema) {
      throw new Error(`getTemplate: schema "${schemaName}" not found`);
    }

    const frontmatter: Record<string, unknown> = {};
    for (const [fieldName, fieldDef] of Object.entries(schema.frontmatter.fields)) {
      // Only include required fields in the template
      if (!fieldDef.required) continue;
      // Skip conditional fields (can't know context at template time)
      if (fieldDef.when) continue;

      // Use schema-defined default if available, otherwise type-appropriate zero value
      if (fieldDef.default !== undefined) {
        frontmatter[fieldName] = fieldDef.default;
      } else {
        switch (fieldDef.type) {
          case "string":
            frontmatter[fieldName] = "";
            break;
          case "list":
            frontmatter[fieldName] = [];
            break;
          case "number":
            frontmatter[fieldName] = 0;
            break;
          case "boolean":
            frontmatter[fieldName] = false;
            break;
        }
      }
    }

    return { frontmatter, content: "" };
  }

  listSchemas(): SchemaInfo[] {
    return this.schemas.map((s) => ({
      name: s.name,
      description: s.description,
      scope: s.scope,
      fieldCount: Object.keys(s.frontmatter.fields).length,
      contentRuleCount: s.content.rules.length,
      hasFolderConfig: !!s.folders,
    }));
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private async validateFolderWithListing(
    folderPath: string,
    listing: { entries: Array<{ name: string; type: "file" | "directory"; path: string }> },
  ): Promise<FolderValidation> {
    log.info({ path: folderPath }, "validateFolder start");

    const folderName = path.basename(folderPath) || folderPath;

    const fakeNotePath = `${folderPath.replace(/\\/g, "/").replace(/\/$/, "")}/x.md`;
    const schema = this.getSchemaForPath(fakeNotePath);

    const mdFiles = listing.entries
      .filter((e) => e.type === "file" && e.name.endsWith(".md"))
      .map((e) => e.path);
    const subDirs = listing.entries.filter((e) => e.type === "directory").map((e) => e.path);

    const folderType = this.classifyFolder(folderName, schema, mdFiles, subDirs);

    if (schema?.folders?.classification.skip.includes(folderName)) {
      log.info({ path: folderPath, folderType: "unclassified" }, "validateFolder: skip folder");
      return {
        path: folderPath,
        pass: true,
        folderType: "unclassified",
        schema: schema?.name ?? null,
        notes: {},
        structural: [],
      };
    }

    if (folderType === "supplemental") {
      log.info({ path: folderPath, folderType }, "validateFolder: supplemental folder");
      return {
        path: folderPath,
        pass: true,
        folderType,
        schema: schema?.name ?? null,
        notes: {},
        structural: [],
      };
    }

    const notes: Record<string, LintResult> = {};
    for (const notePath of mdFiles) {
      notes[notePath] = await this.lintNote(notePath);
    }

    let structural: Check[] = [];
    if (
      folderType === "packet" &&
      schema?.folders?.structural &&
      schema.folders.structural.length > 0
    ) {
      const { hubPath, hubContent, hubError } = await this.detectHub(mdFiles, folderName, schema);
      structural = await this.checkStructuralRules(
        schema.folders.structural,
        hubPath,
        hubContent,
        hubError,
        mdFiles,
        folderPath,
      );
    }

    const notesPassing = Object.values(notes).every((r) => r.pass);
    const structuralPassing = structural.every((c) => c.pass);
    const pass = notesPassing && structuralPassing;

    log.info({ path: folderPath, folderType, pass }, "validateFolder complete");
    return {
      path: folderPath,
      pass,
      folderType,
      schema: schema?.name ?? null,
      notes,
      structural,
    };
  }

  private parseSchemaFile(content: string, filename: string): Schema {
    const raw = yaml.load(content) as Record<string, unknown>;

    if (!raw || typeof raw !== "object") {
      throw new Error(`${filename}: schema must be a YAML object`);
    }

    if (typeof raw["name"] !== "string" || !raw["name"]) {
      throw new Error(`${filename}: schema.name must be a non-empty string`);
    }

    if (typeof raw["description"] !== "string") {
      throw new Error(`${filename}: schema.description must be a string`);
    }

    const scopeRaw = raw["scope"] as Record<string, unknown> | undefined;
    if (!scopeRaw || !Array.isArray(scopeRaw["paths"])) {
      throw new Error(`${filename}: schema.scope.paths must be an array`);
    }

    const scope: SchemaScope = {
      paths: scopeRaw["paths"] as string[],
      exclude: Array.isArray(scopeRaw["exclude"]) ? (scopeRaw["exclude"] as string[]) : [],
    };

    // Parse frontmatter fields
    const fmRaw = raw["frontmatter"] as Record<string, unknown> | undefined;
    const fieldsRaw =
      fmRaw && typeof fmRaw === "object" && fmRaw["fields"]
        ? (fmRaw["fields"] as Record<string, unknown>)
        : {};

    const fields: Record<string, SchemaField> = {};
    for (const [fieldName, fieldRaw] of Object.entries(fieldsRaw)) {
      fields[fieldName] = this.parseSchemaField(
        fieldRaw as Record<string, unknown>,
        fieldName,
        filename,
      );
    }

    // Parse content rules
    const contentRaw = raw["content"] as Record<string, unknown> | undefined;
    const rulesRaw =
      contentRaw && Array.isArray(contentRaw["rules"]) ? (contentRaw["rules"] as unknown[]) : [];

    const rules: ContentRule[] = rulesRaw.map((r) =>
      this.parseContentRule(r as Record<string, unknown>, filename),
    );

    // Parse folders config (optional)
    const foldersRaw = raw["folders"] as Record<string, unknown> | undefined;
    const folders: SchemaFolders | undefined = foldersRaw
      ? this.parseFoldersConfig(foldersRaw, filename)
      : undefined;

    return {
      name: raw["name"] as string,
      description: raw["description"] as string,
      scope,
      frontmatter: { fields },
      content: { rules } as SchemaContent,
      folders,
    };
  }

  private parseSchemaField(
    raw: Record<string, unknown>,
    fieldName: string,
    filename: string,
  ): SchemaField {
    const validTypes = ["string", "list", "number", "boolean"] as const;
    if (!validTypes.includes(raw["type"] as (typeof validTypes)[number])) {
      throw new Error(
        `${filename}: field "${fieldName}" has invalid type "${String(raw["type"])}"`,
      );
    }

    const field: SchemaField = {
      type: raw["type"] as SchemaField["type"],
      required: raw["required"] === true,
    };

    if (typeof raw["format"] === "string") {
      field.format = raw["format"];
    }

    if (raw["default"] !== undefined) {
      field.default = raw["default"];
    }

    if (raw["when"] && typeof raw["when"] === "object") {
      field.when = raw["when"] as SchemaCondition;
    }

    if (Array.isArray(raw["constraints"])) {
      field.constraints = raw["constraints"] as SchemaConstraint[];
    }

    return field;
  }

  private parseContentRule(raw: Record<string, unknown>, filename: string): ContentRule {
    const validChecks = [
      "hasPattern",
      "noPattern",
      "noSelfWikilink",
      "noMalformedWikilinks",
      "minWordCount",
    ] as const;

    if (!validChecks.includes(raw["check"] as (typeof validChecks)[number])) {
      throw new Error(`${filename}: content rule has invalid check "${String(raw["check"])}"`);
    }

    return {
      name: typeof raw["name"] === "string" ? raw["name"] : String(raw["check"]),
      check: raw["check"] as ContentRule["check"],
      pattern: typeof raw["pattern"] === "string" ? raw["pattern"] : undefined,
      count: typeof raw["count"] === "number" ? raw["count"] : undefined,
    };
  }

  private parseFoldersConfig(raw: Record<string, unknown>, filename: string): SchemaFolders {
    const classRaw = raw["classification"] as Record<string, unknown> | undefined;
    const classification = {
      supplemental: Array.isArray(classRaw?.["supplemental"])
        ? (classRaw!["supplemental"] as string[])
        : [],
      skip: Array.isArray(classRaw?.["skip"]) ? (classRaw!["skip"] as string[]) : [],
    };

    const hubRaw = raw["hub"] as Record<string, unknown> | undefined;
    const hub = hubRaw
      ? {
          detection: Array.isArray(hubRaw["detection"])
            ? (hubRaw["detection"] as HubDetectionRule[])
            : [],
          required: hubRaw["required"] === true,
        }
      : undefined;

    const validStructuralChecks = ["hubCoversChildren", "noOrphansInFolder"];
    const structuralRaw = raw["structural"] as Record<string, unknown>[] | undefined;
    const structural = Array.isArray(structuralRaw)
      ? structuralRaw.map((r) => {
          if (!validStructuralChecks.includes(r["check"] as string)) {
            throw new Error(
              `${filename}: structural rule has invalid check "${String(r["check"])}"`,
            );
          }
          return {
            name: typeof r["name"] === "string" ? r["name"] : String(r["check"]),
            check: r["check"] as StructuralRule["check"],
          };
        })
      : undefined;

    return { classification, hub, structural };
  }

  private evalCondition(condition: SchemaCondition, fm: Record<string, unknown>): boolean {
    if ("tagPresent" in condition) {
      const tags = fm["tags"];
      if (Array.isArray(tags)) {
        return tags.some((t) => t === condition.tagPresent);
      }
      if (typeof tags === "string") {
        return tags === condition.tagPresent;
      }
      return false;
    }

    if ("fieldEquals" in condition) {
      const { field, value } = condition.fieldEquals;
      return String(fm[field] ?? "") === value;
    }

    if ("fieldExists" in condition) {
      const val = fm[condition.fieldExists];
      if (val === null || val === undefined) return false;
      if (typeof val === "string") return val.length > 0;
      if (Array.isArray(val)) return val.length > 0;
      return true;
    }

    return false;
  }

  private checkField(
    fieldName: string,
    fieldDef: SchemaField,
    fm: Record<string, unknown>,
    ctx: TemplateContext,
  ): Check[] {
    // Evaluate `when` condition — if false, skip entirely
    if (fieldDef.when && !this.evalCondition(fieldDef.when, fm)) {
      return [];
    }

    const checks: Check[] = [];
    const value = fm[fieldName];
    const absent = value === null || value === undefined;

    // Required check
    if (fieldDef.required) {
      const missing = absent || (typeof value === "string" && value.length === 0);
      checks.push({
        name: `field_${fieldName}_required`,
        pass: !missing,
        detail: missing ? `Field "${fieldName}" is required but missing or empty` : "",
      });
    }

    // Skip further checks if value is absent
    if (absent) return checks;

    // Type check
    let typeOk = false;
    switch (fieldDef.type) {
      case "string":
        typeOk = typeof value === "string";
        break;
      case "list":
        typeOk = Array.isArray(value);
        break;
      case "number":
        typeOk = typeof value === "number";
        break;
      case "boolean":
        typeOk = typeof value === "boolean";
        break;
    }

    checks.push({
      name: `field_${fieldName}_type`,
      pass: typeOk,
      detail: typeOk
        ? ""
        : `Field "${fieldName}" expected type "${fieldDef.type}" but got "${typeof value}"`,
    });

    // Skip format/constraints if type is wrong
    if (!typeOk) return checks;

    // Format check (strings only)
    if (fieldDef.format && typeof value === "string") {
      const formatRe = new RegExp(fieldDef.format);
      const formatOk = formatRe.test(value);
      checks.push({
        name: `field_${fieldName}_format`,
        pass: formatOk,
        detail: formatOk
          ? ""
          : `Field "${fieldName}" value "${value}" does not match format "${fieldDef.format}"`,
      });
    }

    // Constraints
    if (fieldDef.constraints) {
      for (const constraint of fieldDef.constraints) {
        const check = this.evalConstraint(constraint, value, fieldName, ctx);
        if (check) checks.push(check);
      }
    }

    return checks;
  }

  private evalConstraint(
    constraint: SchemaConstraint,
    value: unknown,
    fieldName: string,
    ctx: TemplateContext,
  ): Check | null {
    if ("minItems" in constraint) {
      const list = value as unknown[];
      const pass = Array.isArray(list) && list.length >= constraint.minItems;
      return {
        name: `field_${fieldName}_minItems`,
        pass,
        detail: pass
          ? ""
          : `Field "${fieldName}" must have at least ${constraint.minItems} items (has ${Array.isArray(list) ? list.length : 0})`,
      };
    }

    if ("maxItems" in constraint) {
      const list = value as unknown[];
      const pass = Array.isArray(list) && list.length <= constraint.maxItems;
      return {
        name: `field_${fieldName}_maxItems`,
        pass,
        detail: pass
          ? ""
          : `Field "${fieldName}" must have at most ${constraint.maxItems} items (has ${Array.isArray(list) ? list.length : 0})`,
      };
    }

    if ("exactItems" in constraint) {
      const list = value as unknown[];
      const pass = Array.isArray(list) && list.length === constraint.exactItems;
      return {
        name: `field_${fieldName}_exactItems`,
        pass,
        detail: pass
          ? ""
          : `Field "${fieldName}" must have exactly ${constraint.exactItems} items (has ${Array.isArray(list) ? list.length : 0})`,
      };
    }

    if ("atLeastOne" in constraint) {
      const list = value as unknown[];
      const re = new RegExp(constraint.atLeastOne.matches);
      const pass = Array.isArray(list) && list.some((item) => re.test(String(item)));
      return {
        name: `field_${fieldName}_atLeastOne`,
        pass,
        detail: pass
          ? ""
          : `Field "${fieldName}": at least one item must match "${constraint.atLeastOne.matches}"`,
      };
    }

    if ("allMatch" in constraint) {
      const list = value as unknown[];
      const re = new RegExp(constraint.allMatch);
      const pass = Array.isArray(list) && list.every((item) => re.test(String(item)));
      return {
        name: `field_${fieldName}_allMatch`,
        pass,
        detail: pass ? "" : `Field "${fieldName}": all items must match "${constraint.allMatch}"`,
      };
    }

    if ("firstEquals" in constraint) {
      const list = value as unknown[];
      const expected = expandTemplateVars(constraint.firstEquals, ctx);
      const pass = Array.isArray(list) && list.length > 0 && String(list[0]) === expected;
      return {
        name: `field_${fieldName}_firstEquals`,
        pass,
        detail: pass
          ? ""
          : `Field "${fieldName}": first item must equal "${expected}" (got "${Array.isArray(list) && list.length > 0 ? String(list[0]) : "(empty list)"})"`,
      };
    }

    if ("enum" in constraint) {
      const pass = (constraint.enum as Array<string | number>).includes(value as string | number);
      return {
        name: `field_${fieldName}_enum`,
        pass,
        detail: pass
          ? ""
          : `Field "${fieldName}" value "${String(value)}" is not in allowed values: [${constraint.enum.join(", ")}]`,
      };
    }

    if ("pattern" in constraint) {
      const re = new RegExp(constraint.pattern);
      const pass = typeof value === "string" && re.test(value);
      return {
        name: `field_${fieldName}_pattern`,
        pass,
        detail: pass
          ? ""
          : `Field "${fieldName}" value "${String(value)}" does not match pattern "${constraint.pattern}"`,
      };
    }

    return null;
  }

  private checkContentRule(rule: ContentRule, content: string, ctx: TemplateContext): Check {
    switch (rule.check) {
      case "hasPattern": {
        const re = new RegExp(rule.pattern ?? "", "g");
        re.lastIndex = 0;
        const pass = re.test(content);
        return {
          name: rule.name,
          pass,
          detail: pass ? "" : `Content must match pattern "${rule.pattern}"`,
        };
      }

      case "noPattern": {
        const re = new RegExp(rule.pattern ?? "", "g");
        re.lastIndex = 0;
        const pass = !re.test(content);
        return {
          name: rule.name,
          pass,
          detail: pass ? "" : `Content must not match pattern "${rule.pattern}"`,
        };
      }

      case "noSelfWikilink": {
        const stem = ctx.stem;
        const escapedStem = escapeRegex(stem);
        // Match [[stem]], [[stem|display]], [[stem#section]], [[stem|display#section]]
        const selfRe = new RegExp(`\\[\\[${escapedStem}(?:[|#][^\\]]*)?\\]\\]`);
        const pass = !selfRe.test(content);
        return {
          name: rule.name,
          pass,
          detail: pass ? "" : `Content must not contain a self-wikilink to "[[${stem}]]"`,
        };
      }

      case "noMalformedWikilinks": {
        // Check for empty links: [[]], [[|...]], [[#...]]
        const emptyLinkRe = /\[\[\s*(?:[|#][^\]]+)?\s*\]\]/g;
        emptyLinkRe.lastIndex = 0;
        if (emptyLinkRe.test(content)) {
          return {
            name: rule.name,
            pass: false,
            detail: "Content contains empty wikilink(s) like [[]] or [[|...]]",
          };
        }

        // Check for unterminated [[...  (no closing ]] on the same line)
        const lines = content.split("\n");
        for (const line of lines) {
          // Count [[ and ]] on the line
          const opens = (line.match(/\[\[/g) ?? []).length;
          const closes = (line.match(/\]\]/g) ?? []).length;
          if (opens > closes) {
            return {
              name: rule.name,
              pass: false,
              detail: `Content contains unterminated wikilink on line: "${line.trim().slice(0, 80)}"`,
            };
          }
        }

        return { name: rule.name, pass: true, detail: "" };
      }

      case "minWordCount": {
        const wordCount = content.trim() === "" ? 0 : content.trim().split(/\s+/).length;
        const required = rule.count ?? 0;
        const pass = wordCount >= required;
        return {
          name: rule.name,
          pass,
          detail: pass ? "" : `Content must have at least ${required} words (has ${wordCount})`,
        };
      }

      default:
        return { name: rule.name, pass: true, detail: "" };
    }
  }

  private classifyFolder(
    folderName: string,
    schema: Schema | null,
    mdFiles: string[],
    subDirs: string[],
  ): FolderType {
    if (!schema?.folders) return "unclassified";

    if (schema.folders.classification.skip.includes(folderName)) {
      return "unclassified"; // treated as skip; caller checks skip list separately
    }

    if (schema.folders.classification.supplemental.includes(folderName)) {
      return "supplemental";
    }

    // Superfolder: has subdirectories but no direct .md files
    if (subDirs.length > 0 && mdFiles.length === 0) {
      return "superfolder";
    }

    return "packet";
  }

  private async detectHub(
    mdFiles: string[],
    folderName: string,
    schema: Schema,
  ): Promise<{ hubPath: string | null; hubContent: string; hubError: string | null }> {
    const hubConfig = schema.folders?.hub;
    if (!hubConfig) return { hubPath: null, hubContent: "", hubError: null };

    const fileBasenames = new Map<string, string>(); // basename -> full path
    for (const f of mdFiles) {
      fileBasenames.set(path.basename(f), f);
    }

    for (const rule of hubConfig.detection) {
      if ("pattern" in rule) {
        const targetName = expandHubPattern(rule.pattern, folderName);
        if (fileBasenames.has(targetName)) {
          const hubPath = fileBasenames.get(targetName)!;
          let hubContent = "";
          try {
            const note = await this.vault.readNote(hubPath);
            hubContent = this.frontmatter.parse(note.raw).content;
          } catch {
            // hub exists but can't be read — content will be empty
          }
          return { hubPath, hubContent, hubError: null };
        }
      } else if ("fallback" in rule) {
        // Check the condition against each file's frontmatter
        const candidates: string[] = [];
        for (const filePath of mdFiles) {
          try {
            const note = await this.vault.readNote(filePath);
            const { frontmatter: fm } = this.frontmatter.parse(note.raw);
            if (this.evalCondition(rule.fallback, fm)) {
              candidates.push(filePath);
            }
          } catch {
            // skip unreadable files
          }
        }

        if (candidates.length === 1) {
          const hubPath = candidates[0];
          let hubContent = "";
          try {
            const note = await this.vault.readNote(hubPath);
            hubContent = this.frontmatter.parse(note.raw).content;
          } catch {
            // hub exists but can't be read
          }
          return { hubPath, hubContent, hubError: null };
        }

        if (candidates.length > 1) {
          return {
            hubPath: null,
            hubContent: "",
            hubError: `Multiple hub candidates found: ${candidates.join(", ")}`,
          };
        }
        // 0 candidates — continue to next rule (but fallback is last, so no hub)
        return { hubPath: null, hubContent: "", hubError: null };
      }
    }

    return { hubPath: null, hubContent: "", hubError: null };
  }

  private async checkStructuralRules(
    rules: StructuralRule[],
    hubPath: string | null,
    hubContent: string,
    hubError: string | null,
    mdFiles: string[],
    _folderPath: string,
  ): Promise<Check[]> {
    const checks: Check[] = [];

    for (const rule of rules) {
      if (rule.check === "hubCoversChildren") {
        if (hubError) {
          checks.push({ name: rule.name, pass: false, detail: hubError });
          continue;
        }
        if (!hubPath) {
          checks.push({
            name: rule.name,
            pass: false,
            detail: "No hub file found — cannot check hub coverage",
          });
          continue;
        }

        const linkedStems = extractWikilinkStems(hubContent);
        const siblings = mdFiles.filter((f) => f !== hubPath);
        const uncovered: string[] = [];

        for (const sibling of siblings) {
          const sibStem = getStem(path.basename(sibling));
          if (!linkedStems.has(sibStem)) {
            uncovered.push(sibling);
          }
        }

        const pass = uncovered.length === 0;
        checks.push({
          name: rule.name,
          pass,
          detail: pass ? "" : `Hub does not cover: ${uncovered.join(", ")}`,
        });
      } else if (rule.check === "noOrphansInFolder") {
        if (hubError) {
          checks.push({ name: rule.name, pass: false, detail: hubError });
          continue;
        }

        // Build set of all stems linked from any file in the folder
        const allLinkedStems = new Set<string>();
        const fileContents = new Map<string, string>();

        for (const f of mdFiles) {
          try {
            const note = await this.vault.readNote(f);
            const { content } = this.frontmatter.parse(note.raw);
            fileContents.set(f, content);
            const stems = extractWikilinkStems(content);
            stems.forEach((s) => allLinkedStems.add(s));
          } catch {
            // skip unreadable files
          }
        }

        // Check non-hub files for orphan status
        const nonHubFiles = hubPath ? mdFiles.filter((f) => f !== hubPath) : mdFiles;
        const orphans: string[] = [];

        for (const f of nonHubFiles) {
          const fileStem = getStem(path.basename(f));
          const fileBase = path.basename(f, path.extname(f));
          if (!allLinkedStems.has(fileStem) && !allLinkedStems.has(fileBase)) {
            orphans.push(f);
          }
        }

        const pass = orphans.length === 0;
        checks.push({
          name: rule.name,
          pass,
          detail: pass
            ? ""
            : `Orphan notes found (not linked from any sibling): ${orphans.join(", ")}`,
        });
      }
    }

    return checks;
  }

  private async walkDirectories(
    dirPath: string,
    folders: Record<string, FolderValidation>,
    summary: { total: number; passed: number; failed: number; skipped: number },
  ): Promise<void> {
    let listing;
    try {
      listing = await this.vault.listDirectory(dirPath);
    } catch (err) {
      log.warn({ dirPath, err }, "walkDirectories: could not list directory");
      return;
    }

    const folderResult = await this.validateFolderWithListing(dirPath, listing);
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

    for (const entry of listing.entries) {
      if (entry.type === "directory") {
        await this.walkDirectories(entry.path, folders, summary);
      }
    }
  }
}
