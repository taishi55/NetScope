/* NetScope – seo-ui.js
 * The SEO view: enter a site (and optionally its queries, or a Search
 * Console export), compare it with Google's top 2 for each query, read the
 * per-query scores and gaps, then have the AI write the playbook.
 * DOM is built with createElement/textContent only.
 */
"use strict";

window.__netscopeSeoUi = (() => {
  const S = () => window.__netscopeSeo;
  let api = null;
  let report = null; // the report on screen
  let running = null; // { ctl, rows, blocked }
  const open = new Set(); // expanded queries
  const $ = (id) => document.getElementById(id);

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const btn = (label, cls, onClick) => {
    const b = node("button", cls || "", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  };
  const aiName = () => (window.__netscopeAi && window.__netscopeAi.aiName ? window.__netscopeAi.aiName() : "Kimi");
  const fmt = (n) => Number(n || 0).toLocaleString();
  const visible = () => $("view-seo") && $("view-seo").classList.contains("on");

  /* -------------------------------------------------------------- form */

  async function prefill() {
    const st = await S().loadStore();
    const d = $("seoDomain");
    if (!d.value) {
      let host = st.last.domain || "";
      if (!host && api) {
        try {
          const u = new URL(api.page().url);
          if (/^https?:/.test(u.protocol)) host = u.hostname.replace(/^www\./, "");
        } catch (_) {}
      }
      d.value = host;
    }
    if (!$("seoHl").value && st.last.hl) $("seoHl").value = st.last.hl;
    if (!$("seoGl").value && st.last.gl) $("seoGl").value = st.last.gl;
    if (!report && st.reports[0]) report = st.reports[0];
    fillHistory(st.reports);
    render();
  }

  function fillHistory(list) {
    const sel = $("seoHistory");
    sel.replaceChildren();
    sel.hidden = list.length < 2;
    for (const r of list) {
      const o = node("option", "", `${r.domain} · ${new Date(r.created).toLocaleDateString()} · ${r.rows.length} ${r.rows.length === 1 ? "query" : "queries"}`);
      o.value = r.id;
      if (report && report.id === r.id) o.selected = true;
      sel.appendChild(o);
    }
  }

  function readQueries() {
    return $("seoQueries")
      .value.split(/\r?\n/)
      .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
      .filter(Boolean)
      .map((q) => ({ query: q }));
  }

  function setRunning(on) {
    for (const id of ["seoDomain", "seoHl", "seoGl", "seoQueries", "seoRun", "seoImport"]) $(id).disabled = on;
    $("seoStop").hidden = !on;
    if (!on) $("seoStatus").textContent = "";
  }

  async function start(ev) {
    if (ev) ev.preventDefault();
    if (running) return;
    let host;
    try {
      host = S().hostOf($("seoDomain").value);
    } catch (err) {
      $("seoStatus").textContent = err.message;
      $("seoDomain").focus();
      return;
    }
    $("seoDomain").value = host;
    const hl = $("seoHl").value.trim().toLowerCase();
    const gl = $("seoGl").value.trim().toLowerCase();
    const ctl = new AbortController();
    running = { ctl, rows: [], blocked: null, host };
    open.clear();
    report = null;
    setRunning(true);
    render();
    const say = (t) => ($("seoStatus").textContent = t);
    try {
      let queries = readQueries();
      let by = "you";
      if (!queries.length) {
        const d = await S().discover(host, { count: 8, hl, signal: ctl.signal, onStatus: say });
        queries = d.queries;
        by = d.by;
        if (!queries.length) throw new Error(`Could not find queries for ${host}. Type a few, one per line.`);
        $("seoQueries").value = queries.map((q) => q.query).join("\n");
      }
      const r = await S().analyze({
        domain: host,
        queries,
        hl,
        gl,
        queries_by: by,
        signal: ctl.signal,
        onStatus: say,
        onRow(row, i) {
          running.rows[i] = row;
          render();
        },
        onBlocked: (kind, run) =>
          new Promise((resolve) => {
            running.blocked = { kind, run, resolve };
            render();
          })
      });
      report = r;
      running = null;
      setRunning(false);
      const st = await S().loadStore();
      fillHistory(st.reports);
      render();
      if (typeof toast === "function") toast(`Compared ${r.rows.length} ${r.rows.length === 1 ? "query" : "queries"} for ${r.domain}`);
    } catch (err) {
      const stopped = err && err.name === "AbortError";
      running = null;
      setRunning(false);
      report = (await S().latest()) || null;
      render();
      $("seoStatus").textContent = stopped ? "Stopped." : err.message;
    }
  }

  async function importCsv(file) {
    const text = await file.text();
    const list = S().parseQueriesCsv(text);
    if (!list.length) {
      $("seoStatus").textContent = "No queries found in that file.";
      return;
    }
    $("seoQueries").value = list
      .slice(0, S().MAX_QUERIES)
      .map((q) => q.query)
      .join("\n");
    $("seoStatus").textContent = `Imported the top ${Math.min(list.length, S().MAX_QUERIES)} of ${list.length} queries.`;
  }

  /* ------------------------------------------------------------ render */

  function render() {
    const body = $("seoBody");
    if (!body) return;
    body.replaceChildren();
    if (running) {
      if (running.blocked) body.appendChild(blockedBanner(running.blocked));
      const rows = running.rows.filter(Boolean);
      if (!rows.length) body.appendChild(node("p", "seo-wait", "Reading your site and choosing queries…"));
      else body.appendChild(resultsTable(rows, running.host, true));
      return;
    }
    if (!report) return body.appendChild(emptyState());
    body.appendChild(summary(report));
    body.appendChild(resultsTable(report.rows, report.domain, false));
    body.appendChild(node("p", "hint seo-note", "Scores are on-page points out of 100 for each query, from the same rubric for every page. Backlinks and domain authority are not measured. Google's results come from this browser, so they can be personal and local."));
  }

  function emptyState() {
    const box = node("div", "seo-empty");
    box.appendChild(node("h2", "", "See why the top results win"));
    box.appendChild(
      node(
        "p",
        "",
        `For each query, NetScope searches Google in a background tab, reads your page and the top 2 other sites, and scores all three on the same on-page checklist. ${aiName()} then writes the playbook: new titles, descriptions, headings, schema and content to add.`
      )
    );
    const steps = node("ul", "seo-steps");
    for (const t of ["Leave the queries empty to have them picked from your site, or paste your own.", "Have Search Console? Export Performance › Queries and import the CSV to use your real queries.", "If Google asks you to confirm you're not a robot, NetScope stops and waits for you."]) steps.appendChild(node("li", "", t));
    box.appendChild(steps);
    return box;
  }

  function blockedBanner(b) {
    const box = node("div", "connect seo-blocked");
    box.setAttribute("role", "alert");
    box.appendChild(node("p", "", b.kind === "captcha" ? "Google wants you to confirm you're not a robot. Open the Google tab, complete the check yourself, then continue." : "Google is showing its cookie consent page. Open the Google tab, make your choice, then continue."));
    const a = node("div", "actions");
    a.appendChild(btn("Open the Google tab", "primary", () => api.rpc("seo.show", { run: b.run }).catch((err) => toast(err.message))));
    a.appendChild(
      btn("Continue", "", () => {
        running.blocked = null;
        render();
        b.resolve(true);
      })
    );
    a.appendChild(
      btn("Stop", "ghost", () => {
        running.blocked = null;
        b.resolve(false);
      })
    );
    box.appendChild(a);
    return box;
  }

  function summary(r) {
    const done = r.rows.filter((x) => x.status === "done");
    const ranked = done.filter((x) => x.rank);
    const mine = done.map((x) => x.user.score).filter((n) => n != null);
    const top = done.flatMap((x) => x.competitors.map((c) => c.score)).filter((n) => n != null);
    const avg = (a) => (a.length ? Math.round(a.reduce((t, n) => t + n, 0) / a.length) : null);
    const high = done.reduce((t, x) => t + x.gaps.filter((g) => g.sev === "high").length, 0);
    const best = ranked.slice().sort((a, b) => a.rank - b.rank)[0];
    const wrap = node("div", "seo-summary");
    const head = node("div", "seo-head");
    head.appendChild(node("h2", "", r.domain));
    head.appendChild(node("span", "pane-stats", `${new Date(r.created).toLocaleString()}${r.stopped ? " · stopped early" : ""}${r.queries_by && r.queries_by !== "you" ? ` · queries from ${r.queries_by}` : ""}`));
    wrap.appendChild(head);
    const strip = node("div", "readout");
    const cell = (label, value, detail, tone) => {
      const c = node("div", "ro-cell" + (tone ? " ro-" + tone : ""));
      c.append(node("span", "ro-label", label), node("span", "ro-value", value));
      if (detail) c.appendChild(node("span", "ro-detail", detail));
      strip.appendChild(c);
    };
    cell("In the top 10", `${ranked.length} of ${done.length}`, best ? `Best: #${best.rank} for “${best.query}”` : "Not ranking yet for these", ranked.length ? (ranked.length === done.length ? "good" : "") : "bad");
    const a = avg(mine);
    const b = avg(top);
    cell("Your score", a == null ? "—" : `${a} / 100`, b == null ? "" : `Top rivals average ${b}`, a != null && b != null ? (a >= b ? "good" : a < b - 10 ? "bad" : "") : "");
    cell("High-priority gaps", String(high), high ? "Fix these first" : "None found", high ? "bad" : "good");
    cell("Compared", `${done.length} ${done.length === 1 ? "query" : "queries"}`, `Your page and the top 2 for each${r.gl ? ", from " + r.gl.toUpperCase() : ""}`);
    wrap.appendChild(strip);
    const actions = node("div", "actions seo-actions");
    actions.appendChild(btn(`Write the playbook with ${aiName()}`, "primary", () => writePlaybook(r)));
    actions.appendChild(btn("Copy as Markdown", "", () => typeof copyText === "function" && copyText(S().toMarkdown(r), "Copied as Markdown")));
    actions.appendChild(
      btn("Save as doc", "ghost", async () => {
        try {
          await api.rpc("docs.save", { by: "you", doc: { title: `SEO comparison — ${r.domain}`, content: S().toMarkdown(r) } });
          toast("Saved to Docs");
        } catch (err) {
          toast(err.message);
        }
      })
    );
    wrap.appendChild(actions);
    return wrap;
  }

  async function writePlaybook(r) {
    const c = window.__netscopeAiClient;
    const s = c ? await c.loadSettings() : null;
    if (!c || !c.isReady(s)) {
      toast(`Connect ${aiName()} in Settings to write the playbook. Save as doc keeps the comparison meanwhile.`);
      return;
    }
    if (window.__netscopeAi) window.__netscopeAi.prefill(S().playbookPrompt(r), true);
  }

  function scoreText(n) {
    return n == null ? "—" : String(n);
  }

  // Query (with its biggest gap underneath), then You, #1 and #2 as score
  // over rank or domain: narrow enough for the small popup.
  function resultsTable(rows, host, live) {
    const wrap = node("div", "dt-wrap");
    const t = node("table", "dt seo-table");
    const thead = node("thead");
    const hr = node("tr");
    for (const [label, cls] of [
      [live ? "Query and status" : "Query and biggest gap", ""],
      ["You", "c-sc"],
      ["Rival 1", "c-sc"],
      ["Rival 2", "c-sc"]
    ]) {
      const th = node("th", cls, label);
      th.scope = "col";
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    t.appendChild(thead);
    const tb = node("tbody");
    for (const x of rows) {
      const tr = node("tr", "seo-row" + (x.status === "error" ? " bad" : ""));
      const q = node("td", "seo-q");
      q.appendChild(node("span", "seo-query", x.query));
      if (x.impressions != null) q.appendChild(node("span", "name-sub", ` · ${fmt(x.impressions)} impressions`));
      let sub = "";
      if (live && x.status !== "done") sub = x.status === "searching" ? "Searching Google…" : x.status === "reading" ? "Reading your page and the top 2…" : x.error || "";
      else sub = x.error ? "Couldn't search: " + x.error : x.gaps[0] ? x.gaps[0].text : "No gaps found";
      q.appendChild(node("span", "seo-gap" + (x.gaps && x.gaps[0] && x.gaps[0].sev === "high" ? " seo-high" : ""), sub));
      tr.appendChild(q);
      const you = node("td", "c-sc");
      if (x.status === "done") {
        you.appendChild(node("span", "seo-score " + tone(x.user.score, x.competitors[0] && x.competitors[0].score), scoreText(x.user.score)));
        you.appendChild(node("span", "seo-sub", x.rank ? `#${x.rank}` : "not top 10"));
      } else you.textContent = "…";
      tr.appendChild(you);
      for (let k = 0; k < 2; k++) {
        const c = x.competitors && x.competitors[k];
        const td = node("td", "c-sc");
        if (c) {
          td.appendChild(node("span", "seo-score", scoreText(c.score)));
          td.appendChild(node("span", "seo-sub", `#${c.rank} ${c.domain}`));
          td.title = c.url;
        } else td.textContent = x.status === "done" ? "—" : "";
        tr.appendChild(td);
      }
      tb.appendChild(tr);
      if (x.status === "done") {
        tr.tabIndex = 0;
        tr.setAttribute("role", "button");
        tr.setAttribute("aria-expanded", open.has(x.query) ? "true" : "false");
        tr.setAttribute("aria-label", `${x.query}: your score ${scoreText(x.user.score)}, ${x.rank ? "rank " + x.rank : "not in the top 10"}. Show the comparison`);
        const toggle = () => {
          if (open.has(x.query)) open.delete(x.query);
          else open.add(x.query);
          render();
        };
        tr.addEventListener("click", toggle);
        tr.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            toggle();
          }
        });
        if (open.has(x.query)) {
          const dr = node("tr", "seo-detail");
          const td = node("td");
          td.colSpan = 4;
          td.appendChild(detail(x, host));
          dr.appendChild(td);
          tb.appendChild(dr);
        }
      }
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }

  function tone(mine, theirs) {
    if (mine == null || theirs == null) return "";
    return mine >= theirs ? "good" : mine < theirs - 10 ? "bad" : "";
  }

  /* ------------------------------------------------------------ detail */

  function detail(x) {
    const box = node("div", "seo-more");
    if (x.gaps.length) {
      box.appendChild(node("h3", "", "What you're missing"));
      const ul = node("ul", "seo-gaps");
      for (const g of x.gaps) {
        const li = node("li", "sev-" + g.sev);
        li.appendChild(node("span", "sev", g.sev === "high" ? "High" : g.sev === "medium" ? "Medium" : "Low"));
        li.appendChild(document.createTextNode(" " + g.text));
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }

    box.appendChild(node("h3", "", "Side by side"));
    const pages = [{ label: "You", url: x.user.url, a: x.user.audit, score: x.user.score, hits: x.user.paa_hits }].concat(x.competitors.map((c) => ({ label: "#" + c.rank, url: c.url, a: c.audit, score: c.score, hits: c.paa_hits })));
    const paa = x.serp.people_also_ask || [];
    const terms = (x.user.audit && x.user.audit.terms) || (pages.find((p) => p.a && p.a.terms) || { a: { terms: [] } }).a.terms || [];
    const frac = (arr) => `${(arr || []).length}/${terms.length}`;
    const SIG = [
      ["Score", (p) => scoreText(p.score), (p) => p.score],
      ["Title", (p) => `${p.a.title || "(none)"} · ${p.a.title_len}`, (p) => (p.a.title_terms || []).length * 10 + (p.a.title_len >= 30 && p.a.title_len <= 60 ? 1 : 0)],
      ["Query words in title / H1 / URL / intro", (p) => [frac(p.a.title_terms), frac(p.a.h1_terms), frac(p.a.url_terms), frac(p.a.intro_terms)].join(" · "), (p) => (p.a.title_terms || []).length + (p.a.h1_terms || []).length + (p.a.url_terms || []).length + (p.a.intro_terms || []).length],
      ["Meta description", (p) => (p.a.description ? `${p.a.description_len} chars` : "missing"), (p) => (p.a.description ? 1 + (p.a.description_len >= 120 && p.a.description_len <= 160 ? 1 : 0) : 0)],
      ["H1", (p) => (p.a.h1 || []).join(" | ") || "missing", (p) => ((p.a.h1 || []).length === 1 ? 1 : 0)],
      ["Words", (p) => fmt(p.a.words), (p) => p.a.words],
      ["H2 sections", (p) => String(p.a.h2_count || 0), (p) => p.a.h2_count || 0],
      ["People also ask answered", (p) => (paa.length ? `${(p.hits || []).filter(Boolean).length}/${paa.length}` : "—"), (p) => (p.hits || []).filter(Boolean).length],
      ["Structured data", (p) => (p.a.schema || []).join(", ") || "none", (p) => (p.a.schema || []).length],
      ["Lists · tables · videos", (p) => `${p.a.lists} · ${p.a.tables} · ${p.a.videos}`, (p) => p.a.lists + p.a.tables + p.a.videos],
      ["Images without alt", (p) => (p.a.images ? `${p.a.images_no_alt} of ${p.a.images}` : "no images"), (p) => (p.a.images ? -p.a.images_no_alt / p.a.images : 0)],
      ["Internal links", (p) => String(p.a.links_internal), (p) => Math.min(p.a.links_internal, 30)],
      ["Updated", (p) => (p.a.dates && (p.a.dates.modified || p.a.dates.published || p.a.dates.visible) ? String(p.a.dates.modified || p.a.dates.published || p.a.dates.visible).slice(0, 10) : "no date"), (p) => (p.a.dates && (p.a.dates.modified || p.a.dates.published || p.a.dates.visible) ? 1 : 0)],
      ["Author", (p) => p.a.author || "none", (p) => (p.a.author ? 1 : 0)],
      ["Load (background tab)", (p) => (p.a.load_ms ? (p.a.load_ms / 1000).toFixed(1) + " s" : "—"), (p) => (p.a.load_ms ? -p.a.load_ms : null)]
    ];
    const wrap = node("div", "dt-wrap");
    const t = node("table", "dt seo-sig");
    const thead = node("thead");
    const hr = node("tr");
    const th0 = node("th", "", "Signal");
    th0.scope = "col";
    hr.appendChild(th0);
    for (const p of pages) {
      const th = node("th", "", p.label);
      th.scope = "col";
      th.title = p.url;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    t.appendChild(thead);
    const tb = node("tbody");
    for (const [label, show, rank] of SIG) {
      const tr = node("tr");
      const th = node("th", "", label);
      th.scope = "row";
      tr.appendChild(th);
      const vals = pages.map((p) => (p.a && !p.a.error ? rank(p) : null));
      const best = Math.max(...vals.filter((v) => v != null));
      pages.forEach((p, i) => {
        const td = node("td");
        if (!p.a || p.a.error) td.textContent = i === 0 ? "couldn't read" : "—";
        else {
          td.textContent = show(p);
          if (i === 0 && vals[0] != null && vals.length > 1 && vals[0] < best) td.classList.add("worse");
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    box.appendChild(wrap);

    if ((x.skipped || []).length) box.appendChild(node("p", "hint", "Not read: " + x.skipped.map((k) => `#${k.rank} ${k.domain} (${k.reason})`).join("; ") + ". The next results took their place."));
    const links = node("p", "seo-urls");
    for (const p of pages) {
      const a = node("a", "", `${p.label}: ${p.url}`);
      a.href = p.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      links.appendChild(a);
    }
    box.appendChild(links);

    if (paa.length) {
      box.appendChild(node("h3", "", "People also ask"));
      const ul = node("ul", "seo-paa");
      paa.forEach((q, i) => {
        const li = node("li", (x.user.paa_hits || [])[i] ? "hit" : "miss", q);
        li.appendChild(node("span", "sr-only", (x.user.paa_hits || [])[i] ? " (your page answers this)" : " (your page does not answer this)"));
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    const f = x.serp.features || {};
    const feats = [f.ai_overview && "AI Overview", f.featured_snippet && "Featured snippet", f.ads && `${f.ads} ads`, f.local_pack && "Local pack", f.videos && "Videos", f.shopping && "Shopping", f.top_stories && "Top stories", f.images && "Images", f.knowledge_panel && "Knowledge panel"].concat((f.packs || []).filter((x) => x !== "Videos")).filter(Boolean);
    if (feats.length || (x.serp.related_searches || []).length) {
      const p = node("p", "seo-feats");
      if (feats.length) p.appendChild(node("span", "", "On the results page: " + feats.join(", ") + ". "));
      if ((x.serp.related_searches || []).length) p.appendChild(node("span", "dim", "Related searches: " + x.serp.related_searches.slice(0, 6).join(" · ")));
      box.appendChild(p);
    }
    return box;
  }

  /* -------------------------------------------------------------- wire */

  function attach(a) {
    if (api) return;
    api = a;
    $("seoForm").addEventListener("submit", start);
    $("seoStop").addEventListener("click", () => {
      if (!running) return;
      if (running.blocked) running.blocked.resolve(false);
      running.ctl.abort();
    });
    $("seoImport").addEventListener("click", () => $("seoFile").click());
    $("seoFile").addEventListener("change", (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (f) importCsv(f).catch((err) => ($("seoStatus").textContent = err.message));
      ev.target.value = "";
    });
    $("seoHistory").addEventListener("change", async (ev) => {
      report = await S().latest(ev.target.value);
      open.clear();
      render();
    });
  }

  return {
    attach,
    onShown: () => prefill().catch(() => {}),
    // compare_with_competitors from the chat shows its result here too.
    showReport(r) {
      if (running) return;
      report = r;
      open.clear();
      S()
        .loadStore()
        .then((st) => fillHistory(st.reports))
        .catch(() => {});
      if (visible()) render();
    }
  };
})();
