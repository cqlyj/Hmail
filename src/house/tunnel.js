import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { bin, install, Tunnel } from "cloudflared";
import { log } from "../shared/log.js";
import { errMessage } from "../shared/util.js";

const START_TIMEOUT_MS = 45_000;

/**
 * @param {string[]} lines
 * @param {unknown} chunk
 */
function rememberStderr(lines, chunk) {
  const text = String(chunk);
  log("debug", "cloudflared", { stream: "stderr", text });
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    lines.push(line);
    if (lines.length > 5) lines.shift();
  }
}

/**
 * @param {string[]} lines
 * @param {number | null} code
 */
function startFailure(lines, code) {
  const reason =
    lines.length > 0
      ? lines.join(" | ")
      : code === undefined
        ? "timed out"
        : `exit ${code}`;
  return new Error(`tunnel failed to start: ${reason}`);
}

/** A download cut off halfway leaves a file that exists but can't run. */
function binaryWorks() {
  if (!existsSync(bin)) return false;
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    return false;
  }
  const probe = spawnSync(bin, ["--version"], {
    timeout: 10_000,
    stdio: "ignore",
  });
  return probe.status === 0;
}

/** Resolves after cloudflared reports "connected". Retries transient failures (for example a slow api.trycloudflare.com). @returns {Promise<{ url: string, stop(): void, onExit(cb: (code: number|null) => void): void }>} */
export async function startTunnel(localUrl) {
  if (!binaryWorks()) {
    log("info", "downloading cloudflared", { bin });
    await install(bin);
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await startTunnelOnce(localUrl);
    } catch (err) {
      lastError = err;
      log("warn", "tunnel start failed", { attempt });
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  throw lastError;
}

async function startTunnelOnce(localUrl) {
  const t = Tunnel.quick(localUrl, { "--no-autoupdate": true });
  /** @type {string[]} */
  const stderrLines = [];
  const onStderr = (data) => rememberStderr(stderrLines, data);
  const onStdout = (data) => {
    log("debug", "cloudflared", { stream: "stdout", text: String(data) });
  };
  t.on("stderr", onStderr);
  t.on("stdout", onStdout);

  /** @type {string | undefined} */
  let url;

  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(undefined), START_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      t.off("url", onUrl);
      t.off("connected", onConnected);
      t.off("exit", onExit);
    }
    function fail(code) {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        t.stop();
      } catch {
        // The process is already gone, or stop raced with exit.
      }
      reject(startFailure(stderrLines, code));
    }
    function succeed() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }
    function onUrl(value) {
      url = value;
      if (connected) succeed();
    }
    let connected = false;
    function onConnected() {
      connected = true;
      if (url) succeed();
    }
    function onExit(code) {
      fail(code);
    }
    function onError(err) {
      const message = errMessage(err);
      if (settled) {
        log("error", "tunnel error", { message });
        return;
      }
      settled = true;
      cleanup();
      try {
        t.stop();
      } catch {
        // The process is already gone, or stop raced with exit.
      }
      reject(new Error(`tunnel failed to start: ${message}`));
    }
    t.on("url", onUrl);
    t.on("connected", onConnected);
    t.on("exit", onExit);
    t.on("error", onError);
  });

  return {
    url: /** @type {string} */ (url).replace(/\/$/, ""),
    stop() {
      t.stop();
    },
    onExit(cb) {
      t.on("exit", (code) => cb(code));
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function fetchReason(err) {
  const cause =
    err && typeof err === "object" && "cause" in err ? err.cause : undefined;
  if (cause && typeof cause === "object") {
    if ("code" in cause && typeof cause.code === "string" && cause.code !== "")
      return cause.code;
    if ("errors" in cause && Array.isArray(cause.errors)) {
      for (const item of cause.errors) {
        if (
          item &&
          typeof item === "object" &&
          "code" in item &&
          typeof item.code === "string" &&
          item.code !== ""
        ) {
          return item.code;
        }
      }
    }
  }
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof err.code === "string" &&
    err.code !== ""
  ) {
    return err.code;
  }
  if (
    err &&
    typeof err === "object" &&
    "name" in err &&
    typeof err.name === "string" &&
    err.name !== "" &&
    err.name !== "Error"
  ) {
    return err.name;
  }
  return "error";
}

/** @returns {Promise<{ ok: true } | { ok: false, reason: string }>} */
export async function waitForPublic(
  publicUrl,
  { initialDelayMs = 10_000, intervalMs = 2_000, timeoutMs = 60_000 } = {},
) {
  // DNS negative-cache gotcha: do not shorten this delay.
  await sleep(initialDelayMs);
  const health = `${publicUrl}/healthz`;
  const deadline = Date.now() + timeoutMs;
  let reason = "timeout";
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const res = await fetch(health, {
        signal: AbortSignal.timeout(Math.max(1, remaining)),
      });
      if (res.status === 200) {
        await res.body?.cancel().catch(() => {});
        return { ok: true };
      }
      reason = String(res.status);
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      reason = fetchReason(err);
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left));
  }
  return { ok: false, reason };
}
