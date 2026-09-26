import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTunnel, waitForPublic } from "../src/house/tunnel.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = "/tmp/hmail-share";

/** @type {import("node:child_process").ChildProcess | null} */
let packChild = null;
/** @type {import("node:http").Server | null} */
let server = null;
/** @type {{ stop(): void } | null} */
let tunnel = null;
let stopping = false;

function say(line) {
  process.stdout.write(`${line}\n`);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (packChild && packChild.exitCode === null) {
    try {
      packChild.kill("SIGTERM");
    } catch {
      // the pack process is already gone
    }
  }
  try {
    tunnel?.stop();
  } catch {
    // stop is best-effort
  }
  if (server) {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }
  say("stopped");
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});

/**
 * @param {string[]} args
 */
function runPack(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    packChild = child;
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      packChild = null;
      if (code !== 0) {
        reject(
          new Error(err.trim() || out.trim() || `npm pack exited ${code}`),
        );
        return;
      }
      resolve(out);
    });
  });
}

await mkdir(destDir, { recursive: true });
const packedOut = await runPack(["pack", "--pack-destination", destDir]);
const packedName = packedOut
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.endsWith(".tgz"))
  .pop();
if (!packedName) throw new Error("npm pack did not name a tarball");
const packedPath = join(destDir, packedName.split("/").pop());
const bytes = await readFile(packedPath);
const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
const name = `hmail-${sha}.tgz`;
const sharedPath = join(destDir, name);
await copyFile(packedPath, sharedPath);

server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1:8403").pathname;
  if (req.method === "GET" && path === `/${name}`) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(bytes);
    return;
  }
  if (req.method === "GET" && path === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

await new Promise((resolve, reject) => {
  const onError = (err) => {
    server.off("listening", onListening);
    reject(err);
  };
  const onListening = () => {
    server.off("error", onError);
    resolve();
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(8403, "127.0.0.1");
});

tunnel = await startTunnel("http://127.0.0.1:8403");
const check = await waitForPublic(tunnel.url);
if (!check.ok) {
  try {
    tunnel.stop();
  } catch {
    // already stopped
  }
  process.stderr.write(`error: share tunnel not reachable (${check.reason})\n`);
  process.exit(1);
}

const base = tunnel.url.replace(/\/$/, "");
say("share-build ready (Ctrl-C to stop)");
say(`tarball  ${name}`);
say(`bot      npx -y -p node@22 -p ${base}/${name} hmail <command...>`);
