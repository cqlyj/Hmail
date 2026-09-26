import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseEther,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { getEnsText, normalize } from "viem/ens";
import {
  ENS_SEPOLIA,
  FACTORY_ABI,
  ISSUE_ERRORS,
  MAX_EXPIRY,
  PARENT,
  REGISTRY_ABI,
  RESOLVER_ABI,
  ROLES,
  TEXT_KEYS,
  WEB_KEY,
  dnsEncode,
  isZero,
  resolverSalt,
  same,
  textResource,
} from "./ens.js";

/**
 * Explicit gas limits. A load-balanced RPC can estimate against a node that has
 * not seen the previous batch yet (a call to a not-yet-deployed resolver
 * estimates at ~26k and then runs out of gas). Unused gas is not charged.
 */
const GAS = {
  deployProxy: 400_000n,
  register: 300_000n,
  setText: 200_000n,
  grantSetterRoles: 200_000n,
  revokeRootRoles: 150_000n,
};

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-runs check() until it returns true, for reads that may hit a lagging RPC node.
 * @param {() => Promise<boolean>} check
 */
async function eventually(check, tries = 15) {
  for (let i = 0; i < tries; i += 1) {
    if (await check()) return true;
    await sleep(1_000);
  }
  return false;
}

/**
 * @param {string} code
 */
function fail(code) {
  const err = new Error(code);
  throw err;
}

/**
 * @param {unknown} err
 */
function rethrow(err) {
  if (err instanceof Error && ISSUE_ERRORS.has(err.message)) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (/nonce too low|replacement transaction underpriced/i.test(message)) {
    fail("TX_FAILED");
  }
  fail("TX_FAILED");
}

/**
 * @param {unknown} err
 */
function isExpiryError(err) {
  const text = err instanceof Error ? err.message : String(err);
  if (/expir/i.test(text)) return true;
  if (err instanceof BaseError) {
    const rev = err.walk(
      (item) => item instanceof ContractFunctionRevertedError,
    );
    if (rev instanceof ContractFunctionRevertedError) {
      const name = rev.data?.errorName ?? rev.reason ?? "";
      if (/expir/i.test(String(name))) return true;
    }
    if (/expir/i.test(err.shortMessage)) return true;
  }
  return false;
}

/**
 * @param {string} rpc
 * @param {string} label
 * @returns {Promise<boolean>}
 */
export async function isLabelAvailable(rpc, label) {
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpc),
  });
  let chainId;
  try {
    chainId = await publicClient.getChainId();
  } catch {
    fail("CHAIN");
  }
  if (chainId !== ENS_SEPOLIA.chainId) fail("CHAIN");
  const sub = await publicClient.readContract({
    address: getAddress(ENS_SEPOLIA.ETHRegistry),
    abi: REGISTRY_ABI,
    functionName: "getSubregistry",
    args: [PARENT],
  });
  if (isZero(sub)) return true;
  if (!same(sub, ENS_SEPOLIA.UserRegistry)) fail("NOT_OURS");
  const owner = await publicClient.readContract({
    address: getAddress(ENS_SEPOLIA.UserRegistry),
    abi: REGISTRY_ABI,
    functionName: "findOwner",
    args: [label],
  });
  return isZero(owner);
}

/**
 * Subname-only issuance under the existing hmail.eth UserRegistry. Idempotent.
 * onStep, when given, hears each step as it happens: { step, status: "sent" | "done", tx? }.
 * Steps: resolver, fund, register, records, grants, renounce, verify.
 * @param {{ rpc: string, key: string, label: string, house: string, web: string, onStep?: (event: { step: string, status: "sent" | "done", tx?: string }) => void }} input
 * @returns {Promise<{ name: string, resolver: string, steps: string[] }>}
 */
export async function issueSubname(input) {
  try {
    return await issue(input);
  } catch (err) {
    rethrow(err);
  }
}

/**
 * @param {{ rpc: string, key: string, label: string, house: string, web: string, onStep?: (event: { step: string, status: "sent" | "done", tx?: string }) => void }} input
 */
async function issue(input) {
  /** @type {string[]} */
  const steps = [];
  /**
   * @param {string} step
   * @param {"sent" | "done"} status
   * @param {string} [tx]
   */
  function emit(step, status, tx) {
    if (!input.onStep) return;
    try {
      input.onStep(tx ? { step, status, tx } : { step, status });
    } catch {
      // A listener must never break issuance.
    }
  }
  const rawKey = input.key;
  if (typeof rawKey !== "string") fail("TX_FAILED");
  const keyHex = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(keyHex)) fail("TX_FAILED");
  let account;
  try {
    account = privateKeyToAccount(/** @type {`0x${string}`} */ (keyHex));
  } catch {
    fail("TX_FAILED");
  }
  let house;
  try {
    house = getAddress(input.house);
  } catch {
    fail("TX_FAILED");
  }

  const transport = http(input.rpc);
  const publicClient = createPublicClient({
    chain: sepolia,
    transport,
    pollingInterval: 1_000,
  });
  const wallet = createWalletClient({ account, chain: sepolia, transport });

  const ethRegistry = getAddress(ENS_SEPOLIA.ETHRegistry);
  const userRegistry = getAddress(ENS_SEPOLIA.UserRegistry);
  const resolverImpl = getAddress(ENS_SEPOLIA.PermissionedResolverImpl);
  const factory = getAddress(ENS_SEPOLIA.VerifiableFactory);

  /**
   * @param {`0x${string}`} address
   * @param {readonly unknown[]} abi
   * @param {string} functionName
   * @param {readonly unknown[]} args
   */
  function read(address, abi, functionName, args) {
    return publicClient.readContract({
      address,
      abi,
      functionName,
      args,
    });
  }

  let chainId;
  try {
    chainId = await publicClient.getChainId();
  } catch {
    fail("CHAIN");
  }
  if (chainId !== ENS_SEPOLIA.chainId) fail("CHAIN");

  const [houseCode, sub, ours, owner, linked, balance] = await Promise.all([
    publicClient.getCode({ address: house }),
    read(ethRegistry, REGISTRY_ABI, "getSubregistry", [PARENT]),
    read(userRegistry, REGISTRY_ABI, "hasRootRoles", [
      ROLES.REGISTRAR,
      account.address,
    ]),
    read(userRegistry, REGISTRY_ABI, "findOwner", [input.label]),
    read(userRegistry, REGISTRY_ABI, "getResolver", [input.label]),
    publicClient.getBalance({ address: house }),
  ]);

  if (houseCode && houseCode !== "0x") fail("HOUSE_HAS_CODE");
  if (!same(sub, userRegistry)) fail("NOT_OURS");
  if (!ours) fail("NOT_OURS");
  if (!isZero(owner) && !same(owner, house)) fail("LABEL_TAKEN");

  const fresh = isZero(owner);
  const fullName = `${input.label}.${PARENT}.eth`;
  /** @type {`0x${string}`} */
  let resolver;

  let nonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });

  /**
   * @param {object} call
   */
  function simulate(call) {
    return publicClient.simulateContract({
      account,
      ...call,
    });
  }

  /**
   * @param {{ request: object, result?: unknown }} sim
   */
  async function sendSim(sim) {
    const request = /** @type {{ functionName: keyof typeof GAS }} */ (
      sim.request
    );
    const hash = await wallet.writeContract({
      ...sim.request,
      gas: GAS[request.functionName] ?? 300_000n,
      nonce: nonce++,
    });
    return { hash, result: sim.result };
  }

  /**
   * @param {`0x${string}`[]} hashes
   */
  async function waitAll(hashes) {
    if (hashes.length === 0) return;
    const receipts = await Promise.all(
      hashes.map((hash) => publicClient.waitForTransactionReceipt({ hash })),
    );
    for (const receipt of receipts) {
      if (receipt.status !== "success") fail("TX_FAILED");
    }
  }

  /** @type {`0x${string}`[]} */
  const batch1 = [];

  if (!isZero(linked)) {
    resolver = getAddress(linked);
    steps.push("resolver: done");
    emit("resolver", "done");
  } else if (!fresh) {
    fail("TX_FAILED");
  } else {
    const init = encodeFunctionData({
      abi: RESOLVER_ABI,
      functionName: "initialize",
      args: [
        [
          {
            account: account.address,
            roleBitmap: ROLES.SET_TEXT | ROLES.SET_TEXT_ADMIN,
          },
        ],
        [],
      ],
    });
    /** @type {{ sim: Awaited<ReturnType<typeof simulate>>, attempt: number } | null} */
    let chosen = null;
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const salt = resolverSalt(input.label, house, attempt);
      try {
        const sim = await simulate({
          address: factory,
          abi: FACTORY_ABI,
          functionName: "deployProxy",
          args: [resolverImpl, salt, init],
        });
        chosen = { sim, attempt };
        break;
      } catch (err) {
        if (err instanceof Error && ISSUE_ERRORS.has(err.message)) throw err;
      }
    }
    if (!chosen) fail("TX_FAILED");
    const sent = await sendSim(chosen.sim);
    emit("resolver", "sent", sent.hash);
    resolver = getAddress(/** @type {string} */ (sent.result));
    batch1.push(sent.hash);
    steps.push(
      chosen.attempt === 0
        ? "resolver: deployed"
        : `resolver: deployed (attempt ${chosen.attempt})`,
    );
  }

  if (fresh && balance < parseEther("0.003")) {
    const hash = await wallet.sendTransaction({
      account,
      to: house,
      value: parseEther("0.005"),
      gas: 21_000n,
      nonce: nonce++,
    });
    batch1.push(hash);
    emit("fund", "sent", hash);
    steps.push("fund: 0.005 ETH");
  }
  await waitAll(batch1);
  if (batch1.length > 0) {
    emit("resolver", "done");
    if (batch1.length > 1) emit("fund", "done");
  }
  const deployed = await eventually(async () => {
    const code = await publicClient.getCode({ address: resolver });
    return typeof code === "string" && code !== "0x";
  });
  if (!deployed) fail("TX_FAILED");

  /** @type {{ sim: Awaited<ReturnType<typeof simulate>>, step: string }[]} */
  const batch2sims = [];

  if (fresh) {
    const registerCall = (expiry) => ({
      address: userRegistry,
      abi: REGISTRY_ABI,
      functionName: "register",
      args: [input.label, house, zeroAddress, resolver, 0n, expiry],
    });
    /** @type {Awaited<ReturnType<typeof simulate>>} */
    let sim;
    try {
      sim = await simulate(registerCall(MAX_EXPIRY));
    } catch (err) {
      if (err instanceof Error && ISSUE_ERRORS.has(err.message)) throw err;
      if (!isExpiryError(err)) fail("TX_FAILED");
      const parentId = await read(ethRegistry, REGISTRY_ABI, "findTokenId", [
        PARENT,
      ]);
      const parentExpiry = await read(ethRegistry, REGISTRY_ABI, "getExpiry", [
        parentId,
      ]);
      try {
        sim = await simulate(registerCall(parentExpiry));
      } catch (err2) {
        if (err2 instanceof Error && ISSUE_ERRORS.has(err2.message)) throw err2;
        fail("TX_FAILED");
      }
    }
    batch2sims.push({ sim, step: "register" });
    steps.push("subname: registered");
  } else {
    steps.push("subname: done");
    emit("register", "done");
  }

  let needWeb = true;
  if (!fresh) {
    let currentWeb;
    try {
      currentWeb = await getEnsText(publicClient, {
        name: normalize(fullName),
        key: WEB_KEY,
      });
    } catch (err) {
      if (err instanceof Error && ISSUE_ERRORS.has(err.message)) throw err;
      fail("TX_FAILED");
    }
    needWeb = currentWeb !== input.web;
  }
  if (needWeb) {
    batch2sims.push({
      sim: await simulate({
        address: resolver,
        abi: RESOLVER_ABI,
        functionName: "setText",
        args: [dnsEncode(fullName), WEB_KEY, input.web],
      }),
      step: "records",
    });
    steps.push("records: set web");
  } else {
    steps.push("records: done");
    emit("records", "done");
  }

  let granted = false;
  for (const key of TEXT_KEYS) {
    const resource = textResource(key);
    const has = await read(resolver, RESOLVER_ABI, "hasRoles", [
      resource,
      ROLES.SET_TEXT,
      house,
    ]);
    if (has) continue;
    const setter = encodeFunctionData({
      abi: RESOLVER_ABI,
      functionName: "setText",
      args: [dnsEncode(fullName), key, ""],
    });
    batch2sims.push({
      sim: await simulate({
        address: resolver,
        abi: RESOLVER_ABI,
        functionName: "grantSetterRoles",
        args: [setter, house],
      }),
      step: "grants",
    });
    granted = true;
  }
  steps.push(granted ? "grant: set" : "grant: done");
  if (!granted) emit("grants", "done");

  /** @type {`0x${string}`[]} */
  const batch2 = [];
  for (const item of batch2sims) {
    const sent = await sendSim(item.sim);
    batch2.push(sent.hash);
    emit(item.step, "sent", sent.hash);
  }
  await waitAll(batch2);
  for (const step of new Set(batch2sims.map((item) => item.step))) {
    emit(step, "done");
  }

  /**
   * @param {`0x${string}`} resolverAddress
   */
  async function setterProblems(resolverAddress) {
    /** @type {string[]} */
    const problems = [];
    for (const key of TEXT_KEYS) {
      const resource = textResource(key);
      const has = await read(resolverAddress, RESOLVER_ABI, "hasRoles", [
        resource,
        ROLES.SET_TEXT,
        house,
      ]);
      const only = await read(resolverAddress, RESOLVER_ABI, "isOnlyAssignee", [
        resource,
        ROLES.SET_TEXT,
        house,
      ]);
      if (!has || !only) problems.push(key);
    }
    return problems;
  }

  const settersReady = await eventually(
    async () => (await setterProblems(resolver)).length === 0,
  );
  if (!settersReady) fail("TX_FAILED");

  const resolverRoot = await read(resolver, RESOLVER_ABI, "ROOT_RESOURCE", []);
  const registryRoles = await read(resolver, RESOLVER_ABI, "roles", [
    resolverRoot,
    account.address,
  ]);
  if (registryRoles !== 0n) {
    const sim = await simulate({
      address: resolver,
      abi: RESOLVER_ABI,
      functionName: "revokeRootRoles",
      args: [ROLES.SET_TEXT | ROLES.SET_TEXT_ADMIN, account.address],
    });
    const sent = await sendSim(sim);
    emit("renounce", "sent", sent.hash);
    await waitAll([sent.hash]);
    emit("renounce", "done");
    steps.push("renounce: revoked");
  } else {
    steps.push("renounce: done");
    emit("renounce", "done");
  }

  const verified = await eventually(async () => {
    const [ownerNow, resolverNow, left, finalProblems] = await Promise.all([
      read(userRegistry, REGISTRY_ABI, "findOwner", [input.label]),
      read(userRegistry, REGISTRY_ABI, "getResolver", [input.label]),
      read(resolver, RESOLVER_ABI, "roles", [resolverRoot, account.address]),
      setterProblems(resolver),
    ]);
    return (
      same(ownerNow, house) &&
      same(resolverNow, resolver) &&
      left === 0n &&
      finalProblems.length === 0
    );
  });
  if (!verified) fail("TX_FAILED");
  steps.push("verify: done");
  emit("verify", "done");

  return { name: fullName, resolver, steps };
}
