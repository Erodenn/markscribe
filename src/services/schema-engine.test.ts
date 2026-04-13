import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SchemaEngineImpl } from "./schema-engine.js";
import { VaultServiceImpl } from "./vault-service.js";
import { FrontmatterServiceImpl } from "./frontmatter-service.js";
import { PathFilterImpl } from "./path-filter.js";

// =============================================================================
// Helpers
// =============================================================================

async function makeTempVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "vaultscribe-schema-test-"));
}

function makeServices(vaultPath: string): {
  schema: SchemaEngineImpl;
  vault: VaultServiceImpl;
} {
  const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
  const vault = new VaultServiceImpl(vaultPath, filter);
  const frontmatter = new FrontmatterServiceImpl(vault);
  const schema = new SchemaEngineImpl(vault, frontmatter);
  return { schema, vault };
}

async function writeSchema(schemasDir: string, filename: string, content: string): Promise<void> {
  await fs.mkdir(schemasDir, { recursive: true });
  await fs.writeFile(path.join(schemasDir, filename), content, "utf-8");
}

async function writeNote(vaultPath: string, relPath: string, content: string): Promise<void> {
  const full = path.join(vaultPath, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

// =============================================================================
// Fixture YAML schemas
// =============================================================================

const BASIC_SCHEMA_YAML = `
name: basic
description: Basic test schema
scope:
  paths: ["Notes/"]
  exclude: []
frontmatter:
  fields:
    title:
      type: string
      required: true
    tags:
      type: list
      required: true
content:
  rules: []
`;

const CONTENT_RULES_SCHEMA_YAML = `
name: content-rules
description: Schema with content rules
scope:
  paths: ["Content/"]
  exclude: []
frontmatter:
  fields: {}
content:
  rules:
    - name: has-outgoing-link
      check: hasPattern
      pattern: "\\\\[\\\\[.+?\\\\]\\\\]"
    - name: no-broken-words
      check: noPattern
      pattern: "BROKEN"
    - name: no-self-links
      check: noSelfWikilink
    - name: no-malformed
      check: noMalformedWikilinks
    - name: min-words
      check: minWordCount
      count: 5
`;

const PACKET_SCHEMA_YAML = `
name: knowledge-packet
description: Packet schema with folder rules
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
    created:
      type: string
      required: true
      format: "\\\\d{4}-\\\\d{2}-\\\\d{2}"
    aliases:
      type: list
      required: true
      when:
        tagPresent: hub
      constraints:
        - exactItems: 1
        - firstEquals: "{{stem}}"
content:
  rules: []
folders:
  classification:
    supplemental: ["Resources"]
    skip: ["_Inbox"]
  hub:
    detection:
      - pattern: "_{folderName}.md"
      - pattern: "{folderName}.md"
      - fallback:
          tagPresent: hub
    required: true
  structural:
    - name: hub-links-all-children
      check: hubCoversChildren
    - name: no-orphan-notes
      check: noOrphansInFolder
`;

// =============================================================================
// loadSchemas
// =============================================================================

describe("SchemaEngineImpl.loadSchemas", () => {
  let tmpDir: string;
  let svc: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ schema: svc } = makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads a valid YAML schema file", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
    const list = svc.listSchemas();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("basic");
    expect(list[0].description).toBe("Basic test schema");
  });

  it("loads multiple schemas from directory", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await writeSchema(schemasDir, "content.yaml", CONTENT_RULES_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
    expect(svc.listSchemas()).toHaveLength(2);
  });

  it("skips malformed YAML files without throwing", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "broken.yaml", "{ not: valid: yaml: [");
    await writeSchema(schemasDir, "good.yaml", BASIC_SCHEMA_YAML);
    await expect(svc.loadSchemas(schemasDir)).resolves.toBeUndefined();
    // Only the good one loaded
    expect(svc.listSchemas()).toHaveLength(1);
  });

  it("handles non-existent schemas directory without throwing", async () => {
    const schemasDir = path.join(tmpDir, "does-not-exist");
    await expect(svc.loadSchemas(schemasDir)).resolves.toBeUndefined();
    expect(svc.listSchemas()).toHaveLength(0);
  });

  it("loads schemas with no frontmatter fields (empty fields)", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "content.yaml", CONTENT_RULES_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
    const list = svc.listSchemas();
    expect(list[0].fieldCount).toBe(0);
    expect(list[0].contentRuleCount).toBe(5);
  });

  it("reports fieldCount and contentRuleCount correctly", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
    const info = svc.listSchemas()[0];
    expect(info.fieldCount).toBe(2);
    expect(info.contentRuleCount).toBe(0);
    expect(info.hasFolderConfig).toBe(false);
  });

  it("reports hasFolderConfig correctly", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "packet.yaml", PACKET_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
    const info = svc.listSchemas()[0];
    expect(info.hasFolderConfig).toBe(true);
  });
});

// =============================================================================
// getSchemaForPath — scope resolution
// =============================================================================

describe("SchemaEngineImpl.getSchemaForPath", () => {
  let tmpDir: string;
  let svc: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ schema: svc } = makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no schemas loaded", async () => {
    expect(svc.getSchemaForPath("Notes/foo.md")).toBeNull();
  });

  it("matches a note within scope", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
    const schema = svc.getSchemaForPath("Notes/foo.md");
    expect(schema?.name).toBe("basic");
  });

  it("returns null for a note outside scope", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
    expect(svc.getSchemaForPath("Other/foo.md")).toBeNull();
  });

  it("returns null for excluded paths", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "packet.yaml", PACKET_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
    // Knowledge/_Inbox/ is excluded
    expect(svc.getSchemaForPath("Knowledge/_Inbox/note.md")).toBeNull();
  });

  it("longest prefix wins over shorter prefix", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    const broadSchema = `
name: broad
description: Broad schema
scope:
  paths: ["Knowledge/"]
  exclude: []
frontmatter:
  fields: {}
content:
  rules: []
`;
    const narrowSchema = `
name: narrow
description: Narrow schema
scope:
  paths: ["Knowledge/Programming/"]
  exclude: []
frontmatter:
  fields: {}
content:
  rules: []
`;
    await writeSchema(schemasDir, "a-broad.yaml", broadSchema);
    await writeSchema(schemasDir, "b-narrow.yaml", narrowSchema);
    await svc.loadSchemas(schemasDir);

    // Should match narrow (longer prefix)
    expect(svc.getSchemaForPath("Knowledge/Programming/Rust/note.md")?.name).toBe("narrow");
    // Should match broad
    expect(svc.getSchemaForPath("Knowledge/History/note.md")?.name).toBe("broad");
  });

  it("tie-breaking: alphabetically first schema filename wins", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    const schema1 = `
name: alpha
description: Alpha
scope:
  paths: ["Shared/"]
  exclude: []
frontmatter:
  fields: {}
content:
  rules: []
`;
    const schema2 = `
name: beta
description: Beta
scope:
  paths: ["Shared/"]
  exclude: []
frontmatter:
  fields: {}
content:
  rules: []
`;
    // a-alpha.yaml sorts before b-beta.yaml
    await writeSchema(schemasDir, "a-alpha.yaml", schema1);
    await writeSchema(schemasDir, "b-beta.yaml", schema2);
    await svc.loadSchemas(schemasDir);
    // First loaded (a-alpha) should win
    expect(svc.getSchemaForPath("Shared/note.md")?.name).toBe("alpha");
  });
});

// =============================================================================
// lintNote — field types
// =============================================================================

describe("SchemaEngineImpl.lintNote — field types", () => {
  let tmpDir: string;
  let svc: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ schema: svc } = makeServices(tmpDir));
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(
      schemasDir,
      "types.yaml",
      `
name: types-schema
description: Type testing
scope:
  paths: ["Types/"]
  exclude: []
frontmatter:
  fields:
    str_field:
      type: string
      required: true
    list_field:
      type: list
      required: true
    num_field:
      type: number
      required: true
    bool_field:
      type: boolean
      required: true
content:
  rules: []
`,
    );
    await svc.loadSchemas(schemasDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("passes with all correct field types", async () => {
    await writeNote(
      tmpDir,
      "Types/note.md",
      "---\nstr_field: hello\nlist_field:\n  - a\nnum_field: 42\nbool_field: true\n---\nContent",
    );
    const result = await svc.lintNote("Types/note.md");
    expect(result.pass).toBe(true);
    expect(result.schema).toBe("types-schema");
  });

  it("fails when string field contains wrong type", async () => {
    await writeNote(
      tmpDir,
      "Types/note.md",
      "---\nstr_field:\n  - a\nlist_field:\n  - b\nnum_field: 1\nbool_field: true\n---\nContent",
    );
    const result = await svc.lintNote("Types/note.md");
    expect(result.pass).toBe(false);
    const typeCheck = result.checks.find((c) => c.name === "field_str_field_type");
    expect(typeCheck?.pass).toBe(false);
  });

  it("fails when required field is absent", async () => {
    await writeNote(
      tmpDir,
      "Types/note.md",
      "---\nlist_field:\n  - a\nnum_field: 1\nbool_field: true\n---\nContent",
    );
    const result = await svc.lintNote("Types/note.md");
    const reqCheck = result.checks.find((c) => c.name === "field_str_field_required");
    expect(reqCheck?.pass).toBe(false);
  });

  it("returns pass: true with schema: null when no schema matches", async () => {
    await writeNote(tmpDir, "Unmanaged/note.md", "---\ntitle: foo\n---\nContent");
    const result = await svc.lintNote("Unmanaged/note.md");
    expect(result.pass).toBe(true);
    expect(result.schema).toBeNull();
    expect(result.checks).toHaveLength(0);
  });
});

// =============================================================================
// lintNote — conditions
// =============================================================================

describe("SchemaEngineImpl.lintNote — conditions", () => {
  let tmpDir: string;
  let svc: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ schema: svc } = makeServices(tmpDir));
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(
      schemasDir,
      "conditions.yaml",
      `
name: conditions-schema
description: Condition testing
scope:
  paths: ["Cond/"]
  exclude: []
frontmatter:
  fields:
    hub_alias:
      type: string
      required: true
      when:
        tagPresent: hub
    source_url:
      type: string
      required: true
      when:
        fieldEquals:
          field: type
          value: source
    related_count:
      type: number
      required: true
      when:
        fieldExists: related
content:
  rules: []
`,
    );
    await svc.loadSchemas(schemasDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("tagPresent: skips validation when tag absent", async () => {
    await writeNote(tmpDir, "Cond/note.md", "---\ntags:\n  - other\n---\nContent");
    const result = await svc.lintNote("Cond/note.md");
    const check = result.checks.find((c) => c.name.startsWith("field_hub_alias"));
    expect(check).toBeUndefined();
  });

  it("tagPresent: validates when tag is present", async () => {
    await writeNote(tmpDir, "Cond/note.md", "---\ntags:\n  - hub\n---\nContent");
    const result = await svc.lintNote("Cond/note.md");
    const check = result.checks.find((c) => c.name === "field_hub_alias_required");
    expect(check?.pass).toBe(false); // hub_alias is missing
  });

  it("fieldEquals: skips validation when field value does not match", async () => {
    await writeNote(tmpDir, "Cond/note.md", "---\ntype: note\n---\nContent");
    const result = await svc.lintNote("Cond/note.md");
    const check = result.checks.find((c) => c.name.startsWith("field_source_url"));
    expect(check).toBeUndefined();
  });

  it("fieldEquals: validates when field equals expected value", async () => {
    await writeNote(tmpDir, "Cond/note.md", "---\ntype: source\n---\nContent");
    const result = await svc.lintNote("Cond/note.md");
    const check = result.checks.find((c) => c.name === "field_source_url_required");
    expect(check?.pass).toBe(false); // source_url is missing
  });

  it("fieldExists: skips validation when field absent", async () => {
    await writeNote(tmpDir, "Cond/note.md", "---\ntitle: foo\n---\nContent");
    const result = await svc.lintNote("Cond/note.md");
    const check = result.checks.find((c) => c.name.startsWith("field_related_count"));
    expect(check).toBeUndefined();
  });

  it("fieldExists: validates when field is present and non-empty", async () => {
    await writeNote(tmpDir, "Cond/note.md", "---\nrelated: something\n---\nContent");
    const result = await svc.lintNote("Cond/note.md");
    const check = result.checks.find((c) => c.name === "field_related_count_required");
    expect(check?.pass).toBe(false); // related_count is missing
  });
});

// =============================================================================
// lintNote — constraints
// =============================================================================

describe("SchemaEngineImpl.lintNote — constraints", () => {
  let tmpDir: string;
  let svc: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ schema: svc } = makeServices(tmpDir));
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(
      schemasDir,
      "constraints.yaml",
      `
name: constraints-schema
description: Constraint testing
scope:
  paths: ["Con/"]
  exclude: []
frontmatter:
  fields:
    items:
      type: list
      required: false
      constraints:
        - minItems: 2
        - maxItems: 5
    exact_items:
      type: list
      required: false
      constraints:
        - exactItems: 3
    matched_items:
      type: list
      required: false
      constraints:
        - atLeastOne:
            matches: "^tag/.+"
        - allMatch: "^[a-z]"
    first_item:
      type: list
      required: false
      constraints:
        - firstEquals: "{{stem}}"
    status:
      type: string
      required: false
      constraints:
        - enum: [draft, published, archived]
    code:
      type: string
      required: false
      constraints:
        - pattern: "^[A-Z]{3}-\\\\d{3}$"
content:
  rules: []
`,
    );
    await svc.loadSchemas(schemasDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("minItems: passes when list has enough items", async () => {
    await writeNote(tmpDir, "Con/note.md", "---\nitems:\n  - a\n  - b\n  - c\n---\nContent");
    const result = await svc.lintNote("Con/note.md");
    const check = result.checks.find((c) => c.name === "field_items_minItems");
    expect(check?.pass).toBe(true);
  });

  it("minItems: fails when list has too few items", async () => {
    await writeNote(tmpDir, "Con/note.md", "---\nitems:\n  - a\n---\nContent");
    const result = await svc.lintNote("Con/note.md");
    const check = result.checks.find((c) => c.name === "field_items_minItems");
    expect(check?.pass).toBe(false);
  });

  it("maxItems: fails when list has too many items", async () => {
    await writeNote(
      tmpDir,
      "Con/note.md",
      "---\nitems:\n  - a\n  - b\n  - c\n  - d\n  - e\n  - f\n---\nContent",
    );
    const result = await svc.lintNote("Con/note.md");
    const check = result.checks.find((c) => c.name === "field_items_maxItems");
    expect(check?.pass).toBe(false);
  });

  it("exactItems: passes with correct count", async () => {
    await writeNote(tmpDir, "Con/note.md", "---\nexact_items:\n  - a\n  - b\n  - c\n---\nContent");
    const result = await svc.lintNote("Con/note.md");
    const check = result.checks.find((c) => c.name === "field_exact_items_exactItems");
    expect(check?.pass).toBe(true);
  });

  it("exactItems: fails with wrong count", async () => {
    await writeNote(tmpDir, "Con/note.md", "---\nexact_items:\n  - a\n  - b\n---\nContent");
    const result = await svc.lintNote("Con/note.md");
    const check = result.checks.find((c) => c.name === "field_exact_items_exactItems");
    expect(check?.pass).toBe(false);
  });

  it("atLeastOne: passes when at least one item matches", async () => {
    await writeNote(
      tmpDir,
      "Con/note.md",
      "---\nmatched_items:\n  - tag/programming\n  - other\n---\nContent",
    );
    const result = await svc.lintNote("Con/note.md");
    const check = result.checks.find((c) => c.name === "field_matched_items_atLeastOne");
    expect(check?.pass).toBe(true);
  });

  it("atLeastOne: fails when no item matches", async () => {
    await writeNote(
      tmpDir,
      "Con/note.md",
      "---\nmatched_items:\n  - other\n  - another\n---\nContent",
    );
    const result = await svc.lintNote("Con/note.md");
    const check = result.checks.find((c) => c.name === "field_matched_items_atLeastOne");
    expect(check?.pass).toBe(false);
  });

  it("allMatch: passes when all items match", async () => {
    await writeNote(
      tmpDir,
      "Con/note.md",
      "---\nmatched_items:\n  - alpha\n  - beta\n---\nContent",
    );
    const result = await svc.lintNote("Con/note.md");
    const check = result.checks.find((c) => c.name === "field_matched_items_allMatch");
    expect(check?.pass).toBe(true);
  });

  it("allMatch: fails when any item doesn't match", async () => {
    await writeNote(
      tmpDir,
      "Con/note.md",
      "---\nmatched_items:\n  - alpha\n  - Beta\n---\nContent",
    );
    const result = await svc.lintNote("Con/note.md");
    const check = result.checks.find((c) => c.name === "field_matched_items_allMatch");
    expect(check?.pass).toBe(false);
  });

  it("firstEquals: passes when first item equals template expansion", async () => {
    // File is at Con/MyNote.md so stem = MyNote
    await writeNote(
      tmpDir,
      "Con/MyNote.md",
      "---\nfirst_item:\n  - MyNote\n  - other\n---\nContent",
    );
    const result = await svc.lintNote("Con/MyNote.md");
    const check = result.checks.find((c) => c.name === "field_first_item_firstEquals");
    expect(check?.pass).toBe(true);
  });

  it("firstEquals: fails when first item does not match stem", async () => {
    await writeNote(tmpDir, "Con/MyNote.md", "---\nfirst_item:\n  - WrongName\n---\nContent");
    const result = await svc.lintNote("Con/MyNote.md");
    const check = result.checks.find((c) => c.name === "field_first_item_firstEquals");
    expect(check?.pass).toBe(false);
  });

  it("firstEquals: stem strips leading underscore", async () => {
    // _MyNote.md → stem = MyNote
    await writeNote(tmpDir, "Con/_MyNote.md", "---\nfirst_item:\n  - MyNote\n---\nContent");
    const result = await svc.lintNote("Con/_MyNote.md");
    const check = result.checks.find((c) => c.name === "field_first_item_firstEquals");
    expect(check?.pass).toBe(true);
  });

  it("enum: passes when value is in allowed set", async () => {
    await writeNote(tmpDir, "Con/note.md", "---\nstatus: published\n---\nContent");
    const result = await svc.lintNote("Con/note.md");
    const check = result.checks.find((c) => c.name === "field_status_enum");
    expect(check?.pass).toBe(true);
  });

  it("enum: fails when value is not in allowed set", async () => {
    await writeNote(tmpDir, "Con/note.md", "---\nstatus: pending\n---\nContent");
    const result = await svc.lintNote("Con/note.md");
    const check = result.checks.find((c) => c.name === "field_status_enum");
    expect(check?.pass).toBe(false);
  });

  it("pattern: passes when value matches regex", async () => {
    await writeNote(tmpDir, "Con/note.md", "---\ncode: ABC-123\n---\nContent");
    const result = await svc.lintNote("Con/note.md");
    const check = result.checks.find((c) => c.name === "field_code_pattern");
    expect(check?.pass).toBe(true);
  });

  it("pattern: fails when value does not match regex", async () => {
    await writeNote(tmpDir, "Con/note.md", "---\ncode: abc-123\n---\nContent");
    const result = await svc.lintNote("Con/note.md");
    const check = result.checks.find((c) => c.name === "field_code_pattern");
    expect(check?.pass).toBe(false);
  });
});

// =============================================================================
// lintNote — content rules
// =============================================================================

describe("SchemaEngineImpl.lintNote — content rules", () => {
  let tmpDir: string;
  let svc: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ schema: svc } = makeServices(tmpDir));
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "content.yaml", CONTENT_RULES_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("hasPattern: passes when pattern is found in content", async () => {
    await writeNote(tmpDir, "Content/note.md", "Content with [[some link]] here and more words");
    const result = await svc.lintNote("Content/note.md");
    const check = result.checks.find((c) => c.name === "has-outgoing-link");
    expect(check?.pass).toBe(true);
  });

  it("hasPattern: fails when pattern not found", async () => {
    await writeNote(
      tmpDir,
      "Content/note.md",
      "Content without any wikilinks here at all more words",
    );
    const result = await svc.lintNote("Content/note.md");
    const check = result.checks.find((c) => c.name === "has-outgoing-link");
    expect(check?.pass).toBe(false);
  });

  it("noPattern: passes when pattern is not in content", async () => {
    await writeNote(tmpDir, "Content/note.md", "Clean content with no bad words at all really");
    const result = await svc.lintNote("Content/note.md");
    const check = result.checks.find((c) => c.name === "no-broken-words");
    expect(check?.pass).toBe(true);
  });

  it("noPattern: fails when pattern found", async () => {
    await writeNote(tmpDir, "Content/note.md", "Content with BROKEN word inside it here is more");
    const result = await svc.lintNote("Content/note.md");
    const check = result.checks.find((c) => c.name === "no-broken-words");
    expect(check?.pass).toBe(false);
  });

  it("noSelfWikilink: passes when content has no self-reference", async () => {
    await writeNote(tmpDir, "Content/MyNote.md", "This links to [[OtherNote]] but not itself");
    const result = await svc.lintNote("Content/MyNote.md");
    const check = result.checks.find((c) => c.name === "no-self-links");
    expect(check?.pass).toBe(true);
  });

  it("noSelfWikilink: fails when content references own stem", async () => {
    await writeNote(tmpDir, "Content/MyNote.md", "Here is [[MyNote]] which is a self link");
    const result = await svc.lintNote("Content/MyNote.md");
    const check = result.checks.find((c) => c.name === "no-self-links");
    expect(check?.pass).toBe(false);
  });

  it("noSelfWikilink: strips leading underscore for stem comparison", async () => {
    await writeNote(tmpDir, "Content/_HubNote.md", "Here is [[HubNote]] which is a self link");
    const result = await svc.lintNote("Content/_HubNote.md");
    const check = result.checks.find((c) => c.name === "no-self-links");
    expect(check?.pass).toBe(false);
  });

  it("noSelfWikilink: also catches self-link with display text", async () => {
    await writeNote(
      tmpDir,
      "Content/MyNote.md",
      "This is [[MyNote|My Custom Title]] which is a self link",
    );
    const result = await svc.lintNote("Content/MyNote.md");
    const check = result.checks.find((c) => c.name === "no-self-links");
    expect(check?.pass).toBe(false);
  });

  it("noMalformedWikilinks: passes with well-formed wikilinks", async () => {
    await writeNote(
      tmpDir,
      "Content/note.md",
      "Good [[Target]] and [[Target|Display]] links with [[Target#Section]] also",
    );
    const result = await svc.lintNote("Content/note.md");
    const check = result.checks.find((c) => c.name === "no-malformed");
    expect(check?.pass).toBe(true);
  });

  it("noMalformedWikilinks: fails on empty link [[]]", async () => {
    await writeNote(tmpDir, "Content/note.md", "Bad [[]] link here");
    const result = await svc.lintNote("Content/note.md");
    const check = result.checks.find((c) => c.name === "no-malformed");
    expect(check?.pass).toBe(false);
  });

  it("noMalformedWikilinks: fails on unterminated [[", async () => {
    await writeNote(tmpDir, "Content/note.md", "Unterminated [[ link on same line");
    const result = await svc.lintNote("Content/note.md");
    const check = result.checks.find((c) => c.name === "no-malformed");
    expect(check?.pass).toBe(false);
  });

  it("minWordCount: passes when content has enough words", async () => {
    await writeNote(tmpDir, "Content/note.md", "one two three four five six seven eight");
    const result = await svc.lintNote("Content/note.md");
    const check = result.checks.find((c) => c.name === "min-words");
    expect(check?.pass).toBe(true);
  });

  it("minWordCount: fails when content has too few words", async () => {
    await writeNote(tmpDir, "Content/note.md", "one two");
    const result = await svc.lintNote("Content/note.md");
    const check = result.checks.find((c) => c.name === "min-words");
    expect(check?.pass).toBe(false);
  });
});

// =============================================================================
// template variables
// =============================================================================

describe("SchemaEngineImpl — template variable expansion", () => {
  let tmpDir: string;
  let svc: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ schema: svc } = makeServices(tmpDir));
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(
      schemasDir,
      "tmpl.yaml",
      `
name: tmpl-schema
description: Template var testing
scope:
  paths: ["TmplTest/"]
  exclude: []
frontmatter:
  fields:
    aliases:
      type: list
      required: true
      constraints:
        - firstEquals: "{{stem}}"
content:
  rules: []
`,
    );
    await svc.loadSchemas(schemasDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("{{stem}} strips leading underscore", async () => {
    await writeNote(tmpDir, "TmplTest/_MyNote.md", "---\naliases:\n  - MyNote\n---\nContent");
    const result = await svc.lintNote("TmplTest/_MyNote.md");
    const check = result.checks.find((c) => c.name === "field_aliases_firstEquals");
    expect(check?.pass).toBe(true);
  });

  it("{{stem}} preserves name without underscore", async () => {
    await writeNote(tmpDir, "TmplTest/MyNote.md", "---\naliases:\n  - MyNote\n---\nContent");
    const result = await svc.lintNote("TmplTest/MyNote.md");
    const check = result.checks.find((c) => c.name === "field_aliases_firstEquals");
    expect(check?.pass).toBe(true);
  });

  it("{{stem}} mismatch fails the check", async () => {
    await writeNote(tmpDir, "TmplTest/MyNote.md", "---\naliases:\n  - WrongName\n---\nContent");
    const result = await svc.lintNote("TmplTest/MyNote.md");
    const check = result.checks.find((c) => c.name === "field_aliases_firstEquals");
    expect(check?.pass).toBe(false);
  });
});

// =============================================================================
// validateFolder — classification
// =============================================================================

describe("SchemaEngineImpl.validateFolder — folder classification", () => {
  let tmpDir: string;
  let svc: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ schema: svc } = makeServices(tmpDir));
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "packet.yaml", PACKET_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("classifies packet folder (direct .md files)", async () => {
    await writeNote(
      tmpDir,
      "Knowledge/Topic/_Topic.md",
      "---\ntags:\n  - hub\n---\nContent [[Child]]",
    );
    await writeNote(
      tmpDir,
      "Knowledge/Topic/Child.md",
      "---\ntags:\n  - science/topic\n---\nContent",
    );
    const result = await svc.validateFolder("Knowledge/Topic");
    expect(result.folderType).toBe("packet");
  });

  it("classifies supplemental folder by name", async () => {
    // Folder named "Resources" is in supplemental list
    await writeNote(tmpDir, "Knowledge/Resources/ref.md", "---\ntags: []\n---\nContent");
    const result = await svc.validateFolder("Knowledge/Resources");
    expect(result.folderType).toBe("supplemental");
    expect(result.pass).toBe(true);
  });

  it("supplemental folder skips structural checks and passes", async () => {
    await writeNote(tmpDir, "Knowledge/Resources/ref.md", "Bare content");
    const result = await svc.validateFolder("Knowledge/Resources");
    expect(result.pass).toBe(true);
    expect(result.structural).toHaveLength(0);
    expect(Object.keys(result.notes)).toHaveLength(0);
  });

  it("classifies unclassified (skip) folder", async () => {
    await writeNote(tmpDir, "Knowledge/_Inbox/draft.md", "Draft note");
    // _Inbox is in the skip list but also excluded from scope
    // Let's test a folder directly in the schema scope that has no folder config
    // Actually _Inbox is excluded from schema scope — test a different scenario
    // Use a schema that has a skip list
    const schemasDir = path.join(tmpDir, "schemas2");
    await writeSchema(
      schemasDir,
      "skip.yaml",
      `
name: skip-schema
description: Skip test
scope:
  paths: ["Area/"]
  exclude: []
frontmatter:
  fields: {}
content:
  rules: []
folders:
  classification:
    supplemental: []
    skip: ["Archive"]
  structural: []
`,
    );
    const filter = new PathFilterImpl({ blockedPaths: [], allowedExtensions: [] });
    const vault = new VaultServiceImpl(tmpDir, filter);
    const frontmatter = new FrontmatterServiceImpl(vault);
    const skipSvc = new SchemaEngineImpl(vault, frontmatter);
    await skipSvc.loadSchemas(schemasDir);

    await writeNote(tmpDir, "Area/Archive/old.md", "Old content");
    const result = await skipSvc.validateFolder("Area/Archive");
    expect(result.folderType).toBe("unclassified");
    expect(result.pass).toBe(true);
  });

  it("classifies superfolder (subdirs but no direct .md files)", async () => {
    // Create a folder with subdirectories but no direct .md files
    await fs.mkdir(path.join(tmpDir, "Knowledge/SuperFolder/SubA"), { recursive: true });
    await writeNote(tmpDir, "Knowledge/SuperFolder/SubA/note.md", "---\ntags: []\n---\nContent");
    const result = await svc.validateFolder("Knowledge/SuperFolder");
    expect(result.folderType).toBe("superfolder");
  });
});

// =============================================================================
// validateFolder — hub detection
// =============================================================================

describe("SchemaEngineImpl.validateFolder — hub detection", () => {
  let tmpDir: string;
  let svc: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ schema: svc } = makeServices(tmpDir));
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "packet.yaml", PACKET_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects hub via pattern _{folderName}.md", async () => {
    // Hub detection requires hub to link to all children
    await writeNote(
      tmpDir,
      "Knowledge/Topic/_Topic.md",
      "---\ntags:\n  - hub\n  - science/topic\naliases:\n  - Topic\ncreated: 2024-01-01\n---\n[[Child]]",
    );
    await writeNote(
      tmpDir,
      "Knowledge/Topic/Child.md",
      "---\ntags:\n  - science/topic\ncreated: 2024-01-01\n---\nContent [[_Topic]]",
    );
    const result = await svc.validateFolder("Knowledge/Topic");
    // Hub should be found via pattern
    const hubCheck = result.structural.find((c) => c.name === "hub-links-all-children");
    expect(hubCheck).toBeDefined();
    expect(hubCheck?.pass).toBe(true);
  });

  it("detects hub via fallback tagPresent condition", async () => {
    // No _{folderName}.md, no {folderName}.md, but one file has hub tag
    await writeNote(
      tmpDir,
      "Knowledge/Topic/HubFile.md",
      "---\ntags:\n  - hub\n  - science/topic\ncreated: 2024-01-01\n---\n[[Child]]",
    );
    await writeNote(
      tmpDir,
      "Knowledge/Topic/Child.md",
      "---\ntags:\n  - science/topic\ncreated: 2024-01-01\n---\nContent",
    );
    const result = await svc.validateFolder("Knowledge/Topic");
    const hubCheck = result.structural.find((c) => c.name === "hub-links-all-children");
    expect(hubCheck).toBeDefined();
  });

  it("structural check fails when hub does not cover all children", async () => {
    await writeNote(
      tmpDir,
      "Knowledge/Folder/_Folder.md",
      "---\ntags:\n  - hub\n  - cat/sub\naliases:\n  - Folder\ncreated: 2024-01-01\n---\nNo wikilinks here",
    );
    await writeNote(
      tmpDir,
      "Knowledge/Folder/Child.md",
      "---\ntags:\n  - cat/sub\ncreated: 2024-01-01\n---\nContent",
    );
    const result = await svc.validateFolder("Knowledge/Folder");
    const hubCheck = result.structural.find((c) => c.name === "hub-links-all-children");
    expect(hubCheck?.pass).toBe(false);
  });
});

// =============================================================================
// validateFolder — structural rules
// =============================================================================

describe("SchemaEngineImpl.validateFolder — structural rules", () => {
  let tmpDir: string;
  let svc: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ schema: svc } = makeServices(tmpDir));
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "packet.yaml", PACKET_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("noOrphansInFolder: passes when all non-hub notes are referenced", async () => {
    await writeNote(
      tmpDir,
      "Knowledge/Pack/_Pack.md",
      "---\ntags:\n  - hub\n  - cat/sub\naliases:\n  - Pack\ncreated: 2024-01-01\n---\n[[Child]] [[Another]]",
    );
    await writeNote(
      tmpDir,
      "Knowledge/Pack/Child.md",
      "---\ntags:\n  - cat/sub\ncreated: 2024-01-01\n---\nContent [[Another]]",
    );
    await writeNote(
      tmpDir,
      "Knowledge/Pack/Another.md",
      "---\ntags:\n  - cat/sub\ncreated: 2024-01-01\n---\nContent [[Child]]",
    );
    const result = await svc.validateFolder("Knowledge/Pack");
    const orphanCheck = result.structural.find((c) => c.name === "no-orphan-notes");
    expect(orphanCheck?.pass).toBe(true);
  });

  it("noOrphansInFolder: fails when a non-hub note is not linked", async () => {
    await writeNote(
      tmpDir,
      "Knowledge/Pack/_Pack.md",
      "---\ntags:\n  - hub\n  - cat/sub\naliases:\n  - Pack\ncreated: 2024-01-01\n---\n[[Child]]",
    );
    await writeNote(
      tmpDir,
      "Knowledge/Pack/Child.md",
      "---\ntags:\n  - cat/sub\ncreated: 2024-01-01\n---\nContent",
    );
    await writeNote(
      tmpDir,
      "Knowledge/Pack/Orphan.md",
      "---\ntags:\n  - cat/sub\ncreated: 2024-01-01\n---\nIsolated content",
    );
    const result = await svc.validateFolder("Knowledge/Pack");
    const orphanCheck = result.structural.find((c) => c.name === "no-orphan-notes");
    expect(orphanCheck?.pass).toBe(false);
    expect(orphanCheck?.detail).toContain("Orphan");
  });
});

// =============================================================================
// validateArea
// =============================================================================

describe("SchemaEngineImpl.validateArea", () => {
  let tmpDir: string;
  let svc: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ schema: svc } = makeServices(tmpDir));
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns pass: true when all folders pass", async () => {
    await writeNote(
      tmpDir,
      "Notes/folder1/note.md",
      "---\ntitle: Note 1\ntags:\n  - a\n---\nContent",
    );
    const result = await svc.validateArea("Notes/folder1");
    expect(result.pass).toBe(true);
    expect(result.summary.total).toBeGreaterThan(0);
  });

  it("returns pass: false when any folder fails", async () => {
    // Missing required title field
    await writeNote(tmpDir, "Notes/folder1/note.md", "---\ntags:\n  - a\n---\nContent");
    const result = await svc.validateArea("Notes/folder1");
    expect(result.pass).toBe(false);
    expect(result.summary.failed).toBeGreaterThan(0);
  });

  it("summary counts total, passed, failed correctly", async () => {
    await writeNote(
      tmpDir,
      "Notes/goodfolder/note.md",
      "---\ntitle: Good\ntags:\n  - a\n---\nContent",
    );
    const result = await svc.validateArea("Notes");
    expect(result.summary.total).toBe(
      result.summary.passed + result.summary.failed + result.summary.skipped,
    );
  });

  it("area path appears in result", async () => {
    await writeNote(tmpDir, "Notes/folder1/note.md", "---\ntitle: Note\ntags: [a]\n---\nContent");
    const result = await svc.validateArea("Notes/folder1");
    expect(result.path).toBe("Notes/folder1");
  });
});

// =============================================================================
// getTemplate
// =============================================================================

describe("SchemaEngineImpl.getTemplate", () => {
  let tmpDir: string;
  let svc: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ schema: svc } = makeServices(tmpDir));
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns template with required field defaults", () => {
    const tmpl = svc.getTemplate("basic");
    // title: string required → ""
    expect(tmpl.frontmatter["title"]).toBe("");
    // tags: list required → []
    expect(tmpl.frontmatter["tags"]).toEqual([]);
  });

  it("returns empty content", () => {
    const tmpl = svc.getTemplate("basic");
    expect(tmpl.content).toBe("");
  });

  it("throws when schema not found", () => {
    expect(() => svc.getTemplate("nonexistent")).toThrow();
  });

  it("uses schema-defined defaults in template", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(
      schemasDir,
      "defaults.yaml",
      `
name: defaults-test
description: Schema with field defaults
scope:
  paths:
    - "Defaults/"
frontmatter:
  fields:
    title:
      type: string
      required: true
      default: "{{stem}}"
    created:
      type: string
      required: true
      default: "{{today}}"
    status:
      type: string
      required: true
      default: "draft"
    count:
      type: number
      required: true
    optional_field:
      type: string
      required: false
      default: "ignored"
`,
    );
    await svc.loadSchemas(schemasDir);
    const tmpl = svc.getTemplate("defaults-test");
    // Schema-defined defaults are used
    expect(tmpl.frontmatter["title"]).toBe("{{stem}}");
    expect(tmpl.frontmatter["created"]).toBe("{{today}}");
    expect(tmpl.frontmatter["status"]).toBe("draft");
    // No default → type zero value
    expect(tmpl.frontmatter["count"]).toBe(0);
    // Non-required fields are excluded
    expect(tmpl.frontmatter["optional_field"]).toBeUndefined();
  });
});

// =============================================================================
// listSchemas
// =============================================================================

describe("SchemaEngineImpl.listSchemas", () => {
  let tmpDir: string;
  let svc: SchemaEngineImpl;

  beforeEach(async () => {
    tmpDir = await makeTempVault();
    ({ schema: svc } = makeServices(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array before loading", () => {
    expect(svc.listSchemas()).toEqual([]);
  });

  it("returns SchemaInfo for each loaded schema", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await writeSchema(schemasDir, "content.yaml", CONTENT_RULES_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
    const list = svc.listSchemas();
    expect(list).toHaveLength(2);
    const names = list.map((s) => s.name);
    expect(names).toContain("basic");
    expect(names).toContain("content-rules");
  });

  it("includes correct scope info", async () => {
    const schemasDir = path.join(tmpDir, "schemas");
    await writeSchema(schemasDir, "basic.yaml", BASIC_SCHEMA_YAML);
    await svc.loadSchemas(schemasDir);
    const info = svc.listSchemas()[0];
    expect(info.scope.paths).toContain("Notes/");
    expect(info.scope.exclude).toEqual([]);
  });
});
