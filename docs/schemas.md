# Schema Reference

Schemas define conventions for your notes and folders. Place them as YAML files in your schemas directory (`~/.markscribe/schemas/` by default, or set via `--schemas-dir`). Schemas are loaded once at server startup.

There are two schema types: **note** (frontmatter and content rules for individual notes) and **folder** (structural rules for directories plus default note-schema assignments). Notes opt into a note schema via `note_schema: <name>` in frontmatter, or inherit one automatically via the convention cascade.

---

## Note schema

A note schema validates a single note's frontmatter and content.

```yaml
name: blog-post
description: Blog post with required metadata and an outgoing link
type: note
frontmatter:
  fields:
    title:
      type: string
      required: true
    tags:
      type: list
      required: true
      constraints:
        - minItems: 1
    created:
      type: string
      required: true
      format: "\\d{4}-\\d{2}-\\d{2}"
content:
  rules:
    - name: has-outgoing-link
      check: hasPattern
      pattern: "\\[\\[.+?\\]\\]|https?://"
    - name: no-self-links
      check: noSelfWikilink
```

### `frontmatter.fields`

Each field is validated against its configured options.

| Option | Values | Purpose |
|---|---|---|
| `type` | `string`, `list`, `number`, `boolean`, `date` | YAML type of the value |
| `required` | `true`, `false` | Whether the field must be present |
| `format` | regex string | Value must match (strings and dates; dates coerced to `YYYY-MM-DD` first) |

The `date` type expects YAML date scalars — unquoted ISO dates like `created: 2026-03-09` that `js-yaml` parses into JS `Date` objects. Use `string` if you want strict string handling for quoted ISO dates. For `date` fields, `format` and `pattern` constraints are tested against the date's `YYYY-MM-DD` ISO form.
| `default` | any | Default applied by `create_note` templates. Supports `{{stem}}`, `{{filename}}`, `{{today}}`, `{{folderName}}` |
| `when` | condition object | Gates whether validation applies. See conditions below |
| `constraints` | array | Additional rules beyond type/format |

**Conditions** (`when:`):

```yaml
when:
  tagPresent: draft            # tag in `tags` list
# or
  fieldEquals:
    field: status
    value: published
# or
  fieldExists: publishedAt
```

**Constraints** (any combination):

```yaml
constraints:
  - minItems: 1
  - maxItems: 10
  - exactItems: 3
  - atLeastOne:
      matches: "\\breviewed\\b"
  - allMatch: "^[a-z0-9-]+$"
  - firstEquals: "draft"
  - enum: [draft, published, archived]
  - pattern: "^\\d{4}-\\d{2}-\\d{2}$"
```

### `content.rules`

Each rule runs against the note's markdown body.

| `check` | Uses | Description |
|---|---|---|
| `hasPattern` | `pattern` | Rule passes if the regex matches at least once |
| `noPattern` | `pattern` | Rule passes if the regex does not match |
| `noSelfWikilink` | — | Rule passes if the note does not `[[link]]` to itself |
| `noMalformedWikilinks` | — | Rule passes if no unbalanced `[[` / `]]` are present |
| `noBrokenWikilinks` | — | Rule passes if every `[[target]]` resolves to an existing note (by stem or alias) |
| `minWordCount` | `count` | Rule passes if the body has at least `count` words |

Every rule needs a `name` — it appears in `lint_note` output so failures are identifiable.

### Opting in

Notes opt into a specific note schema by adding a frontmatter field:

```yaml
---
note_schema: blog-post
---
```

If no explicit opt-in is present, the convention cascade decides. If no convention applies either, the note has no schema and `lint_note` returns `schema: null`.

---

## Folder schema

A folder schema classifies a directory, assigns note schemas by role, and enforces structural rules on the folder as a whole.

```yaml
name: project-folder
description: Project folder with a hub note
type: folder
noteSchemas:
  default: blog-post
  hub: project-hub
classification:
  supplemental: [assets, templates]
  skip: [archive, _drafts]
hub:
  detection:
    - pattern: "_{{folderName}}.md"
    - pattern: "{{folderName}}.md"
    - fallback:
        tagPresent: hub
  required: true
structural:
  - name: hub-covers-children
    check: hubCoversChildren
  - name: no-orphans
    check: noOrphansInFolder
```

### `noteSchemas`

Role-based mapping of note-schema names. Built-in roles are `default` and `hub`. Any additional role keys are allowed and can be referenced by custom cascade logic.

```yaml
noteSchemas:
  default: packet
  hub: moc
  template: packet-template
```

### `classification`

Decides how subfolders are treated during `validate_folder` and `validate_area`.

- `supplemental`: folder names that auto-pass validation (e.g., `assets`, `images`).
- `skip`: folder names excluded from validation entirely (e.g., `archive`, `_drafts`).

### `hub.detection`

Ordered list of rules. The first match wins.

```yaml
hub:
  detection:
    - pattern: "_{{folderName}}.md"       # templated pattern
    - pattern: "{{folderName}}.md"
    - fallback:
        tagPresent: hub                   # if no filename matches, look for a note with this tag
  required: true                          # if true, missing hub fails validation
```

`{{folderName}}` expands to the folder's base name.

### `structural`

Each rule runs once per folder during validation.

| `check` | Uses | Description |
|---|---|---|
| `hubCoversChildren` | — | Hub note `[[links]]` to every child note |
| `noOrphansInFolder` | — | Every note has at least one incoming link from within the folder |
| `noSubdirectories` | — | Folder contains no subdirectories |
| `requiredFile` | `pattern` | At least one file matching the regex exists |
| `filenamePattern` | `pattern` | All files match the regex |
| `minFileCount` | `count` | Folder has at least `count` notes |
| `maxFileCount` | `count` | Folder has at most `count` notes |
| `minOutgoingLinks` | `count` | Every note has at least `count` outgoing wikilinks |
| `allNotesMatch` | `when` | Every note satisfies the condition |
| `someNoteMatches` | `when`, `count` | At least `count` notes satisfy the condition |

---

## The convention cascade

Notes don't have to opt in manually. A `_conventions.md` file in any directory binds a folder schema to that subtree.

```markdown
---
folder_schema: project-folder
inherit: true
---
```

- The binding applies to the folder containing `_conventions.md` and, when `inherit: true`, to all nested subdirectories until a deeper `_conventions.md` overrides it.
- Each note in a scoped folder is assigned a role (default `default`, or `hub` if it matches `hub.detection`) and validated against the corresponding note schema from `noteSchemas`.
- `_conventions.md` files are never linted themselves.

**Resolution order (applied by `lint_note`):**

1. Skip if the note is `_conventions.md`.
2. If the note's frontmatter has `note_schema: <name>`, use that schema.
3. Otherwise, consult the convention cascade: if a folder schema applies, determine the role (`hub` if the note matches the folder's hub detection, else `default`), then look up `noteSchemas[role]`.
4. If neither applies: the note has no schema.

---

## Authoring a new schema end-to-end

1. Decide whether the rule belongs on individual notes (note schema) or on directory structure (folder schema).
2. Write the YAML file in your schemas directory (`~/.markscribe/schemas/` by default).
3. Restart the server, or call `switch_directory` — schemas load at startup.
4. Confirm it loaded with the `list_schemas` tool.
5. For a note schema, opt a note in with `note_schema: <name>`, then call `lint_note`.
6. For a folder schema, add `_conventions.md` to the folder with `folder_schema: <name>`, then call `validate_folder` or `validate_area`.

Bundled schemas (`vault-packet`, `vault-packet-folder`, `daily-note`, `moc`) ship with the server and serve as starting points — copy one into your schemas directory and adapt it.
