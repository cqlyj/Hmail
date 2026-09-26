import { createProfile, readProfile } from "hors-sdk/node";

/** @returns {Promise<{ address: `0x${string}`, created: boolean }>} */
export async function ensureHouseWallet(home, profile) {
  const existing = await readProfile(home, profile);
  if (existing === undefined) {
    const created = await createProfile(home, profile);
    return { address: created.address, created: true };
  }
  return { address: existing.address, created: false };
}
