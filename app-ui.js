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
  const PANELS = [
    ["overview", "Overview"],
    ["routes", "Routes"],
    ["components", "Components"],
    ["state", "State"],
    ["storage", "Storage"],
    ["sources", "Sources"],
    ["dom", "DOM"]
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
  const esc = (s) => String(s == null ? "" : s).replace(/\r?\n/g, " ").replace(/([\\`*_{}[\]()#+\-.!|~<>])/g, "\\$1");
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
      window.__netscopeMarkdown.render(body, text, { copy: (t, msg) => typeof copyText === "function" && copyText(t, msg) });
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
      $("appStats").textContent = "";
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
    $("appStats").textContent = data && data.ms != null ? `read in ${data.ms} ms` : "";
    try {
      RENDER[panel](body, data);
    } catch (err) {
      body.appendChild(node("p", "pane-error", "Could not show this: " + err.message));
    }
    body.scrollTop = 0;
  }

  const panelKey = () =>
    panel === "storage" ? `storage:${storageArea}:${idb.db}:${idb.store}` : panel === "state" ? `state:${stateSource}:${statePath}` : panel === "dom" ? `dom:${domSelector}` : panel === "components" ? `components:${compFilter}` : panel === "sources" ? `sources:${srcQuery}:${srcRead ? srcRead.file || srcRead.url : ""}:${srcRead ? srcRead.line || "" : ""}` : panel;

  async function load() {
    switch (panel) {
      case "overview":
        return call("overview");
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
    }
    return {};
  }

  /* ------------------------------------------------------------ panels */

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
    overview(body, o) {
      const out = [];
      const fw = o.frameworks || [];
      out.push("### Stack");
      if (fw.length) {
        out.push("| Technology | Version | Notes |", "| --- | --- | --- |");
        for (const f of fw) out.push(`| **${esc(f.name)}** | ${esc(f.version || "")} | ${esc(f.note || "")} |`);
      } else out.push("No framework detected — likely server-rendered HTML, or a framework NetScope does not recognise yet.");
      const b = o.build || {};
      if (b.next) out.push("", `**Next.js** page \`${code(b.next.page)}\`, build \`${code(b.next.buildId)}\`${b.next.data_fetching && b.next.data_fetching.length ? ", data fetching: " + esc(b.next.data_fetching.join(", ")) : ""}`);
      if (b.remix) out.push("", `**Route manifest**: ${b.remix.routes} routes (version ${esc(b.remix.version || "?")})`);
      if (b.sveltekit) out.push("", "**SvelteKit**: " + b.sveltekit.map((k) => "`" + code(JSON.stringify(k.value)) + "`").join(" "));
      if (b.nuxt) out.push("", "**Nuxt** payload keys: " + esc((b.nuxt.keys || []).join(", ")));
      if ((o.services || []).length) {
        out.push("", "### Services");
        for (const s of o.services) out.push(`- **${esc(s.name)}**${s.detail ? " — " + esc(s.detail) : ""}`);
      }
      const st = o.storage || {};
      out.push("", "### Storage", "| Where | What |", "| --- | --- |");
      const area = (a) => (a && !a.error ? `${a.count} keys, ${kb(a.chars)}` : a ? esc(a.error) : "—");
      out.push(`| localStorage | ${area(st.localStorage)} |`, `| sessionStorage | ${area(st.sessionStorage)} |`);
      out.push(`| Cookies readable by scripts | ${esc((st.cookies_visible_to_js || []).join(", ") || "none")} |`);
      out.push(`| IndexedDB | ${esc(Array.isArray(st.indexedDB) ? st.indexedDB.join(", ") || "none" : st.indexedDB)} |`);
      out.push(`| Cache Storage | ${esc((st.cacheStorage || []).join(", ") || "none")} |`);
      out.push(`| Service workers | ${esc((st.serviceWorkers || []).map((w) => w.scope + " (" + w.state + ")").join(", ") || "none")} |`);
      const p = o.performance || {};
      if (p.navigation) {
        const n = p.navigation;
        out.push("", "### Performance", "| Metric | Value |", "| --- | ---: |");
        out.push(`| Time to first byte | ${n.ttfb_ms} ms |`, `| DOMContentLoaded | ${n.dom_content_loaded_ms} ms |`, `| Load | ${n.load_ms} ms |`, `| Protocol | ${esc(n.protocol || "—")} |`);
        if (p.js_heap_mb) out.push(`| JS heap | ${p.js_heap_mb} MB |`);
        if ((n.server_timing || []).length) out.push(`| Server-Timing | ${esc(n.server_timing.join(", "))} |`);
        if ((p.slowest || []).length) out.push("", "Slowest resources:", fence(p.slowest.join("\n")));
      }
      const d = o.dom || {};
      out.push("", "### Page", `${d.elements} elements, ${d.forms} forms, ${d.inputs} inputs, ${d.buttons} buttons, ${d.links_internal} internal and ${d.links_external} external links, ${d.images} images.`);
      if ((d.custom_elements || []).length) out.push("", "Custom elements: " + esc(d.custom_elements.join(", ")));
      if ((d.iframes || []).length) out.push("", "Iframes: " + esc(d.iframes.join(", ")));
      const h = o.hosts || {};
      if ((h.third_party || []).length) out.push("", "### Hosts", "First-party: " + esc((h.first_party || []).join(", ") || "—"), "", "Third-party: " + esc(h.third_party.join(", ")));
      if ((o.inline_data || []).length) {
        out.push("", "### Data embedded in the HTML");
        for (const x of o.inline_data) out.push(`- \`${code(x.id || x.type)}\` ${kb(x.chars)}: ${esc(x.shape)}`);
      }
      const g = o.app_globals || {};
      if ((g.sample || []).length) out.push("", `### App globals (${g.count})`, fence(g.sample.join("\n")));
      const m = o.meta || {};
      out.push("", "### Meta", fence(JSON.stringify(m, null, 2), "json"));
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
    }
  };

  /* -------------------------------------------------------------- wire */

  function wire() {
    const tabs = $("appTabs");
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
