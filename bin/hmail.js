#!/usr/bin/env node
import { USAGE, UsageError } from "../src/shared/cli.js";
import { errMessage } from "../src/shared/util.js";
import { VERSION } from "../src/shared/version.js";

const argv = process.argv.slice(2);

// A closed pipe (hmail status | head) is not an error worth a stack trace.
process.stdout.on("error", (err) => {
  if (/** @type {NodeJS.ErrnoException} */ (err).code === "EPIPE") process.exit(0);
  throw err;
});
const cmd = argv[0];

/**
 * @param {number} major
 * @param {number} minor
 * @param {string} what
 */
function requireNode(major, minor, what) {
  const [haveMajor = 0, haveMinor = 0] = process.versions.node
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (haveMajor > major || (haveMajor === major && haveMinor >= minor)) return;
  process.stderr.write(`error: ${what} (found ${process.version})\n`);
  process.exit(1);
}

function usageError(message) {
  process.stderr.write(`error: ${message}\n`);
  process.stderr.write(`run "hmail help" for usage\n`);
  process.exit(2);
}

function fail(err) {
  if (err instanceof UsageError) usageError(err.message);
  process.stderr.write(`error: ${errMessage(err)}\n`);
  if (process.env.HMAIL_LOG === "debug" && err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
}

const HOUSE = "the house needs Node >= 22.19";
const CLIENT = "this command needs Node >= 22.18";

async function main() {
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    process.stdout.write(`hmail ${VERSION}\n`);
    return;
  }
  if (cmd === "ping") {
    requireNode(22, 18, CLIENT);
    const { runPing } = await import("../src/client/ping.js");
    process.exitCode = await runPing(argv.slice(1), process.env);
    return;
  }
  if (cmd === "connect" || cmd === "pair") {
    requireNode(22, 18, CLIENT);
    const { runConnect } = await import("../src/client/connect.js");
    process.exitCode = await runConnect(argv.slice(1), process.env);
    return;
  }
  if (cmd === "search") {
    requireNode(22, 18, CLIENT);
    const { runSearch } = await import("../src/client/mail.js");
    process.exitCode = await runSearch(argv.slice(1), process.env);
    return;
  }
  if (cmd === "read") {
    requireNode(22, 18, CLIENT);
    const { runRead } = await import("../src/client/mail.js");
    process.exitCode = await runRead(argv.slice(1), process.env);
    return;
  }
  if (cmd === "attachment") {
    requireNode(22, 18, CLIENT);
    const { runAttachment } = await import("../src/client/mail.js");
    process.exitCode = await runAttachment(argv.slice(1), process.env);
    return;
  }
  if (cmd === "type") {
    requireNode(22, 18, CLIENT);
    const { runType } = await import("../src/client/type.js");
    process.exitCode = await runType(argv.slice(1), process.env);
    return;
  }
  if (cmd === "gmail-connect") {
    requireNode(22, 19, HOUSE);
    const { runGmailConnect } = await import("../src/house/gmail/oauth.js");
    process.exitCode = await runGmailConnect(argv.slice(1), process.env);
    return;
  }
  if (cmd === "inspect") {
    requireNode(22, 19, HOUSE);
    const { runInspect } = await import("../src/house/inspect.js");
    process.exitCode = await runInspect(argv.slice(1), process.env);
    return;
  }
  if (cmd === "world-setup") {
    requireNode(22, 19, HOUSE);
    const { runWorldSetup } = await import("../src/house/world/setup.js");
    process.exitCode = await runWorldSetup(argv.slice(1), process.env);
    return;
  }
  if (cmd === "activity") {
    requireNode(22, 19, HOUSE);
    const { runActivity } = await import("../src/house/audit.js");
    process.exitCode = await runActivity(argv.slice(1), process.env);
    return;
  }
  if (cmd === "status" || cmd === "stop" || cmd === "open") {
    requireNode(22, 19, HOUSE);
    const daemon = await import("../src/house/daemon.js");
    const run = { status: daemon.runStatus, stop: daemon.runStop, open: daemon.runOpen }[cmd];
    process.exitCode = await run(argv.slice(1), process.env);
    return;
  }
  if (cmd === "up" || cmd === undefined || cmd.startsWith("-")) {
    requireNode(22, 19, HOUSE);
    const houseArgv = cmd === "up" ? argv.slice(1) : argv;
    if (houseArgv.includes("--background")) {
      const { startBackground } = await import("../src/house/daemon.js");
      process.exitCode = await startBackground(
        houseArgv.filter((arg) => arg !== "--background"),
        process.env,
      );
      return;
    }
    const { startHouse } = await import("../src/house/start.js");
    await startHouse(houseArgv, process.env);
    return;
  }
  usageError(`unknown command "${cmd}"`);
}

main().catch(fail);
