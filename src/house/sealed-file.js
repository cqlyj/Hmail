import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** @type {Map<string, Promise<void>>} */
const chains = new Map();
let counter = 0;

/**
 * Reads <stateDir>/<file>, vault.open(purpose, …). Missing file → fallback. Any other error throws.
 * @param {string} stateDir
 * @param {string} file
 * @param {{ open(purpose: string, sealed: string): unknown }} vault
 * @param {string} purpose
 * @param {T} fallback
 * @template T
 * @returns {Promise<T | unknown>}
 */
export async function readSealed(stateDir, file, vault, purpose, fallback) {
  try {
    const text = await readFile(join(stateDir, file), "utf8");
    return vault.open(purpose, text.trim());
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
      return fallback;
    }
    throw err;
  }
}

/**
 * @param {string} path
 * @param {{ seal(purpose: string, value: unknown): string }} vault
 * @param {string} purpose
 * @param {unknown} value
 */
async function writeOne(path, vault, purpose, value) {
  counter += 1;
  const tmp = `${path}.${process.pid}.${counter}.tmp`;
  await writeFile(tmp, `${vault.seal(purpose, value)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Writes `${vault.seal(purpose, value)}\n` to a unique tmp file (mode 600), then renames.
 * Writes to the same path are chained, so they never interleave and the last call wins.
 * @param {string} stateDir
 * @param {string} file
 * @param {{ seal(purpose: string, value: unknown): string }} vault
 * @param {string} purpose
 * @param {unknown} value
 */
export function writeSealed(stateDir, file, vault, purpose, value) {
  const path = join(stateDir, file);
  const prev = chains.get(path) ?? Promise.resolve();
  const run = prev.then(
    () => writeOne(path, vault, purpose, value),
    () => writeOne(path, vault, purpose, value),
  );
  chains.set(
    path,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}
