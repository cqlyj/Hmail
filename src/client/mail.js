import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { UsageError } from "../shared/cli.js";
import { parseClientArgs } from "./args.js";
import { callHouse } from "./call.js";
import { report, reportError } from "./report.js";

/**
 * @param {string} raw
 */
function parseMax(raw) {
  if (!/^(?:[1-9]|1[0-9]|20)$/.test(raw)) {
    throw new UsageError("--max must be an integer between 1 and 20");
  }
  return Number(raw);
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {{ max: boolean, cmd: string }} opts
 */
function parseMailArgs(argv, env, opts) {
  const parsed = parseClientArgs(argv, env, {
    positionals: 2,
    usage: `${opts.cmd} accepts an http(s) URL or an ENS name like lyj.hmail.eth`,
    options: opts.max ? { max: { type: "string" } } : {},
  });
  return {
    url: parsed.service,
    second: parsed.rest[0],
    profile: parsed.profile,
    home: parsed.home,
    max:
      opts.max && typeof parsed.values.max === "string"
        ? parseMax(parsed.values.max)
        : undefined,
  };
}

/**
 * @param {() => Promise<import("hors-sdk/client").CallOutcome>} call
 */
async function run(call) {
  try {
    return report(await call());
  } catch (err) {
    return reportError(err);
  }
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @returns {Promise<number>} */
export async function runSearch(argv, env) {
  const input = parseMailArgs(argv, env, { max: true, cmd: "search" });
  /** @type {{ query: string, max?: number }} */
  const args = { query: input.second };
  if (input.max !== undefined) args.max = input.max;
  return run(() =>
    callHouse({
      service: input.url,
      fn: "search",
      args,
      profile: input.profile,
      home: input.home,
      env,
    }),
  );
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @returns {Promise<number>} */
export async function runRead(argv, env) {
  const input = parseMailArgs(argv, env, { max: false, cmd: "read" });
  return run(() =>
    callHouse({
      service: input.url,
      fn: "read",
      args: { id: input.second },
      profile: input.profile,
      home: input.home,
      env,
    }),
  );
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @returns {Promise<number>} */
export async function runAttachment(argv, env) {
  const parsed = parseClientArgs(argv, env, {
    positionals: 3,
    usage: "attachment needs your house's name, a mail id and a filename",
    options: { out: { type: "string" } },
  });
  const [id, filename] = parsed.rest;
  const out =
    typeof parsed.values.out === "string"
      ? parsed.values.out
      : basename(filename).replace(/[^\w.() -]/g, "_") || "attachment";
  try {
    const outcome = await callHouse({
      service: parsed.service,
      fn: "attachment",
      args: { id, filename },
      profile: parsed.profile,
      home: parsed.home,
      env,
    });
    if (!outcome.ok || outcome.result.isError === true) return report(outcome);
    const block = (outcome.result.content ?? []).find(
      (item) => item.type === "resource" && item.resource && typeof item.resource.blob === "string",
    );
    if (!block) {
      process.stderr.write("error: the house sent no file\n");
      return 1;
    }
    const bytes = Buffer.from(block.resource.blob, "base64");
    await writeFile(out, bytes);
    process.stdout.write(`saved ${out} (${bytes.byteLength} bytes)\n`);
    return 0;
  } catch (err) {
    return reportError(err);
  }
}
