import { VERSION } from "./version.js";

export class UsageError extends Error {}

export const EXIT = { ok: 0, error: 1, usage: 2, denied: 3, notConnected: 4 };

export const USAGE = `hmail ${VERSION} - phase 0 (mock mode only)

usage:
  hmail up --mock [--home <dir>] [--profile <name>] [--owner <humanId>] [--port <n>] [--no-tunnel]
  hmail ping <url> [--profile <name>] [--home <dir>] [--delay-ms <n>]
  hmail help | version

up    start the house: HORS-gated MCP server on 127.0.0.1 plus a Cloudflare quick tunnel
ping  call the house's ping tool, signed with a HORS profile (default profile: grokbot)`;
