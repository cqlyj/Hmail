# World: notes from building Hmail

We used IDKit 4.3.0 (Selfie Check in sessions, server-side verify v4), one production app in the
Developer Portal, World App on a real phone, and AgentBook through HORS, with `agentkit-cli` 0.2.0 to
register assistants.

## Time to first success

Seconds. The first Selfie Check session was accepted on the first scan, and the first proof passed
`/api/v4/verify` on the first try. A code release takes a few seconds of the user's time. AgentBook
checks were instant, because HORS already does the lookup.

## What slowed us down

- `createSession(...).preset(selfieCheck())` throws "Presets are not supported for session flows",
  though the docs show presets with sessions. `.constraints(CredentialRequest("selfie", { signal }))`
  works.
- IDKit loads its WASM with `fetch(file://…)`, which Node doesn't support, so we needed a fetch shim.
- `@hono/node-server` swaps the global `Request`/`Response` by default. IDKit then fails, but only inside
  the server, and silently. It took a while to find (`overrideGlobalObjects: false`).
- `@worldcoin/human-in-the-loop` needs Vercel Workflow, so we wrote our own approval loop for a local
  daemon.
- The simulator has no Selfie Check (Human, Passport, ID, Device only). Every Selfie test needs a real
  phone, and the wrong-face path needs a second person.
- An expired AgentKit link comes back as `malformed_request`, which reads like a bug. Agent mode also
  prints the whole proof to stdout; we filter it before an assistant relays the link.

## What we missed

- Selfie Check in the simulator, with scripted "cancel" and "different face" outcomes.
- IDKit that runs in Node as is.
- AgentKit registration on IDKit 4, with clear `expired` / `cancelled` results.

## The one thing we'd ask for

Selfie Check in the simulator. It was our slowest test loop by far.
