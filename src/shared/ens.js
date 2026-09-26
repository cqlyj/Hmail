import { resolve } from "hors-sdk/resolvers";
import { concat, createPublicClient, http, parseAbi, stringToBytes, toHex } from "viem";
import { sepolia } from "viem/chains";
import { errMessage } from "./util.js";

// Subset of web/lib/ens.js for the house and client. web/ is deployed alone, so the two copies are kept in sync by hand.

export const DEFAULT_ENS_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

export const ENS_SEPOLIA = {
  chainId: 11155111,
  ETHRegistry: "0x657ea849311d3d5823348dded7c2aaafb3ede09e",
};

const ENS_NAME_RE =
  /^(?=.{5,255}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+eth$/;

/** @param {unknown} s */
export function isEnsName(s) {
  return typeof s === "string" && ENS_NAME_RE.test(s);
}

/**
 * env HMAIL_ENS_RPC, else the default Sepolia RPC.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveEnsRpc(env) {
  if (typeof env.HMAIL_ENS_RPC === "string" && env.HMAIL_ENS_RPC.length > 0) {
    return env.HMAIL_ENS_RPC;
  }
  return DEFAULT_ENS_RPC;
}

/** 0x-hex DNS wire format. @param {string} name @returns {`0x${string}`} */
export function dnsEncode(name) {
  return toHex(
    concat([
      ...name.split(".").flatMap((label) => {
        const bytes = stringToBytes(label);
        return [new Uint8Array([bytes.length]), bytes];
      }),
      new Uint8Array([0]),
    ]),
  );
}

export const REGISTRY_ABI = parseAbi([
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
]);

export const RESOLVER_ABI = parseAbi([
  "function setText(bytes name, string key, string value)",
]);

/**
 * hors-sdk/resolvers resolve(name, { rpc: { ens: rpc }, cache: false }).
 * Returns the https URL or throws Error("ENS name <name> has no agent-endpoint[mcp]").
 * Refuses an RPC whose eth_chainId is not Sepolia.
 * @param {string} name
 * @param {string} [rpc]
 * @returns {Promise<string>}
 */
export async function resolveEndpoint(name, rpc = DEFAULT_ENS_RPC) {
  const client = createPublicClient({ chain: sepolia, transport: http(rpc) });
  const chainId = await client.getChainId();
  if (chainId !== ENS_SEPOLIA.chainId) {
    throw new Error(
      `ENS resolution requires Sepolia (chain ${ENS_SEPOLIA.chainId}), got chain ${chainId}`,
    );
  }
  let value;
  try {
    value = await resolve(name, { rpc: { ens: rpc }, cache: false });
  } catch (err) {
    const message = errMessage(err);
    if (message.includes("no agent-endpoint[mcp]")) {
      throw new Error(`ENS name ${name} has no agent-endpoint[mcp]`);
    }
    throw err instanceof Error ? err : new Error(message);
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`ENS name ${name} has no agent-endpoint[mcp]`);
  }
  return value;
}
