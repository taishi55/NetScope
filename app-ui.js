/* NetScope – app-ui.js
 * The App view: what DevTools' Elements, Application and Sources panels show,
 * read for meaning rather than raw — the stack and services, routes,
 * component tree, client state, every kind of storage, the code (with source
 * maps), and a semantic DOM outline. Each panel loads when opened, from the
 * same read-only inspector the AI uses.
 *
 * Results render through markdown.js (DOM nodes only, never HTML parsing);
 * page data is escaped before it enters the Markdown.
 */
"use strict";

window.__netscopeAppUi = (() => {
  // [key, label, group] — groups organise the compact select menu.
  const PANELS = [
    ["overview", "Overview", "Structure"],
    ["routes", "Routes", "Structure"],
    ["components", "Components", "Structure"],
    ["dom", "DOM", "Structure"],
    ["handlers", "Handlers", "Structure"],
    ["frames", "Frames", "Structure"],
    ["state", "State", "Data"],
    ["storage", "Storage", "Data"],
    ["flags", "Flags & i18n", "Data"],
    ["sources", "Sources", "Code"],
    ["network", "Network", "Network"],
    ["security", "Security", "Network"],
    ["design", "Design", "Look and feel"],
    ["styles", "Styles", "Look and feel"],
    ["accessibility", "Accessibility", "Look and feel"],
    ["performance", "Performance", "Look and feel"]
  ];
  let api = null;
  let panel = "overview";
  const cache = new Map(); // panel key -> result (cleared on reload/refresh)
  let pageUrl = "";
  let storageArea = "local";
  let stateSource = "";
  let statePath = "";
  let idb = { db: "", store: "" };
  let domSelector = "";
  let netType = "all";
  let handlersSelector = "";
  let stylesSelector = "body";
  let compFilter = "";
  let srcQuery = "";
  let srcRead = null; // { file | url, line }
  let seq = 0;

  const $ = (id) => document.getElementById(id);

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function btn(label, fn, cls) {
    const b = node("button", cls || "", label);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }

  // Page text is untrusted: escape everything Markdown would interpret.
  // Inline markers are escaped everywhere; block markers (# - + 1.) only where
  // they could start a line. Dots stay, so URLs read and link normally.
  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/\r?\n/g, " ")
      .replace(/([\\`*_{}[\]()|~<>])/g, "\\$1")
      .replace(/^(\s*)([#+\-!])/, "$1\\$2")
      .replace(/^(\s*\d+)\.(\s)/, "$1\\.$2");
  // Inside `code` Markdown escapes are not processed: only backticks need removing.
  const code = (s) => String(s == null ? "" : s).replace(/\r?\n/g, " ").replace(/`/g, "ˋ");
  const fence = (s, lang) => {
    const t = String(s == null ? "" : s);
    const ticks = /```/.test(t) ? "````" : "```";
    return `${ticks}${lang || "text"}\n${t}\n${ticks}`;
  };
  const kb = (chars) => (chars >= 1024 * 1024 ? (chars / 1048576).toFixed(1) + " MB" : chars >= 1024 ? Math.round(chars / 1024) + " kB" : chars + " B");

  function md(target, text) {
    const wrap = node("div", "msg-assistant app-md");
    const body = node("div", "msg-body");
    if (window.__netscopeMarkdown) {
      // headingShift 0: "###" is h3 here (the view has no h1/h2 of its own above it).
      window.__netscopeMarkdown.render(body, text, { headingShift: 0, copy: (t, msg) => typeof copyText === "function" && copyText(t, msg) });
    } else body.appendChild(node("pre", "", text));
    wrap.appendChild(body);
    target.appendChild(wrap);
    return wrap;
  }

  function call(op, args) {
    return api.rpc("inspect", { op, args: args || {} }).then((r) => {
      if (r && r.error && Object.keys(r).length <= 2) throw new Error(r.error);
      return r;
    });
  }

  // Loads one panel's data (cached until Refresh or a page change) and renders it.
  async function show(force) {
    const body = $("appBody");
    const mine = ++seq;
    const key = panelKey();
    if ($("appSelect")) $("appSelect").value = panel;
    for (const b of $("appTabs").children) {
      const on = b.dataset.panel === panel;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    }
    if (force) cache.delete(key);
    let data = cache.get(key);
    if (!data) {
      body.replaceChildren(node("div", "pane-loading", "Reading the page…"));
      $("appStats").textContent = "Reading the page";
      try {
        data = await load();
      } catch (err) {
        if (mine !== seq) return;
        body.replaceChildren();
        const box = node("div", "pane-empty");
        box.appendChild(node("p", "lead", "Couldn't read this page"));
        box.appendChild(node("p", "", (err && err.message) || String(err)));
        body.appendChild(box);
        return;
      }
      if (mine !== seq) return;
      cache.set(key, data);
    }
    body.replaceChildren();
    $("appStats").textContent = "";
    $("appRefresh").title = data && data.ms != null ? `Read the page again (last read took ${data.ms} ms)` : "Read the page again";
    try {
      RENDER[panel](body, data);
    } catch (err) {
      body.appendChild(node("p", "pane-error", "Could not show this: " + err.message));
    }
    body.scrollTop = 0;
  }

  const panelKey = () =>
    panel === "storage" ? `storage:${storageArea}:${idb.db}:${idb.store}` : panel === "state" ? `state:${stateSource}:${statePath}` : panel === "dom" ? `dom:${domSelector}` : panel === "network" ? `network:${netType}` : panel === "handlers" ? `handlers:${handlersSelector}` : panel === "styles" ? `styles:${stylesSelector}` : panel === "components" ? `components:${compFilter}` : panel === "sources" ? `sources:${srcQuery}:${srcRead ? srcRead.file || srcRead.url : ""}:${srcRead ? srcRead.line || "" : ""}` : panel;

  async function load() {
    switch (panel) {
      case "overview": {
        const [page, res] = await Promise.all([call("overview"), api.rpc("res.list", { limit: 1 }).catch(() => null)]);
        return { page, res, ms: page.ms };
      }
      case "routes":
        return call("routes");
      case "components":
        return call("components", { max_nodes: 600, filter: compFilter || undefined });
      case "state":
        return call("state", stateSource ? { source: stateSource, path: statePath || undefined, max_depth: 5 } : {});
      case "storage":
        if (storageArea === "cookies") return call("cookies", { value_chars: 400 });
        if (storageArea === "indexeddb") return call("idb", idb.db ? { db: idb.db, store: idb.store || undefined, limit: 50 } : {});
        if (storageArea === "cache") return call("cache", {});
        return call("storage", { area: storageArea, limit: 500 });
      case "sources": {
        const [list, hits, read] = await Promise.all([
          api.rpc("sources.list", {}),
          srcQuery ? api.rpc("sources.search", { query: srcQuery, limit: 80 }) : null,
          srcRead ? api.rpc("sources.read", Object.assign({}, srcRead, srcRead.line ? { around: 30 } : {})) : null
        ]);
        return { list, hits, read };
      }
      case "dom":
        return call("dom", { selector: domSelector || undefined, max_lines: 600 });
      case "network": {
        const r = await api.rpc("res.list", { type: netType === "failed" ? undefined : netType, failed: netType === "failed" || undefined, limit: 400 });
        if (!r.total) r.timing = await call("resources", { limit: 400 }).catch(() => null);
        return r;
      }
      case "security":
        return api.rpc("res.security", {});
      case "handlers":
        return call("handlers", { selector: handlersSelector || undefined, limit: 400 });
      case "styles":
        return call("styles", { selector: stylesSelector || "body" });
      case "design":
        return call("design");
      case "accessibility":
        return call("a11y");
      case "performance":
        return call("performance");
      case "frames":
        return call("frames");
      case "flags":
        return call("flags");
    }
    return {};
  }

  /* ------------------------------------------------------------ panels */

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

  // An instrument-style strip: one panel split into cells, each a label, a
  // value and one line of detail. A cell with go() is a button to its section;
  // tone "bad" adds a red tick, "good" a green one.
  function readout(parent, cells) {
    const strip = node("div", "readout");
    for (const c of cells) {
      const el = c.go ? node("button", "ro-cell") : node("div", "ro-cell");
      if (c.go) {
        el.type = "button";
        el.addEventListener("click", c.go);
      }
      if (c.tone) el.classList.add("ro-" + c.tone);
      el.appendChild(node("span", "ro-label", c.label));
      el.appendChild(node("span", "ro-value", c.value));
      if (c.detail) el.appendChild(node("span", "ro-detail", c.detail));
      strip.appendChild(el);
    }
    parent.appendChild(strip);
    return strip;
  }

  // A compact data table like Traffic's list. cols: [label, class]; rows:
  // { cells: [[text | [main, sub], class, title]], cls, title }.
  function table(cols, rows) {
    const wrap = node("div", "dt-wrap");
    const t = node("table", "dt");
    const thead = node("thead");
    const htr = node("tr");
    for (const [label, cls] of cols) {
      const th = node("th", cls, label);
      th.scope = "col";
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    t.appendChild(thead);
    const tbody = node("tbody");
    for (const r of rows) {
      const tr = node("tr", r.cls || "");
      if (r.title) tr.title = r.title;
      r.cells.forEach(([text, cls, title], i) => {
        const td = node("td", [cols[i][1], cls].filter(Boolean).join(" "));
        if (Array.isArray(text)) {
          td.appendChild(document.createTextNode(String(text[0])));
          if (text[1]) td.appendChild(node("span", "name-sub", " " + text[1]));
        } else td.textContent = String(text);
        if (title) td.title = title;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    t.appendChild(tbody);
    wrap.appendChild(t);
    return wrap;
  }

  function controls(parent, items) {
    const bar = node("div", "app-controls");
    for (const it of items) bar.appendChild(it);
    parent.appendChild(bar);
    return bar;
  }

  function input(placeholder, value, onEnter, label) {
    const i = node("input");
    i.type = "search";
    i.placeholder = placeholder;
    i.value = value || "";
    i.spellcheck = false;
    i.setAttribute("aria-label", label || placeholder);
    i.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") onEnter(i.value.trim());
    });
    return i;
  }

  function chips(options, current, onPick, label) {
    const g = node("div", "app-chips");
    g.setAttribute("role", "group");
    g.setAttribute("aria-label", label);
    for (const [key, text] of options) {
      const b = btn(text, () => onPick(key), "tgl" + (key === current ? " on" : ""));
      b.setAttribute("aria-pressed", key === current ? "true" : "false");
      g.appendChild(b);
    }
    return g;
  }

  const RENDER = {
    overview(body, d) {
      const o = d.page;
      const logs = api.getLogs();
      const res = d.res || {};
      // A failed image/script load is both a console error and a failed request: count it once.
      const errors = logs.filter((l) => l.level === "error" && !(l.kind === "resource" && res.total)).length;
      const warnings = logs.filter((l) => l.level === "warn").length;
      const failed = res.failed || 0;
      const fw = o.frameworks || [];
      const st = o.storage || {};
      const keys = ((st.localStorage && st.localStorage.count) || 0) + ((st.sessionStorage && st.sessionStorage.count) || 0);
      const idb = Array.isArray(st.indexedDB) ? st.indexedDB : [];
      const apiCalls = api.getEntries().filter((e) => e.kind === "http").length;
      const hosts = new Set();
      for (const e of api.getEntries()) {
        try {
          if (e.url) hosts.add(new URL(e.url).host);
        } catch (_) {}
      }
      readout(body, [
        {
          label: "Health",
          value: errors + failed ? plural(errors + failed, "problem") : "No errors",
          detail: [errors ? plural(errors, "console error") : "", failed ? plural(failed, "failed request") : "", warnings ? plural(warnings, "warning") : ""].filter(Boolean).join(", ") || "Console and network are clean",
          tone: errors + failed ? "bad" : "good",
          go: errors ? () => switchView("console") : failed ? () => ((netType = "failed"), (panel = "network"), show()) : null
        },
        {
          label: "Stack",
          value: fw.length ? fw[0].name + (fw[0].version ? " " + fw[0].version.split(/[ +]/)[0] : "") : "No framework",
          detail: fw.length > 1 ? fw.slice(1, 4).map((f) => f.name).join(", ") : fw.length ? fw[0].note || "" : "Server-rendered or unrecognised",
          go: () => ((panel = "components"), show())
        },
        {
          label: "Data",
          value: plural(keys, "storage key"),
          detail:
            [
              st.localStorage && st.localStorage.count ? `${st.localStorage.count} local` : "",
              st.sessionStorage && st.sessionStorage.count ? `${st.sessionStorage.count} session` : "",
              idb.length ? plural(idb.length, "database") : "",
              (st.cookies_visible_to_js || []).length ? plural(st.cookies_visible_to_js.length, "readable cookie") : "",
              (st.serviceWorkers || []).length ? "service worker" : ""
            ]
              .filter(Boolean)
              .join(", ") || "Nothing stored",
          go: () => ((panel = "storage"), show())
        },
        {
          label: "Network",
          value: res.total ? plural(res.total, "request") : plural(apiCalls, "API call"),
          detail: [res.total ? plural(apiCalls, "API call") : "", plural(hosts.size, "host"), (o.hosts && o.hosts.third_party || []).length ? plural(o.hosts.third_party.length, "third party", "third parties") : ""].filter(Boolean).join(", "),
          go: () => ((panel = "network"), show())
        }
      ]);
      const out = [];
      const b = o.build || {};
      if (fw.length) {
        out.push("### Stack", "| Technology | Version | Notes |", "| --- | --- | --- |");
        for (const f of fw) out.push(`| **${esc(f.name)}** | ${esc(f.version || "")} | ${esc(f.note || "")} |`);
      }
      if (b.next) out.push("", `**Next.js** page \`${code(b.next.page)}\`, build \`${code(b.next.buildId)}\`${b.next.data_fetching && b.next.data_fetching.length ? ", data fetching: " + esc(b.next.data_fetching.join(", ")) : ""}`);
      if (b.remix) out.push("", `**Route manifest**: ${b.remix.routes} routes (version ${esc(b.remix.version || "?")})`);
      if (b.sveltekit) out.push("", "**SvelteKit**: " + b.sveltekit.map((k) => "`" + code(JSON.stringify(k.value)) + "`").join(" "));
      if (b.nuxt) out.push("", "**Nuxt** payload keys: " + esc((b.nuxt.keys || []).join(", ")));
      if ((o.services || []).length) {
        out.push("", "### Services");
        for (const s of o.services) out.push(`- **${esc(s.name)}**${s.detail ? " — " + esc(s.detail) : ""}`);
      }
      const dom = o.dom || {};
      out.push("", "### Page", `${plural(dom.elements, "element")}, ${plural(dom.forms, "form")}, ${plural(dom.inputs, "input")}, ${plural(dom.buttons, "button")}, ${dom.links_internal} internal and ${plural(dom.links_external, "external link")}, ${plural(dom.images, "image")}.`);
      if ((dom.custom_elements || []).length) out.push("", "Custom elements: " + esc(dom.custom_elements.join(", ")));
      const h = o.hosts || {};
      if ((h.third_party || []).length) out.push("", "### Hosts", "First-party: " + esc((h.first_party || []).join(", ") || "—"), "", "Third-party: " + esc(h.third_party.join(", ")));
      if ((o.inline_data || []).length) {
        out.push("", "### Data embedded in the HTML");
        for (const x of o.inline_data) out.push(`- \`${code(x.id || x.type)}\` ${kb(x.chars)}: ${esc(x.shape)}`);
      }
      const g = o.app_globals || {};
      if ((g.sample || []).length) out.push("", `### App globals (${g.count})`, fence(g.sample.join("\n")));
      out.push("", "### Meta", fence(JSON.stringify(o.meta || {}, null, 2), "json"));
      md(body, out.join("\n"));
    },

    routes(body, r) {
      const out = [`Current: \`${code(r.current)}\``];
      for (const s of r.sources || []) out.push("", `### ${esc(s.source)} (${s.count})`, s.note ? esc(s.note) : "", fence(s.routes.join("\n")));
      if (!(r.sources || []).length) out.push("", "No router table is exposed by this page. The links and visited routes below still show its structure.");
      if ((r.internal_links || []).length) out.push("", "### Internal links on this page", fence(r.internal_links.join("\n")));
      if ((r.form_actions || []).length) out.push("", "### Form actions", fence(r.form_actions.join("\n")));
      const visited = new Map();
      for (const l of api.getLogs()) {
        if (l.level !== "route") continue;
        try {
          const p = new URL(l.text).pathname;
          visited.set(p, (visited.get(p) || 0) + 1);
        } catch (_) {}
      }
      if (visited.size) out.push("", "### Visited while NetScope watched", fence(Array.from(visited.entries()).map(([p, n]) => p + (n > 1 ? "  ×" + n : "")).join("\n")));
      md(body, out.join("\n"));
    },

    components(body, c) {
      controls(body, [
        input("Filter components by name", compFilter, (v) => {
          compFilter = v;
          show();
        })
      ]);
      const out = [];
      if (c.react) out.push(`### React (${c.react.nodes} components${c.react.truncated ? ", truncated" : ""})`, c.react.note ? esc(c.react.note) : "", fence(c.react.tree || "(empty)"));
      if (c.vue) out.push(`### Vue (${c.vue.nodes} components${c.vue.truncated ? ", truncated" : ""})`, fence(c.vue.tree || "(empty)"));
      if (c.angular) out.push(`### Angular ${esc(c.angular.version)}`, fence(c.angular.components.join("\n")));
      if (c.svelte_dev) out.push("### Svelte (dev build)", fence(c.svelte_dev.join("\n")));
      if (c.astro_islands) out.push("### Astro islands", fence(c.astro_islands.join("\n")));
      if (c.web_components) out.push("### Web components", fence(c.web_components.join("\n")));
      if (c.note) out.push(esc(c.note));
      md(body, out.join("\n\n"));
    },

    state(body, s) {
      if (!stateSource) {
        const av = s.available || [];
        if (!av.length) {
          md(body, "No client state found: no Redux, React Query, Apollo, Next/Nuxt data, Pinia, Vuex or app globals like `window.__INITIAL_STATE__`. Type a global's name below to read it.");
        }
        const list = node("div", "app-list");
        for (const a of av) {
          const row = btn("", () => {
            stateSource = a.source;
            statePath = "";
            show();
          }, "app-item");
          row.appendChild(node("span", "app-item-title", a.source));
          row.appendChild(node("span", "app-item-meta", a.note + " — " + a.shape));
          list.appendChild(row);
        }
        body.appendChild(list);
        controls(body, [
          input("Read any global, e.g. window.__APP_CONFIG__", "", (v) => {
            if (!v) return;
            stateSource = v.startsWith("window.") ? v : "window." + v;
            show();
          })
        ]);
        return;
      }
      controls(body, [
        btn("← All state", () => {
          stateSource = "";
          statePath = "";
          show();
        }, "ghost"),
        input("Path, e.g. user.profile or items.0", statePath, (v) => {
          statePath = v;
          show();
        })
      ]);
      if (s.error) return md(body, esc(s.error));
      md(body, [`### ${esc(s.source)}${s.path ? " › " + esc(s.path) : ""}`, "Shape:", fence(s.shape), "Value:", fence(typeof s.value === "string" ? s.value : JSON.stringify(s.value, null, 2), "json")].join("\n\n"));
    },

    storage(body, r) {
      body.appendChild(
        chips(
          [
            ["local", "Local"],
            ["session", "Session"],
            ["cookies", "Cookies"],
            ["indexeddb", "IndexedDB"],
            ["cache", "Cache"]
          ],
          storageArea,
          (k) => {
            storageArea = k;
            idb = { db: "", store: "" };
            show();
          },
          "Storage area"
        )
      );
      const out = [];
      if (storageArea === "local" || storageArea === "session") {
        out.push(`${r.count} keys in ${r.area}`);
        if (r.items && r.items.length) {
          out.push("", "| Key | Size | Value |", "| --- | ---: | --- |");
          for (const it of r.items) out.push(`| \`${code(it.key)}\` | ${kb(it.chars)} | ${esc(it.preview)} |`);
        }
      } else if (storageArea === "cookies") {
        out.push(`${r.count} cookies are sent to ${esc(r.url)} — HttpOnly ones included, which page scripts cannot see.`);
        if (r.cookies && r.cookies.length) {
          out.push("", "| Name | Value | Flags | Expires |", "| --- | --- | --- | --- |");
          for (const c of r.cookies) {
            const flags = [c.httpOnly ? "HttpOnly" : "", c.secure ? "Secure" : "", c.sameSite && c.sameSite !== "unspecified" ? "SameSite=" + c.sameSite : "", c.domain, c.path !== "/" ? c.path : ""].filter(Boolean).join(" ");
            out.push(`| \`${code(c.name)}\` | ${esc(c.value)} | ${esc(flags)} | ${esc(c.session ? "session" : (c.expires || "").slice(0, 10))} |`);
          }
        }
      } else if (storageArea === "indexeddb") {
        if (!idb.db) {
          const dbs = r.databases || [];
          if (!dbs.length) out.push("No IndexedDB databases.");
          for (const d of dbs) {
            out.push("", `### ${esc(d.name)} (v${d.version})`, d.error ? esc(d.error) : "");
            if ((d.stores || []).length) {
              out.push("| Store | Key | Records | Indexes |", "| --- | --- | ---: | --- |");
              for (const s of d.stores) out.push(`| \`${code(s.name)}\` | ${esc(JSON.stringify(s.keyPath))}${s.autoIncrement ? " (auto)" : ""} | ${s.count} | ${esc(s.indexes.join(", "))} |`);
            }
          }
          md(body, out.join("\n"));
          const list = node("div", "app-list");
          for (const d of dbs) for (const s of d.stores || []) list.appendChild(btn(`Browse ${d.name} › ${s.name}`, () => ((idb = { db: d.name, store: s.name }), show()), "app-item"));
          body.appendChild(list);
          return;
        }
        controls(body, [btn("← All databases", () => ((idb = { db: "", store: "" }), show()), "ghost")]);
        out.push(`### ${esc(r.db)} › ${esc(r.store)}`, `${r.count} records, showing ${(r.records || []).length}.`, fence(JSON.stringify(r.records || [], null, 2), "json"));
      } else if (storageArea === "cache") {
        const cs = r.caches || [];
        if (!cs.length) out.push("No Cache Storage entries.");
        for (const c of cs) out.push("", `### ${esc(c.cache)} (${c.entries} entries)`, c.error ? esc(c.error) : fence((c.requests || []).join("\n")));
      }
      md(body, out.join("\n"));
    },

    sources(body, d) {
      const { list, hits, read } = d;
      controls(body, [
        input("Search the code: an endpoint, a function, a flag…", srcQuery, (v) => {
          srcQuery = v;
          srcRead = null;
          show();
        }, "Search the page's code")
      ]);
      if (read) {
        controls(body, [btn("← Back", () => ((srcRead = null), show()), "ghost")]);
        md(body, [`### ${esc(read.name)}`, read.total_lines ? `Lines ${read.from_line}–${read.to_line} of ${read.total_lines}` : `${kb(read.chars)}, from offset ${read.offset}`, fence(read.text, /\.(tsx?|jsx?|mjs|vue|svelte)$/.test(read.name) ? "js" : "js")].join("\n\n"));
        return;
      }
      if (hits) {
        const box = node("div", "app-list");
        box.appendChild(node("p", "pane-stats", `${hits.hits.length} matches in ${hits.files_with_hits} files (${hits.units_scanned} scanned)${hits.truncated ? ", more not shown" : ""}`));
        for (const h of hits.hits) {
          const row = btn("", () => {
            srcRead = h.kind === "original" ? { file: h.where, line: h.line } : { url: h.where, line: h.line };
            show();
          }, "app-item");
          row.appendChild(node("span", "app-item-title", `${h.where.split("/").slice(-2).join("/")}:${h.line}`));
          row.appendChild(node("span", "app-item-meta", h.kind + " — " + h.snippet));
          row.title = h.where;
          box.appendChild(row);
        }
        body.appendChild(box);
      }
      const out = [];
      out.push(`### Scripts (${list.scripts.length}${list.scripts_not_fetched ? ", " + list.scripts_not_fetched + " more not read" : ""})`);
      out.push(list.source_maps ? `${list.source_maps} with source maps — ${list.app_files} original app files.` : "No source maps: the code is searchable as shipped (minified).");
      out.push("", "| Script | Size | Source map |", "| --- | ---: | --- |");
      for (const s of list.scripts) out.push(`| ${esc(s.url.replace(/^https?:\/\//, "").slice(0, 90))}${s.third_party ? " *(third-party)*" : ""} | ${s.kb} kB | ${s.original_files ? s.original_files + " files" : s.source_map ? "yes" : s.error ? esc(s.error) : "—"} |`);
      if (list.app_files) out.push("", "### Original app files", fence(list.app_file_tree.join("\n")));
      if ((list.packages || []).length) out.push("", "### Packages", fence(list.packages.join("\n")));
      if ((list.inline_scripts || []).length) out.push("", `### Inline scripts (${list.inline_scripts.length})`, fence(list.inline_scripts.map((x) => `#${x.index} ${kb(x.chars)}  ${x.head}`).join("\n")));
      md(body, out.join("\n"));
    },

    dom(body, r) {
      controls(body, [
        input("CSS selector for one region, e.g. main or #checkout", domSelector, (v) => {
          domSelector = v;
          show();
        })
      ]);
      md(body, [`Outline of \`${code(r.root)}\` — ${r.lines} lines${r.truncated ? " (truncated)" : ""}`, fence(r.outline || "(empty)")].join("\n\n"));
    },

    network(body, r) {
      body.appendChild(
        chips(
          [
            ["all", "All"],
            ["main_frame", "Document"],
            ["script", "Scripts"],
            ["stylesheet", "Styles"],
            ["image", "Images"],
            ["font", "Fonts"],
            ["xmlhttprequest", "Fetch/XHR"],
            ["media", "Media"],
            ["sub_frame", "Frames"],
            ["other", "Other"],
            ["failed", "Failed"]
          ],
          netType,
          (k) => {
            netType = k;
            show();
          },
          "Request type"
        )
      );
      if (!r.total) {
        const out = [r.recording ? "Nothing recorded yet. **Reload the page** to record its document, scripts, styles and every other request with status and headers." : "Not recording this tab yet."];
        const rt = r.timing && r.timing.resources;
        if (rt && rt.length) {
          out.push("", `### Loaded so far (Resource Timing, ${r.timing.count})`, "| Type | Resource | Time | Size |", "| --- | --- | ---: | ---: |");
          for (const x of rt.slice(-150)) out.push(`| ${esc(x.type)} | \`${code(x.url.replace(/^https?:\/\//, "").slice(0, 140))}\` | ${x.ms} ms | ${x.kb} kB |`);
        }
        return md(body, out.join("\n"));
      }
      const TYPE = { main_frame: "Document", sub_frame: "Frame", xmlhttprequest: "Fetch/XHR", stylesheet: "Style", script: "Script", image: "Image", font: "Font", media: "Media", ping: "Beacon", websocket: "WebSocket", other: "Other" };
      body.appendChild(node("p", "pane-stats app-summary", `${r.total} requests${r.failed ? `, ${r.failed} failed` : ""}` + (r.matched !== r.total ? `, ${r.matched} shown` : "")));
      body.appendChild(
        table(
          [
            ["Status", "c-s"],
            ["Name", ""],
            ["Type", "c-type"],
            ["Size", "c-sz num"],
            ["Time", "c-tm num"]
          ],
          r.requests.map((q) => {
            let path = q.url;
            let host = "";
            try {
              const u = new URL(q.url);
              path = (u.pathname.split("/").filter(Boolean).pop() || u.pathname) + u.search;
              host = u.host;
            } catch (_) {}
            const bad = q.error || q.status >= 400;
            return {
              cls: bad ? "bad" : "",
              title: q.url,
              cells: [
                [q.error ? "✕" : q.status || "—", q.error ? "sx" : statusClass(q.status || 0), q.error || (q.cache ? "from cache" : "")],
                [[path || "/", host + (q.method !== "GET" ? "  " + q.method : "") + (q.worker ? "  worker" : "") + (q.redirect_to ? "  → " + q.redirect_to : "")], "name"],
                [TYPE[q.type] || q.type, "dim"],
                [q.kb != null ? q.kb + " kB" : "", "num"],
                [q.ms != null ? q.ms + " ms" : "", "num"]
              ]
            };
          })
        )
      );
      if (r.matched > r.requests.length) body.appendChild(node("p", "pane-stats", `Showing ${r.requests.length} of ${r.matched}.`));
    },

    security(body, s) {
      if (!s.document) return md(body, esc(s.note || "No page document recorded."));
      const out = [`### ${esc(s.document.url)}`, `Status ${s.document.status}${s.document.protocol ? ", " + esc(s.document.protocol) : ""}${s.document.ip ? ", IP " + esc(s.document.ip) : ""}`];
      if ((s.issues || []).length) out.push("", "### Issues", ...s.issues.map((i) => "- " + esc(i)));
      const h = s.security_headers || {};
      if (Object.keys(h).length) {
        out.push("", "### Security headers", "| Header | Value |", "| --- | --- |");
        for (const [k, v] of Object.entries(h)) out.push(`| \`${code(k)}\` | ${esc(String(v).slice(0, 200))} |`);
      }
      if (s.content_security_policy) out.push("", "### Content-Security-Policy", fence(Object.entries(s.content_security_policy).map(([k, v]) => k + " " + v.join(" ")).join("\n")));
      if ((s.cookies_set_by_document || []).length) {
        out.push("", "### Cookies set by the page", "| Cookie | HttpOnly | Secure | SameSite |", "| --- | --- | --- | --- |");
        for (const c of s.cookies_set_by_document) out.push(`| \`${code(c.name)}\` | ${c.httpOnly ? "yes" : "**no**"} | ${c.secure ? "yes" : "**no**"} | ${esc(c.sameSite)} |`);
      }
      const hb = s.hosting_and_backend || {};
      const host = (title, obj) => {
        const rows = Object.entries(obj || {});
        if (!rows.length) return;
        out.push("", `### ${title}`, "| Host | Clues |", "| --- | --- |");
        for (const [k, v] of rows) out.push(`| ${esc(k)} | ${esc(v.join(", "))} |`);
      };
      host("Hosting and backend — this site", hb.this_site);
      host("Third parties", hb.third_parties);
      const cors = Object.entries(s.cors_by_host || {});
      if (cors.length) out.push("", "### CORS", "| API host | Allows |", "| --- | --- |", ...cors.map(([k, v]) => `| ${esc(k)} | ${esc(v)} |`));
      md(body, out.join("\n"));
    },

    handlers(body, r) {
      controls(body, [
        input("Only inside a region, e.g. header or #checkout", handlersSelector, (v) => {
          handlersSelector = v;
          show();
        })
      ]);
      md(body, [`${r.interactive} interactive elements, ${r.with_handlers} with handlers found.`, esc(r.note), fence((r.elements || []).join("\n") || "(none)")].join("\n\n"));
    },

    styles(body, s) {
      controls(body, [
        input("Element, e.g. button.primary or #checkout h2", stylesSelector, (v) => {
          stylesSelector = v || "body";
          show();
        })
      ]);
      if (s.error) return md(body, esc(s.error));
      const out = [`### ${esc(s.element)}${s.matches > 1 ? ` (1 of ${s.matches})` : ""}`];
      if (s.text) out.push(`"${esc(s.text)}"`);
      out.push("", `Box: ${s.box.width}×${s.box.height} at ${s.box.x},${s.box.y}${s.box.visible ? "" : " — **not visible**"}`);
      out.push("", "| Property | Value |", "| --- | --- |", ...Object.entries(s.computed || {}).map(([k, v]) => `| \`${code(k)}\` | ${esc(v)} |`));
      if ((s.matched_rules || []).length) out.push("", "### Matching rules", fence(s.matched_rules.map((r) => `${r.selector}   /* ${r.where} */\n  ${r.css}`).join("\n\n"), "css"));
      if (s.inline_style) out.push("", "Inline style:", fence(s.inline_style, "css"));
      if (s.custom_properties_in_scope) out.push("", "### Variables in scope", fence(s.custom_properties_in_scope.join("\n"), "css"));
      md(body, out.join("\n"));
    },

    design(body, d) {
      const list = (title, arr) => (arr && arr.length ? ["", `### ${title}`, fence(arr.join("\n"))] : []);
      const out = [];
      out.push("### Styling approach", d.css_approach && d.css_approach.length ? d.css_approach.map((x) => "- " + esc(x)).join("\n") : "Plain CSS (no framework fingerprint).");
      const vars = d.css_variables || {};
      out.push("", `### Design tokens (${vars.count || 0} CSS variables)`);
      for (const [k, v] of Object.entries(vars.by_prefix || {}).slice(0, 30)) out.push(`**--${esc(k)}** (${v.length})`, fence(v.slice(0, 40).join("\n"), "css"));
      out.push(...list("Text colors", d.text_colors), ...list("Background colors", d.background_colors), ...list("Fonts in use", d.font_families), ...list("Loaded fonts", d.loaded_fonts), ...list("Font sizes", d.font_sizes), ...list("Border radii", d.border_radii), ...list("Shadows", d.shadows), ...list("Breakpoints", d.breakpoints));
      if (d.layout) out.push("", `Layout: ${d.layout.flex_containers} flex and ${d.layout.grid_containers} grid containers in ${d.layout.sampled_elements} elements.${d.dark_mode ? " Has a dark mode." : ""}`);
      out.push(...list("Stylesheets", d.stylesheets));
      md(body, out.join("\n"));
    },

    accessibility(body, a) {
      // Group issues by kind: "image without alt: img — url" → kind "image without alt".
      // Page-level issues ("page: no <main> landmark") are each their own kind.
      const groups = new Map();
      for (const i of a.issues || []) {
        const at = i.indexOf(": ");
        let k = at > 0 ? i.slice(0, at) : i;
        let rest = at > 0 ? i.slice(at + 2) : "";
        if (k === "page") (k = rest), (rest = "");
        else if (k.startsWith("duplicate id ")) (rest = k.slice(13)), (k = "duplicate id");
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(rest);
      }
      readout(body, [
        { label: "Issues", value: String(a.issues_count), detail: groups.size ? plural(groups.size, "kind") : "None found", tone: a.issues_count ? "bad" : "good" },
        { label: "Contrast", value: a.contrast.below_aa ? `${a.contrast.below_aa} failing` : "Passes AA", detail: `${a.contrast.text_elements_checked} text elements checked`, tone: a.contrast.below_aa ? "bad" : "good" },
        { label: "Landmarks", value: String((a.landmarks || []).length), detail: (a.landmarks || []).slice(0, 4).join(", ") || "None", tone: (a.landmarks || []).length ? "" : "bad" },
        { label: "Headings", value: String((a.heading_outline || []).length), detail: a.lang ? "lang " + a.lang : "No lang attribute", tone: a.lang ? "" : "bad" }
      ]);
      if (groups.size) {
        body.appendChild(
          table(
            [
              ["Issue", ""],
              ["Count", "c-s num"],
              ["Example", ""]
            ],
            Array.from(groups.entries()).map(([k, list]) => ({ cells: [[k[0].toUpperCase() + k.slice(1), "strong"], [String(list.length), "num"], [list[0] || "", "dim"]] }))
          )
        );
      }
      const out = ["### Heading outline", fence((a.heading_outline || []).join("\n") || "(no headings)"), "", "### Controls and their names", fence((a.controls || []).join("\n")), "", esc(a.note)];
      md(body, out.join("\n"));
    },

    performance(body, p) {
      const v = p.web_vitals || {};
      if (p.note) body.appendChild(node("p", "pane-stats app-summary", p.note));
      const tone = (r) => (r === "good" ? "good" : r ? "bad" : "");
      const cell = (label, m, detail, fmt) => (m ? { label, value: fmt(m), detail: (m.rating ? m.rating[0].toUpperCase() + m.rating.slice(1) : "") + (detail ? " — " + detail : ""), tone: tone(m.rating) } : { label, value: "—", detail: "Not measured" });
      readout(body, [
        cell("LCP", v.LCP, v.LCP && v.LCP.element, (m) => m.ms + " ms"),
        cell("CLS", v.CLS, "", (m) => String(m.value)),
        v.INP && v.INP.ms != null ? cell("INP", v.INP, `${v.INP.event} on ${v.INP.target}`, (m) => m.ms + " ms") : { label: "INP", value: "—", detail: v.INP ? v.INP.note : "Not measured" },
        cell("FCP", v.FCP, "", (m) => m.ms + " ms"),
        cell("TTFB", v.TTFB, "", (m) => m.ms + " ms")
      ]);
      const out = [];
      if ((p.layout_shifts || []).length) out.push("### Layout shifts", fence(p.layout_shifts.map((s) => `${s.ms} ms  ${s.value}  ${s.moved.join(", ")}`).join("\n")));
      const lt = p.long_tasks;
      if (lt && lt.count) out.push("", `### Long tasks: ${lt.count}, ${lt.totalMs} ms in total`, fence(lt.worst.map((t) => `${t.ms} ms at ${t.at} ms${t.from ? "  " + t.from : ""}`).join("\n")));
      if ((p.long_animation_frames || []).length) out.push("", "### Slow frames and the scripts behind them", fence(p.long_animation_frames.map((f) => `${f.ms} ms (blocking ${f.blocking_ms}) at ${f.at} ms\n` + f.scripts.map((s) => `   ${s.ms} ms ${s.fn || "(anonymous)"} ${s.source || ""} ${s.invoker || ""}`).join("\n")).join("\n")));
      if ((p.js_heap_mb_over_time || []).length > 1) out.push("", "### JS heap", fence(p.js_heap_mb_over_time.map((h) => `${h.s} s  ${h.mb} MB`).join("\n")));
      const n = (p.timings || {}).navigation;
      if (n) out.push("", "### Page load", `Time to first byte ${n.ttfb_ms} ms, DOMContentLoaded ${n.dom_content_loaded_ms} ms, load ${n.load_ms} ms over ${esc(n.protocol || "?")}.`);
      if (out.length) md(body, out.join("\n"));
    },

    frames(body, f) {
      const out = [`${(f.frames || []).length} frames.`, "", "| Id | URL | Frameworks | Forms | Inputs | Scripts |", "| ---: | --- | --- | ---: | ---: | ---: |"];
      for (const x of f.frames || []) out.push(`| ${x.frame_id} | \`${code((x.url || x.error || "").slice(0, 140))}\`${x.top ? " (page)" : ""} | ${esc((x.frameworks || []).join(", "))} | ${x.forms ?? ""} | ${x.inputs ?? ""} | ${x.scripts ?? ""} |`);
      out.push("", "Ask the AI about a frame by its id — every inspection tool takes a frame_id.");
      md(body, out.join("\n"));
    },

    flags(body, f) {
      const out = ["### Feature flags and experiments"];
      if (!(f.feature_flags || []).length && !(f.experiments || []).length) out.push("No flag SDK or flag-like storage found.");
      for (const x of f.feature_flags || []) out.push("", `**${esc(x.source)}**`, fence(JSON.stringify(Object.assign({}, x, { source: undefined }), null, 2), "json"));
      for (const x of f.experiments || []) out.push("", `**${esc(x.source)}**`, fence(JSON.stringify(x, null, 2), "json"));
      out.push("", "### Language and region", fence(JSON.stringify(f.i18n || {}, null, 2), "json"));
      out.push("", "### Workers", Array.isArray(f.workers) ? (f.workers.length ? fence(f.workers.map((w) => `${w.kind} ${w.name ? '"' + w.name + '" ' : ""}${w.url}${w.module ? " (module)" : ""}`).join("\n")) : "None started.") : esc(String(f.workers)));
      if ((f.event_streams || []).length) out.push("", "### EventSource streams", fence(f.event_streams.map((s) => s.url).join("\n")));
      md(body, out.join("\n"));
    }
  };

  /* -------------------------------------------------------------- wire */

  function wire() {
    const tabs = $("appTabs");
    // Small popup: one grouped select instead of 16 chips.
    const sel = $("appSelect");
    if (sel) {
      let group = null;
      for (const [key, label, g] of PANELS) {
        if (!group || group.label !== g) {
          group = node("optgroup");
          group.label = g;
          sel.appendChild(group);
        }
        const o = node("option", "", label);
        o.value = key;
        group.appendChild(o);
      }
      sel.addEventListener("change", () => {
        panel = sel.value;
        show();
      });
    }
    for (const [key, label] of PANELS) {
      const b = btn(label, () => {
        panel = key;
        show();
      }, "tgl");
      b.setAttribute("role", "tab");
      b.dataset.panel = key;
      tabs.appendChild(b);
    }
    tabs.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
      const i = PANELS.findIndex(([k]) => k === panel);
      panel = PANELS[(i + (ev.key === "ArrowRight" ? 1 : PANELS.length - 1)) % PANELS.length][0];
      show().then(() => tabs.querySelector(`[data-panel="${panel}"]`).focus());
    });
    $("appRefresh").addEventListener("click", () => {
      if (panel === "sources") api.rpc("sources.list", { refresh: true }).catch(() => {});
      show(true);
    });
    $("appAsk").addEventListener("click", () => {
      if (!window.__netscopeAi) return;
      window.__netscopeAi.prefill(
        "Map this app for a developer who has to work on it: stack and services, routes (and which are server loaders/actions), the main components, client state, storage (local/session, cookies, IndexedDB, caches), the API endpoints and how the frontend calls them, auth, and what the server must be doing (mark inferences). Use the source maps if there are any. Save it as a doc for this site.",
        true
      );
    });
  }

  function attach(a) {
    if (api) return;
    api = a;
    wire();
    api.subscribe((type, entry) => {
      // A reload or navigation makes cached panels stale.
      if (type === "clear" || (type === "add" && entry && entry.kind === "nav")) {
        cache.clear();
        if ($("view-app").classList.contains("on")) show();
      }
    });
  }

  return {
    attach,
    onShown: () => {
      const url = api && api.page ? api.page().url : "";
      if (url !== pageUrl) {
        pageUrl = url;
        cache.clear();
      }
      show();
    }
  };
})();
