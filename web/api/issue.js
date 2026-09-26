import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { isAddress } from "viem";
import { DEFAULT_RPC, ISSUE_ERRORS, LABEL_RE } from "../lib/ens.js";
import { isLabelAvailable, issueSubname } from "../lib/issue-core.js";

const NONCE_RE = /^[0-9a-fA-F]{32}$/;
const BODY_MAX = 16 * 1024;
const VERIFY_URL =
  "https://developer.world.org/api/v4/verify/rp_1d770f6bea9daa0f";
const WEB = "https://hmail-web.vercel.app";
/**
 * @param {unknown} body
 * @param {number} status
 */
function json(body, status) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * @returns {string}
 */
function rpcUrl() {
  const raw = process.env.SEPOLIA_RPC_URL;
  if (typeof raw === "string" && raw.length > 0) return raw;
  return DEFAULT_RPC;
}

/**
 * @param {unknown} result
 * @param {string} signal
 */
function proofOk(result, signal) {
  if (result === null || typeof result !== "object") return false;
  const proof = /** @type {Record<string, unknown>} */ (result);
  if (proof.environment !== "production") return false;
  if (typeof proof.session_id !== "string" || proof.session_id.length === 0) {
    return false;
  }
  if (!Array.isArray(proof.responses) || proof.responses.length !== 1) {
    return false;
  }
  const response = proof.responses[0];
  if (response === null || typeof response !== "object") return false;
  const item = /** @type {Record<string, unknown>} */ (response);
  if (item.identifier !== "selfie") return false;
  if (item.issuer_schema_id !== 11) return false;
  if (typeof item.signal_hash !== "string") return false;
  return item.signal_hash.toLowerCase() === hashSignal(signal).toLowerCase();
}

/**
 * @param {unknown} err
 */
function issueError(err) {
  return err instanceof Error && ISSUE_ERRORS.has(err.message)
    ? err.message
    : "TX_FAILED";
}

/**
 * Streams issuance as newline-delimited JSON: one {"type":"step",...} line per
 * step as it is sent and confirmed, then {"type":"done",...} or {"type":"error",...}.
 * @param {Parameters<typeof issueSubname>[0]} params
 */
function streamIssue(params) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      /** @param {object} line */
      const send = (line) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      try {
        const issued = await issueSubname({
          ...params,
          onStep: (event) => send({ type: "step", ...event }),
        });
        send({ type: "done", name: issued.name, resolver: issued.resolver });
      } catch (err) {
        send({ type: "error", error: issueError(err) });
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      const label = url.searchParams.get("label") ?? "";
      if (!LABEL_RE.test(label)) return json({ error: "bad_label" }, 400);
      try {
        const available = await isLabelAvailable(rpcUrl(), label);
        return json({ available }, 200);
      } catch (err) {
        const code =
          err instanceof Error && ISSUE_ERRORS.has(err.message)
            ? err.message
            : "CHAIN";
        return json({ error: code }, 500);
      }
    }
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    const declared = request.headers.get("content-length");
    if (declared !== null && Number(declared) > BODY_MAX) {
      return json({ error: "bad_request" }, 400);
    }
    /** @type {unknown} */
    let body;
    try {
      const text = await request.text();
      if (text.length > BODY_MAX) return json({ error: "bad_request" }, 400);
      body = JSON.parse(text);
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    if (body === null || typeof body !== "object") {
      return json({ error: "bad_request" }, 400);
    }
    const input = /** @type {Record<string, unknown>} */ (body);
    if (typeof input.label !== "string" || !LABEL_RE.test(input.label)) {
      return json({ error: "bad_request" }, 400);
    }
    if (
      typeof input.house !== "string" ||
      !isAddress(input.house, { strict: false }) ||
      !isAddress(input.house)
    ) {
      return json({ error: "bad_request" }, 400);
    }
    if (typeof input.nonce !== "string" || !NONCE_RE.test(input.nonce)) {
      return json({ error: "bad_request" }, 400);
    }
    if (input.result === null || typeof input.result !== "object") {
      return json({ error: "bad_request" }, 400);
    }
    const signal = `hmail/v1/setup/${input.house.toLowerCase()}/${input.label}/${input.nonce}`;
    if (!proofOk(input.result, signal)) return json({ error: "bad_proof" }, 400);

    let verified;
    try {
      verified = await fetch(VERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          .../** @type {Record<string, unknown>} */ (input.result),
          environment: "production",
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return json({ error: "verify_failed" }, 403);
    }
    /** @type {{ success?: unknown, environment?: unknown } | null} */
    let verdict = null;
    try {
      verdict = await verified.json();
    } catch {
      verdict = null;
    }
    if (
      verified.status !== 200 ||
      verdict === null ||
      verdict.success !== true ||
      verdict.environment !== "production"
    ) {
      return json({ error: "verify_failed" }, 403);
    }

    const key = process.env.HMAIL_REGISTRY_KEY;
    if (typeof key !== "string" || key.length === 0) {
      return json({ error: "TX_FAILED" }, 500);
    }
    const params = {
      rpc: rpcUrl(),
      key,
      label: input.label,
      house: input.house,
      web: WEB,
    };
    const accept = request.headers.get("accept") ?? "";
    if (accept.includes("application/x-ndjson")) return streamIssue(params);
    try {
      const issued = await issueSubname(params);
      return json({ name: issued.name, resolver: issued.resolver }, 200);
    } catch (err) {
      const code = issueError(err);
      if (code === "LABEL_TAKEN") return json({ error: "LABEL_TAKEN" }, 409);
      return json({ error: code }, 500);
    }
  },
};
