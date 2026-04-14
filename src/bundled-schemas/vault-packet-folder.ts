import type { FolderSchema } from "../types.js";

export const vaultPacketFolderSchema: FolderSchema = {
  name: "vault-packet-folder",
  description: "Opinionated folder schema for knowledge packet folders",
  type: "folder",
  noteSchemas: { default: "vault-packet", hub: "moc" },
  classification: { supplemental: ["Resources", "References"], skip: ["_Inbox"] },
  hub: {
    detection: [
      { pattern: "_{folderName}.md" },
      { pattern: "{folderName}.md" },
      { fallback: { tagPresent: "hub" } },
    ],
    required: true,
  },
  structural: [
    { name: "hub-covers-children", check: "hubCoversChildren" },
    { name: "no-orphan-notes", check: "noOrphansInFolder" },
  ],
};
