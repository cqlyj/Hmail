import { createHash } from "node:crypto";

/**
 * @param {string} houseAddress
 * @param {string} label
 * @param {string} nonceHex
 */
export function setupSignal(houseAddress, label, nonceHex) {
  const name = typeof label === "string" && label.length > 0 ? label : "-";
  return `hmail/v1/setup/${houseAddress.toLowerCase()}/${name}/${nonceHex}`;
}

/**
 * @param {string} houseAddress
 * @param {string} site
 * @param {string} reason
 * @param {string} recipientKey
 * @param {string} nonceHex
 */
export function releaseSignal(
  houseAddress,
  site,
  reason,
  recipientKey,
  nonceHex,
) {
  const bind = createHash("sha256")
    .update(`${reason}\n${recipientKey}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `hmail/v1/release/${houseAddress.toLowerCase()}/${site}/${nonceHex}/${bind}`;
}
