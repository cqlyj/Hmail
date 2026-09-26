const HEX = /^0x[0-9a-fA-F]+$/;

/**
 * POST signerUrl with body "{}" . Returns rp_context.
 * Throws Error("signer unavailable") on any failure; never includes the response body.
 * @param {{ signerUrl: string, rpId: string }} world
 */
export async function fetchRpContext(world) {
  try {
    const response = await fetch(world.signerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) throw new Error("signer unavailable");
    const json = await response.json();
    if (!json || typeof json !== "object") throw new Error("signer unavailable");
    if (typeof json.nonce !== "string" || !HEX.test(json.nonce)) {
      throw new Error("signer unavailable");
    }
    if (typeof json.signature !== "string" || !HEX.test(json.signature)) {
      throw new Error("signer unavailable");
    }
    if (!Number.isInteger(json.created_at) || !Number.isInteger(json.expires_at)) {
      throw new Error("signer unavailable");
    }
    if (!(json.expires_at > Date.now() / 1000)) throw new Error("signer unavailable");
    return {
      rp_id: world.rpId,
      nonce: json.nonce,
      created_at: json.created_at,
      expires_at: json.expires_at,
      signature: json.signature,
    };
  } catch (err) {
    if (err instanceof Error && err.message === "signer unavailable") throw err;
    throw new Error("signer unavailable");
  }
}
