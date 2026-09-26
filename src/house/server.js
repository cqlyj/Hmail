import { serve } from "@hono/node-server";
import { log } from "../shared/log.js";
import { VERSION } from "../shared/version.js";
import { corsHeaders, json } from "./http.js";

/**
 * @param {{ port: number, mock: boolean }} opts
 * @returns {Promise<{ setMcp(handler: { fetch(request: Request): Promise<Response>, close(): Promise<void> }): void, setApprovals(manager: { view(id: string, token: string): unknown, webOrigin: string }): void, setSetup(api: { handle(request: Request): Promise<Response> }): void, setLocalEntry(target: () => string): void, close(): Promise<void> }>}
 */
export async function startHttpServer(opts) {
  /** @type {{ fetch(request: Request): Promise<Response>, close(): Promise<void> } | null} */
  let mcp = null;
  /** @type {{ view(id: string, token: string): unknown, webOrigin: string } | null} */
  let approvals = null;
  /** @type {{ handle(request: Request): Promise<Response> } | null} */
  let setup = null;
  /** @type {(() => string) | null} */
  let localEntry = null;

  /**
   * True only for requests made on this machine. Tunnel requests carry the
   * tunnel's host name and Cloudflare headers.
   * @param {Request} request
   */
  function isLocal(request) {
    const host = request.headers.get("host") ?? "";
    if (host !== `127.0.0.1:${opts.port}` && host !== `localhost:${opts.port}`) {
      return false;
    }
    return !request.headers.has("cf-connecting-ip") && !request.headers.has("cf-ray");
  }

  const server = serve({
    hostname: "127.0.0.1",
    port: opts.port,
    // Hono's replacement Request/Response globals break IDKit's WebAssembly loading.
    overrideGlobalObjects: false,
    fetch: async (request) => {
      const url = new URL(request.url);
      const path = url.pathname;
      /** @type {Response | undefined} */
      let response;
      try {
        response = await route(request, url, path);
        return response;
      } finally {
        log("info", "http", {
          method: request.method,
          path,
          host: request.headers.get("host"),
          status: response ? response.status : undefined,
          type: response ? response.headers.get("content-type") : undefined,
        });
      }
    },
  });

  /**
   * @param {Request} request
   * @param {URL} url
   * @param {string} path
   */
  async function route(request, url, path) {
    const approvalMatch = /^\/approvals\/([^/]+)$/.exec(path);
    if (path === "/setup" || path.startsWith("/setup/")) {
      if (!setup) return json(503, { error: "starting" });
      return setup.handle(request);
    }
    if (approvals && approvalMatch) {
      const headers = corsHeaders(request, approvals.webOrigin, "GET");
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== "GET") {
        return new Response("not found", { status: 404 });
      }
      let id;
      try {
        id = decodeURIComponent(approvalMatch[1]);
      } catch {
        return new Response("not found", { status: 404 });
      }
      const token = url.searchParams.get("k") ?? "";
      const view = approvals.view(id, token);
      if (view === null) return json(404, { error: "not found" }, headers);
      return json(200, view, headers);
    }
    if (request.method === "GET" && path === "/" && isLocal(request)) {
      if (!localEntry) return new Response("starting, try again in a moment", { status: 503 });
      return new Response(null, {
        status: 302,
        headers: { location: localEntry(), "cache-control": "no-store", "referrer-policy": "no-referrer" },
      });
    }
    if (path === "/mcp") {
      if (!mcp) return json(503, { error: "starting" });
      return mcp.fetch(request);
    }
    if (request.method === "GET" && path === "/healthz") {
      return json(200, {
        ok: true,
        service: "hmail-house",
        version: VERSION,
        mock: opts.mock,
      });
    }
    return new Response("not found", { status: 404 });
  }

  await new Promise((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    const onError = (err) => {
      server.off("listening", onListening);
      if (
        err &&
        /** @type {NodeJS.ErrnoException} */ (err).code === "EADDRINUSE"
      ) {
        reject(
          new Error(
            `port ${opts.port} is in use; Hmail may already be running (open http://localhost:${opts.port}), or pass --port`,
          ),
        );
        return;
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });

  return {
    setMcp(handler) {
      mcp = handler;
    },
    setApprovals(manager) {
      approvals = manager;
    },
    setSetup(api) {
      setup = api;
    },
    setLocalEntry(target) {
      localEntry = target;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      if (mcp) await mcp.close();
    },
  };
}
