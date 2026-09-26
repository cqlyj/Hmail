import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * @param {string} keyPath
 * @returns {Promise<Buffer>}
 */
async function loadOrCreateKey(keyPath) {
  try {
    const info = await stat(keyPath);
    if ((info.mode & 0o077) !== 0) {
      throw new Error(
        `vault.key must be mode 0600 (${keyPath}); run: chmod 600 ${keyPath}`,
      );
    }
    const hex = (await readFile(keyPath, "utf8")).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("vault.key is not a valid key");
    }
    return Buffer.from(hex, "hex");
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
      const hex = randomBytes(32).toString("hex");
      await writeFile(keyPath, `${hex}\n`, { flag: "wx", mode: 0o600 });
      return Buffer.from(hex, "hex");
    }
    throw err;
  }
}

/** @returns {Promise<{ seal(purpose: string, value: unknown): string, open(purpose: string, sealed: string): unknown }>} */
export async function openVault(stateDir) {
  const key = await loadOrCreateKey(join(stateDir, "vault.key"));

  return {
    seal(purpose, value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`hmail:${purpose}:v1`));
      const ct = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return JSON.stringify({
        v: 1,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ct: ct.toString("base64"),
      });
    },
    open(purpose, sealed) {
      try {
        const parsed = JSON.parse(sealed);
        const iv = Buffer.from(parsed.iv, "base64");
        const tag = Buffer.from(parsed.tag, "base64");
        const ct = Buffer.from(parsed.ct, "base64");
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(`hmail:${purpose}:v1`));
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return JSON.parse(pt.toString("utf8"));
      } catch {
        throw new Error(`sealed data for ${purpose} failed to open`);
      }
    },
  };
}
