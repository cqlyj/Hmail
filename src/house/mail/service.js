import { placeholder } from "./render.js";
import { processMessage } from "./process.js";

const CACHE_MAX = 500;

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<unknown>} fn
 */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  const workers = Math.min(limit, items.length);
  if (workers > 0)
    await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/**
 * @param {{ gmail: { listIds(q: string, max: number): Promise<string[]>, getRaw(id: string): Promise<{ id: string, internalDate: number, raw: Buffer }> }, store: import("../held/store.js").HeldStore }} deps
 */
export function createMailService({ gmail, store }) {
  /** @type {Map<string, import("./process.js").ProcessedMail>} */
  const cache = new Map();

  /**
   * @param {import("./process.js").ProcessedMail} mail
   */
  function remember(mail) {
    if (mail.sender.temporary === true) return;
    if (cache.has(mail.id)) cache.delete(mail.id);
    cache.set(mail.id, mail);
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  /**
   * @param {string} id
   */
  async function load(id) {
    const hit = cache.get(id);
    if (hit) return hit;
    const message = await gmail.getRaw(id);
    const mail = await processMessage({
      id,
      raw: message.raw,
      internalDate: message.internalDate,
    });
    remember(mail);
    return mail;
  }

  return {
    async search(query, max) {
      const ids = await gmail.listIds(query, max);
      return pool(ids, 5, (id) => load(id));
    },
    async read(id) {
      return load(id);
    },
    async ingest(ids) {
      const missing = ids.filter((id) => !cache.has(id));
      const loaded = await pool(missing, 5, async (id) => {
        const mail = await load(id);
        store.upsertFromMessage(mail);
        return mail;
      });
      return loaded.length;
    },
    redactionPairs() {
      /** @type {Map<string, { secret: string, placeholder: string }>} */
      const pairs = new Map();
      for (const pair of store.redactionPairs()) {
        if (!pairs.has(pair.secret)) pairs.set(pair.secret, pair);
      }
      for (const mail of cache.values()) {
        for (const item of mail.held) {
          if (pairs.has(item.secret)) continue;
          pairs.set(item.secret, {
            secret: item.secret,
            placeholder: placeholder(item),
          });
        }
      }
      return [...pairs.values()].sort(
        (a, b) => b.secret.length - a.secret.length,
      );
    },
  };
}
