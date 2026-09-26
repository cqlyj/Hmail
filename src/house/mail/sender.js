import { dkimVerify } from "mailauth";
import { siteForDomain } from "./sites.js";

/** @typedef {{ verified: true, site: string, signingDomain: string } | { verified: false, site: null, reason: string, temporary: boolean }} SenderVerdict */

/**
 * @param {import("mailauth").DKIMVerifyResult} r
 * @returns {SenderVerdict}
 */
function verdictFrom(r) {
  if (!Array.isArray(r.headerFrom) || r.headerFrom.length !== 1) {
    return {
      verified: false,
      site: null,
      reason: "multiple From headers",
      temporary: false,
    };
  }
  const results = Array.isArray(r.results) ? r.results : [];
  const pass = results.find((item) => {
    const status = item?.status;
    return status?.result === "pass" && status.aligned && !status.underSized;
  });
  if (!pass) {
    const first = results[0];
    const reason =
      first?.status?.comment ?? first?.status?.result ?? "no DKIM signature";
    const temporary = results.some((item) => {
      const result = item?.status?.result;
      return result === "temperror" || result === "temperr";
    });
    return { verified: false, site: null, reason: String(reason), temporary };
  }
  const domain = String(r.headerFrom[0]).split("@").pop() ?? "";
  const site = siteForDomain(domain);
  if (site == null) {
    return {
      verified: false,
      site: null,
      reason: "no registrable From domain",
      temporary: false,
    };
  }
  return { verified: true, site, signingDomain: pass.signingDomain };
}

/** @param {Buffer | string} raw @param {{ timeoutMs?: number }} [opts] @returns {Promise<SenderVerdict>} */
export async function verifySender(raw, { timeoutMs = 10_000 } = {}) {
  const pending = dkimVerify(raw).then(
    (value) => ({ ok: /** @type {const} */ (true), value }),
    () => ({ ok: /** @type {const} */ (false) }),
  );
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {import("mailauth").DKIMVerifyResult | undefined} */
  let result;
  try {
    const raced = await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    if (!raced || raced.ok !== true) {
      return {
        verified: false,
        site: null,
        reason: "dkim check failed",
        temporary: true,
      };
    }
    result = raced.value;
  } catch {
    return {
      verified: false,
      site: null,
      reason: "dkim check failed",
      temporary: true,
    };
  } finally {
    clearTimeout(timer);
  }
  return verdictFrom(result);
}
