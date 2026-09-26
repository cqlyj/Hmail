import { readSealed, writeSealed } from "../sealed-file.js";

/** @typedef {{ session_id: string, environment: "production"|"sandbox", rp_id: string, created_at: string }} WorldSession */

const MISSING = Symbol("missing");

/**
 * @param {string} stateDir
 * @param {{ seal(purpose: string, value: unknown): string }} vault
 * @param {WorldSession} session
 */
export async function saveWorldSession(stateDir, vault, session) {
  await writeSealed(stateDir, "world.enc", vault, "world", session);
}

/**
 * @param {string} stateDir
 * @param {{ open(purpose: string, sealed: string): unknown }} vault
 * @returns {Promise<WorldSession | null>}
 */
export async function loadWorldSession(stateDir, vault) {
  const value = await readSealed(stateDir, "world.enc", vault, "world", MISSING);
  if (value === MISSING) return null;
  if (value === null || typeof value !== "object") return null;
  return /** @type {WorldSession} */ (value);
}
