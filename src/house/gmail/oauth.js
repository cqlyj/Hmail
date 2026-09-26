import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { UsageError, parseCommandArgs } from "../../shared/cli.js";
import { errMessage, safeEqual } from "../../shared/util.js";
import { resolveStateDir, resolveWebOrigin } from "../config.js";
import { ensureStateDir } from "../state.js";
import { openVault } from "../vault.js";
import { resolveGoogleClient } from "./client-config.js";
import { saveGmailToken } from "./token-store.js";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const WAIT_MS = 5 * 60 * 1000;

/**
 * @param {string} got
 * @param {string} expected
 */
function sameState(got, expected) {
  return safeEqual(expected, got);
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
function parseConnectArgs(argv, env) {
  const parsed = parseCommandArgs(argv, {
    "state-dir": { type: "string" },
    email: { type: "string" },
  });
  return {
    stateDir: resolveStateDir(parsed.values["state-dir"], env),
    email: parsed.values.email,
  };
}

/**
 * @param {Response} res
 */
async function drain(res) {
  await res.body?.cancel().catch(() => {});
}

/**
 * @param {{ clientId: string, loginHint?: string, state: string, verifier: string, allowPaste?: boolean }} input
 * @returns {{ url: Promise<string>, code: Promise<{ code: string, redirectUri: string }> }}
 */
function collectCode(input) {
  const challenge = createHash("sha256")
    .update(input.verifier)
    .digest("base64url");
  /** @type {(url: string) => void} */
  let resolveUrl = () => {};
  /** @type {(err: Error) => void} */
  let rejectUrl = () => {};
  const url = new Promise((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  const code = new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    let urlSettled = false;

    const server = createServer((req, res) => {
      const port = listenPort();
      let url;
      try {
        url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("bad request");
        return;
      }
      const params = url.searchParams;
      if (!params.has("code") && !params.has("error") && !params.has("state")) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      accept(params, res);
    });

    const rl =
      input.allowPaste === true && process.stdin.isTTY
        ? createInterface({ input: process.stdin })
        : null;

    function listenPort() {
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : 0;
    }

    /**
     * @param {Error | null} err
     * @param {{ code: string, redirectUri: string }} [value]
     */
    function finish(err, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (rl) rl.close();
      server.close(() => {
        if (err) {
          if (!urlSettled) rejectUrl(err);
          reject(err);
        } else resolve(value ?? { code: "", redirectUri: "" });
      });
    }

    /**
     * @param {URLSearchParams} params
     * @param {import("node:http").ServerResponse | null} res
     */
    function accept(params, res) {
      const redirectUri = `http://127.0.0.1:${listenPort()}`;
      if (!sameState(params.get("state") ?? "", input.state)) {
        if (res) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("wrong state");
        } else {
          process.stdout.write(
            "that address is from a different sign-in attempt; paste the latest one\n",
          );
        }
        return;
      }
      const oauthError = params.get("error");
      if (oauthError) {
        if (res) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("error");
        }
        finish(new Error(`Google returned ${oauthError}`));
        return;
      }
      const code = params.get("code");
      if (!code) {
        if (res) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("missing code");
        }
        finish(new Error("Google did not return a code"));
        return;
      }
      const done = () => finish(null, { code, redirectUri });
      if (!res) {
        done();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<p>Hmail: Gmail connected. You can close this tab.</p>", done);
    }

    rl?.on("line", (line) => {
      const trimmed = line.trim();
      const port = listenPort();
      let url;
      try {
        url = new URL(trimmed);
      } catch {
        return;
      }
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.port !== String(port)
      )
        return;
      if (!trimmed.startsWith(`http://127.0.0.1:${port}`)) return;
      accept(url.searchParams, null);
    });

    server.once("error", (err) => finish(new Error(errMessage(err))));
    server.listen(0, "127.0.0.1", () => {
      const port = listenPort();
      const redirectUri = `http://127.0.0.1:${port}`;
      const params = new URLSearchParams({
        client_id: input.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: input.state,
        prompt: "consent",
      });
      if (input.loginHint) params.set("login_hint", input.loginHint);
      urlSettled = true;
      resolveUrl(`${AUTH_URL}?${params.toString()}`);
      timer = setTimeout(
        () => finish(new Error("timed out waiting for Google")),
        WAIT_MS,
      );
    });
  });
  code.catch(() => {});
  return { url, code };
}

/**
 * @param {{ stateDir: string, vault: { seal(purpose: string, value: unknown): string }, clientId: string, clientSecret?: string | null, loginHint?: string, allowPaste?: boolean }} input
 * @returns {Promise<{ url: string, done: Promise<{ email: string }> }>}
 */
export async function startGmailConsent(input) {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const collected = collectCode({
    clientId: input.clientId,
    loginHint: input.loginHint,
    state,
    verifier,
    allowPaste: input.allowPaste === true,
  });
  const url = await collected.url;
  const done = collected.code.then(async (got) => {
    const token = await exchangeCode({
      clientId: input.clientId,
      clientSecret: input.clientSecret || undefined,
      code: got.code,
      verifier,
      redirectUri: got.redirectUri,
    });
    await saveGmailToken(input.stateDir, input.vault, token);
    return { email: token.email };
  });
  return { url, done };
}

/**
 * @param {{ clientId: string, clientSecret?: string, code: string, verifier: string, redirectUri: string }} input
 */
async function exchangeCode(input) {
  const body = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.verifier,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    await drain(res);
    throw new Error(`Google token endpoint returned ${res.status}`);
  }
  const json = await res.json();
  const scope = typeof json.scope === "string" ? json.scope : "";
  if (
    typeof json.refresh_token !== "string" ||
    !scope.includes("gmail.readonly")
  ) {
    throw new Error(
      "Google did not return a refresh token with gmail.readonly",
    );
  }
  if (typeof json.access_token !== "string") {
    throw new Error("Google did not return an access token");
  }
  const profileRes = await fetch(PROFILE_URL, {
    headers: { authorization: `Bearer ${json.access_token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!profileRes.ok) {
    await drain(profileRes);
    throw new Error(`Gmail API ${profileRes.status}`);
  }
  const profile = await profileRes.json();
  if (
    typeof profile.emailAddress !== "string" ||
    profile.emailAddress.length === 0
  ) {
    throw new Error("Gmail profile has no email address");
  }
  return {
    client_id: input.clientId,
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    refresh_token: json.refresh_token,
    email: profile.emailAddress,
    scope,
    obtained_at: new Date().toISOString(),
  };
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @returns {Promise<number>} */
export async function runGmailConnect(argv, env) {
  const { stateDir, email } = parseConnectArgs(argv, env);
  const { clientId, clientSecret } = await resolveGoogleClient(
    env,
    resolveWebOrigin(undefined, env),
  );

  try {
    await ensureStateDir(stateDir);
    const vault = await openVault(stateDir);
    const started = await startGmailConsent({
      stateDir,
      vault,
      clientId,
      clientSecret,
      loginHint: email,
      allowPaste: true,
    });
    const pasteHint = process.stdin.isTTY
      ? " If the browser ends on a page that cannot be reached, copy its full address and paste it here, then press Enter:"
      : "";
    process.stdout.write(
      `open this URL in a browser signed in to the Gmail account to connect:\n  ${started.url}\nwaiting up to 5 minutes.${pasteHint}\n`,
    );
    const result = await started.done;
    process.stdout.write(`gmail connected: ${result.email}\n`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    process.stderr.write(`error: ${errMessage(err)}\n`);
    return 1;
  }
}
