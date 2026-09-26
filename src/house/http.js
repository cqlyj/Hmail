/**
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
export function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });
}

/**
 * Exact-origin allow, vary: Origin, cache-control: no-store.
 * @param {Request} request
 * @param {string} allowedOrigin
 * @param {string} methods
 */
export function corsHeaders(request, allowedOrigin, methods) {
  /** @type {Record<string, string>} */
  const headers = {
    "cache-control": "no-store",
    vary: "Origin",
  };
  const origin = request.headers.get("origin");
  if (origin !== null && origin === allowedOrigin) {
    headers["access-control-allow-origin"] = allowedOrigin;
    headers["access-control-allow-methods"] = methods;
    headers["access-control-allow-headers"] = "content-type";
  }
  return headers;
}

/**
 * @param {Request} request
 * @param {number} max
 * @returns {Promise<{ value: unknown } | { error: string }>}
 */
export async function readJsonBody(request, max) {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return { error: "too large" };
  const buf = await request.arrayBuffer();
  if (buf.byteLength > max) return { error: "too large" };
  if (buf.byteLength === 0) return { value: {} };
  try {
    return { value: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { error: "bad json" };
  }
}
