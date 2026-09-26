import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { getEnsText, normalize } from "viem/ens";
import { DEFAULT_RPC, MCP_KEY, NAME_RE, WEB_KEY } from "../lib/ens.js";

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

export default {
  async fetch(request) {
    if (request.method !== "GET") {
      return json({ error: "bad_name" }, 400);
    }
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "";
    if (!NAME_RE.test(name)) return json({ error: "bad_name" }, 400);
    try {
      const client = createPublicClient({
        chain: sepolia,
        transport: http(rpcUrl()),
      });
      const normalized = normalize(name);
      const [mcp, web] = await Promise.all([
        getEnsText(client, { name: normalized, key: MCP_KEY }),
        getEnsText(client, { name: normalized, key: WEB_KEY }),
      ]);
      return json(
        {
          name,
          mcp: typeof mcp === "string" && mcp.length > 0 ? mcp : null,
          web: typeof web === "string" && web.length > 0 ? web : null,
        },
        200,
      );
    } catch {
      return json({ error: "resolve_failed" }, 502);
    }
  },
};
