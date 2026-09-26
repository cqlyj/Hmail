import { readFile, stat } from "node:fs/promises";
import { UsageError } from "../shared/cli.js";
import { processMessage } from "./mail/process.js";
import { renderRead } from "./mail/render.js";

/** hmail inspect <file.eml>: local redacted view. @returns {Promise<number>} */
export async function runInspect(argv) {
  if (argv.length !== 1 || !argv[0])
    throw new UsageError("usage: hmail inspect <file.eml>");
  const path = argv[0];
  /** @type {Buffer} */
  let raw;
  /** @type {import("node:fs").Stats} */
  let info;
  try {
    raw = await readFile(path);
    info = await stat(path);
  } catch {
    process.stderr.write(`error: cannot read ${path}\n`);
    return 1;
  }
  const mail = await processMessage({
    id: "file",
    raw,
    internalDate: info.mtimeMs,
  });
  process.stdout.write(`${renderRead(mail)}\n`);
  return 0;
}
