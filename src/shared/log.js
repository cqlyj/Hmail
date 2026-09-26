const RANK = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

/** @param {"debug"|"info"|"warn"|"error"} level @param {string} msg @param {Record<string, unknown>} [data] */
export function log(level, msg, data) {
  const configured = process.env.HMAIL_LOG;
  const threshold =
    configured !== undefined && Object.hasOwn(RANK, configured)
      ? configured
      : "info";
  if (RANK[level] < RANK[threshold]) return;
  const line = { t: new Date().toISOString(), level, msg };
  if (data !== undefined) line.data = data;
  process.stderr.write(`${JSON.stringify(line)}\n`);
}
