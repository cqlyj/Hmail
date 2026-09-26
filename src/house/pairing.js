import { randomBytes, randomInt } from "node:crypto";

const REQUEST_TTL_MS = 10 * 60_000;
const MAX_PENDING = 5;

/**
 * @typedef {{ id: string, confirm: string, callerAddress: string, callerHumanId: string, expiresAt: number, status: "pending" | "approved" | "denied" }} PairRequest
 */

/**
 * Pair requests from assistants, settled by the owner on the setup page. The
 * assistant and the page both show the same 6-digit confirm number, so the owner
 * can tell their assistant's request from anyone else's.
 */
export function createPairRequests() {
  /** @type {Map<string, PairRequest>} */
  const items = new Map();

  /** @param {number} now */
  function prune(now) {
    for (const [id, request] of items) {
      if (now >= request.expiresAt + REQUEST_TTL_MS) items.delete(id);
    }
  }

  /** @param {PairRequest} request @param {number} now */
  function isOpen(request, now) {
    return request.status === "pending" && now < request.expiresAt;
  }

  return {
    /**
     * Opens a request, or returns the caller's open one.
     * @param {string} callerAddress
     * @param {string} callerHumanId
     * @returns {PairRequest | null} null when too many requests are open
     */
    open(callerAddress, callerHumanId) {
      const now = Date.now();
      prune(now);
      const address = callerAddress.toLowerCase();
      let openCount = 0;
      for (const request of items.values()) {
        if (!isOpen(request, now)) continue;
        if (request.callerAddress === address) return request;
        openCount += 1;
      }
      if (openCount >= MAX_PENDING) return null;
      /** @type {PairRequest} */
      const request = {
        id: `p_${randomBytes(8).toString("hex")}`,
        confirm: String(randomInt(0, 1_000_000)).padStart(6, "0"),
        callerAddress: address,
        callerHumanId,
        expiresAt: now + REQUEST_TTL_MS,
        status: "pending",
      };
      items.set(request.id, request);
      return request;
    },

    /**
     * @param {string} id
     * @returns {(Omit<PairRequest, "status"> & { status: PairRequest["status"] | "expired" }) | null}
     */
    get(id) {
      const request = items.get(id);
      if (!request) return null;
      if (request.status === "pending" && Date.now() >= request.expiresAt) {
        return { ...request, status: "expired" };
      }
      return request;
    },

    /** Open requests, oldest first. */
    pending() {
      const now = Date.now();
      prune(now);
      return [...items.values()].filter((request) => isOpen(request, now));
    },

    /**
     * @param {string} id
     * @param {boolean} approve
     * @returns {PairRequest | null} null when the request is gone, expired or settled
     */
    settle(id, approve) {
      const request = items.get(id);
      if (!request || !isOpen(request, Date.now())) return null;
      request.status = approve ? "approved" : "denied";
      if (approve) {
        for (const other of items.values()) {
          if (other !== request && other.status === "pending") {
            other.status = "denied";
          }
        }
      }
      return request;
    },

    /**
     * Puts an approved request back to pending, after the owner could not be saved.
     * @param {string} id
     */
    reopen(id) {
      const request = items.get(id);
      if (request && request.status === "approved") request.status = "pending";
    },
  };
}
