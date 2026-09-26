import { readSealed, writeSealed } from "../sealed-file.js";

/** @typedef {{ client_id: string, client_secret?: string, refresh_token: string, email: string, scope: string, obtained_at: string }} GmailToken */

/** @param {string} stateDir @param {{ seal(purpose: string, value: unknown): string }} vault @param {GmailToken} token */
export async function saveGmailToken(stateDir, vault, token) {
  await writeSealed(stateDir, "gmail.enc", vault, "gmail", token);
}

/** @param {string} stateDir @param {{ open(purpose: string, sealed: string): unknown }} vault @returns {Promise<GmailToken | null>} */
export async function loadGmailToken(stateDir, vault) {
  const opened = await readSealed(stateDir, "gmail.enc", vault, "gmail", null);
  if (opened === null) return null;
  return /** @type {GmailToken} */ (opened);
}
