import { homedir } from "node:os";
import { parseCommandArgs, UsageError } from "../shared/cli.js";
import { isEnsName, resolveEnsRpc } from "../shared/ens.js";

/**
 * @typedef {object} HouseConfig
 * @property {string|undefined} home      --home; undefined = let HORS use HORS_HOME or ~/.hors
 * @property {string} profile             --profile; default "hmail-house" (the house's own wallet)
 * @property {`0x${string}`|undefined} owner --owner, only with --mock; unset means the gate chooses
 * @property {number} port                --port, else env HMAIL_PORT, else 8390
 * @property {boolean} tunnel             false when --no-tunnel
 * @property {boolean} mock               true when --mock; real identity is the default
 * @property {string} stateDir            --state-dir, else HMAIL_STATE_DIR, else ~/.hmail
 * @property {string} webOrigin           --web-origin, else env HMAIL_WEB_ORIGIN, else the hosted project
 * @property {"production"|"sandbox"} worldEnv --world-env, else env HMAIL_WORLD_ENV, else "production"
 * @property {string|null} ensName       --ens-name, else env HMAIL_ENS_NAME, else null
 * @property {string} ensRpc             env HMAIL_ENS_RPC, else the default Sepolia RPC
 * @property {number} syncIntervalMs     env HMAIL_SYNC_INTERVAL_MS, else 15000
 */

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} key
 * @returns {string | undefined}
 */
function envString(env, key) {
  const value = env[key];
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

/** --state-dir, else env HMAIL_STATE_DIR, else `${os.homedir()}/.hmail` */
export function resolveStateDir(flagValue, env) {
  if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;
  const fromEnv = envString(env, "HMAIL_STATE_DIR");
  if (fromEnv !== undefined) return fromEnv;
  return `${homedir()}/.hmail`;
}

const OWNER_RE = /^0x[0-9a-fA-F]{64}$/;

const WEB_ORIGIN_ERROR =
  "--web-origin must be https://<host> (or http://127.0.0.1:<port> for local testing)";

const WORLD_ENV_ERROR = "--world-env must be production or sandbox";

/**
 * @param {string} raw
 * @returns {string}
 */
function parseWebOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(WEB_ORIGIN_ERROR);
  }
  const local =
    url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "";
  const pathOk = url.pathname === "/" || url.pathname === "";
  if (
    !(url.protocol === "https:" || local) ||
    !pathOk ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new UsageError(WEB_ORIGIN_ERROR);
  }
  return url.origin;
}

const DEFAULT_WEB_ORIGIN = "https://hmail-web.vercel.app";

/**
 * --web-origin, else env HMAIL_WEB_ORIGIN, else the hosted project.
 * Stored without a trailing slash.
 * @param {string|undefined} flagValue
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveWebOrigin(flagValue, env) {
  if (flagValue !== undefined) return parseWebOrigin(flagValue);
  const fromEnv = envString(env, "HMAIL_WEB_ORIGIN");
  if (fromEnv !== undefined) return parseWebOrigin(fromEnv);
  return DEFAULT_WEB_ORIGIN;
}

/**
 * --world-env, else env HMAIL_WORLD_ENV, else "production".
 * @param {string|undefined} flagValue
 * @param {NodeJS.ProcessEnv} env
 * @returns {"production"|"sandbox"}
 */
export function resolveWorldEnv(flagValue, env) {
  const raw =
    flagValue !== undefined ? flagValue : envString(env, "HMAIL_WORLD_ENV");
  if (raw === undefined) return "production";
  if (raw === "production" || raw === "sandbox") return raw;
  throw new UsageError(WORLD_ENV_ERROR);
}

const ENS_NAME_ERROR = "--ens-name must be an ENS name like lyj.hmail.eth";

/**
 * --ens-name, else env HMAIL_ENS_NAME, else null.
 * @param {string|undefined} flagValue
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
 */
export function resolveEnsName(flagValue, env) {
  const raw =
    flagValue !== undefined ? flagValue : envString(env, "HMAIL_ENS_NAME");
  if (raw === undefined) return null;
  if (!isEnsName(raw)) throw new UsageError(ENS_NAME_ERROR);
  return raw;
}

/**
 * @param {string} raw
 * @returns {number}
 */
function parsePort(raw) {
  if (!/^[0-9]+$/.test(raw)) {
    throw new UsageError("--port must be an integer between 1 and 65535");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError("--port must be an integer between 1 and 65535");
  }
  return port;
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
function parseSyncInterval(env) {
  const raw = envString(env, "HMAIL_SYNC_INTERVAL_MS");
  if (raw === undefined) return 15_000;
  if (!/^[0-9]+$/.test(raw)) return 15_000;
  const interval = Number(raw);
  if (!Number.isSafeInteger(interval) || interval <= 0) return 15_000;
  return interval;
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @returns {HouseConfig} */
export function readHouseConfig(argv, env) {
  const parsed = parseCommandArgs(argv, {
    home: { type: "string" },
    profile: { type: "string", default: "hmail-house" },
    owner: { type: "string" },
    port: { type: "string" },
    "no-tunnel": { type: "boolean", default: false },
    "state-dir": { type: "string" },
    mock: { type: "boolean", default: false },
    "web-origin": { type: "string" },
    "world-env": { type: "string" },
    "ens-name": { type: "string" },
  });

  const { values } = parsed;
  const mock = values.mock === true;
  const ownerArg = values.owner;
  if (ownerArg !== undefined && !mock) {
    throw new UsageError(
      "--owner is only for --mock; real houses get their owner by pairing",
    );
  }
  /** @type {`0x${string}` | undefined} */
  let owner;
  if (typeof ownerArg === "string") {
    if (!OWNER_RE.test(ownerArg)) {
      throw new UsageError("--owner must be a 0x-prefixed 32-byte hex humanId");
    }
    owner = /** @type {`0x${string}`} */ (ownerArg);
  }

  const portRaw =
    (typeof values.port === "string" ? values.port : undefined) ??
    envString(env, "HMAIL_PORT") ??
    "8390";
  const port = parsePort(portRaw);

  if (envString(env, "HORS_PRIVATE_KEY") !== undefined) {
    throw new UsageError(
      "unset HORS_PRIVATE_KEY; the house uses its own profile wallet",
    );
  }

  const profile = /** @type {string} */ (values.profile);

  return {
    home: typeof values.home === "string" ? values.home : undefined,
    profile,
    owner,
    port,
    tunnel: values["no-tunnel"] !== true,
    mock,
    stateDir: resolveStateDir(
      typeof values["state-dir"] === "string" ? values["state-dir"] : undefined,
      env,
    ),
    webOrigin: resolveWebOrigin(
      typeof values["web-origin"] === "string" ? values["web-origin"] : undefined,
      env,
    ),
    worldEnv: resolveWorldEnv(
      typeof values["world-env"] === "string" ? values["world-env"] : undefined,
      env,
    ),
    ensName: resolveEnsName(
      typeof values["ens-name"] === "string" ? values["ens-name"] : undefined,
      env,
    ),
    ensRpc: resolveEnsRpc(env),
    syncIntervalMs: parseSyncInterval(env),
  };
}
