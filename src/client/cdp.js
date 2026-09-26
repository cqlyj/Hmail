import { readdir, readFile } from "node:fs/promises";

/** Page-side helpers shared by the expressions below. A "code field" is a visible, enabled text-like input
 *  (never email or search) that looks like it takes a code: autocomplete="one-time-code", a short maxlength,
 *  a numeric inputmode, a code/otp/pin-like name or label, or the only input on the page. */
const PAGE_HELPERS = `
  const kinds = ["", "text", "tel", "number", "password"];
  const usable = (e) =>
    e && e.tagName === "INPUT" && !e.disabled && !e.readOnly && e.getClientRects().length > 0 &&
    kinds.includes((e.type || "").toLowerCase());
  const inputs = () => [...document.querySelectorAll("input")].filter(usable);
  const hinted = (e) =>
    /code|otp|pin|token|verif|passcode|2fa|mfa/i.test([e.name, e.id, e.getAttribute("aria-label"), e.placeholder].join(" "));
  const isCode = (e) =>
    usable(e) &&
    ((e.autocomplete || "").toLowerCase() === "one-time-code" ||
      (e.maxLength > 0 && e.maxLength <= 10) ||
      /numeric|decimal/.test(e.inputMode || "") ||
      hinted(e) ||
      inputs().length === 1);
  const deepActive = () => {
    let e = document.activeElement;
    while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
    return e;
  };
`;

const TAB_EXPR = `(() => {
  ${PAGE_HELPERS}
  return JSON.stringify({
    o: location.origin,
    p: location.pathname,
    v: document.visibilityState,
    code: isCode(deepActive()),
  });
})()`;

/** Focuses the page's code field when none is focused: an autocomplete="one-time-code" input, else the first
 *  empty box of a split code (4+ inputs with maxlength 1), else the only numeric input, else the only
 *  code-like input. Returns whether a code field now has focus. */
const FOCUS_EXPR = `(() => {
  ${PAGE_HELPERS}
  const all = inputs();
  let pick = all.find((e) => (e.autocomplete || "").toLowerCase() === "one-time-code");
  if (!pick) {
    const boxes = all.filter((e) => e.maxLength === 1);
    if (boxes.length >= 4) pick = boxes.find((e) => !e.value) || boxes[0];
  }
  if (!pick) {
    const numeric = all.filter((e) => /numeric|decimal/.test(e.inputMode || ""));
    if (numeric.length === 1) pick = numeric[0];
  }
  if (!pick) {
    const codes = all.filter(isCode);
    if (codes.length === 1) pick = codes[0];
  }
  if (!pick) return false;
  pick.focus();
  return isCode(deepActive());
})()`;

/** After typing: did the code land in the page (in the focused field or across split boxes), or did the page
 *  move on (it submitted by itself)? Never returns the code or any field value. */
function landedExpr(code, href) {
  return `(() => {
    ${PAGE_HELPERS}
    const want = ${JSON.stringify(code)};
    const e = deepActive();
    const joined = [...document.querySelectorAll("input")].map((i) => i.value || "").join("").replace(/[\\s-]/g, "");
    return JSON.stringify({
      moved: location.href !== ${JSON.stringify(href)},
      has: joined.includes(want) || ((e && e.value) || "").replace(/[\\s-]/g, "").includes(want),
    });
  })()`;
}

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

/** Ports Chrome is usually started with (--remote-debugging-port), tried when /proc can't be scanned (macOS, Windows) or names none. */
const COMMON_PORTS = [9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229];

/** Ports named by running Chrome processes: /proc/<pid>/cmdline matching /chrom/i and --remote-debugging-port=N. Linux only; [] elsewhere. */
async function portsFromProc() {
  /** @type {string[]} */
  let names;
  try {
    names = await readdir("/proc");
  } catch {
    return [];
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
  return ports;
}

/** True when http://127.0.0.1:<port>/json/version answers 200 within 1 s and names a Chrome-family browser. */
async function isChromeEndpoint(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return false;
    }
    const body = await res.json();
    return typeof body?.Browser === "string" && /chrom|edg\//i.test(body.Browser);
  } catch {
    return false;
  }
}

/** The local Chrome DevTools port: first the ports running Chrome processes name in /proc (Linux), then the
 *  common ports 9222-9229 (macOS, Windows, or a Chrome /proc can't see). Only a live endpoint on 127.0.0.1
 *  that reports a Chrome-family browser is used. Returns null when there is none. */
export async function findCdpPort() {
  const fromProc = await portsFromProc();
  const candidates = [...fromProc, ...COMMON_PORTS.filter((port) => !fromProc.includes(port))];
  for (const port of candidates) {
    if (await isChromeEndpoint(port)) return port;
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
    /** Whether the code shows up in the page (or the page moved on) after typing. @param {string} code @param {string} href */
    async landed(code, href) {
      const raw = await this.evaluate(landedExpr(code, href));
      const out = JSON.parse(String(raw));
      return out.moved === true || out.has === true;
    },
    async href() {
      return String(await this.evaluate("location.href"));
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
/**
 * @param {number} port
 * @param {string} site
 * @returns {Promise<{ ok: true, page: Awaited<ReturnType<typeof connectPage>>, where: string } | { ok: false, reason: string }>}
 */
export async function inspectTab(port, site) {
  const targets = await listPages(port);
  /** @type {{ page: Awaited<ReturnType<typeof connectPage>>, info: { o?: string, p?: string, v?: string, code?: boolean } }[]} */
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
  if (chosen.info.code !== true) {
    // Split code boxes often lose focus when the assistant switches to its terminal: focus the code field
    // ourselves. The origin is already verified, so this can only pick a field on the site itself.
    let focused = false;
    try {
      if ((await chosen.page.evaluate(FOCUS_EXPR)) === true) {
        const again = JSON.parse(String(await chosen.page.evaluate(TAB_EXPR)));
        focused = originMatches(again.o ?? "", site) && again.code === true;
      }
    } catch {
      focused = false;
    }
    if (!focused) {
      closeExcept(null);
      return {
        ok: false,
        reason: `no code field on the visible ${site} tab (${chosen.info.p ?? "/"}); do the whole login in this Chrome (the one with the debugging port) until the site asks for the code, then run type again`,
      };
    }
  }
  closeExcept(chosen);
  return { ok: true, page: chosen.page, where: `${chosen.info.o}${chosen.info.p ?? ""}` };
}
