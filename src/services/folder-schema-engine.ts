import path from "node:path";
import type {
  FolderSchema,
  FolderValidation,
  FolderType,
  AreaValidation,
  Check,
  StructuralRule,
  FileService,
  ParsedNote,
} from "../types.js";
import { createChildLog } from "../markscribe-log.js";
import {
  getStem,
  evalCondition,
  extractWikilinkStems,
  expandHubPattern,
} from "../utils.js";
import type { ConventionCascadeImpl } from "./convention-cascade.js";

const log = createChildLog({ service: "FolderSchemaEngine" });

// ============================================================================
// Structural check context
// ============================================================================

interface StructuralCheckContext {
  rule: StructuralRule;
  mdFiles: string[];
  subDirs: string[];
  folderPath: string;
  hubPath: string | null;
  hubContent: string;
  notes: Map<string, ParsedNote>;
}

type StructuralChecker = (ctx: StructuralCheckContext) => Promise<Check>;

// ============================================================================
// FolderSchemaEngineImpl
// ============================================================================

export class FolderSchemaEngineImpl {
  private readonly checkers: Record<string, StructuralChecker>;
  private readonly regexCache = new Map<string, RegExp>();

  constructor(private readonly file: FileService) {
    this.checkers = {
      hubCoversChildren: (ctx) => this.checkHubCoversChildren(ctx),
      noOrphansInFolder: (ctx) => this.checkNoOrphansInFolder(ctx),
      noSubdirectories: (ctx) => this.checkNoSubdirectories(ctx),
      requiredFile: (ctx) => this.checkRequiredFile(ctx),
      filenamePattern: (ctx) => this.checkFilenamePattern(ctx),
      minFileCount: (ctx) => this.checkMinFileCount(ctx),
      maxFileCount: (ctx) => this.checkMaxFileCount(ctx),
      minOutgoingLinks: (ctx) => this.checkMinOutgoingLinks(ctx),
      allNotesMatch: (ctx) => this.checkAllNotesMatch(ctx),
      someNoteMatches: (ctx) => this.checkSomeNoteMatches(ctx),
    };
  }

  async validateFolder(
    folderPath: string,
    folderSchema: FolderSchema | null,
    lintNoteFn: (notePath: string, preReadNote?: ParsedNote) => Promise<import("../types.js").LintResult>,
  ): Promise<FolderValidation> {
    log.info({ path: folderPath, schema: folderSchema?.name ?? null }, "validateFolder start");

    const listing = await this.file.listDirectory(folderPath);
    const folderName = path.basename(folderPath) || folderPath;

    // Exclude _conventions.md — it's a cascade binding, not a content note
    const CONVENTIONS_FILENAME = "_conventions.md";
    const mdFiles = listing.entries
      .filter((e) => e.type === "file" && e.name.endsWith(".md") && e.name !== CONVENTIONS_FILENAME)
      .map((e) => e.path);
    const subDirs = listing.entries.filter((e) => e.type === "directory").map((e) => e.path);

    if (folderSchema?.classification.skip.includes(folderName)) {
      log.info({ path: folderPath, folderType: "unclassified" }, "validateFolder: skip folder");
      return {
        path: folderPath,
        pass: true,
        folderType: "unclassified",
        schema: folderSchema?.name ?? null,
        notes: {},
        structural: [],
      };
    }

    // Pre-read all notes (used by classification, lint, and structural checks)
    const notesMap = new Map<string, ParsedNote>();
    for (const f of mdFiles) {
      try {
        notesMap.set(f, await this.file.readNote(f));
      } catch {
        // skip unreadable
      }
    }

    // Detect hub up front — needed for section vs packet classification
    let hubPath: string | null = null;
    let hubContent = "";
    let hubError: string | null = null;
    if (folderSchema) {
      const detection = await this.detectHub(mdFiles, folderName, folderSchema, notesMap);
      hubPath = detection.hubPath;
      hubContent = detection.hubContent;
      hubError = detection.hubError;
    }

    let folderType = this.classifyFolder(folderName, folderSchema, mdFiles, subDirs);

    // Promote packet candidates without a hub to "section" if they sit beneath
    // a packet ancestor — sections lint their notes but skip structural rules.
    if (
      folderType === "packet" &&
      folderSchema?.hub &&
      hubPath === null &&
      !hubError &&
      (await this.hasPacketAncestor(folderPath, folderSchema))
    ) {
      folderType = "section";
    }

    if (folderType === "supplemental") {
      log.info({ path: folderPath, folderType }, "validateFolder: supplemental folder");
      return {
        path: folderPath,
        pass: true,
        folderType,
        schema: folderSchema?.name ?? null,
        notes: {},
        structural: [],
      };
    }

    const notes: Record<string, import("../types.js").LintResult> = {};
    for (const notePath of mdFiles) {
      notes[notePath] = await lintNoteFn(notePath, notesMap.get(notePath));
    }

    let structural: Check[] = [];
    if (
      folderType === "packet" &&
      folderSchema?.structural &&
      folderSchema.structural.length > 0
    ) {
      if (hubError) {
        for (const rule of folderSchema.structural) {
          structural.push({ name: rule.name, pass: false, detail: hubError });
        }
      } else {
        structural = await this.runStructuralChecks(folderSchema.structural, {
          mdFiles,
          subDirs,
          folderPath,
          hubPath,
          hubContent,
          notes: notesMap,
        });
      }
    }

    const notesPassing = Object.values(notes).every((r) => r.pass);
    const structuralPassing = structural.every((c) => c.pass);
    const pass = notesPassing && structuralPassing;

    log.info({ path: folderPath, folderType, pass }, "validateFolder complete");
    return {
      path: folderPath,
      pass,
      folderType,
      schema: folderSchema?.name ?? null,
      notes,
      structural,
    };
  }

  async validateArea(
    areaPath: string,
    cascade: ConventionCascadeImpl | null,
    lintNoteFn: (notePath: string, preReadNote?: ParsedNote) => Promise<import("../types.js").LintResult>,
    getSchemaForFolder: (folderPath: string) => FolderSchema | null,
  ): Promise<AreaValidation> {
    log.info({ path: areaPath }, "validateArea start");

    const folders: Record<string, FolderValidation> = {};
    const summary = { total: 0, passed: 0, failed: 0, skipped: 0 };

    await this.walkDirectories(areaPath, folders, summary, lintNoteFn, getSchemaForFolder);

    const pass = summary.failed === 0;
    log.info({ path: areaPath, ...summary }, "validateArea complete");

    return {
      path: areaPath,
      pass,
      folders,
      summary,
    };
  }

  // ==========================================================================
  // Classification + Hub Detection
  // ==========================================================================

  classifyFolder(
    folderName: string,
    schema: FolderSchema | null,
    mdFiles: string[],
    subDirs: string[],
  ): FolderType {
    if (!schema) return "unclassified";

    if (schema.classification.skip.includes(folderName)) {
      return "unclassified";
    }

    if (schema.classification.supplemental.includes(folderName)) {
      return "supplemental";
    }

    if (subDirs.length > 0 && mdFiles.length === 0) {
      return "superfolder";
    }

    return "packet";
  }

  /**
   * Walk up parent directories looking for a folder whose hub file exists
   * (per the schema's pattern-based hub rules). Used to distinguish
   * organizational sections (inside a packet) from top-level packet candidates.
   */
  async hasPacketAncestor(folderPath: string, schema: FolderSchema): Promise<boolean> {
    if (!schema.hub) return false;
    const patternRules = schema.hub.detection.filter(
      (r): r is { pattern: string } => "pattern" in r,
    );
    if (patternRules.length === 0) return false;

    let current = path.dirname(folderPath);
    let lastSeen: string | null = null;
    while (current && current !== "." && current !== "/" && current !== lastSeen) {
      lastSeen = current;
      const parentName = path.basename(current);
      let listing;
      try {
        listing = await this.file.listDirectory(current);
      } catch {
        return false;
      }
      const fileBasenames = new Set(
        listing.entries.filter((e) => e.type === "file").map((e) => e.name),
      );
      for (const rule of patternRules) {
        const target = expandHubPattern(rule.pattern, parentName);
        if (fileBasenames.has(target)) return true;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return false;
  }

  async detectHub(
    mdFiles: string[],
    folderName: string,
    schema: FolderSchema,
    notesMap?: Map<string, ParsedNote>,
  ): Promise<{ hubPath: string | null; hubContent: string; hubError: string | null }> {
    const hubConfig = schema.hub;
    if (!hubConfig) return { hubPath: null, hubContent: "", hubError: null };

    const fileBasenames = new Map<string, string>();
    for (const f of mdFiles) {
      fileBasenames.set(path.basename(f), f);
    }

    for (const rule of hubConfig.detection) {
      if ("pattern" in rule) {
        const targetName = expandHubPattern(rule.pattern, folderName);
        if (fileBasenames.has(targetName)) {
          const hubPath = fileBasenames.get(targetName)!;
          const note = notesMap?.get(hubPath);
          const hubContent = note?.content ?? "";
          return { hubPath, hubContent, hubError: null };
        }
      } else if ("fallback" in rule) {
        const candidates: string[] = [];
        for (const filePath of mdFiles) {
          const note = notesMap?.get(filePath);
          if (note && evalCondition(rule.fallback, note.frontmatter)) {
            candidates.push(filePath);
          }
        }

        if (candidates.length === 1) {
          const hubPath = candidates[0];
          const note = notesMap?.get(hubPath);
          const hubContent = note?.content ?? "";
          return { hubPath, hubContent, hubError: null };
        }

        if (candidates.length > 1) {
          return {
            hubPath: null,
            hubContent: "",
            hubError: `Multiple hub candidates found: ${candidates.join(", ")}`,
          };
        }
        return { hubPath: null, hubContent: "", hubError: null };
      }
    }

    return { hubPath: null, hubContent: "", hubError: null };
  }

  // ==========================================================================
  // Structural Checks
  // ==========================================================================

  private async runStructuralChecks(
    rules: StructuralRule[],
    base: Omit<StructuralCheckContext, "rule">,
  ): Promise<Check[]> {
    const checks: Check[] = [];

    for (const rule of rules) {
      const checker = this.checkers[rule.check];
      if (!checker) {
        checks.push({
          name: rule.name,
          pass: false,
          detail: `Unknown structural check: ${rule.check}`,
        });
        continue;
      }

      const ctx: StructuralCheckContext = { ...base, rule };
      checks.push(await checker(ctx));
    }

    return checks;
  }

  private async checkHubCoversChildren(ctx: StructuralCheckContext): Promise<Check> {
    if (!ctx.hubPath) {
      return {
        name: ctx.rule.name,
        pass: false,
        detail: "No hub file found — cannot check hub coverage",
      };
    }

    const linkedStems = extractWikilinkStems(ctx.hubContent);
    const siblings = ctx.mdFiles.filter((f) => f !== ctx.hubPath);
    const uncovered: string[] = [];

    for (const sibling of siblings) {
      const sibStem = getStem(path.basename(sibling));
      if (!linkedStems.has(sibStem)) {
        uncovered.push(sibling);
      }
    }

    const pass = uncovered.length === 0;
    return {
      name: ctx.rule.name,
      pass,
      detail: pass ? "" : `Hub does not cover: ${uncovered.join(", ")}`,
    };
  }

  private async checkNoOrphansInFolder(ctx: StructuralCheckContext): Promise<Check> {
    const allLinkedStems = new Set<string>();

    for (const f of ctx.mdFiles) {
      const note = ctx.notes.get(f);
      if (note) {
        const stems = extractWikilinkStems(note.content);
        stems.forEach((s) => allLinkedStems.add(s));
      }
    }

    const nonHubFiles = ctx.hubPath ? ctx.mdFiles.filter((f) => f !== ctx.hubPath) : ctx.mdFiles;
    const orphans: string[] = [];

    for (const f of nonHubFiles) {
      const fileStem = getStem(path.basename(f));
      const fileBase = path.basename(f, path.extname(f));
      if (!allLinkedStems.has(fileStem) && !allLinkedStems.has(fileBase)) {
        orphans.push(f);
      }
    }

    const pass = orphans.length === 0;
    return {
      name: ctx.rule.name,
      pass,
      detail: pass
        ? ""
        : `Orphan notes found (not linked from any sibling): ${orphans.join(", ")}`,
    };
  }

  private async checkNoSubdirectories(ctx: StructuralCheckContext): Promise<Check> {
    const pass = ctx.subDirs.length === 0;
    return {
      name: ctx.rule.name,
      pass,
      detail: pass ? "" : `Folder contains ${ctx.subDirs.length} subdirectory(ies)`,
    };
  }

  private getCachedRegex(pattern: string): RegExp {
    let re = this.regexCache.get(pattern);
    if (!re) {
      re = new RegExp(pattern);
      this.regexCache.set(pattern, re);
    }
    return re;
  }

  private async checkRequiredFile(ctx: StructuralCheckContext): Promise<Check> {
    const pattern = ctx.rule.pattern;
    if (!pattern) {
      return { name: ctx.rule.name, pass: false, detail: "requiredFile: no pattern specified" };
    }
    const re = this.getCachedRegex(pattern);
    const found = ctx.mdFiles.some((f) => re.test(path.basename(f)));
    return {
      name: ctx.rule.name,
      pass: found,
      detail: found ? "" : `Required file matching "${pattern}" not found`,
    };
  }

  private async checkFilenamePattern(ctx: StructuralCheckContext): Promise<Check> {
    const pattern = ctx.rule.pattern;
    if (!pattern) {
      return { name: ctx.rule.name, pass: false, detail: "filenamePattern: no pattern specified" };
    }
    const re = this.getCachedRegex(pattern);
    const failing = ctx.mdFiles.filter((f) => !re.test(path.basename(f)));
    const pass = failing.length === 0;
    return {
      name: ctx.rule.name,
      pass,
      detail: pass ? "" : `Files not matching pattern "${pattern}": ${failing.join(", ")}`,
    };
  }

  private async checkMinFileCount(ctx: StructuralCheckContext): Promise<Check> {
    const count = ctx.rule.count ?? 0;
    const pass = ctx.mdFiles.length >= count;
    return {
      name: ctx.rule.name,
      pass,
      detail: pass
        ? ""
        : `Folder has ${ctx.mdFiles.length} file(s), minimum is ${count}`,
    };
  }

  private async checkMaxFileCount(ctx: StructuralCheckContext): Promise<Check> {
    const count = ctx.rule.count ?? Infinity;
    const pass = ctx.mdFiles.length <= count;
    return {
      name: ctx.rule.name,
      pass,
      detail: pass
        ? ""
        : `Folder has ${ctx.mdFiles.length} file(s), maximum is ${count}`,
    };
  }

  private async checkMinOutgoingLinks(ctx: StructuralCheckContext): Promise<Check> {
    const minLinks = ctx.rule.count ?? 1;
    const failing: string[] = [];

    for (const f of ctx.mdFiles) {
      const note = ctx.notes.get(f);
      if (!note) continue;
      const stems = extractWikilinkStems(note.content);
      if (stems.size < minLinks) {
        failing.push(f);
      }
    }

    const pass = failing.length === 0;
    return {
      name: ctx.rule.name,
      pass,
      detail: pass
        ? ""
        : `Notes with fewer than ${minLinks} outgoing link(s): ${failing.join(", ")}`,
    };
  }

  private async checkAllNotesMatch(ctx: StructuralCheckContext): Promise<Check> {
    const condition = ctx.rule.when;
    if (!condition) {
      return {
        name: ctx.rule.name,
        pass: false,
        detail: "allNotesMatch: no when condition specified",
      };
    }

    const failing: string[] = [];
    for (const f of ctx.mdFiles) {
      const note = ctx.notes.get(f);
      if (!note) continue;
      if (!evalCondition(condition, note.frontmatter)) {
        failing.push(f);
      }
    }

    const pass = failing.length === 0;
    return {
      name: ctx.rule.name,
      pass,
      detail: pass ? "" : `Notes not matching condition: ${failing.join(", ")}`,
    };
  }

  private async checkSomeNoteMatches(ctx: StructuralCheckContext): Promise<Check> {
    const condition = ctx.rule.when;
    if (!condition) {
      return {
        name: ctx.rule.name,
        pass: false,
        detail: "someNoteMatches: no when condition specified",
      };
    }

    const minCount = ctx.rule.count ?? 1;
    let matching = 0;
    for (const f of ctx.mdFiles) {
      const note = ctx.notes.get(f);
      if (!note) continue;
      if (evalCondition(condition, note.frontmatter)) {
        matching++;
      }
    }

    const pass = matching >= minCount;
    return {
      name: ctx.rule.name,
      pass,
      detail: pass
        ? ""
        : `Only ${matching} note(s) match condition, minimum is ${minCount}`,
    };
  }

  // ==========================================================================
  // Directory walking
  // ==========================================================================

  private async walkDirectories(
    dirPath: string,
    folders: Record<string, FolderValidation>,
    summary: { total: number; passed: number; failed: number; skipped: number },
    lintNoteFn: (notePath: string, preReadNote?: ParsedNote) => Promise<import("../types.js").LintResult>,
    getSchemaForFolder: (folderPath: string) => FolderSchema | null,
  ): Promise<void> {
    let listing;
    try {
      listing = await this.file.listDirectory(dirPath);
    } catch (err) {
      log.warn({ dirPath, err }, "walkDirectories: could not list directory");
      return;
    }

    const folderSchema = getSchemaForFolder(dirPath);
    const folderResult = await this.validateFolder(dirPath, folderSchema, lintNoteFn);
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
        await this.walkDirectories(entry.path, folders, summary, lintNoteFn, getSchemaForFolder);
      }
    }
  }
}
