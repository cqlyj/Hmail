import { VERSION } from "./version.js";

export class UsageError extends Error {}

export const EXIT = { ok: 0, error: 1, usage: 2, denied: 3, notConnected: 4 };

export const USAGE = `hmail ${VERSION} - phase 1 (mock identity mode only)

usage:
  hmail up --mock [--home <dir>] [--profile <name>] [--owner <humanId>] [--port <n>] [--state-dir <dir>] [--no-tunnel]
  hmail gmail-connect [--state-dir <dir>] [--email <address>]
  hmail inspect <file.eml>
  hmail ping <url> [--profile <name>] [--home <dir>] [--delay-ms <n>]
  hmail search <url> <query> [--max <n>] [--profile <name>] [--home <dir>]
  hmail read <url> <id> [--profile <name>] [--home <dir>]
  hmail help | version

up             start the house: HORS-gated MCP server on 127.0.0.1 plus a Cloudflare quick tunnel
gmail-connect  connect a Gmail inbox read-only (Google sign-in in your browser)
inspect        show the redacted view of a raw email file, locally
ping           call the house's ping tool, signed with a HORS profile (default profile: grokbot)
search, read   search / read mail through the house; held items appear as [held · site · kind]`;
