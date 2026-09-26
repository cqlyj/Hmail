import { log } from "../../shared/log.js";
import { placeholder } from "../mail/render.js";
import { readSealed, writeSealed } from "../sealed-file.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {import("../mail/process.js").HeldItem} HeldItem
 * @typedef {import("../mail/process.js").ProcessedMail} ProcessedMail
 */

export class HeldStore {
  /**
   * @param {string} stateDir
   * @param {{ seal(purpose: string, value: unknown): string, open(purpose: string, sealed: string): unknown }} vault
   * @param {HeldItem[]} items
   */
  constructor(stateDir, vault, items) {
    this.stateDir = stateDir;
    this.vault = vault;
    this.items = items;
    this.dirty = false;
  }

  /** loads held.enc if present; logs info "held store loaded" { count } */
  static async open(stateDir, vault) {
    const missing = Symbol("missing");
    const opened = await readSealed(stateDir, "held.enc", vault, "held", missing);
    /** @type {HeldItem[]} */
    let items = [];
    if (opened !== missing) {
      if (!Array.isArray(opened))
        throw new Error("sealed data for held failed to open");
      items = opened;
    }
    log("info", "held store loaded", { count: items.length });
    return new HeldStore(stateDir, vault, items);
  }

  /** adds items for this message that aren't stored yet */
  upsertFromMessage(processed) {
    for (const item of processed.held ?? []) {
      const exists = this.items.some(
        (stored) =>
          stored.messageId === item.messageId &&
          stored.kind === item.kind &&
          stored.secret === item.secret,
      );
      if (exists) continue;
      this.items.push(item);
      this.dirty = true;
      log("info", "held", {
        site: item.site,
        kind: item.kind,
        verified: item.verified,
        receivedAt: item.receivedAt,
      });
    }
  }

  /** newest verified, unspent item for `site` with receivedAt >= now - maxAgeMs */
  latestForSite(
    site,
    { kind = "login code", maxAgeMs = 15 * 60_000, now = Date.now() } = {},
  ) {
    const min = now - maxAgeMs;
    /** @type {HeldItem | undefined} */
    let best;
    for (const item of this.items) {
      if (
        item.site !== site ||
        item.kind !== kind ||
        !item.verified ||
        item.spent
      )
        continue;
      if (item.receivedAt < min) continue;
      if (!best || item.receivedAt > best.receivedAt) best = item;
    }
    return best;
  }

  /** @param {string} id @returns {HeldItem | undefined} */
  getById(id) {
    return this.items.find((entry) => entry.id === id);
  }

  /** @param {string} id */
  markSpent(id) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item || item.spent) return;
    item.spent = true;
    this.dirty = true;
  }

  /** [{ secret, placeholder }] for every stored item, longest secret first */
  redactionPairs() {
    return this.items
      .map((item) => ({ secret: item.secret, placeholder: placeholder(item) }))
      .sort((a, b) => b.secret.length - a.secret.length);
  }

  /** drops items with receivedAt < now - 24h; returns count dropped */
  prune(now = Date.now()) {
    const min = now - DAY_MS;
    const before = this.items.length;
    const kept = this.items.filter((item) => item.receivedAt >= min);
    const dropped = before - kept.length;
    if (dropped > 0) {
      this.items = kept;
      this.dirty = true;
    }
    return dropped;
  }

  /** writes held.enc if anything changed since the last flush */
  async flush() {
    if (!this.dirty) return;
    const snapshot = this.items.slice();
    this.dirty = false;
    try {
      await writeSealed(this.stateDir, "held.enc", this.vault, "held", snapshot);
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }
}
