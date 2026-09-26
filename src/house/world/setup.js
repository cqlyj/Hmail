import { randomBytes } from "node:crypto";
import { writeSync } from "node:fs";
import { profileHome, readProfile } from "hors-sdk/node";
import { parseCommandArgs, UsageError } from "../../shared/cli.js";
import { errMessage } from "../../shared/util.js";
import {
  resolveStateDir,
  resolveWebOrigin,
  resolveWorldEnv,
} from "../config.js";
import { ensureStateDir } from "../state.js";
import { openVault } from "../vault.js";
import { resolveWorld } from "./config.js";
import { loadIDKit } from "./idkit.js";
import { saveWorldSession } from "./session-store.js";
import { fetchRpContext } from "./signer-client.js";
import { setupSignal } from "./signals.js";
import { verifyWorldResult } from "./verify.js";

/**
 * @param {string|undefined} raw
 */
function parseTimeout(raw) {
  if (raw === undefined) return 180;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new UsageError("--timeout-s must be a positive integer");
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n))
    throw new UsageError("--timeout-s must be a positive integer");
  return n;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
function parseSetup(argv, env) {
  const parsed = parseCommandArgs(argv, {
    home: { type: "string" },
    profile: { type: "string", default: "hmail-house" },
    "state-dir": { type: "string" },
    "world-env": { type: "string" },
    "web-origin": { type: "string" },
    "timeout-s": { type: "string" },
  });
  const { values } = parsed;
  const home = values.home ?? profileHome(env);
  const stateDir = resolveStateDir(values["state-dir"], env);
  const world = resolveWorld(
    {
      webOrigin: resolveWebOrigin(values["web-origin"], env),
      worldEnv: resolveWorldEnv(values["world-env"], env),
    },
    env,
  );
  return {
    home,
    profile: /** @type {string} */ (values.profile),
    stateDir,
    world,
    timeoutS: parseTimeout(values["timeout-s"]),
  };
}

const VERIFY_CODES = new Set([
  "bad_result",
  "environment_mismatch",
  "nonce_mismatch",
  "session_mismatch",
  "bad_response",
  "signal_mismatch",
  "replayed",
]);

/**
 * @param {{ houseAddress: string, label: string, world: { appId: string, rpId: string, environment: "production"|"sandbox", webOrigin: string, signerUrl: string }, timeoutMs?: number }} input
 * @returns {Promise<{ connectorURI: string, done: Promise<{ ok: boolean, sessionId?: string, result?: unknown, nonce: string, code?: string }> }>}
 */
export async function startWorldSetup(input) {
  const rp = await fetchRpContext(input.world);
  const nonce = randomBytes(16).toString("hex");
  const signal = setupSignal(input.houseAddress, input.label, nonce);
  const idkit = await loadIDKit();
  const req = await idkit.IDKit.createSession({
    app_id: /** @type {`app_${string}`} */ (input.world.appId),
    rp_context: rp,
    action_description: "Hmail: set up your house (Selfie Check)",
    environment: input.world.environment,
  }).constraints(idkit.CredentialRequest("selfie", { signal }));

  const done = req
    .pollUntilCompletion({
      timeout: input.timeoutMs ?? 180_000,
      pollInterval: 2000,
    })
    .then(async (c) => {
      if (!c.success) {
        return {
          ok: false,
          nonce,
          code: typeof c.error === "string" ? c.error : "generic_error",
        };
      }
      const v = await verifyWorldResult(
        c.result,
        { mode: { kind: "create" }, signal, rpNonce: rp.nonce },
        input.world,
      );
      if (!v.ok) return { ok: false, nonce, code: v.code, result: c.result };
      return {
        ok: true,
        sessionId: v.sessionId,
        result: c.result,
        nonce,
      };
    })
    .catch(() => ({ ok: false, nonce, code: "generic_error" }));

  return { connectorURI: req.connectorURI, done };
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @returns {Promise<number>} */
export async function runWorldSetup(argv, env) {
  const cfg = parseSetup(argv, env);
  process.env.HORS_HOME = cfg.home;

  const existing = await readProfile(cfg.home, cfg.profile);
  if (existing === undefined) {
    process.stderr.write(
      "error: house wallet not found; run hmail up once first\n",
    );
    return 1;
  }
  await ensureStateDir(cfg.stateDir);
  const vault = await openVault(cfg.stateDir);

  const started = await startWorldSetup({
    houseAddress: existing.address,
    label: "-",
    world: cfg.world,
    timeoutMs: cfg.timeoutS * 1000,
  });

  writeSync(
    1,
    `world setup for house ${existing.address} (${cfg.world.environment})\n`,
  );
  const qrcode = await import("qrcode-terminal");
  qrcode.default.generate(started.connectorURI, { small: true }, (output) => {
    writeSync(1, `${output}\n`);
  });
  writeSync(1, `${"link".padEnd(9)}${started.connectorURI}\n`);
  writeSync(
    1,
    `scan with World App and complete the Selfie Check (up to ${cfg.timeoutS} s)...\n`,
  );

  const outcome = await started.done;
  if (!outcome.ok || typeof outcome.sessionId !== "string") {
    const code = outcome.code ?? "generic_error";
    if (VERIFY_CODES.has(code) || code.startsWith("verify_")) {
      process.stderr.write(
        `error: World setup failed verification (${code})\n`,
      );
    } else {
      process.stderr.write(`error: World setup not completed (${code})\n`);
    }
    return 1;
  }
  await saveWorldSession(cfg.stateDir, vault, {
    session_id: outcome.sessionId,
    environment: cfg.world.environment,
    rp_id: cfg.world.rpId,
    created_at: new Date().toISOString(),
  });
  writeSync(1, `world session saved (${cfg.world.environment})\n`);
  return 0;
}
