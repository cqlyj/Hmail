import { readdir, readFile } from "node:fs/promises";

const TAB_EXPR = `JSON.stringify({
  o: location.origin,
  v: document.visibilityState,
  a: (() => {
    const e = document.activeElement;
    if (!e) return null;
    return {
      t: e.tagName,
      ty: (e.type || "").toLowerCase(),
      ce: !!e.isContentEditable,
      dis: !!e.disabled,
      ro: !!e.readOnly,
    };
  })(),
})`;

const TEXT_INPUTS = new Set([
  "",
  "text",
  "tel",
  "number",
  "password",
  "email",
  "search",
]);

/**
 * @param {string | ArrayBuffer | ArrayBufferView} data
 * @returns {string}
 */
function asText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  return String(data);
}

/** Scans /proc/<pid>/cmdline for processes whose content matches /chrom/i and /--remote-debugging-port=(\d+)/ (regex over the whole file content, not split on \0).
 *  Returns the first port whose http://127.0.0.1:<port>/json/version answers 200 within 1 s, else null. No env var or flag overrides this. */
export async function findCdpPort() {
  /** @type {string[]} */
  let names;
  try {
    names = await readdir("/proc");
  } catch {
    return null;
  }
  /** @type {number[]} */
  const ports = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    /** @type {Buffer} */
    let raw;
    try {
      raw = await readFile(`/proc/${name}/cmdline`);
    } catch {
      continue;
    }
    const text = raw.toString("utf8");
    if (!/chrom/i.test(text)) continue;
    const match = text.match(/--remote-debugging-port=(\d+)/);
    if (!match) continue;
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    ports.push(port);
  }
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      const ok = res.status === 200;
      await res.body?.cancel().catch(() => {});
      if (ok) return port;
    } catch {
      // This port is not a live debugging endpoint.
    }
  }
  return null;
}

/** GET http://127.0.0.1:<port>/json/list → only entries with type === "page" and a webSocketDebuggerUrl starting with ws://127.0.0.1: */
async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5000),
  });
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    throw new Error("cdp list failed");
  }
  const body = await res.json();
  if (!Array.isArray(body)) return [];
  return body.filter(
    (entry) =>
      entry &&
      entry.type === "page" &&
      typeof entry.webSocketDebuggerUrl === "string" &&
      entry.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:"),
  );
}

/** Opens the page's WebSocket (global WebSocket). Methods send CDP commands with incrementing ids and a 5 s timeout each. */
async function connectPage(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("cdp connect timed out"));
      try {
        ws.close();
      } catch {
        // already closing
      }
    }, 5000);
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    ws.addEventListener("open", () => finish(), { once: true });
    ws.addEventListener(
      "error",
      () => finish(new Error("cdp connect failed")),
      { once: true },
    );
    ws.addEventListener(
      "close",
      (ev) => {
        const reason = ev && ev.reason ? ` ${ev.reason}` : "";
        finish(new Error(`cdp connect closed (${ev.code}${reason})`));
      },
      { once: true },
    );
  });

  let nextId = 1;
  /** @type {Map<number, { resolve(value: unknown): void, reject(err: Error): void, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map();

  const failAll = (err) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    pending.clear();
  };

  ws.addEventListener("message", (ev) => {
    /** @type {{ id?: number, result?: unknown, error?: { message?: string } }} */
    let msg;
    try {
      msg = JSON.parse(asText(ev.data));
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || "cdp error"));
    else waiter.resolve(msg.result);
  });
  ws.addEventListener("close", () => {
    failAll(new Error("cdp connection closed"));
  });

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   */
  function send(method, params) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("cdp command timed out"));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  return {
    /** @param {string} expression */
    async evaluate(expression) {
      const result =
        /** @type {{ result?: { value?: unknown }, exceptionDetails?: unknown }} */ (
          await send("Runtime.evaluate", { expression, returnByValue: true })
        );
      if (result.exceptionDetails) throw new Error("cdp evaluate failed");
      return result.result ? result.result.value : undefined;
    },
    /** @param {string} ch */
    async insertText(ch) {
      await send("Input.insertText", { text: ch });
    },
    async pressEnter() {
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: "\r",
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    },
    close() {
      failAll(new Error("cdp connection closed"));
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}

/**
 * @param {string} origin
 * @param {string} site
 */
function originMatches(origin, site) {
  if (typeof origin !== "string") return false;
  /** @type {URL} */
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    (url.hostname === site || url.hostname.endsWith(`.${site}`))
  );
}

/**
 * @param {{ t?: string, ty?: string, ce?: boolean, dis?: boolean, ro?: boolean } | null} active
 */
function fieldReady(active) {
  if (!active || typeof active !== "object") return false;
  if (active.dis || active.ro) return false;
  if (active.ce) return true;
  if (active.t === "TEXTAREA") return true;
  if (active.t === "INPUT" && TEXT_INPUTS.has(active.ty ?? "")) return true;
  return false;
}

/**
 * @param {number} port
 * @param {string} site
 * @returns {Promise<{ ok: true, page: Awaited<ReturnType<typeof connectPage>> } | { ok: false, reason: string }>}
 */
export async function inspectTab(port, site) {
  const targets = await listPages(port);
  /** @type {{ page: Awaited<ReturnType<typeof connectPage>>, info: { o?: string, v?: string, a?: { t?: string, ty?: string, ce?: boolean, dis?: boolean, ro?: boolean } | null } }[]} */
  const opened = [];
  for (const target of targets) {
    /** @type {Awaited<ReturnType<typeof connectPage>> | undefined} */
    let page;
    try {
      page = await connectPage(target);
      const raw = await page.evaluate(TAB_EXPR);
      if (typeof raw !== "string") throw new Error("cdp evaluate failed");
      const info = JSON.parse(raw);
      opened.push({ page, info });
    } catch {
      try {
        page?.close();
      } catch {
        // drop a page we could not read
      }
    }
  }

  const visible = opened.filter((item) => item.info.v === "visible");
  const closeExcept = (keep) => {
    for (const item of opened) {
      if (item === keep) continue;
      try {
        item.page.close();
      } catch {
        // already closed
      }
    }
  };

  if (visible.length === 0) {
    closeExcept(null);
    return { ok: false, reason: "no visible browser tab" };
  }
  if (visible.length > 1) {
    closeExcept(null);
    return {
      ok: false,
      reason: "more than one visible browser tab; close the others",
    };
  }
  const chosen = visible[0];
  if (!originMatches(chosen.info.o ?? "", site)) {
    closeExcept(null);
    return {
      ok: false,
      reason: `the visible tab is ${chosen.info.o}, not ${site}`,
    };
  }
  if (!fieldReady(chosen.info.a ?? null)) {
    closeExcept(null);
    return {
      ok: false,
      reason: `no text field is focused on ${site}; click the code field first`,
    };
  }
  closeExcept(chosen);
  return { ok: true, page: chosen.page };
}
