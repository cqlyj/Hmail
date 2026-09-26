import { parseArgs } from "node:util";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  numberToHex,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { getEnsText, normalize } from "viem/ens";
import { resolveEndpoint } from "../src/shared/ens.js";
import { errMessage, redactKeys } from "../src/shared/util.js";
import {
  ENS_SEPOLIA,
  ERC20_ABI,
  FACTORY_ABI,
  LABEL_RE,
  MAX_EXPIRY,
  MCP_KEY,
  PARENT,
  REGISTRAR_ABI,
  REGISTRY_ABI,
  RESOLVER_ABI,
  ROLES,
  TEXT_KEYS,
  dnsEncode,
  isZero,
  same,
  textResource,
} from "../web/lib/ens.js";
import { issueSubname } from "../web/lib/issue-core.js";

const DURATION = 5n * 31536000n;
const DEFAULT_WEB = "https://hmail-web.vercel.app";

/** @type {unknown[]} */
const abis = [];

function ok(step, detail) {
  process.stdout.write(`ok  ${step}  ${detail}\n`);
}

function skip(step, detail) {
  process.stdout.write(`skip ${step}  already done (${detail})\n`);
}

function fail(step, detail) {
  process.stdout.write(`FAIL ${step} ${redact(detail)}\n`);
  process.exit(1);
}

function usage(message) {
  process.stderr.write(`error: ${redact(message)}\n`);
  process.exit(2);
}

function refuse(message) {
  process.stdout.write(`${redact(message)}\n`);
  process.exit(2);
}

function oneLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function redact(text) {
  return redactKeys(oneLine(text));
}

function formatArg(value) {
  if (typeof value === "bigint") return value.toString();
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (value instanceof Uint8Array) return toHex(value);
  try {
    return JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? item.toString() : item,
    );
  } catch {
    return String(value);
  }
}

function revertRaw(err) {
  if (!(err instanceof BaseError)) return undefined;
  const rev = err.walk((item) => item instanceof ContractFunctionRevertedError);
  if (
    rev instanceof ContractFunctionRevertedError &&
    typeof rev.raw === "string"
  ) {
    return rev.raw;
  }
  return undefined;
}

function describe(err) {
  const raw = revertRaw(err);
  if (raw && raw !== "0x") {
    for (const abi of abis) {
      try {
        const decoded = decodeErrorResult({ abi, data: raw });
        const args = decoded.args ? [...decoded.args] : [];
        const text = args.length
          ? `${decoded.errorName}(${args.map(formatArg).join(", ")})`
          : decoded.errorName;
        return { decoded: true, name: decoded.errorName, text: redact(text) };
      } catch {
        // try the next ABI
      }
    }
  }
  if (err instanceof BaseError) {
    const rev = err.walk(
      (item) => item instanceof ContractFunctionRevertedError,
    );
    if (rev instanceof ContractFunctionRevertedError && rev.data?.errorName) {
      const args = rev.data.args ? [...rev.data.args] : [];
      const text = args.length
        ? `${rev.data.errorName}(${args.map(formatArg).join(", ")})`
        : rev.data.errorName;
      return { decoded: true, name: rev.data.errorName, text: redact(text) };
    }
  }
  const message = err instanceof BaseError ? err.shortMessage : errMessage(err);
  return { decoded: false, name: redact(message), text: redact(message) };
}

function formatExpiry(expiry) {
  if (expiry === MAX_EXPIRY) return "max";
  return new Date(Number(expiry) * 1000).toISOString();
}

function parseWeb(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    usage("--web must be an https origin");
  }
  const pathOk = url.pathname === "/" || url.pathname === "";
  if (
    url.protocol !== "https:" ||
    !pathOk ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    usage("--web must be an https origin");
  }
  return url.origin;
}

async function loadAbi(address) {
  try {
    const res = await fetch(
      `https://sourcify.dev/server/v2/contract/11155111/${address}?fields=abi`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return;
    const body = await res.json();
    if (Array.isArray(body.abi)) abis.push(body.abi);
  } catch {
    // Decode errors without Sourcify when it is unreachable.
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        rpc: { type: "string" },
        label: { type: "string" },
        house: { type: "string" },
        web: { type: "string" },
        bootstrap: { type: "boolean", default: false },
        "verify-only": { type: "boolean", default: false },
        "confirm-sepolia": { type: "boolean", default: false },
      },
    });
  } catch (err) {
    usage(errMessage(err));
  }

  const flags = parsed.values;
  if (!flags.rpc) usage("--rpc is required");
  const bootstrap = flags.bootstrap === true;
  const verifyOnly = flags["verify-only"] === true;
  if (!bootstrap) {
    if (!flags.label) usage("--label is required");
    if (!flags.house) usage("--house is required");
    if (!LABEL_RE.test(flags.label)) {
      usage(
        "--label must match /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/",
      );
    }
  }

  /** @type {`0x${string}` | undefined} */
  let house;
  if (flags.house !== undefined) {
    try {
      house = getAddress(flags.house);
    } catch {
      usage("--house must be an address");
    }
  }
  const web = flags.web !== undefined ? parseWeb(flags.web) : DEFAULT_WEB;

  const transport = http(flags.rpc);
  const publicClient = createPublicClient({ chain: sepolia, transport });

  let chainId;
  try {
    chainId = await publicClient.getChainId();
  } catch (err) {
    usage(`RPC unreachable (${describe(err).text})`);
  }
  if (chainId !== ENS_SEPOLIA.chainId) {
    refuse(`refusing: eth_chainId ${chainId} is not Sepolia (11155111)`);
  }

  let version;
  try {
    version = await publicClient.request({ method: "web3_clientVersion" });
  } catch (err) {
    usage(`RPC unreachable (${describe(err).text})`);
  }
  const anvil = String(version).startsWith("anvil");
  if (!anvil && !verifyOnly && flags["confirm-sepolia"] !== true) {
    refuse(
      "refusing to send transactions to real Sepolia without --confirm-sepolia",
    );
  }

  const rawKey = process.env.HMAIL_REGISTRY_KEY;
  if (typeof rawKey !== "string" || rawKey.length === 0) {
    usage("HMAIL_REGISTRY_KEY is not set");
  }
  let registry;
  try {
    const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
    registry = privateKeyToAccount(/** @type {`0x${string}`} */ (key));
  } catch {
    usage("HMAIL_REGISTRY_KEY is missing or invalid");
  }

  const registryCode = await publicClient.getCode({
    address: registry.address,
  });
  if (registryCode && registryCode !== "0x") {
    refuse(
      `refusing: ${registry.address} has contract code (ERC1155 receiver problem)`,
    );
  }
  if (house) {
    const houseCode = await publicClient.getCode({ address: house });
    if (houseCode && houseCode !== "0x") {
      refuse(`refusing: ${house} has contract code (ERC1155 receiver problem)`);
    }
  }

  await Promise.all([
    loadAbi(ENS_SEPOLIA.ETHRegistry),
    loadAbi(ENS_SEPOLIA.ETHRegistrar),
    loadAbi(ENS_SEPOLIA.PermissionedResolverImpl),
    loadAbi(ENS_SEPOLIA.UserRegistryImpl),
    loadAbi(ENS_SEPOLIA.VerifiableFactory),
    loadAbi(ENS_SEPOLIA.MockUSDC),
  ]);

  const wallet = createWalletClient({
    account: registry,
    chain: sepolia,
    transport,
  });
  const ethRegistry = getAddress(ENS_SEPOLIA.ETHRegistry);
  const registrar = getAddress(ENS_SEPOLIA.ETHRegistrar);
  const factory = getAddress(ENS_SEPOLIA.VerifiableFactory);
  const registryImpl = getAddress(ENS_SEPOLIA.UserRegistryImpl);
  const usdc = getAddress(ENS_SEPOLIA.MockUSDC);

  async function read(address, abi, functionName, args) {
    return publicClient.readContract({ address, abi, functionName, args });
  }

  async function transact(call) {
    const sim = await publicClient.simulateContract({
      account: registry,
      ...call,
    });
    const hash = await wallet.writeContract(sim.request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`transaction status ${receipt.status}`);
    }
    return sim.result;
  }

  async function bootstrapParent() {
    let userRegistry;
    const existingSub = await read(ethRegistry, REGISTRY_ABI, "getSubregistry", [
      PARENT,
    ]);
    if (!isZero(existingSub)) {
      userRegistry = getAddress(existingSub);
      const ours = await read(userRegistry, REGISTRY_ABI, "hasRootRoles", [
        ROLES.REGISTRAR,
        registry.address,
      ]);
      if (!ours) fail("userregistry", "not ours");
      skip("userregistry", userRegistry);
    } else {
      const init = encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: "initialize",
        args: [
          [
            {
              account: registry.address,
              roleBitmap: ROLES.REGISTRAR | ROLES.REGISTRAR_ADMIN,
            },
          ],
        ],
      });
      const salt = BigInt(keccak256(toHex("hmail-userregistry-v1")));
      const deployed = await transact({
        address: factory,
        abi: FACTORY_ABI,
        functionName: "deployProxy",
        args: [registryImpl, salt, init],
      }).catch((err) => fail("userregistry", describe(err).text));
      userRegistry = getAddress(deployed);
      ok("userregistry", userRegistry);
    }

    const available = await read(registrar, REGISTRAR_ABI, "isAvailable", [
      PARENT,
    ]);
    if (!available) {
      const owner = await read(ethRegistry, REGISTRY_ABI, "findOwner", [PARENT]);
      const sub = await read(ethRegistry, REGISTRY_ABI, "getSubregistry", [
        PARENT,
      ]);
      if (!same(owner, registry.address) || !same(sub, userRegistry)) {
        fail("hmail.eth", "owned by someone else");
      }
      skip("hmail.eth", `owner ${getAddress(owner)}`);
    } else {
      const price = await read(registrar, REGISTRAR_ABI, "getRegisterPrice", [
        PARENT,
        DURATION,
        usdc,
      ]);
      const cost = price[0] + price[1];
      await transact({
        address: usdc,
        abi: ERC20_ABI,
        functionName: "mint",
        args: [registry.address, 100n * 10n ** 6n],
      }).catch((err) => fail("hmail.eth", describe(err).text));
      await transact({
        address: usdc,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [registrar, cost],
      }).catch((err) => fail("hmail.eth", describe(err).text));

      const secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const commitment = await read(registrar, REGISTRAR_ABI, "makeCommitment", [
        PARENT,
        registry.address,
        secret,
        userRegistry,
        zeroAddress,
        DURATION,
        zeroHash,
      ]);
      await transact({
        address: registrar,
        abi: REGISTRAR_ABI,
        functionName: "commit",
        args: [commitment],
      }).catch((err) => fail("hmail.eth", describe(err).text));

      const minAge = await read(registrar, REGISTRAR_ABI, "MIN_COMMITMENT_AGE", []);
      if (anvil) {
        await publicClient.request({
          method: "evm_increaseTime",
          params: [numberToHex(Number(minAge) + 1)],
        });
        await publicClient.request({ method: "evm_mine" });
      } else {
        const seconds = Number(minAge) + 15;
        process.stdout.write(`wait  commit  ${seconds} s\n`);
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      }

      const tokenId = await transact({
        address: registrar,
        abi: REGISTRAR_ABI,
        functionName: "register",
        args: [
          PARENT,
          registry.address,
          secret,
          userRegistry,
          zeroAddress,
          DURATION,
          usdc,
          zeroHash,
        ],
      }).catch((err) => fail("hmail.eth", describe(err).text));
      const sub = await read(ethRegistry, REGISTRY_ABI, "getSubregistry", [
        PARENT,
      ]);
      if (!same(sub, userRegistry)) {
        fail("hmail.eth", `subregistry ${sub} != ${userRegistry}`);
      }
      ok("hmail.eth", `tokenId=${tokenId} subregistry=${userRegistry}`);
    }
  }

  async function discover() {
    const sub = await read(ethRegistry, REGISTRY_ABI, "getSubregistry", [PARENT]);
    /** @type {`0x${string}` | null} */
    const userRegistry = isZero(sub) ? null : getAddress(sub);
    /** @type {`0x${string}` | null} */
    let resolver = null;
    if (userRegistry) {
      const current = await read(userRegistry, REGISTRY_ABI, "getResolver", [
        flags.label,
      ]);
      if (!isZero(current)) resolver = getAddress(current);
    }
    return { userRegistry, resolver };
  }

  async function missingSetters(resolverAddress) {
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
      if (!has || !only) {
        problems.push(`${key} hasRoles=${has} isOnlyAssignee=${only}`);
      }
    }
    return problems;
  }

  async function verify(userRegistry, resolverAddress) {
    let failed = 0;
    const check = (name, pass, detail) => {
      process.stdout.write(
        `check ${name} ${pass ? "pass" : "FAIL"} ${redact(detail)}\n`,
      );
      if (!pass) failed += 1;
    };
    const fullName = `${flags.label}.${PARENT}.eth`;

    if (!userRegistry || !house) {
      check("owner", false, "no user registry");
      check("expiry", false, "no user registry");
      check("parent-token-roles", false, "no user registry");
      check("parent-root-roles", false, "no user registry");
      check("house-setters", false, "no resolver");
      check("house-no-root", false, "no resolver");
      check("house-other-key", false, "no resolver");
      check("resolver-registry-roles", false, "no resolver");
      check("resolve", false, "no user registry");
      process.exitCode = 1;
      return;
    }

    const owner = await read(userRegistry, REGISTRY_ABI, "findOwner", [
      flags.label,
    ]);
    check("owner", same(owner, house), getAddress(owner));

    const tokenId = await read(userRegistry, REGISTRY_ABI, "findTokenId", [
      flags.label,
    ]);
    const expiry = await read(userRegistry, REGISTRY_ABI, "getExpiry", [tokenId]);
    let expiryDetail = formatExpiry(expiry);
    let expiryOk = expiry === MAX_EXPIRY;
    if (!expiryOk) {
      const parentId = await read(ethRegistry, REGISTRY_ABI, "findTokenId", [
        PARENT,
      ]);
      const parentExpiry = await read(ethRegistry, REGISTRY_ABI, "getExpiry", [
        parentId,
      ]);
      expiryOk = expiry > 0n && expiry === parentExpiry;
      if (expiryOk) expiryDetail = `${expiryDetail} (parent expiry)`;
    }
    check("expiry", expiryOk, expiryDetail);

    const tokenRoles = await read(userRegistry, REGISTRY_ABI, "roles", [
      tokenId,
      registry.address,
    ]);
    check(
      "parent-token-roles",
      tokenRoles === 0n,
      tokenRoles === 0n ? "0" : tokenRoles.toString(),
    );

    const rootResource = await read(userRegistry, REGISTRY_ABI, "ROOT_RESOURCE", []);
    const rootRoles = await read(userRegistry, REGISTRY_ABI, "roles", [
      rootResource,
      registry.address,
    ]);
    const expectedRoot = ROLES.REGISTRAR | ROLES.REGISTRAR_ADMIN;
    check(
      "parent-root-roles",
      rootRoles === expectedRoot,
      rootRoles === expectedRoot
        ? "ROLE_REGISTRAR|ROLE_REGISTRAR_ADMIN"
        : rootRoles.toString(),
    );

    if (!resolverAddress) {
      check("house-setters", false, "no resolver");
      check("house-no-root", false, "no resolver");
      check("house-other-key", false, "no resolver");
      check("resolver-registry-roles", false, "no resolver");
    } else {
      const problems = await missingSetters(resolverAddress);
      check(
        "house-setters",
        problems.length === 0,
        problems.length === 0 ? TEXT_KEYS.join(",") : problems.join("; "),
      );

      const resolverRoot = await read(
        resolverAddress,
        RESOLVER_ABI,
        "ROOT_RESOURCE",
        [],
      );
      const houseHasText = await read(
        resolverAddress,
        RESOLVER_ABI,
        "hasRootRoles",
        [ROLES.SET_TEXT, house],
      );
      const houseRoot = await read(resolverAddress, RESOLVER_ABI, "roles", [
        resolverRoot,
        house,
      ]);
      check(
        "house-no-root",
        houseHasText === false && houseRoot === 0n,
        houseHasText === false && houseRoot === 0n
          ? "0"
          : `hasRootRoles(SET_TEXT)=${houseHasText} root=${houseRoot}`,
      );

      try {
        await publicClient.call({
          account: house,
          to: resolverAddress,
          data: encodeFunctionData({
            abi: RESOLVER_ABI,
            functionName: "setText",
            args: [dnsEncode(fullName), "avatar", "x"],
          }),
        });
        check("house-other-key", false, "house key could write avatar");
      } catch (err) {
        const info = describe(err);
        const reverted = info.decoded || /reverted|revert/i.test(info.text);
        check(
          "house-other-key",
          reverted,
          reverted ? `(reverted ${info.text})` : info.text,
        );
      }

      const registryRoot = await read(resolverAddress, RESOLVER_ABI, "roles", [
        resolverRoot,
        registry.address,
      ]);
      if (registryRoot === 0n) {
        check("resolver-registry-roles", true, "0 renounced");
      } else {
        check(
          "resolver-registry-roles",
          false,
          `${registryRoot} (not renounced yet)`,
        );
      }
    }

    let record;
    try {
      record = await getEnsText(publicClient, {
        name: normalize(fullName),
        key: MCP_KEY,
      });
    } catch (err) {
      check("resolve", false, describe(err).text);
      record = undefined;
    }
    if (record !== undefined) {
      if (record === null || record === "") {
        check("resolve", true, "no record");
      } else {
        try {
          const resolved = await resolveEndpoint(fullName, flags.rpc);
          check(
            "resolve",
            resolved === record,
            resolved === record
              ? resolved
              : `resolved ${resolved} record ${record}`,
          );
        } catch (err) {
          check("resolve", false, describe(err).text);
        }
      }
    }

    if (failed > 0) process.exitCode = 1;
  }

  if (bootstrap) {
    await bootstrapParent();
    return;
  }
  if (!house || !flags.label) usage("--label and --house are required");
  if (verifyOnly) {
    const found = await discover();
    await verify(found.userRegistry, found.resolver);
    return;
  }

  const issued = await issueSubname({
    rpc: flags.rpc,
    key: rawKey,
    label: flags.label,
    house,
    web,
  });
  process.stdout.write(`name: ${issued.name}\n`);
  process.stdout.write(`resolver: ${issued.resolver}\n`);
  for (const step of issued.steps) process.stdout.write(`step: ${step}\n`);
}

main().catch((err) => {
  const text = describe(err).text;
  process.stdout.write(`FAIL uncaught ${text}\n`);
  process.exit(1);
});
