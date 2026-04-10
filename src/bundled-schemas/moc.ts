import type { NoteSchema } from "../types.js";

export const mocSchema: NoteSchema = {
  name: "moc",
  description: "Map of Content note schema",
  type: "note",
  frontmatter: {
    fields: {
      tags: { type: "list", required: true, constraints: [{ minItems: 1 }] },
      aliases: { type: "list", required: false },
    },
  },
  content: {
    rules: [
      { name: "has-outgoing-link", check: "hasPattern", pattern: "\\[\\[.+?\\]\\]" },
    ],
  },
};
