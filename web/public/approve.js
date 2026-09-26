/* Approval page: checks which house sent the link, then shows the request and the World App scan. */
(function () {
  "use strict";
  var H = window.Hmail;
  var h = H.h;
  var app = document.getElementById("app");
  var countdownSlot = document.getElementById("countdown");
  var NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\.hmail\.eth$/;

  var pollTimer = null;
  var tickTimer = null;
  var failures = 0;
  var expiresAtMs = null;
  var houseLine = null;
  var shownKey = null;

  function stop() {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
    H.clear(countdownSlot);
  }

  function show(node) {
    H.clear(app);
    app.appendChild(node);
  }

  function bigState(kind, icon, title, text) {
    return h(
      "section",
      { class: "card big-state " + kind },
      h("div", { class: "icon", "aria-hidden": "true", text: icon }),
      h("h1", { text: title }),
      text ? h("p", { class: "muted", text: text }) : null,
    );
  }

  function refuse(title, text) {
    stop();
    shownKey = null;
    show(bigState("danger", "!", title, text));
  }

  function decode() {
    var json = H.decodeFragment();
    if (!json || typeof json.h !== "string" || typeof json.i !== "string" || typeof json.k !== "string") return null;
    if (!H.houseOrigin(json.h)) return null;
    if (!/^a_[0-9a-f]{16}$/.test(json.i)) return null;
    if (!/^[A-Za-z0-9_-]{22}$/.test(json.k)) return null;
    if (json.n !== undefined && (typeof json.n !== "string" || !NAME_RE.test(json.n))) return null;
    return json;
  }

  var link = decode();
  if (!link) {
    refuse("This approval link is broken", "Ask your assistant for a new one.");
    return;
  }

  if (typeof link.n === "string") {
    show(h("section", { class: "card" }, h("div", { class: "waiting" }, h("span", { class: "spinner" }), "Checking which house sent this…")));
    checkName(link);
  } else if (new URL(link.h).protocol === "https:") {
    refuse("This link doesn't say which house sent it", "It can't be checked, so don't approve it.");
  } else {
    houseLine = h("span", { class: "pill warn", text: "Local test house (not checked)" });
    startPolling();
  }

  function checkName(current) {
    fetch("/api/resolve?name=" + encodeURIComponent(current.n), { cache: "no-store" })
      .then(function (res) {
        return res.json().then(function (body) {
          var mcpOrigin = "";
          try {
            mcpOrigin = new URL(body.mcp).origin;
          } catch (err) {
            mcpOrigin = "";
          }
          return res.ok && mcpOrigin === current.h && body.web === location.origin;
        });
      })
      .catch(function () {
        return false;
      })
      .then(function (ok) {
        if (!ok) {
          refuse(
            "This link doesn't match " + current.n,
            "The address in the link isn't the one " + current.n + " publishes on ENS. Don't approve it.",
          );
          return;
        }
        houseLine = h("span", { class: "pill ok", text: "From " + current.n + " · verified" });
        startPolling();
      });
  }

  function startPolling() {
    poll();
    pollTimer = setInterval(poll, 2000);
  }

  function poll() {
    fetch(link.h + "/approvals/" + link.i + "?k=" + encodeURIComponent(link.k), { cache: "no-store" })
      .then(function (res) {
        if (res.status === 404) {
          refuse("This request is gone", "It expired or your house restarted. Ask your assistant to try again.");
          return null;
        }
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        failures = 0;
        render(data);
      })
      .catch(function () {
        failures += 1;
        if (failures >= 5) refuse("Can't reach your house", "Hmail may have stopped. Ask your assistant to try again once it's running.");
      });
  }

  function leftText() {
    if (expiresAtMs === null) return "";
    var s = Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + " left";
  }

  function tick() {
    H.clear(countdownSlot);
    var text = leftText();
    if (text) countdownSlot.appendChild(h("span", { class: "pill plain", text: text }));
  }

  function render(data) {
    var ms = Date.parse(data.expiresAt);
    expiresAtMs = isFinite(ms) ? ms : null;
    var site = String(data.site || "");
    var key = [data.status, data.worldUrl, site, data.reason].join("|");
    if (key === shownKey) return;
    shownKey = key;

    if (data.status === "approved" || data.status === "used") {
      stop();
      show(bigState("ok", "✓", "Approved", "Your assistant is typing the code into " + site + " now. It never sees the digits."));
      return;
    }
    if (data.status === "denied") {
      stop();
      show(bigState("warn", "×", "Not approved", data.code === "user_rejected" ? "You declined in World App. Nothing was released." : "The face check didn't pass. Nothing was released."));
      return;
    }
    if (data.status === "expired") {
      stop();
      show(bigState("warn", "⏱", "This request expired", "Nothing was released. Ask your assistant to try again."));
      return;
    }

    if (!tickTimer) {
      tick();
      tickTimer = setInterval(tick, 1000);
    }
    var card = h(
      "section",
      { class: "card" },
      h("div", { class: "approval-head" }, houseLine),
      h("p", { class: "muted", text: "Your assistant wants to log in to" }),
      h("div", { class: "approval-site", text: site }),
      data.reason ? h("p", { class: "reason", text: "“" + data.reason + "”" }) : null,
      h("div", { class: "notice warn", text: "Approve only if you asked your assistant to sign in to " + site + " just now." }),
    );
    var scan = h("section", { class: "card" }, h("h2", { text: "Approve with your face" }));
    if (typeof data.worldUrl === "string" && H.worldHref(data.worldUrl)) {
      scan.appendChild(H.worldPanel(data.worldUrl, "Scan with World App, then do the Selfie Check. To decline, tap Decline in World App or just close this page."));
    } else {
      scan.appendChild(h("div", { class: "waiting" }, h("span", { class: "spinner" }), "Preparing the World App request…"));
    }
    var wrap = h("div", {}, card, scan);
    show(wrap);
  }
})();
