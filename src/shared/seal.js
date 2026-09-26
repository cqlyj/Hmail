import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const RECIPIENT_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * @param {string} recipientKey
 */
function importRecipient(recipientKey) {
  if (!RECIPIENT_RE.test(recipientKey)) throw new Error("bad recipient key");
  return createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: recipientKey },
    format: "jwk",
  });
}

/**
 * @param {string} epk
 * @param {string} recipientKey
 */
function sealSalt(epk, recipientKey) {
  return Buffer.concat([
    Buffer.from(epk, "base64url"),
    Buffer.from(recipientKey, "base64url"),
  ]);
}

/**
 * @param {string} site
 * @param {string} approvalId
 */
function sealAad(site, approvalId) {
  return Buffer.from(`hmail-seal:v1:${site}:${approvalId}`);
}

/**
 * @param {Buffer} shared
 * @param {string} epk
 * @param {string} recipientKey
 */
function sealKey(shared, epk, recipientKey) {
  return Buffer.from(
    hkdfSync("sha256", shared, sealSalt(epk, recipientKey), "hmail-seal-v1", 32),
  );
}

/** @returns {{ publicKey: string, privateKey: import("node:crypto").KeyObject }}  publicKey = base64url raw 32 bytes (JWK "x") */
export function newRecipient() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("recipient key failed");
  return { publicKey: jwk.x, privateKey };
}

/** @returns {{ type: "hmail-sealed", v: 1, site: string, approvalId: string, epk: string, iv: string, ct: string, tag: string }} */
export function sealForRecipient({ recipientKey, site, approvalId, payload }) {
  const recipient = importRecipient(recipientKey);
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const exported = publicKey.export({ format: "jwk" });
  if (typeof exported.x !== "string") throw new Error("ephemeral key failed");
  const epk = exported.x;
  const shared = diffieHellman({ privateKey, publicKey: recipient });
  const key = sealKey(shared, epk, recipientKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(sealAad(site, approvalId));
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    type: "hmail-sealed",
    v: 1,
    site,
    approvalId,
    epk,
    iv: iv.toString("base64url"),
    ct: ct.toString("base64url"),
    tag: tag.toString("base64url"),
  };
}

/** @returns {unknown} payload; throws Error("sealed code failed to open") on any failure */
export function openSealed(sealed, { privateKey, recipientKey, site, approvalId }) {
  try {
    if (
      !sealed ||
      typeof sealed !== "object" ||
      sealed.type !== "hmail-sealed" ||
      sealed.v !== 1 ||
      sealed.site !== site ||
      sealed.approvalId !== approvalId
    ) {
      throw new Error("sealed code failed to open");
    }
    const epk = sealed.epk;
    if (typeof epk !== "string" || typeof recipientKey !== "string") {
      throw new Error("sealed code failed to open");
    }
    const epkKey = createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: epk },
      format: "jwk",
    });
    const shared = diffieHellman({ privateKey, publicKey: epkKey });
    const key = sealKey(shared, epk, recipientKey);
    const iv = Buffer.from(sealed.iv, "base64url");
    const ct = Buffer.from(sealed.ct, "base64url");
    const tag = Buffer.from(sealed.tag, "base64url");
    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error("sealed code failed to open");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: 16,
    });
    decipher.setAAD(sealAad(site, approvalId));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString("utf8"));
  } catch {
    throw new Error("sealed code failed to open");
  }
}
