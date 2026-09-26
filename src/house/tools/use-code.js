import { z } from "zod";
import { sealForRecipient } from "../../shared/seal.js";
import { redactionNet } from "./mail-policy.js";

/**
 * @param {string} reason
 */
function cleanReason(reason) {
  return reason.replace(/\p{Cc}/gu, "").trim();
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
        use: redactionNet(deps),
        describe:
          "Owner's agents only. Every release needs the owner's live World ID Selfie Check; the code is sealed to the caller's one-time key.",
      },
    },
    async ({ site, reason, recipientKey }, ctx) => {
      const cleaned = cleanReason(reason);
      if (cleaned.length === 0) {
        ctx.hors.deny("reason is empty", { code: "BAD_REASON" });
      }
      const callerAddress = /** @type {string} */ (ctx.hors.callerAddress);
      const callerHumanId = /** @type {string | null} */ (
        ctx.hors.callerHumanId
      );
      /** @type {{ site: string, reason: string, callerAddress: string, callerHumanId: string | null }} */
      const who = {
        site,
        reason: cleaned,
        callerAddress,
        callerHumanId,
      };
      const store = deps.store;
      const approvals = deps.approvals;
      const rawId = ctx.hors.meta.approvalId;
      if (typeof rawId !== "string" || !/^a_[0-9a-f]{16}$/.test(rawId)) {
        const item = store.latestForSite(site);
        if (!item) {
          deps.audit.append({
            ...who,
            event: "refused",
            code: "NO_HELD_CODE",
          });
          ctx.hors.deny(`no held login code for ${site}`, {
            code: "NO_HELD_CODE",
          });
        }
        const r = await approvals.create({
          site,
          reason: cleaned,
          callerAddress,
          callerHumanId: callerHumanId ?? "",
          bind: { recipientKey, heldItemId: item.id },
        });
        if (!r.ok) {
          deps.audit.append({ ...who, event: "refused", code: r.code });
          ctx.hors.deny(`code release unavailable (${r.code})`, {
            code: r.code,
          });
        }
        deps.audit.append({
          ...who,
          event: "requested",
          approvalId: r.approval.id,
        });
        ctx.hors.deny(
          "World ID approval required: the owner must open the approval link",
          {
            code: "APPROVAL_REQUIRED",
            challenge: {
              type: "world-selfie",
              approvalId: r.approval.id,
              url: r.url,
              site,
              reason: cleaned,
              expiresAt: new Date(r.approval.expiresAt).toISOString(),
            },
          },
        );
      }
      const s = approvals.consume(rawId, {
        site,
        reason: cleaned,
        callerAddress,
        recipientKey,
      });
      if (s.status === "pending") {
        ctx.hors.deny("approval pending", {
          code: "APPROVAL_PENDING",
          challenge: approvals.challengeFor(rawId),
        });
      }
      if (s.status === "denied") {
        ctx.hors.deny(`approval denied (${s.code})`, {
          code: "APPROVAL_DENIED",
        });
      }
      if (s.status === "expired") {
        ctx.hors.deny("approval expired", { code: "APPROVAL_EXPIRED" });
      }
      if (s.status === "used") {
        deps.audit.append({
          ...who,
          event: "blocked",
          approvalId: rawId,
          code: "APPROVAL_USED",
        });
        ctx.hors.deny("approval already used", { code: "APPROVAL_USED" });
      }
      if (s.status === "unknown") {
        deps.audit.append({
          ...who,
          event: "blocked",
          approvalId: rawId,
          code: "APPROVAL_UNKNOWN",
        });
        ctx.hors.deny("no matching approval", { code: "APPROVAL_UNKNOWN" });
      }
      if (s.status !== "approved" || !s.approval) {
        ctx.hors.deny("no matching approval", { code: "APPROVAL_UNKNOWN" });
      }
      const held = store.getById(s.approval.bind.heldItemId);
      if (!held || held.spent || held.kind !== "login code") {
        deps.audit.append({
          ...who,
          event: "blocked",
          approvalId: rawId,
          code: "CODE_SPENT",
        });
        ctx.hors.deny("the held code was already used", { code: "CODE_SPENT" });
      }
      if (
        !(await ctx.hors.store.consumeOnce(`release:${held.id}`, 24 * 3600_000))
      ) {
        deps.audit.append({
          ...who,
          event: "blocked",
          approvalId: rawId,
          code: "CODE_SPENT",
        });
        ctx.hors.deny("the held code was already used", { code: "CODE_SPENT" });
      }
      store.markSpent(held.id);
      await store.flush();
      const sealed = sealForRecipient({
        recipientKey,
        site,
        approvalId: rawId,
        payload: { code: held.secret, site, kind: held.kind },
      });
      deps.audit.append({
        ...who,
        event: "released",
        approvalId: rawId,
      });
      return { content: [{ type: "text", text: JSON.stringify(sealed) }] };
    },
  );
}
