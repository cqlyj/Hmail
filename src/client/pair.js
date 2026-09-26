import { UsageError } from "../shared/cli.js";
import { parseClientArgs } from "./args.js";
import { callHouse } from "./call.js";
import { report, reportError } from "./report.js";

const PAIR_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
function parsePair(argv, env) {
  const parsed = parseClientArgs(argv, env, {
    positionals: 2,
    usage: "pair accepts an http(s) URL or an ENS name, and a pairing code",
  });
  const code = parsed.rest[0].trim().toUpperCase().replace(/ /g, "");
  if (!PAIR_CODE_RE.test(code)) {
    throw new UsageError("the pairing code looks like ABCD-EFGH");
  }
  return {
    url: parsed.service,
    code,
    profile: parsed.profile,
    home: parsed.home,
  };
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @returns {Promise<number>} */
export async function runPair(argv, env) {
  const input = parsePair(argv, env);
  try {
    const outcome = await callHouse({
      service: input.url,
      fn: "pair",
      args: { code: input.code },
      profile: input.profile,
      home: input.home,
      env,
    });
    return report(outcome);
  } catch (err) {
    return reportError(err);
  }
}
