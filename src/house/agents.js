import { log } from "../shared/log.js";

/**
 * @param {string} address
 */
function lower(address) {
  return address.toLowerCase();
}

const UNPAIRED_WARN_MS = 60_000;

export class AgentTracker {
  /**
   * @param {{ state: import("./house-config.js").HouseConfigState, save: () => Promise<void>, getGate: () => { reload(partial: { deny: `0x${string}`[] }): void }, mock: boolean }} deps
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, { address: string, lastSeen: string, calls: number }>} */
    this.seen = new Map();
    /** @type {(() => void) | null} */
    this.unsub = null;
    this.unpairedAt = 0;
  }

  /**
   * Subscribe to this gate. The previous listener is removed first.
   * @param {{ on(event: "audit", listener: (event: { fn?: string, status?: string, callerAddress?: string | null, callerHumanId?: string | null }) => void): () => void }} gate
   */
  attach(gate) {
    if (this.unsub) this.unsub();
    this.unsub = gate.on("audit", (event) => {
      try {
        if (
          !this.deps.mock &&
          this.deps.state.owner === null &&
          event.status === "deny" &&
          event.fn !== "pair"
        ) {
          const now = Date.now();
          if (now - this.unpairedAt >= UNPAIRED_WARN_MS) {
            this.unpairedAt = now;
            log(
              "warn",
              "no assistant connected yet: connect one from your house page",
            );
          }
        }
        this.note(event);
      } catch {
        // The activity list must not break the call.
      }
    });
  }

  /**
   * @param {{ fn?: string, callerAddress?: string | null, callerHumanId?: string | null }} event
   */
  note(event) {
    if (
      typeof event.callerAddress !== "string" ||
      event.callerAddress.length === 0
    ) {
      return;
    }
    const owner = this.deps.state.owner;
    const fromOwner =
      owner !== null &&
      typeof event.callerHumanId === "string" &&
      event.callerHumanId.toLowerCase() === owner.toLowerCase();
    if (event.fn !== "pair" && !fromOwner) return;
    const address = lower(event.callerAddress);
    const prev = this.seen.get(address);
    this.seen.set(address, {
      address,
      lastSeen: new Date().toISOString(),
      calls: (prev ? prev.calls : 0) + 1,
    });
  }

  list() {
    const denied = new Set(
      this.deps.state.deny.map((item) => item.toLowerCase()),
    );
    return [...this.seen.values()].map((row) => ({
      address: row.address,
      lastSeen: row.lastSeen,
      calls: row.calls,
      denied: denied.has(row.address),
    }));
  }

  /**
   * @param {string} address
   */
  async revoke(address) {
    const key = /** @type {`0x${string}`} */ (lower(address));
    if (!this.deps.state.deny.some((item) => item.toLowerCase() === key)) {
      this.deps.state.deny.push(key);
    }
    await this.deps.save();
    this.deps.getGate().reload({ deny: this.deps.state.deny });
  }

  /**
   * @param {string} address
   */
  async unrevoke(address) {
    const key = lower(address);
    const deny = this.deps.state.deny;
    for (let i = deny.length - 1; i >= 0; i -= 1) {
      if (deny[i].toLowerCase() !== key) continue;
      deny.splice(i, 1);
    }
    await this.deps.save();
    this.deps.getGate().reload({ deny: this.deps.state.deny });
  }
}
