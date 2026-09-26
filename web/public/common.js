/* Shared helpers for the Hmail pages. Plain script, no build step; exposes window.Hmail. */
(function () {
  "use strict";

  var CLI = "npx -y -p node@22 -p github:cqlyj/hmail hmail";

  /**
   * Builds an element. attrs: class, text, html is NOT supported on purpose.
   * Any other attr is set as an attribute; on* functions become listeners.
   */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (key) {
      var value = a[key];
      if (value === undefined || value === null || value === false) return;
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key.slice(0, 2) === "on" && typeof value === "function") {
        el.addEventListener(key.slice(2), value);
      } else if (value === true) el.setAttribute(key, "");
      else el.setAttribute(key, String(value));
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function append(el, child) {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(function (c) {
        append(el, c);
      });
      return;
    }
    el.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function decodeFragment() {
    try {
      var fragment = location.hash.slice(1);
      if (!fragment) return null;
      var pad = "====".slice(0, (4 - (fragment.length % 4)) % 4);
      var b64 = fragment.replace(/-/g, "+").replace(/_/g, "/") + pad;
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (err) {
      return null;
    }
  }

  /** https origin, or http://127.0.0.1:<port> for development. */
  function houseOrigin(raw) {
    try {
      var url = new URL(raw);
      if (url.origin !== raw) return null;
      if (url.protocol === "https:") return raw;
      if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port) {
        return raw;
      }
    } catch (err) {
      return null;
    }
    return null;
  }

  /** Only World App links (https on world.org or a subdomain). */
  function worldHref(link) {
    try {
      var url = new URL(link);
      var host = url.hostname;
      if (
        url.protocol === "https:" &&
        (host === "world.org" || host.slice(-10) === ".world.org")
      ) {
        return url.href;
      }
    } catch (err) {
      return "";
    }
    return "";
  }

  /** Draws a QR code for text as an inline SVG (qrcode-generator, MIT). */
  function qr(text) {
    var box = h("div", { class: "qr", role: "img", "aria-label": "QR code to scan with World App" });
    try {
      var code = window.qrcode(0, "M");
      code.addData(text);
      code.make();
      var n = code.getModuleCount();
      var quiet = 2;
      var size = n + quiet * 2;
      var ns = "http://www.w3.org/2000/svg";
      var svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 " + size + " " + size);
      svg.setAttribute("shape-rendering", "crispEdges");
      var d = "";
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (code.isDark(r, c)) d += "M" + (c + quiet) + " " + (r + quiet) + "h1v1h-1z";
        }
      }
      var bg = document.createElementNS(ns, "rect");
      bg.setAttribute("width", String(size));
      bg.setAttribute("height", String(size));
      bg.setAttribute("fill", "#ffffff");
      var path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "#000000");
      svg.appendChild(bg);
      svg.appendChild(path);
      box.appendChild(svg);
    } catch (err) {
      box.appendChild(h("p", { class: "muted small", text: "QR unavailable; use the link." }));
    }
    return box;
  }

  var toastTimer = null;
  function toast(message) {
    var old = document.querySelector(".toast");
    if (old) old.remove();
    var el = h("div", { class: "toast", role: "status", text: message });
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.remove();
    }, 2200);
  }

  function copy(text, label) {
    function done() {
      toast((label || "Copied") + " ✓");
    }
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(done, fallback);
    }
    fallback();
    return Promise.resolve();
    function fallback() {
      var area = h("textarea", { class: "sr-only", readonly: true });
      area.value = text;
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (err) {
        ok = false;
      }
      area.remove();
      toast(ok ? (label || "Copied") + " ✓" : "Copy failed; select the text and copy it");
    }
  }

  /** A read-only line with the full text and a Copy button. */
  function copyLine(text, label) {
    return h(
      "div",
      { class: "copyline" },
      h("code", { title: text, text: text }),
      h("button", {
        type: "button",
        class: "btn secondary small",
        text: "Copy",
        onclick: function () {
          copy(text, label);
        },
      }),
    );
  }

  /** QR on larger screens, Open World App button, and the raw link with Copy. */
  function worldPanel(link, caption) {
    var href = worldHref(link);
    if (!href) {
      return h("div", { class: "notice danger", text: "This World App link doesn't look right, so it isn't shown." });
    }
    return h(
      "div",
      { class: "scan" },
      qr(href),
      h(
        "div",
        { class: "stack" },
        h("p", { text: caption || "Scan this with World App on your phone." }),
        h("a", { class: "btn primary", href: href, target: "_blank", rel: "noopener noreferrer", text: "Open World App" }),
        h("p", { class: "muted small", text: "Or copy the link (for the World App simulator):" }),
        copyLine(href, "Link copied"),
      ),
    );
  }

  function shortAddr(a) {
    return typeof a === "string" && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : String(a || "");
  }

  function timeAgo(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    var hr = Math.round(m / 60);
    if (hr < 24) return hr + " h ago";
    return new Date(t).toLocaleDateString();
  }

  function setupPrompt() {
    return [
      "Please set up Hmail for me on this computer.",
      "",
      "Important: this must be my own computer. If you are running on a cloud machine, a remote server or a sandbox, stop and tell me instead of installing anything.",
      "",
      "1. Run this command (it needs Node.js and npm; if they are missing, install Node.js 22 or newer first):",
      "   " + CLI + " up --background",
      "2. It starts Hmail in the background and opens my Hmail page in the browser by itself, so you don't need to open it. When it prints \"Hmail is running\", tell me, and give me the page address it shows (http://localhost:8390).",
      "3. If it prints an error, show it to me.",
      "",
      "Please don't open or read anything in the ~/.hmail folder. It holds my private mail data.",
    ].join("\n");
  }

  function connectPrompt(name) {
    return [
      "Please connect yourself to my Hmail house, " + name + ", so you can read my email safely.",
      "",
      "Run everything on the computer whose Chrome you use: Hmail types login codes into that Chrome.",
      "",
      "1. Run this and keep it running until it finishes (it needs Node.js and npm):",
      "   " + CLI + " connect " + name,
      "2. If it prints \"HUMAN ACTION REQUIRED\" with a World App link, send me that link right away (and show it as a QR code if you can). It expires in about 5 minutes. I'll scan it with World App. Keep the command running.",
      "3. If it prints a confirm number, tell me the number. I'll approve you on my Hmail page. Keep the command running until it says \"connected\".",
      "",
      "If step 1 stops before it prints a World App link (the World registration tool it starts, @worldcoin/agentkit-cli, fails to launch), install Hmail into its own folder and run it from there instead:",
      "   mkdir -p ~/hmail && cd ~/hmail && npm init -y && npm install node@22 github:cqlyj/hmail @worldcoin/agentkit-cli@0.2.0",
      "   then use \"npx hmail\" (inside ~/hmail) wherever this message says " + CLI + ".",
      "",
      "Afterwards, use the same prefix (" + CLI + ") with:",
      "- search " + name + " \"<Gmail search>\"  and  read " + name + " <id>  to read my mail. Login codes and links show up as [held · site · kind]; that's expected.",
      "- type " + name + " --site <site> --reason \"<why>\"  when you need a login code for a site.",
      "  It only types into a Chrome started with a debugging port. If your browser tool doesn't have one, start your own Chrome for Hmail and do the login there, up to the code page:",
      "     google-chrome --remote-debugging-port=9222 --user-data-dir=~/hmail/chrome https://<site>",
      "     (on a Mac: \"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\" with the same flags; chromium works too)",
      "  Then run type. It prints an approval link: send it to me right away, as a QR code too if you can. It expires in 3 minutes (I can also approve it from my Hmail page). Keep type running: it types the code straight into that site's tab once I approve.",
      "  Never ask me to read or type a code for you. If type refuses, tell me what it printed.",
    ].join("\n");
  }

  window.Hmail = {
    h: h,
    clear: clear,
    decodeFragment: decodeFragment,
    houseOrigin: houseOrigin,
    worldHref: worldHref,
    qr: qr,
    toast: toast,
    copy: copy,
    copyLine: copyLine,
    worldPanel: worldPanel,
    shortAddr: shortAddr,
    timeAgo: timeAgo,
    setupPrompt: setupPrompt,
    connectPrompt: connectPrompt,
    LOCAL_PAGE: "http://localhost:8390",
  };
})();
