import type { NoteSchema, FolderSchema } from "../types.js";
import { vaultPacketSchema } from "./vault-packet.js";
import { dailyNoteSchema } from "./daily-note.js";
import { mocSchema } from "./moc.js";
import { vaultPacketFolderSchema } from "./vault-packet-folder.js";

export const bundledSchemas: Array<NoteSchema | FolderSchema> = [
  vaultPacketSchema,
  dailyNoteSchema,
  mocSchema,
  vaultPacketFolderSchema,
];

export { vaultPacketSchema, dailyNoteSchema, mocSchema, vaultPacketFolderSchema };
