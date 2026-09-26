import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHouseConfig } from "./config.js";
import { openBrowser } from "./open-browser.js";
import { ensureStateDir } from "./state.js";

const BIN = fileURLToPath(new URL("../../bin/hmail.js", import.meta.url));
const READY_TIMEOUT_MS = 150_000;

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} line */
function say(line) {
  process.stdout.write(`${line}\n`);
}

/** @param {string} stateDir */
function paths(stateDir) {
  return {
    pid: join(stateDir, "house.pid"),
    log: join(stateDir, "house.log"),
  };
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
  }
}

/**
 * @param {string} stateDir
 * @returns {Promise<number | null>} the pid of a running background house
 */
async function runningPid(stateDir) {
  const { pid: pidPath } = paths(stateDir);
  let raw;
  try {
    raw = await readFile(pidPath, "utf8");
  } catch {
    return null;
  }
  const pid = Number(raw.trim());
  if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) return pid;
  await rm(pidPath, { force: true });
  return null;
}

/** @param {number} port */
async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * The banner lines worth repeating (name, gmail, public address, errors).
 * @param {string} logPath
 */
async function bannerLines(logPath) {
  let text = "";
  try {
    text = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  const start = lines.findLastIndex((line) => line.startsWith("hmail house - "));
  return lines
    .slice(Math.max(0, start))
    .filter((line) => /^(house|gmail|world|owner|name|page|public|ens|error)\b/.test(line));
}

/**
 * hmail up --background: starts the house as a detached process and returns
 * once it is ready.
 * @param {string[]} argv the up arguments, without --background
 * @param {NodeJS.ProcessEnv} env
 */
export async function startBackground(argv, env) {
  const cfg = readHouseConfig(argv, env);
  const page = `http://localhost:${cfg.port}`;
  await ensureStateDir(cfg.stateDir);
  if ((await runningPid(cfg.stateDir)) !== null || (await healthy(cfg.port))) {
    say("Hmail is already running.");
    say(`open     ${page}`);
    return 0;
  }

  const { pid: pidPath, log: logPath } = paths(cfg.stateDir);
  const logFd = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [BIN, "up", ...argv], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
  });
  closeSync(logFd);
  child.unref();
  if (child.pid === undefined) {
    process.stderr.write("error: could not start the house\n");
    return 1;
  }
  await writeFile(pidPath, `${child.pid}\n`, { mode: 0o600 });

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const started = Date.now();
  say("starting Hmail in the background (this takes about 20 seconds)...");
  while (Date.now() - started < READY_TIMEOUT_MS) {
    await sleep(1_000);
    const lines = await bannerLines(logPath);
    let text = "";
    try {
      text = await readFile(logPath, "utf8");
    } catch {
      text = "";
    }
    const lastStart = text.lastIndexOf("hmail house - ");
    if (lastStart >= 0 && /\nready\n/.test(text.slice(lastStart))) {
      say("Hmail is running.");
      for (const line of lines) say(line);
      say(`open     ${page}   (your house page)`);
      say(`log      ${logPath}`);
      say("stop     hmail stop");
      return 0;
    }
    if (exited || !alive(child.pid)) {
      await rm(pidPath, { force: true });
      process.stderr.write("error: the house stopped while starting:\n");
      for (const line of text.slice(Math.max(0, lastStart)).split("\n").slice(-15)) {
        if (line.trim()) process.stderr.write(`  ${line}\n`);
      }
      return 1;
    }
  }
  process.stderr.write(
    `error: the house did not become ready in time; see ${logPath}\n`,
  );
  return 1;
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env */
export async function runStatus(argv, env) {
  const cfg = readHouseConfig(argv, env);
  const pid = await runningPid(cfg.stateDir);
  const up = await healthy(cfg.port);
  if (!up) {
    say("Hmail is not running. Start it with: hmail up --background");
    return 3;
  }
  say(`Hmail is running${pid !== null ? ` (pid ${pid})` : ""}.`);
  // Only lines that stay true after start; Gmail, name and owner change on the house page.
  for (const line of await bannerLines(paths(cfg.stateDir).log)) {
    if (/^(house|public)\b/.test(line)) say(line);
  }
  say(`open     http://localhost:${cfg.port}   (live status, assistants and activity)`);
  return 0;
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env */
export async function runStop(argv, env) {
  const cfg = readHouseConfig(argv, env);
  const pid = await runningPid(cfg.stateDir);
  if (pid === null) {
    say(
      (await healthy(cfg.port))
        ? "Hmail is running in a terminal; stop it there with Ctrl-C."
        : "Hmail is not running.",
    );
    return 0;
  }
  process.kill(pid, "SIGINT");
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(500);
  if (alive(pid)) process.kill(pid, "SIGKILL");
  await rm(paths(cfg.stateDir).pid, { force: true });
  say("Hmail stopped.");
  return 0;
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env */
export async function runOpen(argv, env) {
  const cfg = readHouseConfig(argv, env);
  const page = `http://localhost:${cfg.port}`;
  if (!(await healthy(cfg.port))) {
    say("Hmail is not running. Start it with: hmail up --background");
    return 3;
  }
  const opened = await openBrowser(page);
  say(opened ? `opened ${page}` : `open this in your browser: ${page}`);
  return 0;
}
