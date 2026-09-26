import { HorsError } from "hors-sdk";
import { UsageError } from "../shared/cli.js";
import { errMessage } from "../shared/util.js";

/**
 * @param {{ content?: { type: string, text?: string }[], isError?: boolean }} result
 */
export function textOf(result) {
  return (result.content ?? [])
    .filter((block) => block.type === "text" && "text" in block)
    .map((block) => block.text)
    .join("\n");
}

/**
 * @param {{ code: string, reason: string, challenge?: unknown }} outcome
 * @param {{ challenge?: boolean }} [options] print the challenge line (default true)
 */
export function reportDenied(outcome, { challenge = true } = {}) {
  if (outcome.code === "HORS_UNAVAILABLE") {
    process.stderr.write(`error: HORS_UNAVAILABLE: ${outcome.reason}\n`);
    return 1;
  }
  process.stdout.write(`denied ${outcome.code}: ${outcome.reason}\n`);
  if (challenge && outcome.challenge != null) {
    process.stdout.write(`challenge: ${JSON.stringify(outcome.challenge)}\n`);
  }
  return 3;
}

/**
 * Rethrow UsageError. PROFILE_NOT_FOUND exits 4. Anything else prints and exits 1.
 * @param {unknown} err
 */
export function reportError(err) {
  if (err instanceof UsageError) throw err;
  if (err instanceof HorsError && err.code === "PROFILE_NOT_FOUND") {
    process.stderr.write(`error: ${err.message}\n`);
    return 4;
  }
  process.stderr.write(`error: ${errMessage(err)}\n`);
  return 1;
}

/**
 * @param {import("hors-sdk/client").CallOutcome} outcome
 */
export function report(outcome) {
  if (outcome.ok) {
    const text = textOf(outcome.result);
    if (outcome.result.isError === true) {
      process.stderr.write(`error: ${text}\n`);
      return 1;
    }
    process.stdout.write(`${text}\n`);
    return 0;
  }
  return reportDenied(outcome);
}
