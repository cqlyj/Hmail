import { readKeyFile } from "hors-sdk/node";
import { errMessage, redactKeys } from "../shared/util.js";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  InsufficientFundsError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { getEnsText, normalize } from "viem/ens";
import {
  dnsEncode,
  ENS_SEPOLIA,
  REGISTRY_ABI,
  RESOLVER_ABI,
} from "../shared/ens.js";

const MCP_KEY = "agent-endpoint[mcp]";
const WEB_KEY = "agent-endpoint[web]";

/**
 * @param {unknown} err
 */
function safeDetail(err) {
  return redactKeys(errMessage(err)).replace(/\s+/g, " ").trim();
}

/**
 * @param {unknown} err
 * @returns {"funds"|"revert"|"other"}
 */
function classifyWriteError(err) {
  if (err instanceof BaseError) {
    const funds = err.walk((item) => item instanceof InsufficientFundsError);
    if (funds) return "funds";
    const reverted = err.walk(
      (item) => item instanceof ContractFunctionRevertedError,
    );
    if (reverted) return "revert";
    if (/insufficient funds/i.test(err.message)) return "funds";
    if (/execution reverted|contract function .* reverted/i.test(err.message)) {
      return "revert";
    }
  }
  if (err instanceof Error && /insufficient funds/i.test(err.message)) {
    return "funds";
  }
  return "other";
}

/**
 * @param {string} name
 * @returns {{ label: string, parent: string } | null}
 */
function splitName(name) {
  const parts = name.split(".");
  if (parts.length !== 3 || parts[2] !== "eth") return null;
  if (parts[0].length === 0 || parts[1].length === 0) return null;
  return { label: parts[0], parent: parts[1] };
}

/**
 * @param {{ name: string, home: string, profile: string, mcpUrl: string|null, webOrigin: string, rpc: string }} opts
 * @returns {Promise<{ status: "updated" | "unchanged" | "failed", detail: string, tx?: string }>}
 */
export async function syncEnsRecords(opts) {
  try {
    return await syncEnsBody(opts);
  } catch (err) {
    return {
      status: "failed",
      detail: redactKeys(errMessage(err).replace(/\s+/g, " ").trim()),
    };
  }
}

/**
 * @param {{ name: string, home: string, profile: string, mcpUrl: string|null, webOrigin: string, rpc: string }} opts
 */
async function syncEnsBody({ name, home, profile, mcpUrl, webOrigin, rpc }) {
  const key = await readKeyFile(home, profile);
  let account;
  try {
    account = privateKeyToAccount(key);
  } catch {
    return { status: "failed", detail: "house key file is invalid" };
  }
  const transport = http(rpc);
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const wallet = createWalletClient({ account, chain: sepolia, transport });

  const chainId = await publicClient.getChainId();
  if (chainId !== ENS_SEPOLIA.chainId) {
    return { status: "failed", detail: "not Sepolia" };
  }

  const shape = splitName(name);
  if (!shape) return { status: "failed", detail: "unsupported name shape" };

  const sub = await publicClient.readContract({
    address: ENS_SEPOLIA.ETHRegistry,
    abi: REGISTRY_ABI,
    functionName: "getSubregistry",
    args: [shape.parent],
  });
  if (sub === "0x0000000000000000000000000000000000000000") {
    return { status: "failed", detail: `no subregistry for ${shape.parent}` };
  }
  const resolver = await publicClient.readContract({
    address: sub,
    abi: REGISTRY_ABI,
    functionName: "getResolver",
    args: [shape.label],
  });
  if (resolver === "0x0000000000000000000000000000000000000000") {
    return { status: "failed", detail: `no resolver for ${shape.label}` };
  }

  const normalized = normalize(name);
  /** @type {Array<[string, string]>} */
  const pairs = [];
  if (mcpUrl !== null) pairs.push([MCP_KEY, mcpUrl]);
  pairs.push([WEB_KEY, webOrigin]);

  /** @type {bigint | null} */
  let block = null;
  /** @type {string | undefined} */
  let lastTx;
  for (const [recordKey, value] of pairs) {
    let current;
    try {
      current = await getEnsText(publicClient, {
        name: normalized,
        key: recordKey,
      });
    } catch (err) {
      return { status: "failed", detail: safeDetail(err) };
    }
    if (current === value) continue;
    try {
      const hash = await wallet.writeContract({
        address: resolver,
        abi: RESOLVER_ABI,
        functionName: "setText",
        args: [dnsEncode(name), recordKey, value],
        account,
        // Explicit limit: right after issuance a load-balanced RPC may estimate
        // against a node that has not seen this key's new setter role yet.
        gas: 200_000n,
      });
      lastTx = hash;
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 90_000,
      });
      if (receipt.status !== "success") {
        return {
          status: "failed",
          detail: `house key cannot write ${recordKey} (transaction reverted)`,
        };
      }
      block = receipt.blockNumber;
    } catch (err) {
      const kind = classifyWriteError(err);
      if (kind === "funds") {
        return {
          status: "failed",
          detail: `house key has no Sepolia ETH (address ${account.address})`,
        };
      }
      if (kind === "revert") {
        return {
          status: "failed",
          detail: `house key cannot write ${recordKey}`,
        };
      }
      return { status: "failed", detail: safeDetail(err) };
    }
  }

  if (block !== null) {
    return { status: "updated", detail: block.toString(), tx: lastTx };
  }
  return { status: "unchanged", detail: "up to date" };
}
