import type { NoteSchema } from "../types.js";

export const vaultPacketSchema: NoteSchema = {
  name: "vault-packet",
  description: "Opinionated note schema for knowledge packets",
  type: "note",
  frontmatter: {
    fields: {
      tags: { type: "list", required: true, constraints: [{ minItems: 1 }] },
      created: { type: "date", required: true, format: "\\d{4}-\\d{2}-\\d{2}" },
      updated: { type: "date", required: true, format: "\\d{4}-\\d{2}-\\d{2}" },
      source: { type: "string", required: false },
    },
  },
  content: {
    rules: [
      { name: "has-outgoing-link", check: "hasPattern", pattern: "\\[\\[.+?\\]\\]|https?://" },
      { name: "no-self-links", check: "noSelfWikilink" },
      { name: "no-malformed-wikilinks", check: "noMalformedWikilinks" },
    ],
  },
};
