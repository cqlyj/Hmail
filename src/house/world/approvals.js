import { randomBytes } from "node:crypto";
import { log } from "../../shared/log.js";
import { safeEqual } from "../../shared/util.js";
import { loadIDKit } from "./idkit.js";
import { releaseSignal } from "./signals.js";
import { loadWorldSession } from "./session-store.js";
import { fetchRpContext } from "./signer-client.js";
import { verifyWorldResult } from "./verify.js";

const TTL_MS = 180_000;
const PRUNE_MS = 10 * 60 * 1000;
const DUMMY_TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";

/** @typedef {"pending"|"approved"|"denied"|"expired"|"used"} ApprovalStatus */

/**
 * @typedef {{
 *   id: string,
 *   pageToken: string,
 *   site: string,
 *   reason: string,
 *   callerAddress: string,
 *   callerHumanId: string,
 *   nonce: string,
 *   signal: string,
 *   bind: { recipientKey: string, heldItemId: string },
 *   createdAt: number,
 *   expiresAt: number,
 *   status: ApprovalStatus,
 *   code: string|null,
 *   worldUrl: string|null,
 *   url: string,
 * }} StoredApproval
 */

export class ApprovalManager {
  /**
   * @param {{ stateDir: string, vault: { seal(purpose: string, value: unknown): string, open(purpose: string, sealed: string): unknown }, world: { appId: string, rpId: string, environment: "production"|"sandbox", webOrigin: string, signerUrl: string }, houseAddress: string, publicOrigin: string, ensName: () => string | null, onSettle?: (approval: StoredApproval) => void }} deps
   */
  constructor(deps) {
    this.stateDir = deps.stateDir;
    this.vault = deps.vault;
    this.world = deps.world;
    this.houseAddress = deps.houseAddress;
    this.publicOrigin = String(deps.publicOrigin).replace(/\/$/, "");
    this.ensName = deps.ensName;
    this.webOrigin = deps.world.webOrigin;
    this.onSettle = deps.onSettle;
    /** @type {Map<string, StoredApproval>} */
    this.items = new Map();
  }

  /**
   * @param {string} id
   * @param {string} pageToken
   */
  pageUrl(id, pageToken) {
    /** @type {{ h: string, i: string, k: string, n?: string }} */
    const payload = { h: this.publicOrigin, i: id, k: pageToken };
    const name = this.ensName();
    if (name) payload.n = name;
    const fragment = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${this.world.webOrigin}/approve.html#${fragment}`;
  }

  /**
   * @param {StoredApproval} approval
   * @returns {ApprovalStatus}
   */
  effective(approval) {
    if (
      (approval.status === "pending" || approval.status === "approved") &&
      Date.now() >= approval.expiresAt
    ) {
      return "expired";
    }
    return approval.status;
  }

  /** @param {number} now */
  prune(now) {
    for (const [id, approval] of this.items) {
      if (
        approval.status !== "pending" &&
        now - approval.createdAt > PRUNE_MS
      ) {
        this.items.delete(id);
      }
    }
  }

  /**
   * @param {number} now
   * @param {string} callerAddress
   */
  pendingCounts(now, callerAddress) {
    let total = 0;
    let mine = 0;
    for (const approval of this.items.values()) {
      if (approval.status === "pending" && now < approval.expiresAt) {
        total += 1;
        if (approval.callerAddress === callerAddress) mine += 1;
      }
    }
    return { total, mine };
  }

  /**
   * @param {StoredApproval} approval
   * @param {ApprovalStatus} status
   * @param {string|null} code
   */
  settle(approval, status, code) {
    if (approval.status !== "pending") return;
    approval.status = status;
    approval.code = code;
    approval.worldUrl = null;
    if (status === "approved") {
      log("info", "approval verified", {
        id: approval.id,
        site: approval.site,
      });
    } else if (status === "expired") {
      log("info", "approval expired", { id: approval.id });
    } else {
      log("info", "approval denied", { id: approval.id, code });
    }
    if (typeof this.onSettle === "function") {
      try {
        this.onSettle(approval);
      } catch {
        // The activity feed must not break verification.
      }
    }
  }

  /**
   * @param {StoredApproval} approval
   * @param {{ success?: boolean, error?: string, result?: unknown }} outcome
   * @param {{ signal: string, rpNonce: string, sessionId: string }} ctx
   */
  async onWorld(approval, outcome, ctx) {
    try {
      if (approval.status !== "pending") return;
      if (!outcome || outcome.success !== true) {
        const error = outcome && outcome.error;
        if (error === "timeout") this.settle(approval, "expired", null);
        else
          this.settle(
            approval,
            "denied",
            typeof error === "string" ? error : "generic_error",
          );
        return;
      }
      const v = await verifyWorldResult(
        outcome.result,
        {
          mode: { kind: "prove", sessionId: ctx.sessionId },
          signal: ctx.signal,
          rpNonce: ctx.rpNonce,
        },
        this.world,
      );
      if (approval.status !== "pending") return;
      if (v.ok) this.settle(approval, "approved", null);
      else this.settle(approval, "denied", v.code);
    } catch {
      this.settle(approval, "denied", "generic_error");
    }
  }

  /**
   * @param {StoredApproval} approval
   * @param {{ pollUntilCompletion(options: { timeout: number, pollInterval: number }): Promise<unknown> }} req
   * @param {string} rpNonce
   * @param {string} sessionId
   */
  watch(approval, req, rpNonce, sessionId) {
    const signal = approval.signal;
    try {
      const done = req.pollUntilCompletion({
        timeout: TTL_MS,
        pollInterval: 2_000,
      });
      void Promise.resolve(done)
        .then((outcome) =>
          this.onWorld(
            approval,
            /** @type {{ success?: boolean, error?: string, result?: unknown }} */ (
              outcome
            ),
            {
              signal,
              rpNonce,
              sessionId,
            },
          ),
        )
        .catch(() => {
          this.settle(approval, "denied", "generic_error");
        });
    } catch {
      this.items.delete(approval.id);
      return false;
    }
    return true;
  }

  /**
   * @param {{ site: string, reason: string, callerAddress: string, callerHumanId: string, bind: { recipientKey: string, heldItemId: string } }} input
   * @returns {Promise<{ ok: false, code: "WORLD_NOT_SET_UP" | "APPROVAL_UNAVAILABLE" | "TOO_MANY_PENDING" } | { ok: true, approval: StoredApproval, url: string }>}
   */
  async create({ site, reason, callerAddress, callerHumanId, bind }) {
    const session = await loadWorldSession(this.stateDir, this.vault);
    if (
      session === null ||
      session.environment !== this.world.environment ||
      session.rp_id !== this.world.rpId
    ) {
      return { ok: false, code: "WORLD_NOT_SET_UP" };
    }
    const now = Date.now();
    this.prune(now);
    const counts = this.pendingCounts(now, callerAddress);
    if (counts.total >= 5 || counts.mine >= 2) {
      return { ok: false, code: "TOO_MANY_PENDING" };
    }

    const id = `a_${randomBytes(8).toString("hex")}`;
    const pageToken = randomBytes(16).toString("base64url");
    const nonce = randomBytes(16).toString("hex");
    const signal = releaseSignal(
      this.houseAddress,
      site,
      reason,
      bind.recipientKey,
      nonce,
    );
    const createdAt = Date.now();
    /** @type {StoredApproval} */
    const approval = {
      id,
      pageToken,
      site,
      reason,
      callerAddress,
      callerHumanId,
      nonce,
      signal,
      bind,
      createdAt,
      expiresAt: createdAt + TTL_MS,
      status: "pending",
      code: null,
      worldUrl: null,
      url: "",
    };
    approval.url = this.pageUrl(id, pageToken);
    this.items.set(id, approval);

    /** @type {{ nonce: string }} */
    let rp;
    try {
      rp = await fetchRpContext(this.world);
    } catch {
      log("warn", "approval setup failed", { step: "signer" });
      this.items.delete(id);
      return { ok: false, code: "APPROVAL_UNAVAILABLE" };
    }
    /** @type {{ connectorURI: string, pollUntilCompletion(options: { timeout: number, pollInterval: number }): Promise<unknown> }} */
    let req;
    try {
      const idkit = await loadIDKit();
      req = await idkit.IDKit.proveSession(
        /** @type {`session_${string}`} */ (session.session_id),
        {
          app_id: /** @type {`app_${string}`} */ (this.world.appId),
          rp_context: rp,
          action_description: `${site} · ${reason}`.slice(0, 120),
          environment: this.world.environment,
        },
      ).constraints(idkit.CredentialRequest("selfie", { signal }));
    } catch {
      log("warn", "approval setup failed", { step: "idkit" });
      this.items.delete(id);
      return { ok: false, code: "APPROVAL_UNAVAILABLE" };
    }

    approval.createdAt = Date.now();
    approval.expiresAt = approval.createdAt + TTL_MS;
    approval.worldUrl = req.connectorURI;
    if (!this.watch(approval, req, rp.nonce, session.session_id)) {
      return { ok: false, code: "APPROVAL_UNAVAILABLE" };
    }
    log("info", "approval created", { id, site });
    return { ok: true, approval, url: approval.url };
  }

  /**
   * @param {string} id
   * @param {string} token
   */
  view(id, token) {
    const approval = this.items.get(id) ?? null;
    const expected = approval ? approval.pageToken : DUMMY_TOKEN;
    const presented = typeof token === "string" ? token : "";
    const match = safeEqual(expected, presented);
    if (!approval || !match) return null;
    const status = this.effective(approval);
    return {
      id: approval.id,
      site: approval.site,
      reason: approval.reason,
      status,
      code: status === "denied" ? approval.code : null,
      expiresAt: new Date(approval.expiresAt).toISOString(),
      worldUrl: status === "pending" ? approval.worldUrl : null,
    };
  }

  /**
   * Pending approvals for the owner's house page, so the owner can scan
   * without waiting for the assistant to relay the link.
   * @returns {{ id: string, site: string, reason: string, worldUrl: string | null, url: string, expiresAt: string }[]}
   */
  pending() {
    return [...this.items.values()]
      .filter((approval) => this.effective(approval) === "pending")
      .map((approval) => ({
        id: approval.id,
        site: approval.site,
        reason: approval.reason,
        worldUrl: approval.worldUrl,
        url: approval.url,
        expiresAt: new Date(approval.expiresAt).toISOString(),
      }));
  }

  /**
   * @param {string} id
   * @returns {{ type: "world-selfie", approvalId: string, url: string, site: string, reason: string, expiresAt: string } | null}
   */
  challengeFor(id) {
    const approval = this.items.get(id);
    if (!approval || this.effective(approval) !== "pending") return null;
    return {
      type: "world-selfie",
      approvalId: approval.id,
      url: approval.url,
      site: approval.site,
      reason: approval.reason,
      expiresAt: new Date(approval.expiresAt).toISOString(),
    };
  }

  /**
   * @param {StoredApproval | undefined} approval
   * @param {{ site: string, reason: string, callerAddress: string, recipientKey: string }} expected
   */
  matches(approval, { site, reason, callerAddress, recipientKey }) {
    return Boolean(
      approval &&
        approval.site === site &&
        approval.reason === reason &&
        approval.callerAddress === callerAddress &&
        approval.bind &&
        approval.bind.recipientKey === recipientKey,
    );
  }

  /**
   * The status an approval has for this exact request, without spending it.
   * @param {string} id
   * @param {{ site: string, reason: string, callerAddress: string, recipientKey: string }} expected
   * @returns {{ status: ApprovalStatus | "unknown", code?: string }}
   */
  peek(id, expected) {
    const approval = this.items.get(id);
    if (!approval || !this.matches(approval, expected)) return { status: "unknown" };
    const status = this.effective(approval);
    if (status === "denied") return { status, code: approval.code ?? undefined };
    return { status };
  }

  /**
   * Spends an approved approval, once.
   * @param {string} id
   * @param {{ site: string, reason: string, callerAddress: string, recipientKey: string }} expected
   * @returns {{ status: "approved", approval: StoredApproval } | { status: ApprovalStatus | "unknown", code?: string }}
   */
  consume(id, expected) {
    const approval = this.items.get(id);
    if (!approval || !this.matches(approval, expected)) return { status: "unknown" };
    const status = this.effective(approval);
    if (status === "approved") {
      approval.status = "used";
      approval.worldUrl = null;
      return { status: "approved", approval };
    }
    if (status === "denied")
      return { status: "denied", code: approval.code ?? undefined };
    return { status };
  }
}
