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

export const USAGE = `hmail ${VERSION} - keeps login codes from your Gmail away from AI assistants until you approve with World ID

On your own computer (the house):
  hmail up --background      start your house in the background and open your house page
  hmail status | stop | open show, stop, or open your running house (page: http://localhost:8390)
  hmail up [options]         run the house in this terminal instead
      [--port <n>] [--state-dir <dir>] [--home <dir>] [--profile <name>] [--ens-name <name>]
      [--web-origin <url>] [--world-env production|sandbox] [--no-tunnel] [--mock] [--owner <humanId>]
  hmail activity [--limit <n>]              who asked for which code, and what happened
  hmail gmail-connect [--email <address>]   connect Gmail from the terminal (the house page does this too)
  hmail world-setup [--timeout-s <n>]       create your World ID session from the terminal
  hmail inspect <file.eml>                  show the redacted view of a raw email file

For your assistant (any computer, including cloud ones):
  hmail connect <name>                      link this assistant to your World ID (once) and to your house
  hmail search <name> <query> [--max <n>]   search your mail; held codes show as [held · site · kind]
  hmail read <name> <id>                    read one mail, same redaction
  hmail type <name> --site <site> --reason <text> [--wait-s <n>] [--no-submit]
                                            you approve on your phone, then the code is typed into the
                                            site's Chrome tab; it is never shown (Linux + Chrome with
                                            --remote-debugging-port)
  hmail ping <name> [--delay-ms <n>]        check the connection
  Assistant commands take --profile <name> (default hmail-assistant) and --home <dir> (default ~/.hors).
  <name> is your house's ENS name (like lyj.hmail.eth) or its https URL.

  hmail help | version

Environment:
  HMAIL_PORT               house port (default 8390)
  HMAIL_STATE_DIR          where the house keeps its sealed data (default ~/.hmail)
  HMAIL_LOG                log level: debug, info, warn, error, or silent
  HMAIL_WEB_ORIGIN         house page and approval site (default https://hmail-web.vercel.app)
  HMAIL_WORLD_ENV          production or sandbox (default production)
  HMAIL_ENS_NAME           ENS name to adopt on startup
  HMAIL_ENS_RPC            Sepolia RPC for ENS reads and writes
  HMAIL_SIGNER_URL         World RP context URL (default <web origin>/api/rp-context)
  HMAIL_SYNC_INTERVAL_MS   Gmail sync interval in milliseconds (default 15000)
  HORS_PROFILE             assistant profile (default hmail-assistant)
  HORS_HOME                assistant key directory (default ~/.hors)`;
