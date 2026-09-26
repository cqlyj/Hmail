import { parseArgs } from "node:util";
import { HorsError } from "hors-sdk";
import { UsageError } from "../shared/cli.js";
import { callHouse } from "./call.js";

/**
 * @param {string} value
 */
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * @param {string} raw
 */
function parseDelay(raw) {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new UsageError("--delay-ms must be an integer");
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new UsageError("--delay-ms must be an integer");
  return n;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
function parsePing(argv, env) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        profile: { type: "string" },
        home: { type: "string" },
        "delay-ms": { type: "string" },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(message);
  }

  const url = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || url === undefined || !isHttpUrl(url)) {
    throw new UsageError("phase 0 accepts an http(s) URL; ENS names arrive in phase 4");
  }

  /** @type {Record<string, never> | { delayMs: number }} */
  let args = {};
  if (parsed.values["delay-ms"] !== undefined) {
    args = { delayMs: parseDelay(parsed.values["delay-ms"]) };
  }

  return {
    url,
    profile: parsed.values.profile ?? env.HORS_PROFILE ?? "grokbot",
    home: parsed.values.home,
    args,
  };
}

/**
 * @param {import("hors-sdk/client").CallOutcome} outcome
 */
function report(outcome) {
  if (outcome.ok) {
    const text = (outcome.result.content ?? [])
      .filter((block) => block.type === "text" && "text" in block)
      .map((block) => block.text)
      .join("\n");
    if (outcome.result.isError === true) {
      process.stderr.write(`${text}\n`);
      return 1;
    }
    process.stdout.write(`${text}\n`);
    return 0;
  }
  if (outcome.code === "HORS_UNAVAILABLE") {
    process.stderr.write(`error: HORS_UNAVAILABLE: ${outcome.reason}\n`);
    return 1;
  }
  process.stdout.write(`denied ${outcome.code}: ${outcome.reason}\n`);
  if (outcome.challenge != null) {
    process.stdout.write(`challenge: ${JSON.stringify(outcome.challenge)}\n`);
  }
  return 3;
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @returns {Promise<number>} */
export async function runPing(argv, env) {
  const input = parsePing(argv, env);
  try {
    const outcome = await callHouse({
      service: input.url,
      fn: "ping",
      args: input.args,
      profile: input.profile,
      home: input.home,
    });
    return report(outcome);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    if (err instanceof HorsError && err.code === "PROFILE_NOT_FOUND") {
      process.stderr.write(`error: ${err.message}\n`);
      return 4;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}
