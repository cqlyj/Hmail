import {
  concat,
  keccak256,
  parseAbi,
  stringToBytes,
  toBytes,
  toHex,
  zeroAddress,
} from "viem";

export const ENS_SEPOLIA = {
  chainId: 11155111,
  ETHRegistry: "0x657ea849311d3d5823348dded7c2aaafb3ede09e",
  ETHRegistrar: "0xabe76f6c8dfced81aa5a2bb8034202a7136b94ca",
  PermissionedResolverImpl: "0x14f09fd05d4585759e54844dc9b00147131cf243",
  UserRegistryImpl: "0xa80338aaa8d23831cea25e858d1774534abb0263",
  VerifiableFactory: "0x9e726eb570beb6bceb495ab8cda7df517d4e841c",
  MockUSDC: "0x16f95d91dba7da3aca778ec053df0ff6c6a8aa8e",
  UniversalResolver: "0xeeeeeeee14d718c2b47d9923deab1335e144eeee",
  UserRegistry: "0xbC1f7BA36e467EbB70aB4F59BadD1c181De8ED52",
};

export const PARENT = "hmail";
export const MAX_EXPIRY = 2n ** 64n - 1n;
export const MCP_KEY = "agent-endpoint[mcp]";
export const WEB_KEY = "agent-endpoint[web]";
export const TEXT_KEYS = [MCP_KEY, WEB_KEY];
export const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
export const DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
/** The issuer's public address (the project registry key). It renounces its roles on every house resolver. */
export const ISSUER = "0xa38d4fa8de96C0284a079B10d27A68c8C15C3dd6";
export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\.hmail\.eth$/;

export const ISSUE_ERRORS = new Set([
  "LABEL_TAKEN",
  "HOUSE_HAS_CODE",
  "CHAIN",
  "TX_FAILED",
  "NOT_OURS",
]);

const REGISTRAR = 1n << 0n;
const SET_RESOLVER = 1n << 24n;
const UNREGISTER = 1n << 12n;
const SET_SUBREGISTRY = 1n << 20n;
const SET_TEXT = 1n << 4n;
const UPGRADE = 1n << 124n;

export const ROLES = {
  REGISTRAR,
  REGISTRAR_ADMIN: REGISTRAR << 128n,
  SET_RESOLVER,
  SET_RESOLVER_ADMIN: SET_RESOLVER << 128n,
  UNREGISTER,
  UNREGISTER_ADMIN: UNREGISTER << 128n,
  SET_SUBREGISTRY,
  SET_SUBREGISTRY_ADMIN: SET_SUBREGISTRY << 128n,
  SET_TEXT,
  SET_TEXT_ADMIN: SET_TEXT << 128n,
  UPGRADE,
  UPGRADE_ADMIN: UPGRADE << 128n,
};

export const REGISTRY_ABI = parseAbi([
  "function getSubregistry(string label) view returns (address)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function findOwner(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function findTokenId(string label) view returns (uint256)",
  "function getExpiry(uint256 anyId) view returns (uint64)",
  "function roles(uint256 anyId, address account) view returns (uint256)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function initialize((address account, uint256 roleBitmap)[] grants)",
  "function ROOT_RESOURCE() view returns (uint256)",
]);

export const REGISTRAR_ABI = parseAbi([
  "function isAvailable(string label) view returns (bool)",
  "function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)",
  "function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function MIN_COMMITMENT_AGE() view returns (uint64)",
  "function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256 tokenId)",
]);

export const RESOLVER_ABI = parseAbi([
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
  "function setText(bytes name, string key, string value)",
  "function grantSetterRoles(bytes setter, address account) returns (bool)",
  "function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function roles(uint256 resource, address account) view returns (uint256)",
  "function isOnlyAssignee(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function ROOT_RESOURCE() view returns (uint256)",
]);

export const FACTORY_ABI = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)",
]);

export const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

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

/**
 * @param {string} a
 * @param {string} b
 */
export function same(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * @param {string} address
 */
export function isZero(address) {
  return same(address, zeroAddress);
}

/**
 * @param {string} key
 */
export function textResource(key) {
  return BigInt(keccak256(toBytes(key)));
}

/**
 * attempt 0 matches the historical salt. Later attempts append `:${attempt}`.
 * @param {string} label
 * @param {string} house
 * @param {number} attempt
 */
export function resolverSalt(label, house, attempt) {
  const base = `hmail-resolver-v1:${label}:${house.toLowerCase()}`;
  const text = attempt === 0 ? base : `${base}:${attempt}`;
  return BigInt(keccak256(toHex(text)));
}
