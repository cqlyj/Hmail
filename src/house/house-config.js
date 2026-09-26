import { readSealed, writeSealed } from "./sealed-file.js";

const OWNER_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** @typedef {{ owner: `0x${string}`|null, ensName: string|null, deny: `0x${string}`[], pendingLabel: string|null }} HouseConfigState */

/** @returns {HouseConfigState} */
function empty() {
  return { owner: null, ensName: null, deny: [], pendingLabel: null };
}

/**
 * @param {unknown} value
 * @returns {HouseConfigState}
 */
function normalize(value) {
  if (value === null || typeof value !== "object") {
    throw new Error("house.enc content is invalid");
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  let owner = null;
  if (raw.owner !== null && raw.owner !== undefined) {
    if (typeof raw.owner !== "string" || !OWNER_RE.test(raw.owner)) {
      throw new Error("house.enc content is invalid");
    }
    owner = /** @type {`0x${string}`} */ (raw.owner);
  }
  if (
    raw.ensName !== null &&
    raw.ensName !== undefined &&
    typeof raw.ensName !== "string"
  ) {
    throw new Error("house.enc content is invalid");
  }
  if (
    raw.pendingLabel !== null &&
    raw.pendingLabel !== undefined &&
    typeof raw.pendingLabel !== "string"
  ) {
    throw new Error("house.enc content is invalid");
  }
  if (raw.deny !== undefined && !Array.isArray(raw.deny)) {
    throw new Error("house.enc content is invalid");
  }
  /** @type {`0x${string}`[]} */
  const deny = [];
  for (const item of raw.deny ?? []) {
    if (typeof item !== "string" || !ADDR_RE.test(item)) {
      throw new Error("house.enc content is invalid");
    }
    deny.push(/** @type {`0x${string}`} */ (item.toLowerCase()));
  }
  return {
    owner,
    ensName: typeof raw.ensName === "string" ? raw.ensName : null,
    deny,
    pendingLabel:
      typeof raw.pendingLabel === "string" ? raw.pendingLabel : null,
  };
}

const MISSING = Symbol("missing");

/**
 * Missing file → empty config.
 * @param {string} stateDir
 * @param {{ open(purpose: string, sealed: string): unknown }} vault
 * @returns {Promise<HouseConfigState>}
 */
export async function loadHouseConfig(stateDir, vault) {
  const opened = await readSealed(stateDir, "house.enc", vault, "house", MISSING);
  if (opened === MISSING) return empty();
  return normalize(opened);
}

/**
 * Atomic sealed write of house.enc, mode 600.
 * @param {string} stateDir
 * @param {{ seal(purpose: string, value: unknown): string }} vault
 * @param {HouseConfigState} state
 */
export async function saveHouseConfig(stateDir, vault, state) {
  await writeSealed(stateDir, "house.enc", vault, "house", state);
}
