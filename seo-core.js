/* NetScope – seo-core.js
 * "Compare with Google's top 2": for each search query tied to a site,
 * read Google's results in a background tab of this browser, then the
 * site's own page and the top two other sites, score all three on the same
 * on-page rubric, and list what the site is missing. The AI turns that into
 * a per-query playbook (get_seo_report).
 *
 * Rubric (100 points): query terms in title, H1, URL, intro and meta;
 * title and meta length; one H1; H2 structure; depth against the top
 * results; alt text; internal links; structured data; People also ask
 * coverage; freshness; authorship; viewport, HTTPS and canonical.
 * On-page only: backlinks and domain authority are not measured.
 */
"use strict";

window.__netscopeSeo = (() => {
  const T = window.__netscopeAiTools;
  const C = () => window.__netscopeAiClient;
  const STORE = "netscope.seo";
  const MAX_QUERIES = 20;
  const PACE_MS = 2500; // between Google searches: a person's pace
  let api = null;

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener("abort", () => (clearTimeout(t), reject(Object.assign(new Error("stopped"), { name: "AbortError" }))), { once: true });
    });
  const fmt = (n) => Number(n || 0).toLocaleString();

  function hostOf(raw) {
    let s = String(raw || "").trim();
    if (!s) throw new Error("enter your site, e.g. example.com");
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    let u;
    try {
      u = new URL(s);
    } catch (_) {
      throw new Error(`“${raw}” is not a domain`);
    }
    if (!/\./.test(u.hostname)) throw new Error(`“${raw}” is not a domain`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  }
  const sameSite = (url, host) => {
    try {
      const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      return h === host || h.endsWith("." + host);
    } catch (_) {
      return false;
    }
  };
  const domainOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (_) {
      return url;
    }
  };

  /* ------------------------------------------------------------ storage */

  async function loadStore() {
    try {
      const g = await chrome.storage.local.get(STORE);
      return Object.assign({ reports: [], last: {} }, g[STORE] || {});
    } catch (_) {
      return { reports: [], last: {} };
    }
  }

  async function saveReport(r) {
    const st = await loadStore();
    st.reports = [r].concat(st.reports.filter((x) => x.id !== r.id)).slice(0, 6);
    st.last = { domain: r.domain, hl: r.hl, gl: r.gl };
    await chrome.storage.local.set({ [STORE]: st });
  }

  async function latest(id) {
    const st = await loadStore();
    return id ? st.reports.find((r) => r.id === id) || null : st.reports[0] || null;
  }

  /* ---------------------------------------------------------- discovery */

  const BRANDLESS = /\s+[|–—•·:]\s+|\s+-\s+/;

  async function discover(domain, o) {
    const opts = o || {};
    const host = hostOf(domain);
    const run = opts.run || "seo-discover-" + Date.now().toString(36);
    try {
      return await discoverIn(host, run, opts);
    } finally {
      // Our own reading tab closes; a caller's (the AI tool's) closes on its own timer.
      if (!opts.run) await api.rpc("seo.done", { run }).catch(() => {});
    }
  }

  async function discoverIn(host, run, opts) {
    const base = `https://${host}/`;
    const say = opts.onStatus || (() => {});
    say(`Reading ${host}…`);
    const home = await api.rpc("seo.audit", { run, url: base, query: "" }).catch((err) => ({ error: err.message }));
    const pages = [];
    if (home && !home.error) pages.push({ url: home.url, title: home.title, h1: (home.h1 || [])[0] || "", description: home.description });

    // Sitemap URLs (robots.txt first), else the homepage's own links.
    let urls = [];
    try {
      const robots = await api.rpc("seo.fetch", { url: base + "robots.txt" });
      let maps = Array.from(String(robots.text || "").matchAll(/^\s*sitemap:\s*(\S+)/gim)).map((m) => m[1]);
      if (!maps.length) maps = [base + "sitemap.xml"];
      for (const m of maps.slice(0, 3)) {
        const r = await api.rpc("seo.fetch", { url: m });
        const locs = Array.from(String(r.text || "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((x) => x[1].replace(/&amp;/g, "&"));
        if (/<sitemapindex/i.test(r.text || "")) {
          for (const sm of locs.slice(0, 3)) {
            const r2 = await api.rpc("seo.fetch", { url: sm });
            urls.push(...Array.from(String(r2.text || "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((x) => x[1].replace(/&amp;/g, "&")));
          }
        } else urls.push(...locs);
        if (urls.length > 800) break;
      }
    } catch (_) {}
    urls = urls.filter((u) => sameSite(u, host) && !/\.(xml|pdf|jpe?g|png|gif|webp|svg|zip)(\?|$)/i.test(u));
    if (!urls.length && home && home.internal_pages) urls = home.internal_pages.map((l) => l.url);

    // A spread of sections: shallow paths first, one per first segment.
    const bySection = new Map();
    for (const u of urls) {
      let path;
      try {
        path = new URL(u).pathname;
      } catch (_) {
        continue;
      }
      if (path === "/" || /\/(tag|tags|author|page|category|login|signin|cart|account|privacy|terms|legal|cookie)s?\b/i.test(path)) continue;
      const seg = path.split("/").filter(Boolean)[0] || "";
      const depth = path.split("/").filter(Boolean).length;
      const list = bySection.get(seg) || [];
      list.push({ u, depth });
      bySection.set(seg, list);
    }
    const picked = [];
    for (const list of bySection.values()) list.sort((a, b) => a.depth - b.depth);
    for (let round = 0; picked.length < 12 && round < 4; round++) {
      for (const list of bySection.values()) {
        if (list[round] && picked.length < 12) picked.push(list[round].u);
      }
    }
    for (const u of picked) {
      if (opts.signal && opts.signal.aborted) break;
      say(`Reading ${host} (${pages.length + 1}/${picked.length + 1})…`);
      const r = await api.rpc("seo.fetch", { url: u }).catch(() => null);
      if (!r || !r.text || r.status >= 400) continue;
      const doc = new DOMParser().parseFromString(r.text, "text/html");
      const m = doc.querySelector("meta[name='description']");
      pages.push({ url: r.url || u, title: (doc.title || "").trim(), h1: ((doc.querySelector("h1") || {}).textContent || "").replace(/\s+/g, " ").trim(), description: m ? (m.getAttribute("content") || "").trim() : "" });
    }

    const n = Math.min(Math.max(Number(opts.count) || 8, 1), MAX_QUERIES);
    say("Choosing queries…");
    let queries = null;
    try {
      queries = await proposeQueries(host, pages, n, opts.hl, opts.signal);
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      queries = null;
    }
    if (!queries || !queries.length) queries = heuristicQueries(host, pages, n);
    return { host, pages, queries, by: queries && queries.by };
  }

  async function proposeQueries(host, pages, n, hl, signal) {
    const c = C();
    const s = await c.loadSettings();
    if (!c.isReady(s) || !pages.length) return null;
    const list = pages
      .slice(0, 14)
      .map((p) => `- ${p.title || "(no title)"} | ${p.h1 || ""} | ${String(p.description || "").slice(0, 140)} | ${p.url}`)
      .join("\n");
    const prompt =
      `Site: ${host}\nPages (title | H1 | description | URL):\n${list}\n\n` +
      `List the ${n} Google search queries this site most needs to rank for: phrases real people type (2-6 words), in the site's own language${hl ? ` (${hl})` : ""}, ` +
      "a mix of commercial and informational intent, each tied to the page that should rank for it. No queries that are only the brand name. " +
      'Reply with JSON only: [{"query": "...", "page_url": "...", "intent": "commercial|informational|transactional|local"}]';
    const turn = await c.chat({
      messages: [
        { role: "system", content: "You are an SEO strategist. Reply with JSON only, no prose." },
        { role: "user", content: prompt }
      ],
      reasoning_effort: "low",
      max_completion_tokens: 6000,
      signal
    });
    const text = String((turn && turn.assistantMessage && turn.assistantMessage.content) || "");
    const m = /\[[\s\S]*\]/.exec(text);
    if (!m) return null;
    let arr;
    try {
      arr = JSON.parse(m[0]);
    } catch (_) {
      return null;
    }
    const out = [];
    for (const q of Array.isArray(arr) ? arr : []) {
      const query = String((q && q.query) || "").trim();
      if (query && query.length < 120 && !out.some((x) => x.query.toLowerCase() === query.toLowerCase())) out.push({ query, page_url: q.page_url && sameSite(q.page_url, host) ? String(q.page_url) : undefined, intent: q.intent ? String(q.intent) : undefined });
    }
    out.by = c.providerName(s.model);
    return out.slice(0, n);
  }

  // Without an AI: page titles and H1s minus the brand.
  function heuristicQueries(host, pages, n) {
    const brand = host.split(".")[0].toLowerCase();
    const out = [];
    for (const p of pages) {
      for (const src of [p.h1, p.title]) {
        if (!src) continue;
        let found = false;
        for (let seg of String(src).split(BRANDLESS)) {
          seg = seg.replace(/\s+/g, " ").trim().toLowerCase();
          if (seg.length < 6 || seg.length > 70 || seg.includes(brand) || /^(home|homepage|welcome|index|untitled)$/.test(seg)) continue;
          if (!out.some((q) => q.query === seg)) out.push({ query: seg, page_url: p.url });
          found = true;
          break;
        }
        if (found) break;
      }
      if (out.length >= n) break;
    }
    out.by = "page titles";
    return out;
  }

  // Search Console › Performance › Queries › Export: "Top queries,Clicks,…".
  function parseQueriesCsv(text) {
    const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];
    const cells = (l) => {
      const out = [];
      let cur = "";
      let q = false;
      for (let i = 0; i < l.length; i++) {
        const ch = l[i];
        if (q && ch === '"' && l[i + 1] === '"') (cur += '"'), i++;
        else if (ch === '"') q = !q;
        else if (ch === "," && !q) out.push(cur), (cur = "");
        else cur += ch;
      }
      out.push(cur);
      return out.map((c) => c.trim());
    };
    const head = cells(lines[0]).map((h) => h.toLowerCase());
    let col = head.findIndex((h) => /quer|keyword|search term/.test(h));
    const clicks = head.findIndex((h) => /click/.test(h));
    const impr = head.findIndex((h) => /impression/.test(h));
    const start = col >= 0 ? 1 : 0;
    if (col < 0) col = 0;
    const rows = lines.slice(start).map(cells).filter((r) => r[col]);
    rows.sort((a, b) => (Number(b[impr]) || Number(b[clicks]) || 0) - (Number(a[impr]) || Number(a[clicks]) || 0));
    return rows.map((r) => ({ query: r[col], clicks: clicks >= 0 ? Number(r[clicks]) || 0 : undefined, impressions: impr >= 0 ? Number(r[impr]) || 0 : undefined }));
  }

  /* ------------------------------------------------------------ scoring */

  const STOPQ = new Set("a an and are as at be by for from how in is it of on or the to vs what when where which who why will with your you my do does can".split(" "));
  // A People-also-ask question counts as answered when most of its key words
  // appear on the page.
  function paaHits(text, questions) {
    const t = String(text || "");
    return (questions || []).map((q) => {
      const words = String(q)
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 3 && !STOPQ.has(w));
      if (!words.length) return false;
      return words.filter((w) => t.includes(w)).length / words.length >= 0.6;
    });
  }

  const USEFUL_SCHEMA = new Set(["FAQPage", "HowTo", "Product", "Review", "AggregateRating", "Article", "BlogPosting", "NewsArticle", "BreadcrumbList", "Organization", "LocalBusiness", "Recipe", "Event", "VideoObject", "SoftwareApplication", "Offer", "Course", "JobPosting", "Service", "ItemList", "QAPage", "WebApplication", "Person"]);

  function score(a, ctx) {
    if (!a || a.error) return null;
    const n = (a.terms || []).length;
    const frac = (arr) => (n ? (arr || []).length / n : 0);
    let s = 0;
    s += 12 * frac(a.title_terms) + (a.title_len >= 30 && a.title_len <= 60 ? 4 : a.title_len ? 2 : 0) + (a.title_starts_with_term ? 3 : 0);
    s += a.description ? 3 + 5 * frac(a.description_terms) : 0;
    s += a.description_len >= 120 && a.description_len <= 160 ? 3 : 0;
    s += ((a.h1 || []).length === 1 ? 3 : 0) + 9 * frac(a.h1_terms);
    s += 4 * frac(a.url_terms) + 5 * frac(a.intro_terms);
    s += Math.min(4, a.h2_count || 0) + ((a.h2_terms || []).length ? 4 : 0);
    s += ctx.avgWords ? 10 * Math.min(1, (a.words || 0) / (0.8 * ctx.avgWords)) : 10 * Math.min(1, (a.words || 0) / 600);
    s += a.images ? 4 * (1 - a.images_no_alt / a.images) : 2;
    s += Math.min(4, (a.links_internal || 0) / 2);
    s += (a.schema || []).length ? 6 : 0;
    s += ctx.paa && ctx.paa.length ? (6 * (a.paa_answered || 0)) / ctx.paa.length : 3;
    s += a.dates && (a.dates.modified || a.dates.published || a.dates.visible) ? 3 : 0;
    s += a.author ? 3 : 0;
    s += (a.viewport ? 2 : 0) + (a.https ? 2 : 0) + (a.canonical && !a.canonical_elsewhere ? 1 : 0);
    if (a.noindex) s = Math.min(s, 10);
    return Math.round(Math.min(100, s));
  }

  function gapsFor(row, host) {
    const g = [];
    const add = (sev, text) => g.push({ sev, text });
    const u = row.user.audit;
    const cs = row.competitors.map((c) => c.audit).filter((a) => a && !a.error);
    if (!u || u.error) {
      add("high", `Could not read your page${u && u.error ? ": " + u.error : ""}.`);
      return g;
    }
    const terms = u.terms || [];
    const list = (arr) => `“${arr.join("”, “")}”`;
    if (u.noindex) add("high", "Your page has a noindex robots tag, so Google will not rank it.");
    if (u.canonical_elsewhere) add("high", `Its canonical link points to ${u.canonical}, so Google credits that URL instead.`);
    if (u.looks_404) add("high", "Your page looks like a “not found” page.");
    if (row.user.mapped === "homepage") add("high", `No page on ${host} targets this query; your homepage is the closest match. Create a page for it.`);
    const missT = terms.filter((t) => !(u.title_terms || []).includes(t));
    if (missT.length) add(cs.some((c) => missT.every((t) => (c.title_terms || []).includes(t))) ? "high" : "medium", `Title is missing ${list(missT)}${cs.some((c) => missT.every((t) => (c.title_terms || []).includes(t))) ? " — the top results have it" : ""}.`);
    if (!(u.h1 || []).length) add("high", "No H1 heading.");
    else {
      const missH = terms.filter((t) => !(u.h1_terms || []).includes(t));
      if (missH.length) add("medium", `H1 does not mention ${list(missH)}.`);
      if (u.h1.length > 1) add("low", `${u.h1.length} H1 headings; keep one.`);
    }
    const avg = cs.length ? Math.round(cs.reduce((t, c) => t + (c.words || 0), 0) / cs.length) : 0;
    if (avg && u.words < avg * 0.6) add("high", `Thin next to the top results: ${fmt(u.words)} words against ${fmt(avg)} on average.`);
    else if (avg && u.words < avg * 0.85) add("medium", `Shorter than the top results: ${fmt(u.words)} words against ${fmt(avg)}.`);
    const paa = row.serp.people_also_ask || [];
    if (paa.length) {
      const missed = paa.filter((_, i) => !(row.user.paa_hits || [])[i]);
      if (missed.length >= Math.ceil(paa.length / 2)) add("medium", `Answers ${paa.length - missed.length} of ${paa.length} “People also ask” questions. Missing: ${missed.slice(0, 3).join(" · ")}.`);
    }
    const compSchema = new Set(cs.flatMap((c) => c.schema || []));
    const missingSchema = Array.from(compSchema).filter((t) => USEFUL_SCHEMA.has(t) && !(u.schema || []).includes(t));
    if (missingSchema.length) add("medium", `The top results use ${missingSchema.slice(0, 4).join(", ")} structured data; you do not.`);
    else if (!(u.schema || []).length) add("medium", "No structured data (JSON-LD) on the page.");
    if (!u.description) add("medium", "No meta description.");
    else if (u.description_len < 110 || u.description_len > 170) add("low", `Meta description is ${u.description_len} characters; aim for 150–160.`);
    if (u.title_len > 62 || (u.title_len && u.title_len < 25)) add("low", `Title is ${u.title_len} characters; aim for 50–60.`);
    if (!(u.url_terms || []).length && terms.length && cs.some((c) => (c.url_terms || []).length)) add("low", "The URL has none of the query's words; the top results' URLs do.");
    if (u.images && u.images_no_alt / u.images > 0.2) add("low", `${u.images_no_alt} of ${u.images} images have no alt text.`);
    if ((u.links_internal || 0) < 3) add("low", `Only ${u.links_internal || 0} internal links; link to and from related pages.`);
    const dated = (a) => a.dates && (a.dates.modified || a.dates.published || a.dates.visible);
    if (cs.some(dated) && !dated(u)) add("low", "No publish or update date; the top results show one.");
    if (cs.some((c) => c.author) && !u.author) add("low", "No author or byline; the top results name one (E-E-A-T).");
    const loads = cs.map((c) => c.load_ms).filter(Boolean);
    if (u.load_ms && loads.length && u.load_ms > 2500 && u.load_ms > 1.5 * Math.min(...loads)) add("low", `Loads in ${(u.load_ms / 1000).toFixed(1)} s against ${(Math.min(...loads) / 1000).toFixed(1)} s (background tab, indicative).`);
    if (!u.viewport) add("medium", "No mobile viewport meta tag.");
    if (!u.https) add("medium", "Not served over HTTPS.");
    const order = { high: 0, medium: 1, low: 2 };
    return g.sort((a, b) => order[a.sev] - order[b.sev]).slice(0, 8);
  }

  /* ------------------------------------------------------------ analyze */

  async function auditSafe(run, url, query) {
    try {
      const a = await api.rpc("seo.audit", { run, url, query, keep_text: true });
      return a || { url, error: "no answer" };
    } catch (err) {
      return { url, error: String((err && err.message) || err) };
    }
  }

  function finishAudit(a, paa) {
    if (!a || a.error) return { hits: [], audit: a };
    const hits = paaHits(a.text, paa);
    a.paa_answered = hits.filter(Boolean).length;
    delete a.text;
    return { hits, audit: a };
  }

  // o: { domain, queries: [{query, page_url}], hl, gl, signal, onStatus,
  //      onRow(row, i), onBlocked(kind) -> Promise<boolean continue> }
  async function analyze(o) {
    if (!api) throw new Error("NetScope is not connected yet");
    const host = hostOf(o.domain);
    const queries = (o.queries || []).filter((q) => q && String(q.query || "").trim()).slice(0, MAX_QUERIES);
    if (!queries.length) throw new Error("no queries to compare");
    const run = "seo-" + Date.now().toString(36);
    const say = o.onStatus || (() => {});
    const report = { id: run, domain: host, hl: o.hl || "", gl: o.gl || "", created: Date.now(), engine: "Google, read in this browser", queries_by: o.queries_by, rows: [] };
    let searches = 0;

    const search = async (q) => {
      if (searches++) await sleep(PACE_MS, o.signal);
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await api.rpc("seo.serp", { run, query: q, hl: o.hl, gl: o.gl, base: o.searchBase });
        if (!r || !r.blocked) return r;
        const go = o.onBlocked ? await o.onBlocked(r.blocked, run) : false;
        if (!go) throw Object.assign(new Error(r.blocked === "captcha" ? "Google asked to confirm you're not a robot." : "Google is showing its consent page."), { blocked: r.blocked });
      }
      throw new Error("Google kept blocking the search.");
    };

    try {
      for (let i = 0; i < queries.length; i++) {
        if (o.signal && o.signal.aborted) break;
        const q = queries[i];
        const query = String(q.query).trim();
        const row = { query, intent: q.intent, clicks: q.clicks, impressions: q.impressions, status: "searching", rank: null, user: {}, competitors: [], serp: {}, gaps: [] };
        if (o.onRow) o.onRow(row, i);
        say(`Searching Google for “${query}” (${i + 1}/${queries.length})…`);
        let serp;
        try {
          serp = await search(query);
        } catch (err) {
          if (err.blocked || (err && err.name === "AbortError")) throw err;
          serp = { error: String(err.message || err) };
        }
        if (serp.error) {
          row.status = "error";
          row.error = serp.error;
          report.rows.push(row);
          if (o.onRow) o.onRow(row, i);
          continue;
        }
        const organic = serp.organic || [];
        const own = organic.find((r) => sameSite(r.url, host));
        const comps = organic.filter((r) => !sameSite(r.url, host)).slice(0, 2);
        row.rank = own ? own.rank : null;
        row.serp = { people_also_ask: serp.people_also_ask || [], related_searches: serp.related_searches || [], features: serp.features || {}, organic: organic.slice(0, 10).map((r) => ({ rank: r.rank, domain: r.domain, url: r.url, title: r.title })) };

        let userUrl = own ? own.url : q.page_url && sameSite(q.page_url, host) ? q.page_url : "";
        let mapped = own ? "ranked" : userUrl ? "chosen" : "";
        if (!userUrl) {
          say(`Finding your page for “${query}”…`);
          const s2 = await search(`site:${host} ${query}`).catch(() => null);
          const hit = s2 && (s2.organic || []).find((r) => sameSite(r.url, host));
          userUrl = hit ? hit.url : `https://${host}/`;
          mapped = hit ? "site-search" : "homepage";
        }

        row.status = "reading";
        if (o.onRow) o.onRow(row, i);
        say(`Reading your page and the top 2 for “${query}”…`);
        const paa = row.serp.people_also_ask;
        const mine = finishAudit(await auditSafe(run, userUrl, query), paa);
        row.user = { url: userUrl, mapped, audit: mine.audit, paa_hits: mine.hits };
        for (const c of comps) {
          if (o.signal && o.signal.aborted) break;
          const theirs = finishAudit(await auditSafe(run, c.url, query), paa);
          if (theirs.audit) delete theirs.audit.internal_pages;
          row.competitors.push({ rank: c.rank, url: c.url, domain: c.domain, title: c.title, snippet: c.snippet, audit: theirs.audit, paa_hits: theirs.hits });
        }
        if (row.user.audit) delete row.user.audit.internal_pages;
        const okComps = row.competitors.map((c) => c.audit).filter((a) => a && !a.error);
        const avgWords = okComps.length ? okComps.reduce((t, a) => t + (a.words || 0), 0) / okComps.length : 0;
        const ctx = { avgWords, paa };
        row.user.score = score(row.user.audit, ctx);
        for (const c of row.competitors) c.score = score(c.audit, ctx);
        row.gaps = gapsFor(row, host);
        row.status = "done";
        report.rows.push(row);
        if (o.onRow) o.onRow(row, i);
        await saveReport(report).catch(() => {});
      }
    } finally {
      await api.rpc("seo.done", { run }).catch(() => {});
    }
    report.finished = Date.now();
    report.stopped = !!(o.signal && o.signal.aborted) || undefined;
    await saveReport(report).catch(() => {});
    return report;
  }

  /* ------------------------------------------------------------ outputs */

  function pick(a) {
    if (!a || a.error) return a ? { error: a.error } : null;
    return {
      title: a.title,
      title_len: a.title_len,
      description: a.description,
      description_len: a.description_len,
      h1: a.h1,
      h2: (a.h2 || []).slice(0, 15),
      h2_count: a.h2_count,
      words: a.words,
      query_terms_in: { title: a.title_terms, h1: a.h1_terms, url: a.url_terms, intro: a.intro_terms, description: a.description_terms, h2: a.h2_terms },
      exact_phrase_uses: a.exact_phrase,
      schema: a.schema,
      faq_items: a.faq_items,
      paa_answered: a.paa_answered,
      lists: a.lists,
      tables: a.tables,
      videos: a.videos,
      question_headings: a.question_headings,
      images: a.images,
      images_no_alt: a.images_no_alt,
      links_internal: a.links_internal,
      links_external: a.links_external,
      dates: a.dates,
      author: a.author,
      load_ms: a.load_ms,
      transfer_kb: a.transfer_kb,
      canonical_elsewhere: a.canonical_elsewhere || undefined,
      noindex: a.noindex || undefined,
      viewport: a.viewport,
      https: a.https
    };
  }

  function compact(r) {
    if (!r) return null;
    return {
      report_id: r.id,
      domain: r.domain,
      date: new Date(r.created).toISOString().slice(0, 10),
      google: { hl: r.hl || "auto", gl: r.gl || "auto" },
      queries_from: r.queries_by,
      note: "On-page signals only: backlinks, domain authority and click data are not measured. Results come from Google as this browser sees it and can be personal and local. Load times come from a background tab and are indicative.",
      rubric: "score = on-page points out of 100 for this query (terms in title/H1/URL/intro/meta, title and meta length, one H1, H2s, depth vs the top results, alt text, internal links, structured data, People also ask coverage, dates, author, viewport/HTTPS/canonical).",
      queries: r.rows.map((x) => ({
        query: x.query,
        intent: x.intent,
        search_console: x.impressions != null ? { clicks: x.clicks, impressions: x.impressions } : undefined,
        your_rank: x.rank || "not in the top 10",
        error: x.error,
        your_page: x.user && x.user.url ? Object.assign({ url: x.user.url, how_chosen: x.user.mapped, score: x.user.score }, pick(x.user.audit)) : undefined,
        competitors: (x.competitors || []).map((c) => Object.assign({ rank: c.rank, url: c.url, google_title: c.title, google_snippet: c.snippet, score: c.score }, pick(c.audit))),
        serp: x.serp ? { people_also_ask: x.serp.people_also_ask, related_searches: x.serp.related_searches, features: x.serp.features, top_10: (x.serp.organic || []).map((o) => `${o.rank}. ${o.domain}`) } : undefined,
        gaps: (x.gaps || []).map((g) => `${g.sev}: ${g.text}`)
      }))
    };
  }

  function toMarkdown(r) {
    const esc = (s) => String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n/g, " ");
    const out = [`# SEO comparison — ${r.domain}`, "", `${new Date(r.created).toLocaleString()} · Google${r.hl ? " hl=" + r.hl : ""}${r.gl ? " gl=" + r.gl : ""}, read in this browser. On-page signals only; backlinks and authority are not measured.`, ""];
    out.push("| Query | Your rank | Your score | #1 | #2 | Biggest gap |", "| --- | ---: | ---: | --- | --- | --- |");
    for (const x of r.rows) {
      const c = x.competitors || [];
      const cell = (k) => (c[k] ? `${esc(c[k].domain)} (${c[k].score == null ? "—" : c[k].score})` : "—");
      out.push(`| ${esc(x.query)} | ${x.rank || "—"} | ${x.user && x.user.score != null ? x.user.score : "—"} | ${cell(0)} | ${cell(1)} | ${esc(x.gaps && x.gaps[0] ? x.gaps[0].text : x.error || "")} |`);
    }
    for (const x of r.rows) {
      out.push("", `## ${x.query}`, "");
      if (x.error) {
        out.push(`Could not search: ${x.error}`);
        continue;
      }
      out.push(`Your page: ${x.user.url} — ${x.rank ? "rank " + x.rank : "not in the top 10"}, score ${x.user.score == null ? "—" : x.user.score}.`);
      for (const c of x.competitors) out.push(`- #${c.rank} ${c.url} — score ${c.score == null ? "—" : c.score}`);
      if (x.gaps.length) out.push("", "What you're missing:", ...x.gaps.map((g) => `- **${g.sev}** ${g.text}`));
      if ((x.serp.people_also_ask || []).length) out.push("", "People also ask:", ...x.serp.people_also_ask.map((q) => `- ${q}`));
    }
    return out.join("\n");
  }

  function playbookPrompt(r) {
    return (
      `Write the SEO playbook for ${r.domain} from the comparison I just ran in the SEO tab (get_seo_report). ` +
      "For each query: why #1 and #2 outrank me, then my fixes in priority order with exact copy — a new title (50-60 characters, query near the start), " +
      "a meta description (150-160 characters with a reason to click), the H1, an H2 outline that answers the People also ask questions, " +
      "the JSON-LD to add, the content to add with a target length, and internal links to add. Start with a short summary of the biggest wins across all queries. " +
      `Save it as a doc titled “SEO playbook — ${r.domain}” with write_doc.`
    );
  }

  /* -------------------------------------------------------------- tools */

  let toolIdle = 0;
  const releaseToolTab = () => {
    clearTimeout(toolIdle);
    toolIdle = setTimeout(() => api && api.rpc("seo.done", { run: "tool" }).catch(() => {}), 90000);
  };
  const blockedMsg = (kind) => ({
    blocked: kind,
    error: kind === "captcha" ? "Google asked to confirm this browser is not a robot." : "Google is showing its cookie consent page.",
    next: "Stop and ask the developer to open the SEO tab's Google tab (or press “Open the Google tab” in the SEO view), handle it themselves, then ask you to continue. Never try to get around it."
  });

  async function toolSearch(a) {
    const r = await api.rpc("seo.serp", { run: "tool", query: a.query, hl: a.hl, gl: a.gl });
    releaseToolTab();
    if (r && r.blocked) return JSON.stringify(blockedMsg(r.blocked));
    return JSON.stringify({
      query: r.query,
      organic: (r.organic || []).slice(0, Math.min(Number(a.max) || 10, 10)),
      people_also_ask: r.people_also_ask,
      related_searches: r.related_searches,
      features: r.features,
      note: "Google as this browser sees it: results can be personal and local."
    });
  }

  async function toolAudit(a) {
    const r = await api.rpc("seo.audit", { run: "tool", url: a.url, query: a.query || "" });
    releaseToolTab();
    if (!r || r.error) return JSON.stringify(r || { error: "no answer" });
    const out = pick(r);
    out.url = r.url;
    out.canonical = r.canonical;
    out.robots = r.robots;
    out.lang = r.lang;
    out.hreflang = r.hreflang;
    out.og = r.og;
    out.internal_pages = (r.internal_pages || []).slice(0, 20);
    return T.scrubText(JSON.stringify(out));
  }

  async function toolCompare(a) {
    let queries = (Array.isArray(a.queries) ? a.queries : []).map((q) => ({ query: String(q) })).filter((q) => q.query.trim());
    let by = "you";
    if (!queries.length) {
      const d = await discover(a.domain, { count: Math.min(Number(a.count) || 5, 5), hl: a.hl, run: "tool" });
      releaseToolTab();
      queries = d.queries;
      by = d.by;
    }
    try {
      const r = await analyze({ domain: a.domain, queries: queries.slice(0, 5), hl: a.hl, gl: a.gl, queries_by: by });
      if (window.__netscopeSeoUi) window.__netscopeSeoUi.showReport(r);
      return T.scrubText(JSON.stringify(compact(r)));
    } catch (err) {
      if (err.blocked) return JSON.stringify(blockedMsg(err.blocked));
      throw err;
    }
  }

  async function toolReport(a) {
    const r = await latest(a.report_id);
    if (!r) return JSON.stringify({ error: "no SEO comparison yet. Run one in the SEO tab, or call compare_with_competitors." });
    return T.scrubText(JSON.stringify(compact(r)));
  }

  if (T && T.register) {
    const fn = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required: required || [], additionalProperties: false } } });
    const HL = { type: "string", description: "Google interface language, e.g. en, ja. Default: the browser's." };
    const GL = { type: "string", description: "Country to search from, e.g. us, jp. Default: Google decides." };
    T.register(
      [
        fn("google_search", "Search Google in a background tab of this browser and read the results page: organic results in order (rank, url, domain, title, snippet), People also ask, related searches, and SERP features (featured snippet, AI Overview, ads, local pack, videos, shopping). Paced like a person; stop if it reports blocked.", { query: { type: "string" }, hl: HL, gl: GL, max: { type: "integer" } }, ["query"]),
        fn("audit_page_seo", "Read one page's on-page SEO for a query (rendered in a background tab): title, meta, H1/H2s, word count, which query terms appear where, structured data, People also ask coverage, links, images, dates, author, canonical/robots, load time.", { url: { type: "string" }, query: { type: "string" } }, ["url"]),
        fn(
          "compare_with_competitors",
          "For a domain and up to 5 queries (or none: they are chosen from the site), search Google, audit the domain's page and the top 2 other sites per query, score each out of 100 on the same on-page rubric, and list the gaps. Takes about 20 s per query. The result also appears in the SEO tab.",
          { domain: { type: "string" }, queries: { type: "array", items: { type: "string" } }, hl: HL, gl: GL, count: { type: "integer", description: "Queries to choose when none are given (max 5)." } },
          ["domain"]
        ),
        fn("get_seo_report", "The last SEO comparison run in the SEO tab (or by compare_with_competitors): per query your rank, page and score, the top 2 competitors' signals and scores, People also ask, related searches, SERP features and the gaps found.", { report_id: { type: "string" } })
      ],
      { google_search: toolSearch, audit_page_seo: toolAudit, compare_with_competitors: toolCompare, get_seo_report: toolReport },
      { unbudgeted: ["get_seo_report"] }
    );
  }

  return {
    attach(a) {
      api = a;
    },
    hostOf,
    discover,
    analyze,
    parseQueriesCsv,
    loadStore,
    latest,
    compact,
    toMarkdown,
    playbookPrompt,
    score,
    paaHits,
    MAX_QUERIES
  };
})();
