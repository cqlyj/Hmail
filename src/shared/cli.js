import { parseArgs } from "node:util";
import { VERSION } from "./version.js";
import { errMessage } from "./util.js";

export class UsageError extends Error {}

/**
 * House-side commands: no positionals. parseArgs errors become UsageError.
 * @param {string[]} argv
 * @param {import("node:util").ParseArgsOptionsConfig} options
 */
export function parseCommandArgs(argv, options) {
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options,
    });
  } catch (err) {
    throw new UsageError(errMessage(err));
  }
  if (parsed.positionals.length > 0) {
    throw new UsageError(
      `Unexpected argument '${parsed.positionals[0]}'. This command does not take positional arguments`,
    );
  }
  return parsed;
}

export const USAGE = `hmail ${VERSION} - real identity by default; --mock for development

usage:
  hmail [up] [--home <dir>] [--profile <name>] [--owner <humanId>] [--port <n>] [--state-dir <dir>] [--web-origin <url>] [--world-env production|sandbox] [--ens-name <name>] [--no-tunnel] [--mock]
  hmail gmail-connect [--state-dir <dir>] [--email <address>]
  hmail world-setup [--home <dir>] [--profile <name>] [--state-dir <dir>] [--world-env production|sandbox] [--web-origin <url>] [--timeout-s <n>]
  hmail activity [--state-dir <dir>] [--limit <n>]
  hmail inspect <file.eml>
  hmail ping <url|name> [--profile <name>] [--home <dir>] [--delay-ms <n>]
  hmail search <url|name> <query> [--max <n>] [--profile <name>] [--home <dir>]
  hmail read <url|name> <id> [--profile <name>] [--home <dir>]
  hmail type <url|name> --site <site> --reason <text> [--wait-s <n>] [--no-submit] [--profile <name>] [--home <dir>]
  hmail pair <url|name> <code> [--profile <name>] [--home <dir>]
  hmail help | version

up             start the house (default profile hmail-house): HORS-gated MCP server on 127.0.0.1 plus a Cloudflare quick tunnel (--mock and --owner are development only)
gmail-connect  connect a Gmail inbox read-only (Google sign-in in your browser)
world-setup    create your World ID Selfie Check session (one scan). --timeout-s limits the wait
activity       show who asked for which code, and what happened
inspect        show the redacted view of a raw email file, locally
ping           call the house's ping tool, signed with a HORS profile (default profile: grokbot)
search, read   search / read mail through the house (default profile: grokbot); held items appear as [held · site · kind]
type           get a held code released (owner approves with World ID) and type it into the site's Chrome tab; never prints it. --wait-s defaults to 200. Needs Linux and Chrome started with --remote-debugging-port (default profile: grokbot)
pair           make your human the owner of a new house, using the code from the setup page (default profile: grokbot)

(names resolve on Sepolia; set HMAIL_ENS_RPC to use another Sepolia RPC)

Environment:
  HMAIL_ENS_RPC            Sepolia RPC for ENS reads and writes
  HMAIL_LOG                log level: debug, info, warn, error, or silent
  HMAIL_PORT               house listen port (default 8390)
  HMAIL_STATE_DIR          sealed state directory (default ~/.hmail)
  HMAIL_WEB_ORIGIN         setup and approval web origin (default https://hmail-web.vercel.app)
  HMAIL_WORLD_ENV          production or sandbox (default production)
  HMAIL_ENS_NAME           ENS name to adopt on startup
  HMAIL_SIGNER_URL         World RP context URL (default <web origin>/api/rp-context)
  HMAIL_SYNC_INTERVAL_MS   Gmail sync interval in milliseconds (default 15000)
  HORS_PROFILE             default profile for ping, search, read, type, and pair (default grokbot)
  HORS_HOME                HORS home directory (default ~/.hors)`;
