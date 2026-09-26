import { parseArgs } from "node:util";
import { UsageError } from "../shared/cli.js";
import { isEnsName } from "../shared/ens.js";
import { errMessage } from "../shared/util.js";

/**
 * @param {string} value
 */
export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * @param {string} raw
 * @param {string} flag
 */
export function parseUint(raw, flag) {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new UsageError(`${flag} must be an integer`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new UsageError(`${flag} must be an integer`);
  }
  return n;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {{ options?: import("node:util").ParseArgsOptionsConfig, positionals: number, usage: string }} spec
 * @returns {{ service: string, profile: string, home: string | undefined, values: Record<string, string | boolean | undefined>, rest: string[] }}
 */
export function parseClientArgs(argv, env, spec) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        profile: { type: "string" },
        home: { type: "string" },
        ...(spec.options ?? {}),
      },
    });
  } catch (err) {
    throw new UsageError(errMessage(err));
  }
  const service = parsed.positionals[0];
  if (
    service === undefined ||
    (!isHttpUrl(service) && !isEnsName(service))
  ) {
    throw new UsageError(spec.usage);
  }
  if (parsed.positionals.length < spec.positionals) {
    throw new UsageError("missing argument");
  }
  if (parsed.positionals.length > spec.positionals) {
    throw new UsageError(spec.usage);
  }
  return {
    service,
    profile: parsed.values.profile ?? (env.HORS_PROFILE || "hmail-assistant"),
    home: parsed.values.home,
    values: parsed.values,
    rest: parsed.positionals.slice(1),
  };
}
