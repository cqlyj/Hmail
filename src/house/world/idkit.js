import { readFile } from "node:fs/promises";

let installed = false;
/** @type {Promise<typeof import("@worldcoin/idkit-core")> | null} */
let loaded = null;

/** Installs (once) a globalThis.fetch wrapper that serves file: URLs from disk, then returns IDKit. */
export async function loadIDKit() {
  if (!installed) {
    installed = true;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const href =
        input instanceof URL
          ? input.href
          : typeof input === "string"
            ? input
            : input.url;
      if (href.startsWith("file:"))
        return new Response(await readFile(new URL(href)), {
          headers: { "content-type": "application/wasm" },
        });
      return realFetch(input, init);
    };
  }
  if (!loaded) loaded = import("@worldcoin/idkit-core");
  return loaded;
}
