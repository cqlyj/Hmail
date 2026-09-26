import { spawn } from "node:child_process";
import { createProfile, profileHome, readProfile, writeProfile } from "hors-sdk/node";
import { createAgentBook } from "hors-sdk/world";
import { log } from "../shared/log.js";
import { errMessage } from "../shared/util.js";
import { parseClientArgs, parseUint } from "./args.js";
import { callHouse } from "./call.js";
import { reportDenied, reportError, textOf } from "./report.js";

const AGENTKIT_CLI = "@worldcoin/agentkit-cli@0.2.0";

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} line */
function say(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
function parseConnect(argv, env) {
  const parsed = parseClientArgs(argv, env, {
    options: {
      "wait-s": { type: "string" },
      "skip-world-check": { type: "boolean" },
    },
    positionals: 1,
    usage: "connect needs your house's name, like lyj.hmail.eth",
  });
  const rawWait = parsed.values["wait-s"];
  return {
    service: parsed.service,
    profile: parsed.profile,
    home: parsed.home ?? profileHome(env),
    waitS:
      typeof rawWait === "string" ? parseUint(rawWait, "--wait-s") : 600,
    skipWorldCheck: parsed.values["skip-world-check"] === true,
  };
}

/**
 * A fresh AgentBook each time: never one holding a cached "not registered".
 * @param {`0x${string}`} address
 */
async function lookupHuman(address) {
  try {
    return await createAgentBook().lookupHuman(address);
  } catch (err) {
    log("warn", "agentbook lookup failed", { message: errMessage(err) });
    return null;
  }
}

/**
 * Runs World's AgentKit registration. Without a terminal it prints one
 * "HUMAN ACTION REQUIRED ... <link>" line and waits for the scan. Only that
 * line is passed on; the proof it prints afterwards is noise for the assistant.
 * @param {`0x${string}`} address
 * @returns {Promise<{ code: number | null, failure: string | null }>}
 */
function registerWithWorld(address) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  return new Promise((resolve) => {
    const child = spawn(command, ["-y", AGENTKIT_CLI, "register", address], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    /** @type {string | null} */
    let failure = null;
    /** @param {string} line */
    function onLine(line) {
      const link = /https:\/\/world\.org\/verify\S+/.exec(line);
      if (link && /HUMAN ACTION REQUIRED/.test(line)) {
        say(`HUMAN ACTION REQUIRED: send your human this World App link to scan (it expires in about 5 minutes): ${link[0]}`);
        say("If you can show images, also show it to them as a QR code.");
        return;
      }
      const message = /^message:\s*(.+)$/.exec(line.trim());
      if (message) failure = message[1];
    }
    /** @param {Buffer} chunk */
    function onData(chunk) {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        onLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", () => resolve({ code: null, failure: "could not start World's registration tool" }));
    child.on("exit", (code) => {
      if (buffer) onLine(buffer);
      resolve({ code, failure });
    });
  });
}

/**
 * @param {{ home: string, profile: string, skipWorldCheck: boolean }} input
 * @returns {Promise<number>} 0 when the wallet is linked to a human
 */
async function ensureLinked(input) {
  let record = await readProfile(input.home, input.profile);
  if (record === undefined) {
    record = await createProfile(input.home, input.profile, {
      label: "hmail assistant",
    });
    say(`created this assistant's wallet ${record.address}`);
  }
  if (input.skipWorldCheck) return 0;

  let humanId = await lookupHuman(record.address);
  if (humanId !== null) {
    say("this assistant is linked to a World ID");
    return 0;
  }
  say(
    "This assistant must be linked to your human's World ID once. A World App link follows:",
  );
  say(
    "send it to your human and keep this command running while they scan it.",
  );
  const registered = await registerWithWorld(record.address);
  if (registered.code !== 0) {
    process.stderr.write(
      `error: the World App link was not completed${registered.failure ? ` (${registered.failure})` : ""}. It may have expired; run hmail connect again for a fresh link.\n`,
    );
    return 1;
  }
  for (let i = 0; i < 40 && humanId === null; i++) {
    humanId = await lookupHuman(record.address);
    if (humanId === null) await sleep(3_000);
  }
  if (humanId === null) {
    process.stderr.write(
      "error: the registration has not reached World Chain yet; run hmail connect again in a minute\n",
    );
    return 1;
  }
  await writeProfile(input.home, input.profile, {
    ...record,
    humanId,
    registeredAt: new Date().toISOString(),
  });
  say("this assistant is now linked to your human's World ID");
  return 0;
}

/**
 * @param {string} service
 */
function nextSteps(service) {
  say(`connected: you can now use ${service}`);
  say(`  read mail:    hmail search ${service} "<gmail query>"   then   hmail read ${service} <id>`);
  say(
    `  log in:       hmail type ${service} --site <site> --reason "<why>"   (types the held code into the open Chrome tab; you never see it)`,
  );
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @returns {Promise<number>} */
export async function runConnect(argv, env) {
  const input = parseConnect(argv, env);
  try {
    const linked = await ensureLinked(input);
    if (linked !== 0) return linked;

    const started = Date.now();
    /** @type {string | undefined} */
    let pairRequestId;
    while (true) {
      const outcome = await callHouse({
        service: input.service,
        fn: "pair",
        args: {},
        profile: input.profile,
        home: input.home,
        meta: pairRequestId ? { pairRequestId } : undefined,
        env,
      });
      if (outcome.ok) {
        if (outcome.result.isError === true) {
          process.stderr.write(`error: ${textOf(outcome.result)}\n`);
          return 1;
        }
        nextSteps(input.service);
        return 0;
      }
      if (outcome.code !== "PAIR_PENDING") {
        return reportDenied(outcome, { challenge: false });
      }
      const challenge = /** @type {{ pairRequestId?: unknown, confirm?: unknown }} */ (
        outcome.challenge ?? {}
      );
      if (!pairRequestId) {
        if (typeof challenge.pairRequestId !== "string") {
          process.stderr.write(
            "error: the house sent a pair request without an id\n",
          );
          return 1;
        }
        pairRequestId = challenge.pairRequestId;
        const confirm = String(challenge.confirm ?? "");
        say(
          `HUMAN ACTION REQUIRED: ask your human to open their Hmail page and approve this assistant. Confirm number: ${confirm.slice(0, 3)} ${confirm.slice(3)}`,
        );
        say("waiting for approval (keep this command running)...");
      }
      if (Date.now() - started >= input.waitS * 1000) {
        process.stderr.write("error: gave up waiting for approval\n");
        return 1;
      }
      await sleep(2_000);
    }
  } catch (err) {
    return reportError(err);
  }
}
