import { z } from "zod";

/**
 * @param {string} text
 */
function reply(text) {
  return { content: [{ type: "text", text }] };
}

/**
 * HORS rule: once the house has an owner, only that human's assistants may call pair.
 * @param {import("../house-config.js").HouseConfigState} state
 * @returns {import("hors-sdk").Rule}
 */
function ownedByAnother(state) {
  return (ctx) => {
    if (state.owner === null) return true;
    const caller = ctx.callerHumanId;
    if (typeof caller === "string" && caller.toLowerCase() === state.owner.toLowerCase()) {
      return true;
    }
    return {
      deny: "this house belongs to a different World ID; only assistants linked to the owner can connect",
      code: "ALREADY_PAIRED",
    };
  };
}

/**
 * @param {import("hors-sdk/mcp").HorsMcpServer} gated
 * @param {{ pair: { state: import("../house-config.js").HouseConfigState, requests: ReturnType<import("../pairing.js").createPairRequests> } }} deps
 */
export function registerPair(gated, deps) {
  gated.registerTool(
    "pair",
    {
      title: "Pair with this house",
      description:
        'Ask the owner to make your human the owner of this house. The first call opens a request and returns a 6-digit confirm number; the owner approves it on their Hmail page. Retry with hors/meta {"pairRequestId": "..."} until paired. Use the hmail client (hmail connect), which handles this.',
      inputSchema: z.object({}),
      hors: {
        origin: "any-human",
        rule: ownedByAnother(deps.pair.state),
        describe:
          "Any registered human's agent, while the house has no owner (or for the owner's own agents). The owner approves the request on the house's page.",
      },
    },
    async (_args, ctx) => {
      const { state, requests } = deps.pair;
      const callerHumanId = ctx.hors.callerHumanId;
      const callerAddress = String(ctx.hors.callerAddress ?? "").toLowerCase();
      if (state.owner !== null) {
        // The rule already turned away every other human.
        return reply("paired: your human owns this house");
      }
      if (typeof callerHumanId !== "string" || callerAddress === "") {
        ctx.hors.deny("this assistant is not linked to a World ID", {
          code: "HORS_NOT_HUMAN",
        });
      }

      const rawId = ctx.hors.meta.pairRequestId;
      if (typeof rawId === "string") {
        const request = /^p_[0-9a-f]{16}$/.test(rawId)
          ? requests.get(rawId)
          : null;
        if (!request || request.callerAddress !== callerAddress) {
          ctx.hors.deny("no such pair request; start again", {
            code: "PAIR_EXPIRED",
          });
        }
        if (request.status === "denied") {
          ctx.hors.deny("the owner declined this assistant", {
            code: "PAIR_DENIED",
          });
        }
        if (request.status === "expired") {
          ctx.hors.deny("the pair request expired; start again", {
            code: "PAIR_EXPIRED",
          });
        }
        if (request.status === "approved") {
          return reply("paired: your human owns this house");
        }
        ctx.hors.deny("waiting for the owner to approve on their Hmail page", {
          code: "PAIR_PENDING",
          challenge: {
            type: "owner-approval",
            pairRequestId: request.id,
            confirm: request.confirm,
            expiresAt: new Date(request.expiresAt).toISOString(),
          },
        });
      }

      const request = requests.open(
        callerAddress,
        /** @type {string} */ (callerHumanId),
      );
      if (!request) {
        ctx.hors.deny("too many pair requests are open; try again later", {
          code: "PAIR_BUSY",
        });
      }
      ctx.hors.deny("the owner must approve this assistant on their Hmail page", {
        code: "PAIR_PENDING",
        challenge: {
          type: "owner-approval",
          pairRequestId: request.id,
          confirm: request.confirm,
          expiresAt: new Date(request.expiresAt).toISOString(),
        },
      });
    },
  );
}
