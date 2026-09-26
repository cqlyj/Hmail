import { callHouse } from "./call.js";
import { parseClientArgs, parseUint } from "./args.js";
import { report, reportError } from "./report.js";

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
function parsePing(argv, env) {
  const parsed = parseClientArgs(argv, env, {
    positionals: 1,
    usage: "ping accepts an http(s) URL or an ENS name like lyj.hmail.eth",
    options: {
      "delay-ms": { type: "string" },
    },
  });
  /** @type {Record<string, never> | { delayMs: number }} */
  let args = {};
  if (typeof parsed.values["delay-ms"] === "string") {
    args = { delayMs: parseUint(parsed.values["delay-ms"], "--delay-ms") };
  }
  return {
    url: parsed.service,
    profile: parsed.profile,
    home: parsed.home,
    args,
  };
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
      env,
    });
    return report(outcome);
  } catch (err) {
    return reportError(err);
  }
}
