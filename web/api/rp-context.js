import { signRequest } from "@worldcoin/idkit-core/signing";

const KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    const key = process.env.WORLD_RP_SIGNING_KEY;
    if (typeof key !== "string" || !KEY_RE.test(key)) {
      return Response.json({ error: "signer not configured" }, { status: 500 });
    }
    try {
      const s = signRequest({ signingKeyHex: key });
      return Response.json(
        {
          nonce: s.nonce,
          created_at: s.createdAt,
          expires_at: s.expiresAt,
          signature: s.sig,
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch {
      return Response.json({ error: "signing failed" }, { status: 500 });
    }
  },
};
