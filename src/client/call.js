import { createSigner } from "hors-sdk/client";
import { isEnsName, resolveEndpoint, resolveEnsRpc } from "../shared/ens.js";

/** @type {Map<string, string>} */
const endpoints = new Map();

/** @type {Map<string, Promise<Awaited<ReturnType<typeof createSigner>>>>} */
const signers = new Map();

/**
 * Resolve an ENS name once per process. An http(s) URL is returned unchanged.
 * @param {string} service
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>}
 */
export async function resolveService(service, env = process.env) {
  if (!isEnsName(service)) return service;
  const rpc = resolveEnsRpc(env);
  const cacheKey = `${rpc}\n${service}`;
  const cached = endpoints.get(cacheKey);
  if (cached !== undefined) return cached;
  const url = await resolveEndpoint(service, rpc);
  endpoints.set(cacheKey, url);
  return url;
}

/**
 * @param {string | undefined} home
 * @param {string} profile
 */
function signerFor(home, profile) {
  const key = `${home ?? ""}\n${profile}`;
  let pending = signers.get(key);
  if (pending === undefined) {
    pending = (async () => {
      if (home) process.env.HORS_HOME = home;
      return createSigner({ profile });
    })().catch((err) => {
      signers.delete(key);
      throw err;
    });
    signers.set(key, pending);
  }
  return pending;
}

/** @returns {Promise<import("hors-sdk/client").CallOutcome>} */
export async function callHouse({
  service,
  fn,
  args,
  profile,
  home,
  meta,
  env = process.env,
}) {
  if (isEnsName(service)) {
    service = await resolveService(service, env);
  }
  const signer = await signerFor(home, profile);
  if (meta !== undefined) return signer.call(service, fn, args, { meta });
  return signer.call(service, fn, args);
}
