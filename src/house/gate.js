import { keccak256, toBytes } from "viem";
import { createGate } from "hors-sdk";

/** An owner no wallet can map to: keeps same-human tools closed until pairing, and stops HORS from adopting a profile. */
export const UNPAIRED_OWNER = keccak256(toBytes("hmail/unpaired-owner/v1"));

/**
 * Real mode passes the sentinel owner until the house is paired.
 * Mock mode passes the owner selection the caller computed, plus deny.
 * @param {import("./config.js").HouseConfig} cfg
 * @param {string[]} mcpUrls
 * @param {{ owner: "auto" | `0x${string}`, deny?: `0x${string}`[] }} identity
 * @returns {Promise<import("hors-sdk").Gate>}
 */
export async function createHouseGate(cfg, mcpUrls, identity) {
  return createGate({
    configFile: false,
    profile: cfg.profile,
    owner: identity.owner,
    policy: "same-human",
    origins: mcpUrls,
    deny: identity.deny ?? [],
    dev: { mockOrigin: cfg.mock },
  });
}
