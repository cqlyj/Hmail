import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import googleClient from "./api/google-client.js";
import inspect from "./api/inspect.js";
import issue from "./api/issue.js";
import resolveName from "./api/resolve.js";
import rpContext from "./api/rp-context.js";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const vercel = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vercel.json", import.meta.url)), "utf8"),
);
const csp = vercel.headers
  .flatMap((group) => group.headers)
  .find((header) => header.key === "Content-Security-Policy");
if (!csp || typeof csp.value !== "string") {
  throw new Error("vercel.json is missing Content-Security-Policy");
}
const SECURITY = {
  "Content-Security-Policy": csp.value,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const API = {
  "/api/rp-context": rpContext,
  "/api/issue": issue,
  "/api/google-client": googleClient,
  "/api/resolve": resolveName,
  "/api/inspect": inspect,
};
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {string} pathname
 */
function publicName(pathname) {
  if (pathname === "/") return "index.html";
  let name;
  try {
    name = decodeURIComponent(pathname.slice(1));
  } catch {
    return null;
  }
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.startsWith(".")
  ) {
    return null;
  }
  return name;
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {string|Buffer} body
 */
function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY, ...headers });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:8401");
    const handler = API[url.pathname];
    if (handler) {
      const body = await readBody(req);
      /** @type {Record<string, string>} */
      const headers = {};
      const contentType = req.headers["content-type"];
      const contentLength = req.headers["content-length"];
      if (typeof contentType === "string") headers["content-type"] = contentType;
      if (typeof req.headers.accept === "string") headers.accept = req.headers.accept;
      if (typeof contentLength === "string") {
        headers["content-length"] = contentLength;
      }
      const request = new Request(
        `http://127.0.0.1:8401${url.pathname}${url.search}`,
        {
          method: req.method,
          headers,
          body:
            req.method === "GET" || req.method === "HEAD" ? undefined : body,
        },
      );
      const response = await handler.fetch(request);
      /** @type {Record<string, string>} */
      const out = {};
      response.headers.forEach((value, key) => {
        out[key] = value;
      });
      if (out["content-type"] === "application/x-ndjson" && response.body) {
        // Stream line by line, like Vercel does, so progress shows up live.
        res.writeHead(response.status, { ...SECURITY, ...out });
        for await (const chunk of response.body) res.write(chunk);
        res.end();
        return;
      }
      send(
        res,
        response.status,
        out,
        Buffer.from(await response.arrayBuffer()),
      );
      return;
    }
    if (req.method !== "GET") {
      send(
        res,
        404,
        { "content-type": "text/plain; charset=utf-8" },
        "not found",
      );
      return;
    }
    const name = publicName(url.pathname);
    if (name === null) {
      send(
        res,
        404,
        { "content-type": "text/plain; charset=utf-8" },
        "not found",
      );
      return;
    }
    const path = resolve(publicDir, name);
    const root = publicDir.endsWith(sep) ? publicDir : publicDir + sep;
    if (path !== root.slice(0, -1) && !path.startsWith(root)) {
      send(
        res,
        404,
        { "content-type": "text/plain; charset=utf-8" },
        "not found",
      );
      return;
    }
    const file = await readFile(path);
    const type = TYPES[extname(name)] ?? "application/octet-stream";
    send(res, 200, { "content-type": type }, file);
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
      send(
        res,
        404,
        { "content-type": "text/plain; charset=utf-8" },
        "not found",
      );
      return;
    }
    send(
      res,
      500,
      { "content-type": "application/json" },
      JSON.stringify({ error: "internal error" }),
    );
  }
});

server.listen(8401, "127.0.0.1", () => {
  process.stdout.write("web dev server on http://127.0.0.1:8401\n");
});
