import { log } from "../shared/log.js";
import { errMessage, safeEqual, shortHex } from "../shared/util.js";
import { resolveGoogleClient } from "./gmail/client-config.js";
import { startGmailConsent } from "./gmail/oauth.js";
import { corsHeaders, json, readJsonBody } from "./http.js";
import { saveWorldSession } from "./world/session-store.js";
import { startWorldSetup } from "./world/setup.js";

/** same as web/lib/ens.js LABEL_RE */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const BODY_MAX = 2048;
/** Issuance steps in display order (the issuer's, plus the house's own record write). */
const STEP_ORDER = ["scan", "resolver", "fund", "register", "records", "grants", "renounce", "verify", "publish"];

/**
 * @param {{
 *   token: string,
 *   webOrigin: string,
 *   mode: "real" | "mock",
 *   houseAddress: `0x${string}`,
 *   publicMcp: string,
 *   stateDir: string,
 *   vault: { seal(purpose: string, value: unknown): string, open(purpose: string, sealed: string): unknown },
 *   env: NodeJS.ProcessEnv,
 *   state: import("./house-config.js").HouseConfigState,
 *   save: () => Promise<void>,
 *   world: { appId: string, rpId: string, environment: "production" | "sandbox", webOrigin: string, signerUrl: string },
 *   pairRequests: { pending(): { id: string, confirm: string, callerAddress: string, expiresAt: number }[] },
 *   approvePair: (id: string) => Promise<{ ok: true } | { ok: false, status: number, error: string }>,
 *   denyPair: (id: string) => boolean,
 *   activity: (limit: number) => object[],
 *   isOnline: () => boolean,
 *   agents: { list(): { address: string, lastSeen: string, calls: number, denied: boolean }[], revoke(address: string): Promise<void>, unrevoke(address: string): Promise<void> },
 *   isGmailConnected: () => boolean,
 *   isGmailExpired: () => boolean,
 *   gmailEmail: () => string | null,
 *   onGmailConnected: () => Promise<void>,
 *   isWorldReady: () => boolean,
 *   markWorldReady: () => void,
 *   onNamed: (name: string) => Promise<{ status?: string, tx?: string } | void>,
 * }} deps
 */
export function createSetupApi(deps) {
  let gmailPending = false;
  let worldPending = false;
  let worldStarting = false;
  /** @type {string | null} */
  let worldLink = null;
  /** @type {string | null} */
  let worldError = null;
  let nameIssuing = false;
  /** @type {string | null} */
  let nameError = null;
  /** @type {{ startedAt: string, steps: Map<string, { status: "sent" | "done" | "failed", txs: string[] }> } | null} */
  let nameProgress = null;

  /**
   * @param {Request} request
   */
  function headersFor(request) {
    return corsHeaders(request, deps.webOrigin, "GET, POST");
  }

  /**
   * @param {string} presented
   */
  function tokenOk(presented) {
    return safeEqual(deps.token, presented);
  }

  function stateBody() {
    const expired = deps.isGmailExpired();
    return {
      house: deps.houseAddress,
      mode: deps.mode,
      online: deps.isOnline(),
      gmail: {
        connected: deps.isGmailConnected() && !expired,
        expired,
        email: deps.gmailEmail(),
        pending: gmailPending,
      },
      name: {
        ensName: deps.state.ensName,
        pendingLabel: deps.state.pendingLabel,
        issuing: nameIssuing,
        error: nameError,
        progress: progressBody(),
      },
      world: {
        session: deps.isWorldReady(),
        pending: worldPending,
        link: worldPending ? worldLink : null,
        error: worldError,
      },
      owner: {
        paired: deps.state.owner !== null,
        humanIdShort:
          deps.state.owner === null ? null : shortHex(deps.state.owner),
      },
      pairRequests: deps.pairRequests.pending().map((request) => ({
        id: request.id,
        confirm: request.confirm,
        address: request.callerAddress,
        expiresAt: new Date(request.expiresAt).toISOString(),
      })),
      agents: deps.agents.list(),
      webOrigin: deps.webOrigin,
      publicMcp: deps.publicMcp,
    };
  }

  /**
   * @param {Record<string, string>} headers
   */
  async function postGmail(headers) {
    if (gmailPending) {
      return json(409, { error: "consent already pending" }, headers);
    }
    gmailPending = true;
    try {
      const client = await resolveGoogleClient(deps.env, deps.webOrigin);
      const started = await startGmailConsent({
        stateDir: deps.stateDir,
        vault: deps.vault,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
      });
      void started.done.then(
        async () => {
          gmailPending = false;
          try {
            await deps.onGmailConnected();
          } catch (err) {
            log("error", "gmail connect failed", { message: errMessage(err) });
          }
        },
        (err) => {
          gmailPending = false;
          log("info", "gmail consent ended", { message: errMessage(err) });
        },
      );
      return json(200, { url: started.url }, headers);
    } catch (err) {
      gmailPending = false;
      log("info", "gmail consent failed", { message: errMessage(err) });
      return json(500, { error: "gmail consent failed" }, headers);
    }
  }

  /**
   * @param {unknown} body
   * @param {Record<string, string>} headers
   */
  async function postName(body, headers) {
    if (deps.state.ensName) {
      return json(409, { error: "house already named" }, headers);
    }
    if (nameIssuing || worldPending || worldStarting) {
      return json(409, { error: "busy" }, headers);
    }
    const label =
      body !== null &&
      typeof body === "object" &&
      typeof (/** @type {{ label?: unknown }} */ (body).label) === "string"
        ? /** @type {{ label: string }} */ (body).label
        : "";
    if (!LABEL_RE.test(label)) {
      return json(400, { error: "bad label" }, headers);
    }
    /** @type {{ available?: unknown } | null} */
    let data = null;
    try {
      const res = await fetch(
        `${deps.webOrigin}/api/issue?label=${encodeURIComponent(label)}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      data = await res.json();
      if (!res.ok || data === null || typeof data.available !== "boolean") {
        return json(409, { error: "name check failed" }, headers);
      }
    } catch {
      return json(409, { error: "name check failed" }, headers);
    }
    if (data.available !== true) {
      return json(409, { error: "name taken" }, headers);
    }
    deps.state.pendingLabel = label;
    nameError = null;
    await deps.save();
    return json(200, { ok: true }, headers);
  }

  /**
   * Reads the issuer's streamed reply ({"type":"step"|"done"|"error"} lines).
   * @param {Response} res
   * @returns {Promise<{ name?: string, error?: string }>}
   */
  async function readIssueStream(res) {
    if (!res.body) return { error: "network" };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    /** @type {{ name?: string, error?: string }} */
    let outcome = { error: "network" };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line) continue;
        /** @type {{ type?: unknown, step?: unknown, status?: unknown, tx?: unknown, name?: unknown, error?: unknown }} */
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "step" && typeof event.step === "string") {
          markStep(
            event.step,
            event.status === "sent" ? "sent" : "done",
            typeof event.tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(event.tx) ? event.tx : undefined,
          );
        } else if (event.type === "done" && typeof event.name === "string") {
          outcome = { name: event.name };
        } else if (event.type === "error") {
          outcome = { error: typeof event.error === "string" ? event.error : "TX_FAILED" };
        }
      }
    }
    return outcome;
  }

  /**
   * @param {{ nonce: string, result?: unknown }} outcome
   */
  async function issueName(outcome) {
    if (nameIssuing) return;
    const label = deps.state.pendingLabel;
    if (!label) return;
    nameIssuing = true;
    nameError = null;
    nameProgress = { startedAt: new Date().toISOString(), steps: new Map() };
    markStep("scan", "done");
    /** @type {{ name?: string, error?: string }} */
    let result;
    try {
      const res = await fetch(`${deps.webOrigin}/api/issue`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson",
        },
        body: JSON.stringify({
          label,
          house: deps.houseAddress,
          nonce: outcome.nonce,
          result: outcome.result,
        }),
        signal: AbortSignal.timeout(290_000),
      });
      if ((res.headers.get("content-type") ?? "").includes("application/x-ndjson")) {
        result = await readIssueStream(res);
      } else {
        /** @type {{ name?: unknown, error?: unknown } | null} */
        let body = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        result =
          res.status === 200 && body !== null && typeof body.name === "string"
            ? { name: body.name }
            : { error: body !== null && typeof body.error === "string" ? body.error : String(res.status) };
      }
    } catch {
      result = { error: "network" };
    }
    if (!result.name) {
      nameError = `name issuance failed (${result.error ?? "network"})`;
      failOpenSteps();
      nameIssuing = false;
      return;
    }
    deps.state.ensName = result.name;
    deps.state.pendingLabel = null;
    try {
      await deps.save();
    } catch {
      nameError = "name issuance failed (could not save)";
      nameIssuing = false;
      return;
    }
    nameError = null;
    markStep("publish", "sent");
    const synced = await deps.onNamed(result.name);
    if (synced && synced.status === "failed") {
      markStep("publish", "failed");
      nameError =
        "name issued; endpoint update failed - restart the house to retry";
    } else {
      markStep("publish", "done", synced && "tx" in synced && typeof synced.tx === "string" ? synced.tx : undefined);
    }
    nameIssuing = false;
  }

  /**
   * @param {string} id
   * @param {"sent" | "done" | "failed"} status
   * @param {string} [tx]
   */
  function markStep(id, status, tx) {
    if (!nameProgress) return;
    const step = nameProgress.steps.get(id) ?? { status: "sent", txs: [] };
    step.status = status;
    if (tx && !step.txs.includes(tx)) step.txs.push(tx);
    nameProgress.steps.set(id, step);
  }

  function failOpenSteps() {
    if (!nameProgress) return;
    for (const step of nameProgress.steps.values()) {
      if (step.status === "sent") step.status = "failed";
    }
  }

  function progressBody() {
    if (!nameProgress) return null;
    return {
      startedAt: nameProgress.startedAt,
      steps: STEP_ORDER.filter((id) => nameProgress.steps.has(id)).map((id) => ({
        id,
        ...nameProgress.steps.get(id),
      })),
    };
  }

  /**
   * @param {Record<string, string>} headers
   */
  async function postWorld(headers) {
    if (!deps.state.pendingLabel && !deps.state.ensName) {
      return json(409, { error: "choose a name first" }, headers);
    }
    if (deps.isWorldReady() && deps.state.ensName) {
      return json(409, { error: "already set up" }, headers);
    }
    if (worldPending && worldLink) {
      return json(200, { link: worldLink }, headers);
    }
    if (worldStarting) {
      return json(409, { error: "world setup already starting" }, headers);
    }
    worldStarting = true;
    const label = deps.state.pendingLabel ?? "-";
    /** @type {{ connectorURI: string, done: Promise<{ ok: boolean, sessionId?: string, result?: unknown, nonce: string, code?: string }> }} */
    let started;
    try {
      started = await startWorldSetup({
        houseAddress: deps.houseAddress,
        label,
        world: deps.world,
        timeoutMs: 180_000,
      });
    } catch (err) {
      worldStarting = false;
      worldError = "world setup failed";
      log("info", "world setup failed", { message: errMessage(err) });
      return json(409, { error: "world setup failed" }, headers);
    }
    worldPending = true;
    worldStarting = false;
    worldError = null;
    worldLink = started.connectorURI;
    const link = worldLink;
    void started.done.then(async (result) => {
      worldPending = false;
      worldStarting = false;
      worldLink = null;
      if (!result.ok || typeof result.sessionId !== "string") {
        worldError = result.code ?? "world setup failed";
        return;
      }
      try {
        await saveWorldSession(deps.stateDir, deps.vault, {
          session_id: result.sessionId,
          environment: deps.world.environment,
          rp_id: deps.world.rpId,
          created_at: new Date().toISOString(),
        });
        deps.markWorldReady();
      } catch {
        worldError = "could not save session";
        return;
      }
      if (deps.state.pendingLabel) await issueName(result);
    });
    return json(200, { link }, headers);
  }

  /**
   * @param {unknown} body
   * @returns {string | null}
   */
  function parseAddress(body) {
    const address =
      body !== null &&
      typeof body === "object" &&
      typeof (/** @type {{ address?: unknown }} */ (body).address) === "string"
        ? /** @type {{ address: string }} */ (body).address
        : "";
    if (!ADDR_RE.test(address)) return null;
    return address.toLowerCase();
  }

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function handle(request) {
    const url = new URL(request.url);
    const headers = headersFor(request);
    const presented = url.searchParams.get("k") ?? "";
    if (!tokenOk(presented)) {
      return json(404, { error: "not found" }, headers);
    }
    if (request.headers.get("origin") !== deps.webOrigin) {
      return json(403, { error: "forbidden origin" }, headers);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    const path = url.pathname;
    if (request.method === "GET" && path === "/setup/state") {
      return json(200, stateBody(), headers);
    }
    if (request.method === "GET" && path === "/setup/activity") {
      return json(200, { entries: deps.activity(50) }, headers);
    }
    if (request.method !== "POST") {
      return json(404, { error: "not found" }, headers);
    }
    const parsed = await readJsonBody(request, BODY_MAX);
    if ("error" in parsed && parsed.error === "too large") {
      return json(413, { error: "body too large" }, headers);
    }
    if ("error" in parsed) {
      return json(400, { error: "bad request" }, headers);
    }
    if (path === "/setup/gmail") return postGmail(headers);
    if (path === "/setup/name") return postName(parsed.value, headers);
    if (path === "/setup/world") return postWorld(headers);
    if (path === "/setup/pair") {
      const body = /** @type {{ id?: unknown, approve?: unknown }} */ (
        parsed.value ?? {}
      );
      if (
        typeof body.id !== "string" ||
        !/^p_[0-9a-f]{16}$/.test(body.id) ||
        typeof body.approve !== "boolean"
      ) {
        return json(400, { error: "bad request" }, headers);
      }
      if (!body.approve) {
        return deps.denyPair(body.id)
          ? json(200, { ok: true }, headers)
          : json(409, { error: "request expired" }, headers);
      }
      const result = await deps.approvePair(body.id);
      if (!result.ok) return json(result.status, { error: result.error }, headers);
      return json(200, { ok: true }, headers);
    }
    if (path === "/setup/revoke") {
      const address = parseAddress(parsed.value);
      if (address === null) return json(400, { error: "bad address" }, headers);
      if (address === deps.houseAddress.toLowerCase()) {
        return json(400, { error: "cannot revoke the house" }, headers);
      }
      await deps.agents.revoke(address);
      return json(200, { ok: true }, headers);
    }
    if (path === "/setup/unrevoke") {
      const address = parseAddress(parsed.value);
      if (address === null) return json(400, { error: "bad address" }, headers);
      await deps.agents.unrevoke(address);
      return json(200, { ok: true }, headers);
    }
    return json(404, { error: "not found" }, headers);
  }

  return { handle };
}
