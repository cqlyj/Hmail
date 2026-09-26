import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { log } from "../../shared/log.js";
import { VERIFY_BASE } from "./config.js";

/** @typedef {{ kind: "create" } | { kind: "prove", sessionId: string }} VerifyMode */

/** @type {Map<string, number>} */
const seenNullifiers = new Map();
const NULLIFIER_TTL_MS = 60 * 60 * 1000;

/**
 * @param {number} now
 */
function pruneNullifiers(now) {
  for (const [key, expiresAt] of seenNullifiers) {
    if (expiresAt <= now) seenNullifiers.delete(key);
  }
}

/**
 * @param {string} code
 * @returns {{ ok: false, code: string }}
 */
function fail(code) {
  log("info", "verify failed", { code });
  return { ok: false, code };
}

/**
 * @param {unknown} result
 * @param {{ mode: VerifyMode, signal: string, rpNonce: string }} expected
 * @param {{ rpId: string, environment: "production"|"sandbox" }} world
 * @returns {Promise<{ ok: true, sessionId: string } | { ok: false, code: string }>}
 */
export async function verifyWorldResult(result, expected, world) {
  if (
    result === null ||
    typeof result !== "object" ||
    /** @type {{ protocol_version?: unknown }} */ (result).protocol_version !== "4.0" ||
    typeof /** @type {{ session_id?: unknown }} */ (result).session_id !== "string" ||
    !/** @type {{ session_id: string }} */ (result).session_id.startsWith("session_")
  ) {
    return fail("bad_result");
  }
  const proof = /** @type {{ protocol_version: string, session_id: string, environment?: unknown, nonce?: unknown, responses?: unknown }} */ (
    result
  );
  if (proof.environment !== world.environment) return fail("environment_mismatch");
  if (proof.nonce !== expected.rpNonce) return fail("nonce_mismatch");
  if (expected.mode.kind === "prove" && proof.session_id !== expected.mode.sessionId) {
    return fail("session_mismatch");
  }
  if (!Array.isArray(proof.responses) || proof.responses.length !== 1) {
    return fail("bad_response");
  }
  const r = proof.responses[0];
  if (
    r === null ||
    typeof r !== "object" ||
    r.identifier !== "selfie" ||
    r.issuer_schema_id !== 11 ||
    typeof r.signal_hash !== "string" ||
    r.signal_hash.length === 0 ||
    !Array.isArray(r.session_nullifier) ||
    r.session_nullifier.length !== 2
  ) {
    return fail("bad_response");
  }
  if (r.signal_hash.toLowerCase() !== hashSignal(expected.signal).toLowerCase()) {
    return fail("signal_mismatch");
  }
  const nullifier = String(r.session_nullifier[0]);
  const seenAt = Date.now();
  pruneNullifiers(seenAt);
  if (seenNullifiers.has(nullifier)) return fail("replayed");

  let response;
  try {
    response = await fetch(`${VERIFY_BASE}${world.rpId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...proof, environment: world.environment }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return fail("verify_unavailable");
  }
  /** @type {{ success?: unknown, environment?: unknown, session_id?: unknown, code?: unknown } | null} */
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  const sessionOk =
    expected.mode.kind !== "prove" ||
    (json !== null && json.session_id === expected.mode.sessionId);
  if (
    response.status === 200 &&
    json !== null &&
    json.success === true &&
    json.environment === world.environment &&
    sessionOk
  ) {
    const now = Date.now();
    pruneNullifiers(now);
    seenNullifiers.set(nullifier, now + NULLIFIER_TTL_MS);
    return { ok: true, sessionId: proof.session_id };
  }
  const code =
    json !== null && typeof json.code === "string"
      ? `verify_failed:${json.code}`
      : "verify_failed";
  return fail(code);
}
