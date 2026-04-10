import { parseArgs } from "node:util";
import path from "node:path";
import os from "node:os";

export interface CliArgs {
  /** Root directory path — from --root or process.cwd() */
  root: string;
  /** Schemas directory — from --schemas-dir or ~/.markscribe/schemas/ */
  schemasDir: string;
  /** Log level — from --log-level or "info" */
  logLevel: string;
}

export function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      "schemas-dir": { type: "string" },
      "log-level": { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  const root = (values.root as string | undefined) ?? process.cwd();
  const schemasDir =
    (values["schemas-dir"] as string | undefined) ?? path.join(os.homedir(), ".markscribe", "schemas");
  const logLevel = (values["log-level"] as string | undefined) ?? "info";

  return { root, schemasDir, logLevel };
}
