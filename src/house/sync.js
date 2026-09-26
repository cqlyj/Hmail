import { log } from "../shared/log.js";
import { errMessage } from "../shared/util.js";
import { GmailAuthError } from "./gmail/client.js";

/** runs immediately, then every intervalMs; returns { stop() } */
export function startSync({ gmail, service, store, intervalMs, onAuthFailed }) {
  let stopped = false;
  let running = false;
  let authFailed = false;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;

  async function run() {
    if (stopped || authFailed || running) return;
    running = true;
    try {
      const ids = await gmail.listIds("newer_than:1d", 50);
      const n = await service.ingest(ids);
      store.prune();
      await store.flush();
      log("info", "sync", { fetched: ids.length, loaded: n });
    } catch (err) {
      if (err instanceof GmailAuthError) {
        authFailed = true;
        if (timer) clearInterval(timer);
        log("error", "gmail auth failed", { message: err.message });
        // A run still in flight after stop() belongs to a replaced token.
        if (!stopped && typeof onAuthFailed === "function") onAuthFailed();
        return;
      }
      log("warn", "sync failed", { message: errMessage(err) });
    } finally {
      running = false;
    }
  }

  void run();
  timer = setInterval(() => {
    void run();
  }, intervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
