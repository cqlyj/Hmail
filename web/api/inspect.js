import { createPublicClient, getAddress, http } from "viem";
import { sepolia } from "viem/chains";
import { getEnsText, normalize } from "viem/ens";
import {
  DEFAULT_RPC,
  ENS_SEPOLIA,
  ISSUER,
  MCP_KEY,
  NAME_RE,
  REGISTRY_ABI,
  RESOLVER_ABI,
  ROLES,
  TEXT_KEYS,
  WEB_KEY,
  isZero,
  textResource,
} from "../lib/ens.js";

const TOOLS_MAX_BYTES = 256 * 1024;

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

function rpcUrl() {
  const raw = process.env.SEPOLIA_RPC_URL;
  if (typeof raw === "string" && raw.length > 0) return raw;
  return DEFAULT_RPC;
}

/**
 * Only public https hosts: the record is written by the house, so never let it
 * point this function at a private address.
 * @param {string | null} raw
 */
function publicHttpsUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname;
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      /^[0-9.]+$/.test(host) ||
      host.includes(":")
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Unsigned MCP tools/list. The house answers it without a signature and puts each
 * tool's HORS policy in _meta["hors/policy"].
 * @param {string} mcpUrl
 */
async function listTools(mcpUrl) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`house answered ${res.status}`);
  const text = (await res.text()).slice(0, TOOLS_MAX_BYTES);
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data:"));
  const payload = JSON.parse(dataLine ? dataLine.slice(5) : text);
  const tools = Array.isArray(payload?.result?.tools) ? payload.result.tools : [];
  return tools.slice(0, 20).map((tool) => {
    const policy = tool?._meta?.["hors/policy"] ?? {};
    return {
      name: String(tool.name ?? ""),
      title: typeof tool.title === "string" ? tool.title : null,
      description: String(tool.description ?? "").slice(0, 600),
      origin: Array.isArray(policy.origin) ? policy.origin.map(String) : [],
      policy: typeof policy.describe === "string" ? policy.describe : null,
    };
  });
}

export default {
  async fetch(request) {
    if (request.method !== "GET") return json({ error: "bad_request" }, 400);
    const name = new URL(request.url).searchParams.get("name") ?? "";
    if (!NAME_RE.test(name)) return json({ error: "bad_name" }, 400);
    const label = name.slice(0, -".hmail.eth".length);
    const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl()) });
    const registry = getAddress(ENS_SEPOLIA.UserRegistry);
    const read = (address, abi, functionName, args) =>
      client.readContract({ address, abi, functionName, args });

    let owner;
    let resolver;
    let mcp;
    let web;
    try {
      const normalized = normalize(name);
      [owner, resolver, mcp, web] = await Promise.all([
        read(registry, REGISTRY_ABI, "findOwner", [label]),
        read(registry, REGISTRY_ABI, "getResolver", [label]),
        getEnsText(client, { name: normalized, key: MCP_KEY }),
        getEnsText(client, { name: normalized, key: WEB_KEY }),
      ]);
    } catch {
      return json({ error: "resolve_failed" }, 502);
    }
    if (isZero(owner)) return json({ name, exists: false }, 200);

    /** @type {{ key: string, houseOnly: boolean }[]} */
    let setters = [];
    let issuerRenounced = null;
    if (!isZero(resolver)) {
      try {
        const root = await read(resolver, RESOLVER_ABI, "ROOT_RESOURCE", []);
        const [issuerRoles, ...checks] = await Promise.all([
          read(resolver, RESOLVER_ABI, "roles", [root, ISSUER]),
          ...TEXT_KEYS.map((key) =>
            read(resolver, RESOLVER_ABI, "isOnlyAssignee", [
              textResource(key),
              ROLES.SET_TEXT,
              owner,
            ]),
          ),
        ]);
        issuerRenounced = issuerRoles === 0n;
        setters = TEXT_KEYS.map((key, i) => ({ key, houseOnly: checks[i] === true }));
      } catch {
        setters = [];
      }
    }

    const mcpUrl = publicHttpsUrl(mcp);
    /** @type {{ reachable: boolean, tools: Awaited<ReturnType<typeof listTools>>, error: string | null }} */
    let house = { reachable: false, tools: [], error: mcp ? null : "no mcp record" };
    if (mcpUrl) {
      try {
        house = { reachable: true, tools: await listTools(mcpUrl), error: null };
      } catch {
        house = { reachable: false, tools: [], error: "house is offline" };
      }
    } else if (mcp) {
      house = { reachable: false, tools: [], error: "mcp record is not a public https URL" };
    }

    return json(
      {
        name,
        exists: true,
        owner,
        resolver,
        records: { [MCP_KEY]: mcp || null, [WEB_KEY]: web || null },
        roles: { setters, issuerRenounced },
        house,
      },
      200,
    );
  },
};
