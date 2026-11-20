/* NetScope – seo-extract.js
 * Two self-contained functions injected (ISOLATED world) into a background
 * tab by bg-browser.js:
 *
 *   __netscopeSerp()           reads a Google results page the way a person
 *                              sees it: organic results in order, People also
 *                              ask, related searches and SERP features. Never
 *                              clicks anything; reports a robot check or a
 *                              consent page instead of touching it.
 *   __netscopeSeoAudit(query)  reads one page's on-page SEO signals for a
 *                              query: title, meta, headings, depth, term
 *                              coverage, schema, links, images, speed,
 *                              freshness and authorship.
 */
"use strict";

globalThis.__netscopeSerp = function () {
  const D = document;
  const clean = (s, n) => {
    // Google double-escapes some snippets ("Buy &amp; sell").
    const t = String(s == null ? "" : s).replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    return n && t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const body = clean(D.body ? D.body.innerText : "", 4000);
  if (/^\/sorry\//.test(location.pathname) || D.querySelector("#captcha-form, form[action*='sorry'], iframe[src*='recaptcha']") || /unusual traffic from your computer/i.test(body)) {
    return { blocked: "captcha", url: location.href };
  }
  if (/^consent\./.test(location.hostname) || (D.querySelector("form[action*='consent.google']") && /before you continue/i.test(body))) {
    return { blocked: "consent", url: location.href };
  }

  const isGoogle = (h) => /(^|\.)google\.[a-z.]+$|(^|\.)googleusercontent\.com$|(^|\.)gstatic\.com$/.test(h);
  const real = (href) => {
    try {
      const u = new URL(href, location.href);
      if (/google\./.test(u.hostname) && u.pathname === "/url") return u.searchParams.get("q") || u.searchParams.get("url") || "";
      return u.href;
    } catch (_) {
      return "";
    }
  };
  // Containers that hold ads, carousels and widgets rather than ranked results.
  const NOT_ORGANIC = "#tads,#tadsb,#bottomads,[data-text-ad],[aria-label='Ads'],[aria-label='Sponsored'],g-scrolling-carousel,[data-initq],.related-question-pair,[jsname='yEVEwb'],#botstuff,[role='complementary'],#rhs,g-section-with-header,[data-attrid='images universal']";
  // A block with its own section heading ("Videos", "Discussions and forums",
  // "Top stories") and several result links is a SERP feature, not one ranked
  // result (live Google, 2026-11).
  const isPack = (block) => !!block && !!block.querySelector("[role='heading'][aria-level='2']") && block.querySelectorAll("a h3, a [role='heading'][aria-level='3']").length > 1;
  const packs = [];
  const root = D.querySelector("#rso") || D.querySelector("#search") || D.body;
  const organic = [];
  const seenUrl = new Set();
  for (const h3 of root.querySelectorAll("a h3, a [role='heading'][aria-level='3']")) {
    const a = h3.closest("a");
    if (!a || a.closest(NOT_ORGANIC)) continue;
    const pack = a.closest("div.MjjYud");
    if (pack && isPack(pack)) {
      const name = clean(pack.querySelector("[role='heading'][aria-level='2']").innerText, 40);
      if (name && !packs.includes(name)) packs.push(name);
      continue;
    }
    const url = real(a.getAttribute("href") || "");
    if (!/^https?:/.test(url)) continue;
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch (_) {}
    if (!host || isGoogle(host)) continue;
    const key = url.split("#")[0];
    if (seenUrl.has(key)) continue;
    seenUrl.add(key);
    const block = a.closest("div.MjjYud, div.g, div[data-hveid][data-ved], div[data-sokoban-container]") || a.parentElement;
    let snippet = "";
    const sn = block && block.querySelector("div.VwiC3b, [data-sncf], div[style*='-webkit-line-clamp'], span.aCOpRe");
    if (sn) snippet = clean(sn.innerText, 320);
    else if (block) snippet = clean(block.innerText.replace(h3.innerText, ""), 320);
    const date = /^([A-Z][a-z]{2} \d{1,2}, \d{4}|\d+ (days?|hours?|weeks?) ago)/.exec(snippet);
    organic.push({
      rank: organic.length + 1,
      url,
      domain: host.replace(/^www\./, ""),
      title: clean(h3.innerText, 160),
      snippet,
      date: date ? date[1] : undefined,
      sitelinks: block ? block.querySelectorAll("table a, .usJj9c a, [data-sitelinks] a").length || undefined : undefined,
      rating: block && /Rating: [\d.]+/.test(block.innerText) ? (/Rating: ([\d.]+)/.exec(block.innerText) || [])[1] : undefined
    });
    if (organic.length >= 10) break;
  }

  const paa = [];
  for (const q of D.querySelectorAll("[data-q], .related-question-pair [role='button'] span, [jsname='Cpkphb'] span")) {
    const t = clean(q.getAttribute("data-q") || q.innerText, 160);
    if (t && /\?$|^(how|what|why|when|where|which|who|can|is|are|do|does|should|will)\b/i.test(t) && !paa.includes(t)) paa.push(t);
    if (paa.length >= 8) break;
  }

  const related = [];
  for (const a of D.querySelectorAll("#botstuff a[href*='/search?'], [data-hveid] a[href*='/search?q=']")) {
    const t = clean(a.innerText, 100);
    if (!t || /^(next|previous|\d+|more results|images|videos|news|shopping|maps|all|ai mode|forums|short videos)$/i.test(t) || t.length < 4 || related.includes(t)) continue;
    if (a.closest("#rso") && !a.closest("[data-abe], #bres, .y6Uyqe, [role='list']")) continue;
    related.push(t);
    if (related.length >= 10) break;
  }

  const has = (sel) => !!D.querySelector(sel);
  const text = (re) => re.test(body);
  const featured = D.querySelector(".xpdopen .kp-blk, [data-attrid='wa:/description'], .IZ6rdc, .c2xzTb");
  let featuredUrl = "";
  if (featured) {
    const a = featured.closest(".xpdopen, .kp-blk, [data-hveid]") ? featured.closest(".xpdopen, .kp-blk, [data-hveid]").querySelector("a[href^='http'] h3, a h3") : null;
    if (a && a.closest("a")) featuredUrl = real(a.closest("a").getAttribute("href"));
  }
  const ads = D.querySelectorAll("#tads [data-text-ad], #tads .uEierd, #tadsb [data-text-ad], [aria-label='Ads'] [data-text-ad]").length;
  const stats = clean((D.querySelector("#result-stats") || {}).innerText || "", 80);
  return {
    url: location.href,
    query: new URL(location.href).searchParams.get("q") || "",
    organic,
    people_also_ask: paa,
    related_searches: related,
    features: {
      featured_snippet: featured ? featuredUrl || true : undefined,
      ai_overview: text(/\bAI Overview\b/) || has("[data-attrid='SGEAnswer'], [jsname='N760b']") || undefined,
      ads: ads || (has("#tads") ? D.querySelectorAll("#tads > div").length : 0) || undefined,
      local_pack: has("[data-local-attribute], #lu_map, .rllt__details") || text(/\bPlaces\b.*\bMore places\b/) || undefined,
      videos: has("g-scrolling-carousel video, [data-vid], [aria-label='Videos']") || packs.includes("Videos") || undefined,
      images: has("[data-attrid='images universal'], #iur") || undefined,
      shopping: has(".commercial-unit-desktop-top, [aria-label='Shopping'], .cu-container") || undefined,
      top_stories: text(/\bTop stories\b/) || undefined,
      knowledge_panel: has("#rhs .kp-wholepage, [data-attrid='title']") || undefined,
      packs: packs.length ? packs : undefined
    },
    result_stats: stats || undefined
  };
};

globalThis.__netscopeSeoAudit = async function (query) {
  const D = document;
  // Script-rendered pages: wait until the text stops growing (max ~6 s).
  let last = -1;
  for (let i = 0; i < 10; i++) {
    const n = D.body ? D.body.innerText.length : 0;
    if (D.readyState === "complete" && n === last && n > 0) break;
    last = n;
    await new Promise((r) => setTimeout(r, 600));
  }
  const clean = (s, n) => {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return n && t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const meta = (sel) => {
    const m = D.querySelector(sel);
    return m ? clean(m.getAttribute("content"), 400) : "";
  };
  const STOP = new Set("a an and are as at be by for from how i in is it of on or the to vs what when where which who why will with your you my me do does can best top near 2024 2025 2026".split(" "));
  const terms = Array.from(new Set(String(query || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1 && !STOP.has(t))));
  const phrase = String(query || "").toLowerCase().trim();
  // Word variants count ("trades" and "traders" match "trading"), as they do for Google.
  const stem = (t) => {
    const s = t.length > 5 ? t.replace(/(ings?|ers?|ies|es|ed|s)$/, "") : t.replace(/s$/, "");
    return s.length >= 4 ? s : t;
  };
  const has = (s) => {
    const l = String(s || "").toLowerCase();
    return terms.filter((t) => l.includes(stem(t)));
  };

  // Main text: skip navigation, header, footer, asides and hidden nodes.
  const SKIP = "nav, header, footer, aside, script, style, noscript, template, [aria-hidden='true'], [role='navigation'], [role='banner'], [role='contentinfo'], form[role='search']";
  const main = D.querySelector("main, [role='main'], article") || D.body;
  const parts = [];
  if (main) {
    const tw = D.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const okCache = new Map();
    let n;
    let chars = 0;
    while ((n = tw.nextNode()) && chars < 400000) {
      const p = n.parentElement;
      if (!p) continue;
      let ok = okCache.get(p);
      if (ok === undefined) {
        // An article's own <header> (its title and byline) is content.
        const skip = p.closest(SKIP);
        ok = !skip || (skip.tagName === "HEADER" && main.tagName === "ARTICLE" && main.contains(skip));
        if (ok && p.checkVisibility && !p.checkVisibility({ checkVisibilityCSS: true })) ok = false;
        okCache.set(p, ok);
      }
      if (!ok) continue;
      const t = n.nodeValue.trim();
      if (t) {
        parts.push(t);
        chars += t.length;
      }
    }
  }
  const text = parts.join(" ").replace(/\s+/g, " ");
  const lower = text.toLowerCase();
  const words = text ? text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
  const intro = lower.split(" ").slice(0, 120).join(" ");
  const termFreq = {};
  for (const t of terms) {
    const re = new RegExp("(^|[^\\p{L}\\p{N}])" + stem(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gu");
    termFreq[t] = (lower.match(re) || []).length;
  }
  const exact = phrase && phrase.length > 3 ? lower.split(phrase).length - 1 : 0;

  // Visible headings only: app chrome keeps hidden dialog headings around.
  const hs = (sel) =>
    Array.from(D.querySelectorAll(sel))
      .filter((h) => !h.closest("nav, footer, dialog:not([open]), [hidden], [aria-hidden='true']") && (!h.checkVisibility || h.checkVisibility({ checkVisibilityCSS: true })))
      .map((h) => clean(h.innerText, 120))
      .filter(Boolean);
  const h1 = hs("h1");
  const h2 = hs("h2");
  const h3 = hs("h3");

  // Schema: JSON-LD types (through @graph and nesting) and microdata.
  const types = new Set();
  let faqCount = 0;
  let dates = {};
  let author = "";
  let rating = null;
  const visit = (o, depth) => {
    if (!o || depth > 6) return;
    if (Array.isArray(o)) return o.forEach((x) => visit(x, depth + 1));
    if (typeof o !== "object") return;
    const t = o["@type"];
    for (const x of [].concat(t || [])) types.add(String(x));
    if (/FAQPage/.test(String(t)) && Array.isArray(o.mainEntity)) faqCount += o.mainEntity.length;
    if (o.datePublished && !dates.published) dates.published = String(o.datePublished).slice(0, 25);
    if (o.dateModified && !dates.modified) dates.modified = String(o.dateModified).slice(0, 25);
    if (o.author && !author) author = clean(typeof o.author === "string" ? o.author : [].concat(o.author).map((a) => (a && a.name) || "").join(", "), 80);
    if (o.aggregateRating && !rating) rating = { value: o.aggregateRating.ratingValue, count: o.aggregateRating.reviewCount || o.aggregateRating.ratingCount };
    for (const k of Object.keys(o)) if (k !== "@context" && typeof o[k] === "object") visit(o[k], depth + 1);
  };
  for (const s of D.querySelectorAll("script[type='application/ld+json']")) {
    try {
      visit(JSON.parse(s.textContent), 0);
    } catch (_) {
      types.add("(invalid JSON-LD)");
    }
  }
  for (const m of D.querySelectorAll("[itemtype]")) {
    const t = String(m.getAttribute("itemtype")).split("/").pop();
    if (t) types.add(t);
  }
  dates.published = dates.published || meta("meta[property='article:published_time']") || undefined;
  dates.modified = dates.modified || meta("meta[property='article:modified_time'], meta[property='og:updated_time']") || undefined;
  const timeEl = D.querySelector("main time[datetime], article time[datetime], time[datetime]");
  if (timeEl && !dates.published) dates.visible = clean(timeEl.getAttribute("datetime"), 25);
  author = author || meta("meta[name='author']") || clean((D.querySelector("[rel='author'], .author, [itemprop='author'], .byline") || {}).innerText || "", 80);

  // Links and images.
  const host = location.hostname.replace(/^www\./, "");
  let internal = 0;
  let external = 0;
  let nofollow = 0;
  let generic = 0;
  const navLinks = [];
  for (const a of D.querySelectorAll("a[href]")) {
    let u;
    try {
      u = new URL(a.getAttribute("href"), location.href);
    } catch (_) {
      continue;
    }
    if (!/^https?:/.test(u.protocol)) continue;
    const same = u.hostname.replace(/^www\./, "") === host;
    if (same) internal++;
    else external++;
    if (/nofollow|ugc|sponsored/.test(a.rel || "")) nofollow++;
    const t = clean(a.innerText, 60);
    if (/^(click here|here|read more|more|learn more|this)$/i.test(t)) generic++;
    if (same && t && navLinks.length < 60 && u.pathname.length > 1 && !navLinks.some((l) => l.url === u.origin + u.pathname)) navLinks.push({ url: u.origin + u.pathname, text: t });
  }
  const imgs = Array.from(D.querySelectorAll("img")).filter((i) => !i.closest("nav, footer, header"));
  // alt="" marks a decorative image, which is correct; only a missing alt counts.
  const noAlt = imgs.filter((i) => !i.hasAttribute("alt") && i.getAttribute("role") !== "presentation" && i.getAttribute("aria-hidden") !== "true").length;
  const modern = imgs.filter((i) => /\.(webp|avif)(\?|$)/i.test(i.currentSrc || i.src)).length;

  // Speed, as far as a background tab can tell.
  const nav = performance.getEntriesByType("navigation")[0];
  const res = performance.getEntriesByType("resource");
  let bytes = nav ? nav.transferSize || 0 : 0;
  for (const r of res) bytes += r.transferSize || 0;

  const canonical = (D.querySelector("link[rel='canonical']") || {}).href || "";
  const robots = meta("meta[name='robots'], meta[name='googlebot']");
  const path = decodeURIComponent(location.pathname).toLowerCase();
  const title = clean(D.title, 300);
  const description = meta("meta[name='description']");

  // A bot wall, sign-in wall or error page is not the page Google ranked.
  const wall = /\b(verify you are human|are you a robot|access denied|blocked by network security|enable javascript|just a moment|checking your browser|log in to continue|sign in to continue|something went wrong)\b/i;
  const unreadable = wall.test(text) && words < 250 ? "the site showed a bot check or sign-in wall instead of the page" : words < 60 ? "its content did not load here (it may need a sign-in or a click)" : "";

  return {
    url: location.href,
    unreadable: unreadable || undefined,
    https: location.protocol === "https:",
    title,
    title_len: title.length,
    title_terms: has(title),
    title_starts_with_term: terms.length ? terms.some((t) => title.toLowerCase().indexOf(stem(t)) > -1 && title.toLowerCase().indexOf(stem(t)) < 25) : false,
    description,
    description_len: description.length,
    description_terms: has(description),
    h1,
    h1_terms: has(h1.join(" ")),
    h2: h2.slice(0, 30),
    h2_count: h2.length,
    h3_count: h3.length,
    h2_terms: has(h2.join(" ")),
    url_terms: has(path.replace(/[-_/]+/g, " ")),
    url_len: location.href.length,
    words,
    intro_terms: has(intro),
    term_freq: termFreq,
    exact_phrase: exact,
    terms,
    lists: main ? main.querySelectorAll("ul, ol").length : 0,
    tables: main ? main.querySelectorAll("table").length : 0,
    videos: D.querySelectorAll("video, iframe[src*='youtube'], iframe[src*='vimeo'], iframe[src*='wistia']").length,
    question_headings: h2.concat(h3).filter((h) => /\?$/.test(h)).length,
    images: imgs.length,
    images_no_alt: noAlt,
    images_modern: modern,
    links_internal: internal,
    links_external: external,
    links_nofollow: nofollow,
    links_generic_anchor: generic,
    schema: Array.from(types).slice(0, 30),
    faq_items: faqCount || undefined,
    rating: rating || undefined,
    dates,
    author: author || undefined,
    lang: D.documentElement.lang || "",
    canonical,
    canonical_elsewhere: !!canonical && canonical.split("#")[0].replace(/\/$/, "") !== location.href.split("#")[0].split("?")[0].replace(/\/$/, ""),
    robots: robots || undefined,
    noindex: /noindex/i.test(robots),
    viewport: !!D.querySelector("meta[name='viewport']"),
    og: !!D.querySelector("meta[property='og:title']") && !!D.querySelector("meta[property='og:image']"),
    hreflang: D.querySelectorAll("link[rel='alternate'][hreflang]").length,
    ttfb_ms: nav ? Math.round(nav.responseStart) : undefined,
    load_ms: nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd) : undefined,
    requests: res.length + 1,
    transfer_kb: Math.round(bytes / 1024),
    html_kb: nav ? Math.round((nav.decodedBodySize || 0) / 1024) : undefined,
    looks_404: /\b(404|not found|page not found)\b/i.test(title) || undefined,
    internal_pages: navLinks,
    text: lower.slice(0, 60000)
  };
};
