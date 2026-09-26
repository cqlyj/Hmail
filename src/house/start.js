import { randomBytes } from "node:crypto";
import { profileHome } from "hors-sdk/node";
import { log } from "../shared/log.js";
import { errMessage, redactKeys, shortHex } from "../shared/util.js";
import { AgentTracker } from "./agents.js";
import { AuditLog } from "./audit.js";
import { readHouseConfig } from "./config.js";
import { syncEnsRecords } from "./ens-sync.js";
import { UNPAIRED_OWNER, createHouseGate } from "./gate.js";
import { createGmailClient } from "./gmail/client.js";
import { loadGmailToken } from "./gmail/token-store.js";
import { HeldStore } from "./held/store.js";
import { loadHouseConfig, saveHouseConfig } from "./house-config.js";
import { createMailService } from "./mail/service.js";
import { createHouseMcpHandler } from "./mcp.js";
import { openBrowser } from "./open-browser.js";
import { createPairRequests } from "./pairing.js";
import { startHttpServer } from "./server.js";
import { createSetupApi } from "./setup-api.js";
import { ensureStateDir } from "./state.js";
import { startSync } from "./sync.js";
import { startTunnel, waitForPublic } from "./tunnel.js";
import { openVault } from "./vault.js";
import { ensureHouseWallet } from "./wallet.js";
import { ApprovalManager } from "./world/approvals.js";
import { resolveWorld } from "./world/config.js";
import { loadWorldSession } from "./world/session-store.js";

/**
 * @param {string} name
 * @param {string} value
 */
function field(name, value) {
  return `${name.padEnd(8, " ")}${value}`;
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @returns {Promise<void>} */
export async function startHouse(argv, env) {
  const cfg = readHouseConfig(argv, env);
  const home = cfg.home ?? profileHome(process.env);
  process.env.HORS_HOME = home;
  const localUrl = `http://127.0.0.1:${cfg.port}`;

  say(
    cfg.mock
      ? "hmail house - MOCK IDENTITY MODE (fake identities; development only)"
      : "hmail house - REAL IDENTITY MODE",
  );

  const wallet = await ensureHouseWallet(home, cfg.profile);
  if (wallet.created) say(`created house wallet ${wallet.address}`);

  await ensureStateDir(cfg.stateDir);
  const vault = await openVault(cfg.stateDir);
  const state = await loadHouseConfig(cfg.stateDir, vault);
  if (cfg.ensName) {
    state.ensName = cfg.ensName;
    await saveHouseConfig(cfg.stateDir, vault, state);
  }
  const save = () => saveHouseConfig(cfg.stateDir, vault, state);
  let gmailToken = await loadGmailToken(cfg.stateDir, vault);
  const store = await HeldStore.open(cfg.stateDir, vault);
  const audit = await AuditLog.open(cfg.stateDir, vault);
  const pairRequests = createPairRequests();
  const setupToken = randomBytes(16).toString("base64url");

  const server = await startHttpServer({ port: cfg.port, mock: cfg.mock });

  /** @type {{ url: string, stop(): void, onExit(cb: (code: number|null) => void): void } | undefined} */
  let tunnel;
  /** @type {import("hors-sdk").Gate | undefined} */
  let gate;
  /** @type {ReturnType<typeof createGmailClient> | null} */
  let gmail = null;
  /** @type {ReturnType<typeof createMailService> | null} */
  let mail = null;
  /** @type {ReturnType<typeof startSync> | null} */
  let syncHandle = null;
  let gmailExpired = false;
  let shuttingDown = false;
  let signals = 0;
  /** @type {Promise<void>} */
  let gateChain = Promise.resolve();
  /** @type {import("./mcp.js").HouseDeps} */
  let deps;

  const agents = new AgentTracker({
    state,
    save,
    mock: cfg.mock,
    getGate: () => {
      if (!gate) throw new Error("gate is not ready");
      return gate;
    },
  });

  async function shutdown(exitCode, message) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (message) process.stderr.write(`error: ${message}\n`);
    try {
      syncHandle?.stop();
    } catch (err) {
      log("error", "sync stop failed", { message: errMessage(err) });
    }
    try {
      tunnel?.stop();
    } catch (err) {
      log("error", "tunnel stop failed", { message: errMessage(err) });
    }
    try {
      await store.flush();
    } catch (err) {
      log("error", "held flush failed", { message: errMessage(err) });
    }
    try {
      await audit.flush();
    } catch (err) {
      log("error", "audit flush failed", { message: errMessage(err) });
    }
    try {
      await Promise.race([
        server.close().catch((err) => {
          log("error", "server close failed", { message: errMessage(err) });
        }),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch (err) {
      log("error", "server close failed", { message: errMessage(err) });
    }
    if (exitCode === 0) say("stopped");
    process.exit(exitCode);
  }

  function onSignal() {
    signals += 1;
    if (signals >= 2) process.exit(130);
    void shutdown(0);
  }

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("unhandledRejection", (err) => {
    log("error", "unexpected error", {
      message: redactKeys(errMessage(err)),
    });
  });

  /** @type {string} */
  let publicOrigin = localUrl;
  /** @type {string} */
  let publicMcp = `${localUrl}/mcp`;
  /** @type {string[]} */
  let mcpUrls = [publicMcp, `http://localhost:${cfg.port}/mcp`];

  try {
    if (cfg.tunnel) {
      tunnel = await startTunnel(localUrl);
      tunnel.onExit(() => {
        void shutdown(1, "tunnel exited; restart the house");
      });
    }
    publicOrigin = tunnel ? tunnel.url : localUrl;
    publicMcp = `${publicOrigin}/mcp`;
    mcpUrls = [
      `http://127.0.0.1:${cfg.port}/mcp`,
      `http://localhost:${cfg.port}/mcp`,
    ];
    if (tunnel) mcpUrls.push(publicMcp);

    function rebuildGate() {
      const build = async () => {
        const owner = cfg.mock
          ? (cfg.owner ?? state.owner ?? "auto")
          : (state.owner ?? UNPAIRED_OWNER);
        const newGate = await createHouseGate(cfg, mcpUrls, {
          owner,
          deny: state.deny,
        });
        server.setMcp(createHouseMcpHandler(newGate, deps));
        gate = newGate;
        agents.attach(newGate);
      };
      gateChain = gateChain.then(build, build);
      return gateChain;
    }

    function useGmail(token) {
      syncHandle?.stop();
      syncHandle = null;
      gmailToken = token;
      gmailExpired = false;
      gmail = createGmailClient(token);
      mail = createMailService({ gmail, store });
      deps.mail = mail;
      syncHandle = startSync({
        gmail,
        service: mail,
        store,
        intervalMs: cfg.syncIntervalMs,
        onAuthFailed: () => {
          gmailExpired = true;
          say(
            `gmail   token expired or revoked - reconnect on your house page (http://localhost:${cfg.port})`,
          );
        },
      });
    }

    async function onGmailConnected() {
      const next = await loadGmailToken(cfg.stateDir, vault);
      if (!next) return;
      useGmail(next);
    }

    const world = resolveWorld(cfg, env);
    const approvals = new ApprovalManager({
      stateDir: cfg.stateDir,
      vault,
      world,
      houseAddress: wallet.address,
      publicOrigin,
      ensName: () => state.ensName,
      onSettle: (a) =>
        audit.append({
          event: a.status,
          site: a.site,
          reason: a.reason,
          callerAddress: a.callerAddress,
          callerHumanId: a.callerHumanId,
          approvalId: a.id,
          code: a.code,
        }),
    });
    deps = {
      mail: null,
      approvals,
      store,
      audit,
      pair: { state, requests: pairRequests },
    };
    const stored = await loadWorldSession(cfg.stateDir, vault);
    let worldReady =
      stored !== null &&
      stored.environment === world.environment &&
      stored.rp_id === world.rpId;
    await rebuildGate();
    server.setApprovals(approvals);

    /**
     * The owner approved a pair request on the setup page.
     * @param {string} id
     * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
     */
    async function approvePair(id) {
      if (state.owner !== null) {
        return { ok: false, status: 409, error: "already paired" };
      }
      const request = pairRequests.settle(id, true);
      if (!request) return { ok: false, status: 409, error: "request expired" };
      // No await between the owner check and this write, so two approvals can't both land.
      state.owner = /** @type {`0x${string}`} */ (request.callerHumanId);
      try {
        await save();
      } catch (err) {
        state.owner = null;
        pairRequests.reopen(id);
        log("error", "pair save failed", { message: errMessage(err) });
        return { ok: false, status: 500, error: "could not save the owner" };
      }
      audit.append({
        event: "paired",
        site: null,
        reason: null,
        callerAddress: request.callerAddress,
        callerHumanId: request.callerHumanId,
      });
      try {
        await rebuildGate();
      } catch (err) {
        log("error", "gate rebuild after pairing failed", {
          message: errMessage(err),
        });
      }
      say(field("owner", `${shortHex(state.owner)} (paired just now)`));
      return { ok: true };
    }

    async function syncEns(name) {
      return syncEnsRecords({
        name,
        home,
        profile: cfg.profile,
        mcpUrl: publicMcp,
        webOrigin: cfg.webOrigin,
        rpc: cfg.ensRpc,
      });
    }

    server.setSetup(
      createSetupApi({
        token: setupToken,
        webOrigin: cfg.webOrigin,
        mode: cfg.mock ? "mock" : "real",
        houseAddress: wallet.address,
        publicMcp,
        stateDir: cfg.stateDir,
        vault,
        env,
        state,
        save,
        world,
        pairRequests,
        approvePair,
        denyPair: (id) => pairRequests.settle(id, false) !== null,
        activity: (limit) => audit.list(limit),
        isOnline: () => Boolean(tunnel) && !shuttingDown,
        agents,
        isGmailConnected: () => gmailToken !== null,
        isGmailExpired: () => gmailExpired,
        gmailEmail: () => (gmailToken ? gmailToken.email : null),
        onGmailConnected,
        isWorldReady: () => worldReady,
        markWorldReady: () => {
          worldReady = true;
        },
        onNamed: async (name) => {
          if (!tunnel) return;
          return syncEns(name);
        },
      }),
    );

    const setupFragment = Buffer.from(
      JSON.stringify({ h: publicOrigin, k: setupToken }),
    ).toString("base64url");
    const setupUrl = `${cfg.webOrigin}/setup.html#${setupFragment}`;
    const localEntry = `http://localhost:${cfg.port}`;
    server.setLocalEntry(() => setupUrl);
    const worldSession = worldReady
      ? "saved"
      : "not set up (scan on your house page)";

    say(field("house", wallet.address));
    say(
      field(
        "gmail",
        gmailToken
          ? gmailToken.email
          : "not connected (connect it on your house page)",
      ),
    );
    say(
      field(
        "world",
        `${world.environment}, session ${worldSession}, web ${world.webOrigin}`,
      ),
    );
    say(
      field(
        "owner",
        state.owner === null
          ? "no assistant yet - connect one from your house page"
          : shortHex(state.owner),
      ),
    );
    say(field("name", state.ensName ?? "not named yet"));
    say(field("page", `${localEntry}  (your house page; works on this computer)`));
    say(field("local", `${localUrl}/mcp`));
    say(field("public", tunnel ? publicMcp : "off"));

    if (tunnel) {
      const check = await waitForPublic(tunnel.url);
      say(check.ok ? "selfcheck ok" : `selfcheck failed (${check.reason})`);
    } else {
      say("selfcheck skipped");
    }

    if (!state.ensName) {
      say(field("ens", "off"));
    } else if (!tunnel) {
      say(
        field(
          "ens",
          `${state.ensName} skipped (no tunnel; endpoints must be https)`,
        ),
      );
    } else {
      const ensResult = await syncEns(state.ensName);
      log("info", "ens", { name: state.ensName, status: ensResult.status });
      if (ensResult.status === "updated") {
        say(
          field(
            "ens",
            `${state.ensName} mcp updated (block ${ensResult.detail})`,
          ),
        );
      } else if (ensResult.status === "unchanged") {
        say(field("ens", `${state.ensName} up to date`));
      } else {
        say(
          field("ens", `${state.ensName} update failed (${ensResult.detail})`),
        );
      }
    }
    say("ready");

    if (
      env.HMAIL_NO_BROWSER !== "1" &&
      (gmailToken === null ||
        !worldReady ||
        state.ensName === null ||
        state.owner === null)
    ) {
      const opened = await openBrowser(localEntry);
      log("info", "house page opened", { opened });
    }

    if (gmailToken) useGmail(gmailToken);
  } catch (err) {
    if (!shuttingDown) {
      try {
        tunnel?.stop();
      } catch {
        // The tunnel may already be gone.
      }
      try {
        await server.close();
      } catch {
        // The listener may already be closed.
      }
      throw err;
    }
  }
}
