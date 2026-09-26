import { access } from "node:fs/promises";
import { join } from "node:path";
import { UsageError, parseCommandArgs } from "../shared/cli.js";
import { errMessage } from "../shared/util.js";
import { log } from "../shared/log.js";
import { resolveStateDir } from "./config.js";
import { readSealed, writeSealed } from "./sealed-file.js";
import { openVault } from "./vault.js";

const MAX_ENTRIES = 500;

/** @typedef {{ at: string, event: "requested"|"refused"|"approved"|"denied"|"expired"|"released"|"blocked"|"paired", site: string | null,
 *   reason: string|null, callerAddress: string|null, callerHumanId: string|null, approvalId: string|null, code: string|null }} AuditEntry */

/**
 * @param {string|null|undefined} address
 */
function callerLabel(address) {
  if (typeof address !== "string" || address.length === 0) return "-";
  return `${address.slice(0, 10)}\u2026`;
}

/**
 * @param {AuditEntry} entry
 */
function formatLine(entry) {
  const event = String(entry.event).padEnd(9, " ");
  const site = entry.site ?? "";
  const approval = entry.approvalId ?? "-";
  const code = entry.code ?? "-";
  const reason = entry.reason ?? "";
  return `${entry.at}  ${event}  ${site}  caller=${callerLabel(entry.callerAddress)}  approval=${approval}  detail=${code}  reason="${reason}"`;
}

export class AuditLog {
  /**
   * @param {string} stateDir
   * @param {{ seal(purpose: string, value: unknown): string, open(purpose: string, sealed: string): unknown }} vault
   * @param {AuditEntry[]} entries
   */
  constructor(stateDir, vault, entries) {
    this.stateDir = stateDir;
    this.vault = vault;
    this.entries = entries;
    this.dirty = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.timer = null;
    /** @type {Promise<void>} */
    this.tail = Promise.resolve();
  }

  /** loads audit.enc (vault purpose "audit") if present */
  static async open(stateDir, vault) {
    const missing = Symbol("missing");
    const opened = await readSealed(
      stateDir,
      "audit.enc",
      vault,
      "audit",
      missing,
    );
    /** @type {AuditEntry[]} */
    let entries = [];
    if (opened !== missing) {
      if (!Array.isArray(opened))
        throw new Error("sealed data for audit failed to open");
      entries = opened;
    }
    return new AuditLog(stateDir, vault, entries);
  }

  /** fills at = ISO now and missing fields with null; keeps the newest 500; schedules a flush */
  append(partial) {
    /** @type {AuditEntry} */
    const entry = {
      at: new Date().toISOString(),
      event: partial.event,
      site: partial.site ?? null,
      reason: partial.reason ?? null,
      callerAddress: partial.callerAddress ?? null,
      callerHumanId: partial.callerHumanId ?? null,
      approvalId: partial.approvalId ?? null,
      code: partial.code ?? null,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.dirty = true;
    this.schedule();
  }

  schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) =>
        log("error", "audit flush failed", { message: errMessage(err) }),
      );
    }, 25);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** atomic sealed write of audit.enc, mode 600 */
  flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const run = this.tail.then(() => this.write());
    this.tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async write() {
    if (!this.dirty) return;
    const snapshot = this.entries.slice();
    this.dirty = false;
    try {
      await writeSealed(
        this.stateDir,
        "audit.enc",
        this.vault,
        "audit",
        snapshot,
      );
    } catch (err) {
      this.dirty = true;
      throw err;
    }
    const last = this.entries[this.entries.length - 1];
    const snapLast = snapshot[snapshot.length - 1];
    if (this.entries.length !== snapshot.length || last !== snapLast) {
      this.dirty = true;
      this.schedule();
    }
  }

  /** newest first. list(0) is empty. */
  list(limit = 50) {
    if (!(limit > 0)) return [];
    return this.entries.slice(-limit).reverse();
  }
}

/**
 * @param {string|undefined} raw
 */
function parseLimit(raw) {
  if (raw === undefined) return 50;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new UsageError("--limit must be an integer");
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n))
    throw new UsageError("--limit must be an integer");
  return n;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
function parseActivity(argv, env) {
  const parsed = parseCommandArgs(argv, {
    "state-dir": { type: "string" },
    limit: { type: "string" },
  });
  return {
    stateDir: resolveStateDir(parsed.values["state-dir"], env),
    limit: parseLimit(parsed.values.limit),
  };
}

/** hmail activity [--state-dir <dir>] [--limit <n>]: prints entries newest first; returns an exit code */
export async function runActivity(argv, env) {
  const input = parseActivity(argv, env);
  try {
    await access(join(input.stateDir, "audit.enc"));
  } catch {
    process.stdout.write("no activity yet\n");
    return 0;
  }
  const vault = await openVault(input.stateDir);
  const audit = await AuditLog.open(input.stateDir, vault);
  const rows = audit.list(input.limit);
  if (rows.length === 0) {
    process.stdout.write("no activity yet\n");
    return 0;
  }
  for (const row of rows) process.stdout.write(`${formatLine(row)}\n`);
  return 0;
}
