import { UsageError } from "../../shared/cli.js";

export const WORLD_APP_ID = "app_7ead58bb9a3e0946c17d9c97647006f2";
export const WORLD_RP_ID = "rp_1d770f6bea9daa0f";
export const VERIFY_BASE = "https://developer.world.org/api/v4/verify/";

const SIGNER_URL_ERROR =
  "HMAIL_SIGNER_URL must be https://<host> (or http://127.0.0.1:<port> for local testing)";

/**
 * @param {string} raw
 * @returns {string}
 */
function parseSignerUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(SIGNER_URL_ERROR);
  }
  const local =
    url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "";
  if (
    !(url.protocol === "https:" || local) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new UsageError(SIGNER_URL_ERROR);
  }
  return raw;
}

/**
 * @param {{ webOrigin: string, worldEnv: "production"|"sandbox" }} cfg
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ appId: string, rpId: string, environment: "production"|"sandbox", webOrigin: string, signerUrl: string }}
 */
export function resolveWorld(cfg, env) {
  const signerUrl =
    typeof env.HMAIL_SIGNER_URL === "string" && env.HMAIL_SIGNER_URL.length > 0
      ? parseSignerUrl(env.HMAIL_SIGNER_URL)
      : `${cfg.webOrigin}/api/rp-context`;
  return {
    appId: WORLD_APP_ID,
    rpId: WORLD_RP_ID,
    environment: cfg.worldEnv,
    webOrigin: cfg.webOrigin,
    signerUrl,
  };
}
