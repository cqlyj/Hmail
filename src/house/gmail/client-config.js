const GOOGLE_CLIENT_ID =
  "399441327945-npv5vju5ks0cpf5majbfeh97op5igs5i.apps.googleusercontent.com";

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ clientId: string, clientSecret: string | null }}
 */
function googleClient(env) {
  return {
    clientId: env.GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET || null,
  };
}

/**
 * Env values first. Otherwise the desktop client's id and secret come from the
 * hosted web project (Google treats a desktop client secret as not confidential,
 * but it stays out of the repo). The house still does the token exchange itself.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} webOrigin
 * @returns {Promise<{ clientId: string, clientSecret: string | null }>}
 */
export async function resolveGoogleClient(env, webOrigin) {
  const local = googleClient(env);
  if (local.clientSecret) return local;
  try {
    const res = await fetch(`${webOrigin}/api/google-client`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) return local;
    /** @type {{ client_id?: unknown, client_secret?: unknown }} */
    const body = await res.json();
    if (
      typeof body.client_id === "string" &&
      body.client_id.endsWith(".apps.googleusercontent.com") &&
      typeof body.client_secret === "string" &&
      body.client_secret.length > 0
    ) {
      return { clientId: body.client_id, clientSecret: body.client_secret };
    }
  } catch {
    // fall back to the id alone; Google will reject the exchange and the page shows it
  }
  return local;
}
