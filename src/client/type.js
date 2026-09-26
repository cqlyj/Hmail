import { UsageError } from "../shared/cli.js";
import { isEnsName } from "../shared/ens.js";
import { newRecipient, openSealed } from "../shared/seal.js";
import { errMessage } from "../shared/util.js";
import { parseClientArgs, parseUint } from "./args.js";
import { callHouse, resolveService } from "./call.js";
import { findCdpPort, inspectTab } from "./cdp.js";
import { reportDenied, reportError, textOf } from "./report.js";

const CODE_RE = /^[A-Za-z0-9 -]{4,12}$/;
const SITE_RE = /^[a-z0-9.-]{3,253}$/;

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {unknown} challenge
 */
function challengeFields(challenge) {
  const url =
    challenge && typeof challenge === "object" && "url" in challenge
      ? /** @type {{ url?: unknown }} */ (challenge).url
      : "";
  const id =
    challenge && typeof challenge === "object" && "approvalId" in challenge
      ? /** @type {{ approvalId?: unknown }} */ (challenge).approvalId
      : "";
  return {
    url: typeof url === "string" ? url : "",
    id: typeof id === "string" ? id : "",
  };
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
function parseType(argv, env) {
  const parsed = parseClientArgs(argv, env, {
    positionals: 1,
    usage: "type accepts an http(s) URL or an ENS name like lyj.hmail.eth",
    options: {
      site: { type: "string" },
      reason: { type: "string" },
      "wait-s": { type: "string" },
      "no-submit": { type: "boolean", default: false },
    },
  });
  const site = parsed.values.site;
  const reason = parsed.values.reason;
  if (typeof site !== "string" || typeof reason !== "string") {
    throw new UsageError("type requires --site and --reason");
  }
  if (!SITE_RE.test(site)) {
    throw new UsageError("--site must be a site name");
  }
  return {
    url: parsed.service,
    site,
    reason,
    waitS:
      typeof parsed.values["wait-s"] === "string"
        ? parseUint(parsed.values["wait-s"], "--wait-s")
        : 200,
    noSubmit: parsed.values["no-submit"] === true,
    profile: parsed.profile,
    home: parsed.home,
  };
}

/** hmail type <url> --site <site> --reason <text> [--wait-s <n, default 200>] [--no-submit] [--profile <name>] [--home <dir>] */
export async function runType(argv, env) {
  const input = parseType(argv, env);
  if (isEnsName(input.url)) {
    try {
      const resolved = await resolveService(input.url, env);
      process.stdout.write(`house    ${input.url} -> ${resolved}\n`);
    } catch (err) {
      return reportError(err);
    }
  }
  process.stdout.write("checking the browser tab...\n");
  const port = await findCdpPort();
  if (port === null) {
    process.stdout.write(
      "refused: no Chrome debugging port found; the typist only types into a Chrome tab it can verify\n",
    );
    return 3;
  }
  /** @type {Awaited<ReturnType<typeof inspectTab>>} */
  let first;
  try {
    first = await inspectTab(port, input.site);
  } catch {
    process.stdout.write(
      "refused: could not read the browser tabs; the typist only types into a Chrome tab it can verify\n",
    );
    return 3;
  }
  if (!first.ok) {
    process.stdout.write(`refused: ${first.reason}\n`);
    return 3;
  }
  first.page.close();

  const rec = newRecipient();
  const args = {
    site: input.site,
    reason: input.reason,
    recipientKey: rec.publicKey,
  };
  const started = Date.now();
  const budget = input.waitS * 1000;
  /** @type {string | undefined} */
  let approvalId;
  let announced = false;

  while (true) {
    /** @type {import("hors-sdk/client").CallOutcome} */
    let outcome;
    try {
      outcome = await callHouse({
        service: input.url,
        fn: "use_code",
        args,
        profile: input.profile,
        home: input.home,
        meta: approvalId ? { approvalId } : undefined,
        env,
      });
    } catch (err) {
      return reportError(err);
    }

    if (!outcome.ok) {
      if (outcome.code === "APPROVAL_REQUIRED") {
        if (!announced) {
          const fields = challengeFields(outcome.challenge);
          if (fields.id.length === 0) {
            process.stderr.write(
              "error: the house sent a challenge without an approvalId\n",
            );
            return 1;
          }
          process.stdout.write(
            "APPROVAL NEEDED: send this link to your human right now (as a QR code too, if you can).\n" +
              "It expires in 3 minutes. They can also approve it from their Hmail page.\n",
          );
          process.stdout.write(`  ${fields.url}\n`);
          process.stdout.write(`  approval id: ${fields.id}\n`);
          process.stdout.write(
            "Keep this command running: it types the code into the site as soon as they approve.\n",
          );
          approvalId = fields.id;
          announced = true;
        }
      } else if (outcome.code !== "APPROVAL_PENDING") {
        return reportDenied(outcome, { challenge: false });
      }
      if (Date.now() - started >= budget) {
        process.stderr.write("error: gave up waiting for approval\n");
        return 1;
      }
      await sleep(3000);
      continue;
    }

    const text = textOf(outcome.result);
    if (outcome.result.isError === true) {
      process.stderr.write(`error: ${text}\n`);
      return 1;
    }
    /** @type {unknown} */
    let sealed;
    try {
      sealed = JSON.parse(text);
    } catch {
      process.stderr.write("error: unexpected reply from the house\n");
      return 1;
    }

    /** @type {string} */
    let chars;
    try {
      const opened = openSealed(sealed, {
        privateKey: rec.privateKey,
        recipientKey: rec.publicKey,
        site: input.site,
        approvalId,
      });
      if (
        !opened ||
        typeof opened !== "object" ||
        /** @type {{ site?: unknown }} */ (opened).site !== input.site ||
        typeof (/** @type {{ code?: unknown }} */ (opened).code) !== "string" ||
        !CODE_RE.test(/** @type {{ code: string }} */ (opened).code)
      ) {
        throw new Error("sealed code failed to open");
      }
      chars = /** @type {{ code: string }} */ (opened).code.replace(/[ -]/g, "");
    } catch {
      process.stderr.write("error: sealed code failed to open\n");
      return 1;
    }

    /** @type {Awaited<ReturnType<typeof inspectTab>>} */
    let again;
    try {
      again = await inspectTab(port, input.site);
    } catch (err) {
      process.stdout.write(
        `refused after approval: ${errMessage(err)}; the code was released but not typed\n`,
      );
      return 3;
    }
    if (!again.ok) {
      process.stdout.write(
        `refused after approval: ${again.reason}; the code was released but not typed\n`,
      );
      return 3;
    }
    const page = again.page;
    try {
      for (const ch of chars) {
        await page.insertText(ch);
        await sleep(60);
      }
      if (!input.noSubmit) await page.pressEnter();
    } catch {
      try {
        page.close();
      } catch {
        // the tab connection is already gone
      }
      process.stderr.write("error: typing failed\n");
      return 1;
    }
    page.close();
    if (input.noSubmit) {
      process.stdout.write(
        `typed into ${input.site} (not submitted), code spent\n`,
      );
    } else {
      process.stdout.write(`typed into ${input.site}, code spent\n`);
    }
    return 0;
  }
}
