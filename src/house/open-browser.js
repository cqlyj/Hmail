import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

function isWsl() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

// On WSL, xdg-open usually hands the URL to BROWSER=explorer.exe, which exits 1
// even on success, so xdg-open runs it a second time and two tabs open.
// Calling explorer.exe ourselves opens exactly one.
/** @type {[string, string[]][]} */
const COMMANDS =
  process.platform === "win32"
    ? [["cmd", ["/c", "start", ""]]]
    : process.platform === "darwin"
      ? [["open", []]]
      : isWsl()
        ? [["wslview", []], ["explorer.exe", []], ["/mnt/c/Windows/explorer.exe", []], ["xdg-open", []]]
        : [["xdg-open", []]];

/**
 * Best effort. Never throws.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export function openBrowser(url) {
  return new Promise((resolve) => {
    let settled = false;
    let index = 0;
    const timer = setTimeout(() => finish(false), 2000);

    /**
     * @param {boolean} value
     */
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }

    function next() {
      if (settled) return;
      if (index >= COMMANDS.length) {
        finish(false);
        return;
      }
      const [command, prefix] = COMMANDS[index];
      index += 1;
      /** @type {ReturnType<typeof spawn>} */
      let child;
      try {
        child = spawn(command, [...prefix, url], {
          stdio: "ignore",
          detached: true,
        });
      } catch {
        next();
        return;
      }
      child.once("error", () => next());
      child.once("spawn", () => {
        child.unref();
        finish(true);
      });
    }

    next();
  });
}
