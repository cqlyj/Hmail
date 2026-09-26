/** Refresh failed with invalid_grant / 400 / 401: token expired or revoked. */
export class GmailAuthError extends Error {}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * @param {Response} res
 */
async function drain(res) {
  await res.body?.cancel().catch(() => {});
}

/**
 * @param {import("./token-store.js").GmailToken} token
 * @returns {{ email: string, listIds(q: string, max: number): Promise<string[]>, getRaw(id: string): Promise<{ id: string, internalDate: number, raw: Buffer }> }}
 */
export function createGmailClient(token) {
  /** @type {{ access: string, expiresAt: number } | null} */
  let cached = null;

  async function refreshAccess() {
    const body = new URLSearchParams({
      client_id: token.client_id,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    });
    if (token.client_secret) body.set("client_secret", token.client_secret);
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 400 || res.status === 401) {
      await drain(res);
      throw new GmailAuthError(
        "Gmail needs reconnecting: the owner must reconnect it on their Hmail house page",
      );
    }
    if (!res.ok) {
      await drain(res);
      throw new Error(`Gmail API ${res.status}`);
    }
    const json = await res.json();
    if (json.error === "invalid_grant") {
      throw new GmailAuthError(
        "Gmail needs reconnecting: the owner must reconnect it on their Hmail house page",
      );
    }
    if (
      typeof json.access_token !== "string" ||
      json.access_token.length === 0
    ) {
      throw new Error(`Gmail API ${res.status}`);
    }
    const expiresIn = Number(json.expires_in);
    const seconds = Number.isFinite(expiresIn) ? expiresIn : 3600;
    cached = {
      access: json.access_token,
      expiresAt: Date.now() + Math.max(0, seconds - 60) * 1000,
    };
    return cached.access;
  }

  async function accessToken() {
    if (cached && Date.now() < cached.expiresAt) return cached.access;
    return refreshAccess();
  }

  /**
   * @param {string | URL} url
   */
  async function gmailGet(url) {
    let retried = false;
    for (;;) {
      const access = await accessToken();
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 401 && !retried) {
        await drain(res);
        cached = null;
        retried = true;
        await refreshAccess();
        continue;
      }
      if (!res.ok) {
        await drain(res);
        throw new Error(`Gmail API ${res.status}`);
      }
      return res.json();
    }
  }

  return {
    email: token.email,
    async listIds(q, max) {
      const url = new URL(`${GMAIL_BASE}/messages`);
      url.searchParams.set("q", q);
      url.searchParams.set("maxResults", String(max));
      const json = await gmailGet(url);
      const messages = Array.isArray(json.messages) ? json.messages : [];
      return messages
        .map((/** @type {{ id?: string }} */ message) => message.id)
        .filter(
          (/** @type {string | undefined} */ id) => typeof id === "string",
        );
    },
    async getRaw(id) {
      const url = `${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=raw`;
      const json = await gmailGet(url);
      return {
        id: typeof json.id === "string" ? json.id : id,
        internalDate: Number(json.internalDate),
        raw: Buffer.from(json.raw, "base64url"),
      };
    },
  };
}
