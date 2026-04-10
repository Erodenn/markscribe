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
import { escapeRegex, expandTemplateVars, buildTemplateContext, evalCondition } from "../utils.js";

const log = createChildLog({ service: "NoteSchemaEngine" });

export class NoteSchemaEngineImpl {
  private readonly regexCache = new Map<string, RegExp>();

  constructor(private readonly vault: FileService) {}

  /**
   * Lint a note against a pre-resolved schema.
   * If schema is null, returns pass with no checks.
   * Accepts an optional pre-read note to avoid double-reading.
   */
  async lintNote(
    notePath: string,
    schema: NoteSchema | null,
    preReadNote?: ParsedNote,
  ): Promise<LintResult> {
    log.info({ path: notePath, schema: schema?.name ?? null }, "lintNote start");

    if (!schema) {
      return { path: notePath, pass: true, schema: null, checks: [] };
    }

    const note = preReadNote ?? (await this.vault.readNote(notePath));
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
      checks.push(this.checkContentRule(rule, content, ctx));
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
    }

    checks.push({
      name: `field_${fieldName}_type`,
      pass: typeOk,
      detail: typeOk
        ? ""
        : `Field "${fieldName}" expected type "${fieldDef.type}" but got "${typeof value}"`,
    });

    if (!typeOk) return checks;

    if (fieldDef.format && typeof value === "string") {
      const formatRe = this.getCachedRegex(fieldDef.format);
      const formatOk = formatRe.test(value);
      checks.push({
        name: `field_${fieldName}_format`,
        pass: formatOk,
        detail: formatOk
          ? ""
          : `Field "${fieldName}" value "${value}" does not match format "${fieldDef.format}"`,
      });
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
      const re = this.getCachedRegex(constraint.pattern);
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
        const selfRe = new RegExp(`\\[\\[${escapedStem}(?:[|#][^\\]]*)?\\]\\]`);
        const pass = !selfRe.test(content);
        return {
          name: rule.name,
          pass,
          detail: pass ? "" : `Content must not contain a self-wikilink to "[[${stem}]]"`,
        };
      }

      case "noMalformedWikilinks": {
        const emptyLinkRe = /\[\[\s*(?:[|#][^\]]+)?\s*\]\]/g;
        emptyLinkRe.lastIndex = 0;
        if (emptyLinkRe.test(content)) {
          return {
            name: rule.name,
            pass: false,
            detail: "Content contains empty wikilink(s) like [[]] or [[|...]]",
          };
        }

        const lines = content.split("\n");
        for (const line of lines) {
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
}
