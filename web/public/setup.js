/* The house page: setup wizard, then the dashboard. Talks to the local house over its setup API. */
(function () {
  "use strict";
  var H = window.Hmail;
  var h = H.h;
  var app = document.getElementById("app");
  var statusSlot = document.getElementById("status");
  var LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

  var link = H.decodeFragment();
  if (!link) {
    // A refresh: the fragment was moved into this tab's session storage below.
    try {
      link = JSON.parse(sessionStorage.getItem("hmail-house") || "null");
    } catch (err) {
      link = null;
    }
  }
  var house = link && typeof link.h === "string" ? H.houseOrigin(link.h) : null;
  var key = link && typeof link.k === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(link.k) ? link.k : null;

  if (!house || !key) {
    renderNoLink();
    return;
  }
  // Keep the secret out of the address bar and history; this tab still survives a refresh.
  try {
    sessionStorage.setItem("hmail-house", JSON.stringify({ h: house, k: key }));
    history.replaceState(null, "", location.pathname);
  } catch (err) {
    /* storage can be blocked; the page still works until it's closed */
  }

  var state = null;
  var failures = 0;
  var busy = {};
  var local = { changingName: false, showConnect: false, gmailWindow: null };
  var activity = [];
  var sections = {};
  var pollTimer = null;
  var activityTimer = null;

  function api(path, method, body) {
    var opts = { method: method || "GET", cache: "no-store", headers: {} };
    if (body !== undefined) {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(house + path + "?k=" + encodeURIComponent(key), opts).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          return { status: res.status, ok: res.ok, data: data || {} };
        });
    });
  }

  function errorText(out, fallback) {
    var e = out && out.data && typeof out.data.error === "string" ? out.data.error : "";
    return e ? e.charAt(0).toUpperCase() + e.slice(1) + "." : fallback;
  }

  /* ---------- rendering: each section redraws only when its key changes ---------- */

  function section(id, keyValue, build) {
    var s = sections[id];
    var serialized = JSON.stringify(keyValue);
    if (s && s.key === serialized) return s.el;
    var el = build();
    if (s && s.el.parentNode) s.el.parentNode.replaceChild(el, s.el);
    sections[id] = { key: serialized, el: el };
    return el;
  }

  function mountOrder(ids) {
    var wanted = ids.map(function (id) {
      return sections[id] && sections[id].el;
    });
    var current = Array.prototype.slice.call(app.children);
    var same =
      wanted.length === current.length &&
      wanted.every(function (el, i) {
        return el === current[i];
      });
    if (same) return;
    H.clear(app);
    wanted.forEach(function (el) {
      if (el) app.appendChild(el);
    });
    Object.keys(sections).forEach(function (id) {
      if (ids.indexOf(id) < 0) delete sections[id];
    });
  }

  function render() {
    if (!state) return;
    renderStatus();
    var done = setupDone();
    if (done) renderDashboard();
    else renderWizard();
  }

  function setupDone() {
    return (
      state.gmail.connected &&
      state.world.session &&
      !!state.name.ensName &&
      state.owner.paired
    );
  }

  function renderStatus() {
    H.clear(statusSlot);
    if (failures < 3 && state.mode !== "mock" && setupDone()) return;
    if (failures >= 3) {
      statusSlot.appendChild(h("span", { class: "pill danger", text: "Can't reach house" }));
    } else if (state.mode === "mock") {
      statusSlot.appendChild(h("span", { class: "pill warn", text: "Test mode" }));
    } else if (state.online) {
      statusSlot.appendChild(h("span", { class: "pill ok", text: "Online" }));
    } else {
      statusSlot.appendChild(h("span", { class: "pill", text: "Local only" }));
    }
  }

  /* ---------- wizard ---------- */

  function stepStates() {
    var s = state;
    var gmail = s.gmail.connected ? "done" : "current";
    var name = s.name.ensName || (s.name.pendingLabel && !local.changingName) ? "done" : gmail === "done" ? "current" : "locked";
    var scan = s.world.session && s.name.ensName && !s.name.issuing ? "done" : name === "done" ? "current" : "locked";
    var connect = s.owner.paired ? "done" : scan === "done" ? "current" : "locked";
    return { gmail: gmail, name: name, scan: scan, connect: connect };
  }

  function renderWizard() {
    var st = stepStates();
    section("intro", [st], function () {
      var labels = [
        ["gmail", "Gmail"],
        ["name", "Name"],
        ["scan", "Face check"],
        ["connect", "Assistant"],
      ];
      return h(
        "div",
        {},
        h("h1", { text: "Set up your house" }),
        h("p", { class: "muted", text: "Four short steps. Your mail and codes stay on this computer." }),
        h(
          "ol",
          { class: "progress", "aria-label": "Setup progress" },
          labels.map(function (pair) {
            return h(
              "li",
              { class: st[pair[0]] },
              h("div", { class: "bar" }),
              h("span", { class: "label", text: pair[1] }),
            );
          }),
        ),
      );
    });
    section("gmail", [st.gmail, state.gmail, !!busy.gmail], buildGmail);
    section("name", [st.name, state.name, local.changingName, !!busy.name], buildName);
    section("scan", [st.scan, state.world, state.name, !!busy.world], buildScan);
    section("connect", [st.connect, state.name.ensName, state.pairRequests, state.owner.paired], buildConnect);
    mountOrder(["intro", "gmail", "name", "scan", "connect"]);
  }

  function doneRow(what, detail, action, more) {
    return h(
      "div",
      { class: "step done" },
      h("span", { class: "check", "aria-hidden": "true", text: "✓" }),
      h("span", { class: "what", text: what }),
      h("span", { class: "detail" }, detail, action ? [" ", action] : null),
      more ? h("div", { class: "more" }, more) : null,
    );
  }

  /* ---------- on-chain progress (streamed from the issuer through the house) ---------- */

  var STEP_LABELS = {
    scan: "Face check verified",
    resolver: "Create your name's resolver",
    fund: "Top up your house for its own updates",
    register: "Register your name",
    records: "Point it at the Hmail app",
    grants: "Give your house its two record keys",
    renounce: "Issuer gives up its rights",
    verify: "Final checks on chain",
    publish: "Your house publishes its address",
  };
  var EXPECTED_STEPS = ["scan", "resolver", "register", "records", "grants", "renounce", "verify", "publish"];
  var elapsedTimer = null;

  function timeline(progress, name) {
    var byId = {};
    (progress && progress.steps ? progress.steps : []).forEach(function (step) {
      byId[step.id] = step;
    });
    var ids = EXPECTED_STEPS.slice();
    if (byId.fund) ids.splice(2, 0, "fund");
    return h(
      "ol",
      { class: "timeline", "aria-label": "Creating " + name },
      ids.map(function (id) {
        var step = byId[id];
        var status = step ? step.status : "upcoming";
        var label = id === "register" ? "Register " + name : STEP_LABELS[id] || id;
        var txs = step && step.txs && step.txs.length
          ? h(
              "div",
              { class: "txs" },
              step.txs.map(function (tx) {
                return h("a", {
                  href: "https://sepolia.etherscan.io/tx/" + tx,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  title: "View this transaction on Etherscan",
                  text: "tx " + tx.slice(0, 8) + "…" + tx.slice(-4) + " ↗",
                });
              }),
            )
          : null;
        return h(
          "li",
          { class: status },
          h("span", { class: "dot", "aria-hidden": "true", text: status === "done" ? "✓" : status === "failed" ? "✕" : "" }),
          h("div", {}, h("div", { class: "label", text: label }), txs),
        );
      }),
    );
  }

  function elapsed(startedAt) {
    var span = h("span", { class: "elapsed" });
    var start = Date.parse(startedAt);
    function tick() {
      var sec = isFinite(start) ? Math.max(0, Math.round((Date.now() - start) / 1000)) : 0;
      span.textContent = Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
    }
    tick();
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(tick, 1000);
    return span;
  }

  function inspectorLink(name) {
    return h("a", { href: "/inspect.html?name=" + encodeURIComponent(name), text: "See " + name + " in the ENS inspector" });
  }

  function lockedRow(what) {
    return h("div", { class: "step locked", text: what });
  }

  function stepCard(n, title, why) {
    var body = h("div", { class: "stack" });
    var card = h(
      "section",
      { class: "card step" },
      h("div", { class: "step-kicker", text: "Step " + n + " of 4" }),
      h("h2", { text: title }),
      why ? h("p", { class: "muted", text: why }) : null,
      body,
    );
    return { card: card, body: body };
  }

  function buildGmail() {
    var st = stepStates().gmail;
    if (st === "done") return doneRow("Gmail connected", state.gmail.email || "");
    var c = stepCard(1, "Connect your Gmail", "Hmail reads your mail on this computer (read-only). Codes and sign-in links are held back from your assistant.");
    if (state.gmail.expired) {
      c.body.appendChild(h("div", { class: "notice warn", text: "Google signed Hmail out (this happens every 7 days while the app is in testing). Connect again to keep reading mail." }));
    }
    if (state.gmail.pending) {
      c.body.appendChild(
        h("div", { class: "waiting" }, h("span", { class: "spinner" }), "Waiting for Google… finish signing in in the other tab."),
      );
      c.body.appendChild(h("button", { type: "button", class: "linkish small", text: "Didn't open? Try again", onclick: startGmail }));
      return c.card;
    }
    c.body.appendChild(
      h("button", { type: "button", class: "btn primary", disabled: !!busy.gmail, text: busy.gmail ? "Opening Google…" : "Connect Gmail", onclick: startGmail }),
    );
    if (busy.gmailError) c.body.appendChild(h("div", { class: "notice danger", text: busy.gmailError }));
    return c.card;
  }

  function startGmail() {
    if (busy.gmail) return;
    // Open the tab now, inside the click, so pop-up blockers allow it.
    var w = window.open("", "_blank");
    busy.gmail = true;
    busy.gmailError = null;
    render();
    api("/setup/gmail", "POST", {})
      .then(function (out) {
        if (out.ok && typeof out.data.url === "string" && out.data.url.indexOf("https://accounts.google.com/") === 0) {
          if (w) {
            w.opener = null;
            w.location.href = out.data.url;
          } else {
            location.assign(out.data.url);
          }
        } else if (out.status === 409) {
          if (w) w.close();
        } else {
          if (w) w.close();
          busy.gmailError = errorText(out, "Couldn't start Google sign-in.") + " Try again.";
        }
      })
      .catch(function () {
        if (w) w.close();
        busy.gmailError = "Couldn't reach your house. Try again.";
      })
      .finally(function () {
        busy.gmail = false;
        poll();
      });
  }

  function buildName() {
    var st = stepStates().name;
    if (st === "locked") return lockedRow("2 · Choose a name");
    if (st === "done") {
      var named = state.name.ensName;
      var change =
        !named && !state.name.issuing && !state.world.pending
          ? h("button", {
              type: "button",
              class: "linkish small",
              text: "Change",
              onclick: function () {
                local.changingName = true;
                render();
              },
            })
          : null;
      return doneRow(
        named ? "Name" : "Name chosen",
        named || state.name.pendingLabel + ".hmail.eth" + (named ? "" : " (yours after the face check)"),
        change,
      );
    }
    var c = stepCard(2, "Choose a name for your house", "Your assistants find your house by this name. It's yours for good.");
    var input = h("input", {
      id: "label",
      autocomplete: "off",
      autocapitalize: "none",
      spellcheck: "false",
      inputmode: "url",
      maxlength: "32",
      placeholder: "yourname",
      "aria-label": "House name",
    });
    if (state.name.pendingLabel) input.value = state.name.pendingLabel;
    var hint = h("p", { class: "muted small", text: "3 to 32 letters, numbers or dashes." });
    var error = h("div", { class: "notice danger", hidden: true });
    var button = h("button", { type: "submit", class: "btn primary", text: "Choose name" });
    var form = h(
      "form",
      { class: "stack" },
      h("div", { class: "field" }, input, h("span", { class: "suffix", text: ".hmail.eth" })),
      hint,
      error,
      h("div", { class: "row" }, button, local.changingName ? h("button", {
        type: "button",
        class: "btn secondary",
        text: "Cancel",
        onclick: function () {
          local.changingName = false;
          render();
        },
      }) : null),
    );
    input.addEventListener("input", function () {
      var v = input.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
      if (v !== input.value) input.value = v;
      error.hidden = true;
    });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var label = input.value.trim().toLowerCase();
      if (!LABEL_RE.test(label)) {
        error.textContent = "Use 3 to 32 lowercase letters, numbers or dashes, not starting or ending with a dash.";
        error.hidden = false;
        input.focus();
        return;
      }
      button.disabled = true;
      button.textContent = "Checking…";
      api("/setup/name", "POST", { label: label })
        .then(function (out) {
          if (out.ok) {
            local.changingName = false;
            poll();
            return;
          }
          error.textContent =
            out.data.error === "name taken"
              ? label + ".hmail.eth is taken. Try another."
              : errorText(out, "Couldn't check that name.") + " Try again.";
          error.hidden = false;
        })
        .catch(function () {
          error.textContent = "Couldn't reach your house. Try again.";
          error.hidden = false;
        })
        .finally(function () {
          button.disabled = false;
          button.textContent = "Choose name";
        });
    });
    c.body.appendChild(form);
    setTimeout(function () {
      if (document.activeElement === document.body) input.focus();
    }, 0);
    return c.card;
  }

  function buildScan() {
    var st = stepStates().scan;
    if (st === "locked") return lockedRow("3 · Scan your face with World App");
    if (st === "done") {
      var named = state.name.ensName;
      var more = state.name.progress
        ? h(
            "details",
            { class: "prompt" },
            h("summary", { text: "How your name was created" }),
            timeline(state.name.progress, named),
            h("p", { class: "small" }, inspectorLink(named)),
          )
        : h("span", { class: "small" }, inspectorLink(named));
      return doneRow("Face check ready", named, null, more);
    }
    var label = state.name.ensName || (state.name.pendingLabel || "") + ".hmail.eth";
    var c = stepCard(3, "Scan your face with World App", "One Selfie Check proves you're a real person. It creates " + label + " for you and lets you approve logins later.");
    var w = state.world;
    var n = state.name;
    if (n.issuing) {
      c.body.appendChild(
        h(
          "div",
          { class: "row between" },
          h("strong", { text: "Creating " + label + " on ENS" }),
          h("span", { class: "pill plain" }, elapsed(n.progress ? n.progress.startedAt : new Date().toISOString())),
        ),
      );
      c.body.appendChild(h("p", { class: "muted small", text: "Each step is a real Sepolia transaction. Click one to see it on Etherscan. Usually under a minute." }));
      c.body.appendChild(timeline(n.progress, label));
      return c.card;
    }
    if (w.pending && w.link) {
      c.body.appendChild(H.worldPanel(w.link, "Scan this with World App on your phone, then do the Selfie Check."));
      c.body.appendChild(h("div", { class: "waiting" }, h("span", { class: "spinner" }), "Waiting for your scan…"));
      return c.card;
    }
    var problem = n.error || w.error || busy.worldError;
    if (problem) {
      c.body.appendChild(h("div", { class: "notice danger", text: friendlyScanError(problem) }));
      if (n.progress) c.body.appendChild(timeline(n.progress, label));
    }
    c.body.appendChild(
      h("button", {
        type: "button",
        class: "btn primary",
        disabled: !!busy.world,
        text: busy.world ? "Preparing…" : problem ? "Try again" : "Start face check",
        onclick: startWorld,
      }),
    );
    return c.card;
  }

  function friendlyScanError(code) {
    if (/TX_FAILED|name issuance failed/.test(code)) return "Your face check worked, but creating the name failed. Scan again to retry; nothing was lost.";
    if (/timeout|expired/i.test(code)) return "The scan timed out. Start again when your phone is ready.";
    if (/cancel|reject/i.test(code)) return "The scan was cancelled in World App.";
    if (/endpoint update failed/.test(code)) return "Your name was created, but the house couldn't publish its address yet. It retries on the next start.";
    return "That didn't work (" + code + "). Try again.";
  }

  function startWorld() {
    if (busy.world) return;
    busy.world = true;
    busy.worldError = null;
    render();
    api("/setup/world", "POST", {})
      .then(function (out) {
        if (!out.ok && out.data.error !== "world setup already starting") {
          busy.worldError = errorText(out, "Couldn't start the face check.");
        }
      })
      .catch(function () {
        busy.worldError = "Couldn't reach your house.";
      })
      .finally(function () {
        busy.world = false;
        poll();
      });
  }

  function connectPanel(name) {
    var prompt = H.connectPrompt(name);
    return h(
      "div",
      { class: "stack" },
      h("button", {
        type: "button",
        class: "btn primary",
        text: "Copy message for your assistant",
        onclick: function () {
          H.copy(prompt, "Message copied");
        },
      }),
      h("p", { class: "muted small", text: "Paste it to Grok, Claude or any assistant with a terminal. It may send you a World App link to scan once." }),
      h("details", { class: "prompt" }, h("summary", { text: "See the message" }), h("pre", { class: "prompt-text", text: prompt })),
      linkToQr(),
    );
  }

  /** Turns a World App link the assistant sent into a QR you can scan from this screen. */
  function linkToQr() {
    var out = h("div", {});
    var input = h("input", {
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "https://world.org/verify?…",
      "aria-label": "World App link from your assistant",
    });
    var form = h(
      "form",
      { class: "stack" },
      h("p", { class: "small", text: "Got a World App link from your assistant? Paste it here to scan it as a QR." }),
      h("div", { class: "row" }, h("div", { class: "field grow" }, input), h("button", { type: "submit", class: "btn secondary", text: "Show QR" })),
      out,
    );
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      H.clear(out);
      var href = H.worldHref(input.value.trim());
      if (!href) {
        out.appendChild(h("div", { class: "notice danger", text: "That isn't a World App link (it should start with https://world.org/)." }));
        return;
      }
      out.appendChild(H.worldPanel(href, "Scan this with World App. It links your assistant to your World ID (only needed once per assistant)."));
    });
    return h("div", { class: "card flat" }, form);
  }

  function pairRequestCard(req) {
    var confirm = String(req.confirm);
    var approve = h("button", { type: "button", class: "btn primary", text: "Approve" });
    var decline = h("button", { type: "button", class: "btn secondary", text: "Decline" });
    function settle(yes) {
      approve.disabled = true;
      decline.disabled = true;
      api("/setup/pair", "POST", { id: req.id, approve: yes })
        .then(function (out) {
          if (!out.ok) H.toast(errorText(out, "That didn't work."));
          else H.toast(yes ? "Assistant connected" : "Request declined");
        })
        .catch(function () {
          H.toast("Couldn't reach your house");
        })
        .finally(poll);
    }
    approve.addEventListener("click", function () {
      settle(true);
    });
    decline.addEventListener("click", function () {
      settle(false);
    });
    return h(
      "div",
      { class: "request" },
      h(
        "div",
        {},
        h("div", { class: "muted small", text: "Assistant " + H.shortAddr(req.address) + " wants to connect" }),
        h("div", { class: "confirm-number", text: confirm.slice(0, 3) + " " + confirm.slice(3) }),
        h("div", { class: "muted small", text: "Approve only if your assistant shows this same number." }),
      ),
      h("div", { class: "row" }, approve, decline),
    );
  }

  function buildConnect() {
    var st = stepStates().connect;
    if (st === "locked") return lockedRow("4 · Connect your assistant");
    if (st === "done") return doneRow("Assistant connected", "");
    var name = state.name.ensName;
    var c = stepCard(4, "Connect your AI assistant", "Send your assistant one message. It links itself to your World ID and asks to join; you approve it here.");
    c.body.appendChild(connectPanel(name));
    if (state.pairRequests.length > 0) {
      state.pairRequests.forEach(function (req) {
        c.body.appendChild(pairRequestCard(req));
      });
    } else {
      c.body.appendChild(h("div", { class: "waiting" }, h("span", { class: "spinner" }), "Waiting for your assistant to ask…"));
    }
    return c.card;
  }

  /* ---------- dashboard ---------- */

  function renderDashboard() {
    section("head", [state.name.ensName, state.online, state.mode], function () {
      return h(
        "section",
        { class: "card house-card" },
        h(
          "div",
          { class: "house-head" },
          h("div", {}, h("div", { class: "muted small", text: "Your house" }), h("div", { class: "house-name", text: state.name.ensName })),
          h("span", { class: state.online ? "pill ok" : "pill warn", text: state.online ? "Online" : "Not reachable from outside" }),
        ),
        h("p", { class: "muted", text: "Your assistants can read your mail here. Login codes stay locked until you approve each one with your face." }),
        h("p", { class: "small" }, h("a", { href: "/inspect.html?name=" + encodeURIComponent(state.name.ensName), text: "See it on ENS" })),
      );
    });
    section("stats", [state.gmail, state.world.session, state.agents.length], function () {
      var gmailValue = state.gmail.expired
        ? h("button", { type: "button", class: "btn secondary small", text: "Reconnect Gmail", onclick: startGmail })
        : h("div", { class: "value", title: state.gmail.email || "", text: state.gmail.email || "Connected" });
      return h(
        "div",
        { class: "grid three" },
        h("div", { class: "card flat stat" }, h("div", { class: "label", text: "Gmail" }), gmailValue),
        h("div", { class: "card flat stat" }, h("div", { class: "label", text: "World ID" }), h("div", { class: "value", text: state.world.session ? "Face check ready" : "Not set up" })),
        h("div", { class: "card flat stat" }, h("div", { class: "label", text: "Assistants" }), h("div", { class: "value", text: String(state.agents.length) })),
      );
    });
    section("assistants", [state.agents, state.pairRequests, local.showConnect], buildAssistants);
    section("activity", [activity], buildActivity);
    mountOrder(["head", "stats", "assistants", "activity"]);
  }

  function buildAssistants() {
    var card = h("section", { class: "card" });
    card.appendChild(
      h(
        "div",
        { class: "row between" },
        h("h2", { text: "Assistants" }),
        h("button", {
          type: "button",
          class: "btn secondary small",
          text: local.showConnect ? "Hide" : "Connect another",
          onclick: function () {
            local.showConnect = !local.showConnect;
            render();
          },
        }),
      ),
    );
    if (local.showConnect) {
      card.appendChild(h("p", { class: "muted small", text: "Any assistant linked to your World ID joins right away, with no approval step." }));
      card.appendChild(connectPanel(state.name.ensName));
    }
    state.pairRequests.forEach(function (req) {
      card.appendChild(pairRequestCard(req));
    });
    if (state.agents.length === 0) {
      card.appendChild(h("p", { class: "empty", text: "No assistant has called your house yet." }));
      return card;
    }
    card.appendChild(
      h(
        "ul",
        { class: "list" },
        state.agents.map(function (agent) {
          var button = h("button", {
            type: "button",
            class: agent.denied ? "btn secondary small" : "btn danger small",
            text: agent.denied ? "Restore" : "Revoke",
          });
          button.addEventListener("click", function () {
            button.disabled = true;
            api(agent.denied ? "/setup/unrevoke" : "/setup/revoke", "POST", { address: agent.address })
              .then(function (out) {
                H.toast(out.ok ? (agent.denied ? "Assistant restored" : "Assistant revoked") : errorText(out, "That didn't work."));
              })
              .catch(function () {
                H.toast("Couldn't reach your house");
              })
              .finally(poll);
          });
          return h(
            "li",
            {},
            h(
              "div",
              {},
              h("div", { class: "mono", text: H.shortAddr(agent.address) }),
              h("div", { class: "muted small", text: (agent.denied ? "Revoked · " : "") + agent.calls + " calls · last seen " + H.timeAgo(agent.lastSeen) }),
            ),
            button,
          );
        }),
      ),
    );
    return card;
  }

  function describe(entry) {
    var site = entry.site || "";
    switch (entry.event) {
      case "requested":
        return ["Asked to log in to " + site, null];
      case "approved":
        return ["You approved " + site, null];
      case "released":
        return ["Code typed into " + site, "Your assistant never saw it"];
      case "denied":
        return ["You declined " + site, entry.code === "user_rejected" ? null : entry.code];
      case "expired":
        return ["Request for " + site + " expired", null];
      case "refused":
        return ["Refused a code for " + site, entry.code === "NO_HELD_CODE" ? "No code from " + site + " was waiting" : entry.code];
      case "blocked":
        return ["Blocked a repeat request for " + site, "Codes work once"];
      case "paired":
        return ["Assistant connected", null];
      default:
        return [String(entry.event) + (site ? " · " + site : ""), null];
    }
  }

  function buildActivity() {
    var card = h("section", { class: "card" }, h("h2", { text: "Activity" }));
    if (activity.length === 0) {
      card.appendChild(h("p", { class: "empty", text: "Nothing yet. Code requests and approvals will show up here." }));
      return card;
    }
    card.appendChild(
      h(
        "ul",
        { class: "list activity" },
        activity.slice(0, 30).map(function (entry) {
          var text = describe(entry);
          var meta = [];
          if (entry.reason) meta.push("“" + entry.reason + "”");
          if (text[1]) meta.push(text[1]);
          if (entry.callerAddress) meta.push("by " + H.shortAddr(entry.callerAddress));
          return h(
            "li",
            {},
            h("div", {}, h("div", { class: "what", text: text[0] }), meta.length ? h("div", { class: "meta", text: meta.join(" · ") }) : null),
            h("span", { class: "when", title: entry.at, text: H.timeAgo(entry.at) }),
          );
        }),
      ),
    );
    return card;
  }

  /* ---------- polling ---------- */

  function poll() {
    clearTimeout(pollTimer);
    api("/setup/state")
      .then(function (out) {
        if (!out.ok) throw new Error("status " + out.status);
        failures = 0;
        state = out.data;
        render();
        if (setupDone()) startActivity();
      })
      .catch(function () {
        failures += 1;
        if (!state && failures >= 2) renderUnreachable();
        else if (state) renderStatus();
      })
      .finally(function () {
        var fast = !state || !setupDone() || (state.pairRequests && state.pairRequests.length > 0);
        pollTimer = setTimeout(poll, failures >= 3 ? 6000 : fast ? 2000 : 5000);
      });
  }

  function startActivity() {
    if (activityTimer) return;
    function load() {
      api("/setup/activity")
        .then(function (out) {
          if (out.ok && Array.isArray(out.data.entries)) {
            activity = out.data.entries;
            render();
          }
        })
        .catch(function () {
          /* the status pill already shows reachability */
        });
    }
    load();
    activityTimer = setInterval(load, 5000);
  }

  function renderUnreachable() {
    H.clear(app);
    sections = {};
    app.appendChild(
      h(
        "section",
        { class: "card" },
        h("h1", { text: "Can't reach your house" }),
        h("p", { class: "muted", text: "Hmail may have stopped, or this page is from an older run." }),
        h("ul", {}, h("li", { text: "On the computer running Hmail, open " }, h("a", { href: H.LOCAL_PAGE, text: "localhost:8390" }), "."), h("li", { text: "If that doesn't load, ask your assistant to run: hmail up --background" })),
        h("button", { type: "button", class: "btn primary", text: "Try again", onclick: poll }),
      ),
    );
  }

  function renderNoLink() {
    H.clear(app);
    app.appendChild(
      h(
        "section",
        { class: "card" },
        h("h1", { text: "Open your house page" }),
        h("p", { class: "muted", text: "Your house page opens from the computer where Hmail runs." }),
        h("p", {}, h("a", { class: "btn primary", href: H.LOCAL_PAGE, text: "Open localhost:8390" })),
        h("p", { class: "muted small" }, "New to Hmail? ", h("a", { href: "/", text: "Start here" }), "."),
      ),
    );
  }

  poll();
})();
