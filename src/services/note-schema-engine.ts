import type {
  NoteSchema,
  SchemaField,
  SchemaConstraint,
  ContentRule,
  NoteTemplate,
  LintResult,
  Check,
  FileService,
  TemplateContext,
  ParsedNote,
} from "../types.js";
import { createChildLog } from "../markscribe-log.js";
import {
  escapeRegex,
  expandTemplateVars,
  buildTemplateContext,
  evalCondition,
  scanWikilinks,
} from "../utils.js";
import type { VaultIndex } from "./vault-index.js";

const log = createChildLog({ service: "NoteSchemaEngine" });

const EMPTY_WIKILINK_RE = /\[\[\s*(?:[|#][^\]]+)?\s*\]\]/;
const WIKILINK_OPEN_RE = /\[\[/g;
const WIKILINK_CLOSE_RE = /\]\]/g;

export class NoteSchemaEngineImpl {
  private readonly regexCache = new Map<string, RegExp>();

  constructor(private readonly file: FileService) {}

  /**
   * Lint a note against a pre-resolved schema.
   * If schema is null, returns pass with no checks.
   * Accepts an optional pre-read note to avoid double-reading.
   */
  async lintNote(
    notePath: string,
    schema: NoteSchema | null,
    preReadNote?: ParsedNote,
    vaultIndex?: VaultIndex,
  ): Promise<LintResult> {
    log.info({ path: notePath, schema: schema?.name ?? null }, "lintNote start");

    if (!schema) {
      return { path: notePath, pass: true, schema: null, checks: [] };
    }

    const note = preReadNote ?? (await this.file.readNote(notePath));
    const fm = note.frontmatter;
    const content = note.content;
    const ctx = buildTemplateContext(notePath);
    const checks: Check[] = [];

    // Frontmatter field checks
    for (const [fieldName, fieldDef] of Object.entries(schema.frontmatter.fields)) {
      const fieldChecks = this.checkField(fieldName, fieldDef, fm, ctx);
      checks.push(...fieldChecks);
    }

    // Content rule checks
    for (const rule of schema.content.rules) {
      checks.push(await this.checkContentRule(rule, content, ctx, vaultIndex));
    }

    const pass = checks.every((c) => c.pass);
    log.info(
      { path: notePath, schema: schema.name, pass, checkCount: checks.length },
      "lintNote complete",
    );

    return { path: notePath, pass, schema: schema.name, checks };
  }

  getTemplate(schema: NoteSchema): NoteTemplate {
    log.info({ schemaName: schema.name }, "getTemplate");

    const frontmatter: Record<string, unknown> = {};
    for (const [fieldName, fieldDef] of Object.entries(schema.frontmatter.fields)) {
      if (!fieldDef.required) continue;
      if (fieldDef.when) continue;

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
          case "date":
            frontmatter[fieldName] = new Date();
            break;
        }
      }
    }

    return { frontmatter, content: "" };
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private getCachedRegex(pattern: string): RegExp {
    let re = this.regexCache.get(pattern);
    if (!re) {
      re = new RegExp(pattern);
      this.regexCache.set(pattern, re);
    }
    return re;
  }

  private checkField(
    fieldName: string,
    fieldDef: SchemaField,
    fm: Record<string, unknown>,
    ctx: TemplateContext,
  ): Check[] {
    if (fieldDef.when && !evalCondition(fieldDef.when, fm)) {
      return [];
    }

    const checks: Check[] = [];
    const value = fm[fieldName];
    const absent = value === null || value === undefined;

    if (fieldDef.required) {
      const missing = absent || (typeof value === "string" && value.length === 0);
      checks.push({
        name: `field_${fieldName}_required`,
        pass: !missing,
        detail: missing ? `Field "${fieldName}" is required but missing or empty` : "",
      });
    }

    if (absent) return checks;

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
      case "date":
        typeOk = value instanceof Date && !Number.isNaN(value.getTime());
        break;
    }

    checks.push({
      name: `field_${fieldName}_type`,
      pass: typeOk,
      detail: typeOk
        ? ""
        : `Field "${fieldName}" expected type "${fieldDef.type}" but got "${typeof value}"`,
    });

    if (!typeOk) return checks;

    if (fieldDef.format) {
      const stringValue =
        value instanceof Date
          ? value.toISOString().slice(0, 10)
          : typeof value === "string"
            ? value
            : null;
      if (stringValue !== null) {
        const formatRe = this.getCachedRegex(fieldDef.format);
        const formatOk = formatRe.test(stringValue);
        checks.push({
          name: `field_${fieldName}_format`,
          pass: formatOk,
          detail: formatOk
            ? ""
            : `Field "${fieldName}" value "${stringValue}" does not match format "${fieldDef.format}"`,
        });
      }
    }

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
      const re = this.getCachedRegex(constraint.atLeastOne.matches);
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
      const re = this.getCachedRegex(constraint.allMatch);
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
      const stringValue =
        value instanceof Date
          ? value.toISOString().slice(0, 10)
          : typeof value === "string"
            ? value
            : null;
      if (stringValue === null) return null;
      const re = this.getCachedRegex(constraint.pattern);
      const pass = re.test(stringValue);
      return {
        name: `field_${fieldName}_pattern`,
        pass,
        detail: pass
          ? ""
          : `Field "${fieldName}" value "${stringValue}" does not match pattern "${constraint.pattern}"`,
      };
    }

    return null;
  }

  private async checkContentRule(
    rule: ContentRule,
    content: string,
    ctx: TemplateContext,
    vaultIndex?: VaultIndex,
  ): Promise<Check> {
    switch (rule.check) {
      case "hasPattern": {
        const re = this.getCachedRegex(rule.pattern ?? "");
        const pass = re.test(content);
        return {
          name: rule.name,
          pass,
          detail: pass ? "" : `Content must match pattern "${rule.pattern}"`,
        };
      }

      case "noPattern": {
        const re = this.getCachedRegex(rule.pattern ?? "");
        const pass = !re.test(content);
        return {
          name: rule.name,
          pass,
          detail: pass ? "" : `Content must not match pattern "${rule.pattern}"`,
        };
      }

      case "noSelfWikilink": {
        const stem = ctx.stem;
        const selfRe = this.getCachedRegex(`\\[\\[${escapeRegex(stem)}(?:[|#][^\\]]*)?\\]\\]`);
        const pass = !selfRe.test(content);
        return {
          name: rule.name,
          pass,
          detail: pass ? "" : `Content must not contain a self-wikilink to "[[${stem}]]"`,
        };
      }

      case "noMalformedWikilinks": {
        if (EMPTY_WIKILINK_RE.test(content)) {
          return {
            name: rule.name,
            pass: false,
            detail: "Content contains empty wikilink(s) like [[]] or [[|...]]",
          };
        }

        const lines = content.split("\n");
        for (const line of lines) {
          const opens = (line.match(WIKILINK_OPEN_RE) ?? []).length;
          const closes = (line.match(WIKILINK_CLOSE_RE) ?? []).length;
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

      case "noBrokenWikilinks": {
        if (!vaultIndex) {
          // Defensive: schema engine should always pass an index when this
          // rule is in play. If absent, do not block — surface the gap.
          return {
            name: rule.name,
            pass: true,
            detail: "noBrokenWikilinks skipped: vault index unavailable",
          };
        }

        const broken: string[] = [];
        for (const scanned of scanWikilinks(content)) {
          if (!vaultIndex.resolve(scanned.target)) {
            broken.push(scanned.target);
          }
        }

        if (broken.length === 0) {
          return { name: rule.name, pass: true, detail: "" };
        }

        const formatted = broken.map((t) => `[[${t}]]`).join(", ");
        return {
          name: rule.name,
          pass: false,
          detail: `Broken wikilinks: ${formatted}`,
        };
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
}
