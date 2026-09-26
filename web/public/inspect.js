/* ENS inspector: live records, roles and published tools for <label>.hmail.eth. */
(function () {
  "use strict";
  var H = window.Hmail;
  var h = H.h;
  var form = document.getElementById("lookup");
  var input = document.getElementById("name");
  var result = document.getElementById("result");
  var LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
  var ETHERSCAN = "https://sepolia.etherscan.io/address/";

  function addressLink(address) {
    return h("a", { class: "mono", href: ETHERSCAN + address, target: "_blank", rel: "noopener noreferrer", text: H.shortAddr(address) });
  }

  function yesNo(ok, yes, no) {
    return h("span", { class: ok ? "pill ok" : "pill danger", text: ok ? yes : no });
  }

  function originLabel(origin) {
    if (origin === "same-human") return "Owner's assistants only";
    if (origin === "any-human") return "Any verified human's assistant";
    if (origin === "public") return "Anyone";
    return origin;
  }

  function render(data) {
    H.clear(result);
    if (!data.exists) {
      result.appendChild(h("div", { class: "card" }, h("h2", { text: data.name }), h("p", { class: "muted", text: "This name isn't registered yet." })));
      return;
    }
    var mcp = data.records["agent-endpoint[mcp]"];
    var web = data.records["agent-endpoint[web]"];
    result.appendChild(
      h(
        "section",
        { class: "card" },
        h("div", { class: "row between" }, h("h2", { text: data.name }), data.house.reachable ? h("span", { class: "pill ok", text: "House online" }) : h("span", { class: "pill warn", text: data.house.reachable ? "" : "House offline" })),
        h(
          "dl",
          { class: "kv" },
          h("dt", { text: "Owner (house key)" }),
          h("dd", {}, addressLink(data.owner)),
          h("dt", { text: "Resolver" }),
          h("dd", {}, addressLink(data.resolver)),
          h("dt", { text: "agent-endpoint[mcp]" }),
          h("dd", { class: "mono small", text: mcp || "not set" }),
          h("dt", { text: "agent-endpoint[web]" }),
          h("dd", { class: "mono small", text: web || "not set" }),
        ),
      ),
    );

    var setters = data.roles.setters || [];
    result.appendChild(
      h(
        "section",
        { class: "card" },
        h("h2", { text: "Who can change it" }),
        h("p", { class: "muted", text: "The house key may rewrite only its two endpoint records (per-record roles on its own resolver), so it can move its address when its tunnel changes, and nothing else." }),
        h(
          "ul",
          { class: "list" },
          setters.map(function (s) {
            return h("li", {}, h("span", { class: "mono", text: s.key }), yesNo(s.houseOnly, "Only the house can set it", "Not exclusive to the house"));
          }),
          h("li", {}, h("span", { text: "Issuer's rights on this resolver" }), yesNo(data.roles.issuerRenounced === true, "Renounced", "Still held")),
        ),
      ),
    );

    var tools = data.house.tools || [];
    var toolsCard = h("section", { class: "card" }, h("h2", { text: "What the house offers" }));
    if (tools.length === 0) {
      toolsCard.appendChild(h("p", { class: "muted", text: data.house.reachable ? "No tools published." : "The house is offline right now, so its tools can't be listed. Its records above are still live." }));
    } else {
      toolsCard.appendChild(h("p", { class: "muted small", text: "Read live from the house (MCP tools/list). Every call is checked by HORS against the policy shown." }));
      tools.forEach(function (tool) {
        toolsCard.appendChild(
          h(
            "div",
            { class: "tool" },
            h("div", { class: "row between" }, h("span", { class: "name", text: tool.name }), h("div", { class: "row" }, (tool.origin || []).map(function (o) {
              return h("span", { class: "pill plain", text: originLabel(o) });
            }))),
            tool.policy ? h("p", { class: "small", text: tool.policy }) : null,
            h("p", { class: "muted small", text: tool.description }),
          ),
        );
      });
    }
    result.appendChild(toolsCard);
  }

  function lookup(label) {
    H.clear(result);
    result.appendChild(h("div", { class: "card" }, h("div", { class: "waiting" }, h("span", { class: "spinner" }), "Reading Sepolia…")));
    var name = label + ".hmail.eth";
    history.replaceState(null, "", "?name=" + encodeURIComponent(name));
    fetch("/api/inspect?name=" + encodeURIComponent(name), { cache: "no-store" })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body && body.error ? body.error : String(res.status));
          render(body);
        });
      })
      .catch(function (err) {
        H.clear(result);
        result.appendChild(h("div", { class: "notice danger", text: "Couldn't read that name (" + err.message + "). Try again." }));
      });
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var label = input.value.trim().toLowerCase().replace(/\.hmail\.eth$/, "");
    if (!LABEL_RE.test(label)) {
      H.clear(result);
      result.appendChild(h("div", { class: "notice danger", text: "Enter a name like lyj or lyj.hmail.eth." }));
      return;
    }
    lookup(label);
  });

  var initial = new URLSearchParams(location.search).get("name");
  if (initial) {
    var label = initial.toLowerCase().replace(/\.hmail\.eth$/, "");
    if (LABEL_RE.test(label)) {
      input.value = label;
      lookup(label);
    }
  }
})();
