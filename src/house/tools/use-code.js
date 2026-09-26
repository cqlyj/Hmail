import { z } from "zod";
import { sealForRecipient } from "../../shared/seal.js";
import { redactionNet } from "./mail-policy.js";

const APPROVAL_ID = /^a_[0-9a-f]{16}$/;

/**
 * @param {string} reason
 */
function cleanReason(reason) {
  return reason.replace(/\p{Cc}/gu, "").trim();
}

/**
 * The request as the rules and the handler see it.
 * @param {import("hors-sdk").HorsContext} ctx
 */
function requestOf(ctx) {
  const args = /** @type {{ site?: unknown, reason?: unknown, recipientKey?: unknown }} */ (ctx.args ?? {});
  const rawId = ctx.meta.approvalId;
  return {
    site: String(args.site ?? ""),
    reason: cleanReason(String(args.reason ?? "")),
    recipientKey: String(args.recipientKey ?? ""),
    callerAddress: String(ctx.callerAddress ?? ""),
    callerHumanId: ctx.callerHumanId ?? null,
    approvalId: typeof rawId === "string" && APPROVAL_ID.test(rawId) ? rawId : null,
  };
}

/**
 * @param {ReturnType<typeof requestOf>} req
 */
function who(req) {
  return {
    site: req.site,
    reason: req.reason,
    callerAddress: req.callerAddress,
    callerHumanId: req.callerHumanId,
  };
}

/**
 * HORS rule 1: there must be a held, verified login code from this site. A retry
 * with an approval id skips it: the approval already names the held code.
 * @param {{ store: import("../held/store.js").HeldStore, audit: import("../audit.js").AuditLog }} deps
 * @returns {import("hors-sdk").Rule}
 */
function heldCode(deps) {
  return (ctx) => {
    const req = requestOf(ctx);
    if (req.approvalId) return true;
    if (req.reason.length === 0) return { deny: "reason is empty", code: "BAD_REASON" };
    const item = deps.store.latestForSite(req.site);
    if (!item) {
      deps.audit.append({ ...who(req), event: "refused", code: "NO_HELD_CODE" });
      return { deny: `no held login code for ${req.site}`, code: "NO_HELD_CODE" };
    }
    ctx.state.heldItemId = item.id;
    return true;
  };
}

/**
 * HORS rule 2: the owner must have approved this exact request with a World ID
 * Selfie Check. The first call opens the approval and denies with it as the
 * challenge; the caller retries with hors/meta {"approvalId"} until it is approved.
 * @param {{ approvals: import("../world/approvals.js").ApprovalManager, audit: import("../audit.js").AuditLog }} deps
 * @returns {import("hors-sdk").Rule}
 */
function faceChecked(deps) {
  return async (ctx) => {
    const req = requestOf(ctx);
    if (!req.approvalId) {
      const r = await deps.approvals.create({
        site: req.site,
        reason: req.reason,
        callerAddress: req.callerAddress,
        callerHumanId: req.callerHumanId ?? "",
        bind: { recipientKey: req.recipientKey, heldItemId: String(ctx.state.heldItemId) },
      });
      if (!r.ok) {
        deps.audit.append({ ...who(req), event: "refused", code: r.code });
        return { deny: `code release unavailable (${r.code})`, code: r.code };
      }
      deps.audit.append({ ...who(req), event: "requested", approvalId: r.approval.id });
      return {
        deny: "World ID approval required: the owner must open the approval link",
        code: "APPROVAL_REQUIRED",
        challenge: {
          type: "world-selfie",
          approvalId: r.approval.id,
          url: r.url,
          site: req.site,
          reason: req.reason,
          expiresAt: new Date(r.approval.expiresAt).toISOString(),
        },
      };
    }
    const s = deps.approvals.peek(req.approvalId, req);
    switch (s.status) {
      case "approved":
        return true;
      case "pending":
        return {
          deny: "approval pending",
          code: "APPROVAL_PENDING",
          challenge: deps.approvals.challengeFor(req.approvalId),
        };
      case "denied":
        return { deny: `approval denied (${s.code})`, code: "APPROVAL_DENIED" };
      case "expired":
        return { deny: "approval expired", code: "APPROVAL_EXPIRED" };
      case "used":
        deps.audit.append({ ...who(req), event: "blocked", approvalId: req.approvalId, code: "APPROVAL_USED" });
        return { deny: "approval already used", code: "APPROVAL_USED" };
      default:
        deps.audit.append({ ...who(req), event: "blocked", approvalId: req.approvalId, code: "APPROVAL_UNKNOWN" });
        return { deny: "no matching approval", code: "APPROVAL_UNKNOWN" };
    }
  };
}

/** @param {import("hors-sdk/mcp").HorsMcpServer} gated @param {{ mail: object | null, approvals: import("../world/approvals.js").ApprovalManager, store: import("../held/store.js").HeldStore, audit: import("../audit.js").AuditLog }} deps */
export function registerUseCode(gated, deps) {
  gated.registerTool(
    "use_code",
    {
      title: "Use a held login code",
      description:
        'Ask the owner to release the held login code for <site>. The owner approves on their phone with a World ID Selfie Check; the code comes back sealed to recipientKey and is never shown. The first call returns a challenge; retry with hors/meta {"approvalId": "..."}. Use the hmail typist (hmail type), which handles this and types the code into the site.',
      inputSchema: z.object({
        site: z.string().regex(/^[a-z0-9.-]{3,253}$/),
        reason: z.string().min(1).max(120),
        recipientKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      }),
      hors: {
        origin: "same-human",
        rule: [heldCode(deps), faceChecked(deps)],
        use: redactionNet(deps),
        describe:
          "Owner's agents only. A held code from this site must exist, and every release needs the owner's live World ID Selfie Check; the code is sealed to the caller's one-time key.",
      },
    },
    async (_args, ctx) => {
      const req = requestOf(ctx.hors);
      const approvalId = /** @type {string} */ (req.approvalId);
      // The rules said "approved"; spending is still once only, even under a race.
      const s = deps.approvals.consume(approvalId, req);
      if (s.status !== "approved" || !("approval" in s)) {
        ctx.hors.deny("no matching approval", { code: "APPROVAL_UNKNOWN" });
      }
      const held = deps.store.getById(s.approval.bind.heldItemId);
      const spent = !held || held.spent || held.kind !== "login code";
      if (
        spent ||
        !(await ctx.hors.store.consumeOnce(`release:${held.id}`, 24 * 3600_000))
      ) {
        deps.audit.append({ ...who(req), event: "blocked", approvalId, code: "CODE_SPENT" });
        ctx.hors.deny("the held code was already used", { code: "CODE_SPENT" });
      }
      deps.store.markSpent(held.id);
      await deps.store.flush();
      const sealed = sealForRecipient({
        recipientKey: req.recipientKey,
        site: req.site,
        approvalId,
        payload: { code: held.secret, site: req.site, kind: held.kind },
      });
      deps.audit.append({ ...who(req), event: "released", approvalId });
      return { content: [{ type: "text", text: JSON.stringify(sealed) }] };
    },
  );
}
