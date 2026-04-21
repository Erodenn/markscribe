import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export async function makeTempDir(prefix = "markscribe-test-"): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeFile(base: string, relPath: string, content: string): Promise<void> {
  const full = path.join(base, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

export async function readFile(base: string, relPath: string): Promise<string> {
  return await fs.readFile(path.join(base, relPath), "utf-8");
}
