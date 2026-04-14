import type { NoteSchema } from "../types.js";

export const dailyNoteSchema: NoteSchema = {
  name: "daily-note",
  description: "Light-touch daily note schema",
  type: "note",
  frontmatter: {
    fields: {
      date: { type: "string", required: true, format: "\\d{4}-\\d{2}-\\d{2}" },
      tags: { type: "list", required: false },
    },
  },
  content: { rules: [] },
};
