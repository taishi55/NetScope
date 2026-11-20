/* NetScope – bg-sources.js
 * The page's JavaScript, read like DevTools' Sources panel: the background
 * worker fetches the bundles a page loaded (script tags and chunks loaded
 * later), follows their source maps, and serves three things to the AI:
 *
 *   list    every script with size and source map, and the original file
 *           tree the maps reveal (app files vs. node_modules packages)
 *   search  plain or regex search across bundles, original files and inline
 *           scripts, with line numbers and context
 *   read    a slice of one bundle or original file, with line numbers
 *
 * Fetches go to the URLs the page itself loaded, with the browser's cookies.
 * Everything is cached in memory with a size cap and evicted LRU; nothing is
 * stored on disk.
 */
"use strict";

globalThis.__netscopeSources = (() => {
  const MAX_SCRIPT = 15 * 1024 * 1024; // chars per bundle
  const MAX_MAP = 40 * 1024 * 1024; // chars per source map
  const CACHE_CAP = 180 * 1024 * 1024; // all cached text
  const MAX_SCRIPTS = 80; // per page
  const LIST_TTL = 30000; // reuse a page's script list this long

  const cache = new Map(); // url -> { text, chars, mapUrl, map, at }
  let total = 0;
  const lists = new Map(); // tabId -> { at, url, scripts: [url], inline: [{index, text}] }

  function touch(url) {
    const rec = cache.get(url);
    if (rec) rec.at = Date.now();
    return rec;
  }

  function evict() {
    if (total <= CACHE_CAP) return;
    const rows = Array.from(cache.entries()).sort((a, b) => a[1].at - b[1].at);
    for (const [url, rec] of rows) {
      if (total <= CACHE_CAP * 0.8) break;
      cache.delete(url);
      total -= rec.chars + (rec.mapChars || 0);
    }
  }

  // credentials: only for the page's own site. A page decides which URLs its
  // scripts and source maps point to, so other sites are fetched without cookies.
  async function fetchText(url, cap, withCookies) {
    if (url.startsWith("data:")) {
      const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url);
      if (!m) throw new Error("bad data URL");
      const body = m[1] ? atob(m[2]) : decodeURIComponent(m[2]);
      // base64 source maps are UTF-8
      try {
        return { text: m[1] ? new TextDecoder().decode(Uint8Array.from(body, (c) => c.charCodeAt(0))) : body, headers: new Headers() };
      } catch (_) {
        return { text: body, headers: new Headers() };
      }
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(url, { credentials: withCookies ? "include" : "omit", cache: "force-cache", signal: ctl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const len = Number(res.headers.get("content-length")) || 0;
      if (len > cap * 2) throw new Error(`too large (${Math.round(len / 1e6)} MB)`);
      const text = await res.text();
      if (text.length > cap) throw new Error(`too large (${Math.round(text.length / 1e6)}M chars)`);
      return { text, headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  function mapUrlOf(text, headers, base) {
    let ref = (headers && (headers.get("SourceMap") || headers.get("X-SourceMap"))) || "";
    if (!ref) {
      const tail = text.slice(-4000);
      const m = /\/\/[#@]\s*sourceMappingURL=\s*(\S+)\s*$/m.exec(tail) || /\/\*[#@]\s*sourceMappingURL=\s*(\S+?)\s*\*\/\s*$/.exec(tail);
      if (m) ref = m[1];
    }
    if (!ref) return null;
    try {
      return new URL(ref, base).href;
    } catch (_) {
      return null;
    }
  }

  const siteOf = (u) => {
    try {
      return new URL(u).hostname.split(".").slice(-2).join(".");
    } catch (_) {
      return "";
    }
  };
  const sameOrigin = (a, b) => {
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch (_) {
      return false;
    }
  };

  async function script(url, page) {
    const hit = touch(url);
    if (hit) return hit;
    const rec = { url, text: "", chars: 0, mapUrl: null, map: undefined, at: Date.now() };
    try {
      const { text, headers } = await fetchText(url, MAX_SCRIPT, !!page && siteOf(url) === siteOf(page));
      rec.text = text;
      rec.chars = text.length;
      rec.mapUrl = mapUrlOf(text, headers, url);
      // Only maps next to the script (same origin) or embedded as data: URLs.
      if (rec.mapUrl && !rec.mapUrl.startsWith("data:") && !sameOrigin(rec.mapUrl, url)) {
        rec.mapNote = "source map on another origin not fetched: " + rec.mapUrl;
        rec.mapUrl = null;
      }
      rec.cookies = !!page && siteOf(url) === siteOf(page);
    } catch (err) {
      rec.error = String((err && err.message) || err);
    }
    cache.set(url, rec);
    total += rec.chars;
    evict();
    return rec;
  }

  // "webpack://_N_E/./src/app/page.tsx" → "src/app/page.tsx"
  function cleanSource(name, root) {
    let s = String((root || "") + name);
    try {
      if (/%2F/i.test(s)) s = decodeURIComponent(s);
    } catch (_) {}
    s = s.replace(/^\0/, "").replace(/^virtual:[a-z-]+:/i, "").replace(/^virtual:/i, "virtual/");
    s = s.replace(/^webpack:\/\/\/?(_N_E|[^/]*)\/?/, "").replace(/^[a-z]+:\/\/\/?/, "");
    s = s.replace(/^(\.\/|\/)+/, "").replace(/\?[a-z0-9=&]*$/i, "");
    s = s.replace(/^(\.\.\/)+/, "");
    return s || String(name);
  }

  async function mapOf(rec) {
    if (rec.map !== undefined) return rec.map;
    rec.map = null;
    if (!rec.mapUrl) return null;
    try {
      const { text } = await fetchText(rec.mapUrl, MAX_MAP, rec.cookies);
      const raw = JSON.parse(text);
      const parts = Array.isArray(raw.sections) ? raw.sections.map((s) => s.map).filter(Boolean) : [raw];
      const files = [];
      const contents = [];
      for (const p of parts) {
        const srcs = p.sources || [];
        for (let i = 0; i < srcs.length; i++) {
          files.push(cleanSource(srcs[i], p.sourceRoot));
          contents.push(p.sourcesContent && typeof p.sourcesContent[i] === "string" ? p.sourcesContent[i] : null);
        }
      }
      const chars = contents.reduce((n, c) => n + (c ? c.length : 0), 0);
      rec.map = { files, contents, withContent: contents.filter(Boolean).length };
      rec.mapChars = chars;
      total += chars;
      evict();
    } catch (err) {
      rec.map = { error: String((err && err.message) || err), files: [], contents: [] };
    }
    return rec.map;
  }

  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) {
          const k = i++;
          out[k] = await fn(items[k]);
        }
      })
    );
    return out;
  }

  // The page's scripts, from the inspector (tags + chunks loaded later + inline).
  async function pageScripts(tabId, inspect, fresh) {
    const hit = lists.get(tabId);
    if (hit && !fresh && Date.now() - hit.at < LIST_TTL) return hit;
    const r = await inspect(tabId, "scripts", { with_inline: true });
    if (!r || r.error) throw new Error((r && r.error) || "could not list the page's scripts");
    const urls = [];
    for (const t of r.tags || []) if (/^(https?|data):/.test(t.src) && !urls.includes(t.src)) urls.push(t.src);
    for (const t of r.loaded_chunks || []) if (/^https?:/.test(t.src) && !urls.includes(t.src)) urls.push(t.src);
    const list = { at: Date.now(), page: r.page || "", scripts: urls.slice(0, MAX_SCRIPTS), skipped: Math.max(0, urls.length - MAX_SCRIPTS), inline: (r.inline || []).filter((x) => x.text), importMap: r.import_map };
    lists.set(tabId, list);
    return list;
  }

  // Framework internals and generated files count as vendor, not the app.
  const isVendor = (f) => /(^|\/)node_modules\//.test(f) || /^(webpack|vite|\(webpack\)|\.pnpm|virtual)\//.test(f) || /(^|\/)\.(nuxt|next|svelte-kit|output|vite)\//.test(f) || /^\.\.?\/?node_modules/.test(f);
  const pkgOf = (f) => {
    const m = /.*node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(f); // the innermost package (pnpm nests them)
    if (m) return m[1];
    const g = /(^|\/)\.(nuxt|next|svelte-kit|output|vite)\//.exec(f);
    return g ? "." + g[2] + " (generated)" : f.split("/")[0];
  };

  async function list(tabId, inspect, opts) {
    const o = opts || {};
    const pl = await pageScripts(tabId, inspect, o.refresh);
    const recs = await pool(pl.scripts, 6, (u) => script(u, pl.page));
    const withMaps = o.maps !== false;
    if (withMaps) await pool(recs.filter((r) => r.mapUrl), 4, mapOf);
    const appFiles = new Set();
    const pkgs = new Map();
    const site = (u) => {
      try {
        return new URL(u).hostname.split(".").slice(-2).join(".");
      } catch (_) {
        return "";
      }
    };
    const scripts = recs.map((r) => {
      const row = { url: r.url, kb: Math.round(r.chars / 1024) };
      if (pl.page && /^https?:/.test(r.url) && site(r.url) !== site(pl.page)) row.third_party = true;
      if (r.error) row.error = r.error;
      if (r.mapUrl) row.source_map = r.mapUrl.startsWith("data:") ? "inline (data: URL)" : r.mapUrl;
      if (r.map && r.map.error) row.source_map_error = r.map.error;
      if (r.mapNote) row.source_map_error = r.mapNote;
      if (r.map && r.map.files.length) {
        row.original_files = r.map.files.length;
        row.with_source_content = r.map.withContent;
        for (const f of r.map.files) {
          if (isVendor(f)) pkgs.set(pkgOf(f), (pkgs.get(pkgOf(f)) || 0) + 1);
          else appFiles.add(f);
        }
      }
      return row;
    });
    const files = Array.from(appFiles).sort();
    return {
      scripts,
      scripts_not_fetched: pl.skipped || undefined,
      inline_scripts: pl.inline.map((x) => ({ index: x.index, chars: x.chars, head: x.head })),
      import_map: pl.importMap || undefined,
      source_maps: scripts.filter((s) => s.source_map).length,
      app_files: files.length,
      app_file_tree: tree(files, o.file_limit || 400),
      packages: Array.from(pkgs.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 80)
        .map(([p, n]) => `${p} (${n} files)`)
    };
  }

  // Directory-grouped listing: "src/components/ (12): Button.tsx, Card.tsx, …"
  function tree(files, limit) {
    const dirs = new Map();
    for (const f of files) {
      const i = f.lastIndexOf("/");
      const d = i < 0 ? "." : f.slice(0, i);
      if (!dirs.has(d)) dirs.set(d, []);
      dirs.get(d).push(i < 0 ? f : f.slice(i + 1));
    }
    const out = [];
    let shown = 0;
    for (const [d, names] of Array.from(dirs.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (shown >= limit) {
        out.push(`… ${files.length - shown} more files`);
        break;
      }
      const take = names.slice(0, 40);
      shown += take.length;
      out.push(`${d}/ (${names.length}): ${take.join(", ")}${names.length > take.length ? ", …" : ""}`);
    }
    return out;
  }

  // Every searchable unit: bundles, original files (from maps) and inline scripts.
  async function units(tabId, inspect, scope) {
    const pl = await pageScripts(tabId, inspect, false);
    const recs = await pool(pl.scripts, 6, (u) => script(u, pl.page));
    const out = [];
    // Scripts from other sites (analytics, ads, widgets) count as vendor code.
    const site = (u) => {
      try {
        return new URL(u).hostname.split(".").slice(-2).join(".");
      } catch (_) {
        return "";
      }
    };
    const own = site(pl.page);
    if (scope !== "original") for (const r of recs) if (r.text) out.push({ kind: "bundle", name: r.url, text: r.text, vendor: !!own && !r.url.startsWith("data:") && site(r.url) !== own });
    if (scope !== "bundles") {
      await pool(recs.filter((r) => r.mapUrl), 4, mapOf);
      const seen = new Set();
      for (const r of recs) {
        const m = r.map;
        if (!m || !m.files) continue;
        for (let i = 0; i < m.files.length; i++) {
          if (!m.contents[i] || seen.has(m.files[i])) continue;
          seen.add(m.files[i]);
          out.push({ kind: "original", name: m.files[i], text: m.contents[i], vendor: isVendor(m.files[i]) });
        }
      }
    }
    if (scope !== "original") for (const x of pl.inline) out.push({ kind: "inline", name: `inline script #${x.index}`, text: x.text });
    return out;
  }

  function lineAt(text, pos) {
    let line = 1;
    let last = 0;
    for (let i = text.indexOf("\n"); i !== -1 && i < pos; i = text.indexOf("\n", i + 1)) {
      line++;
      last = i + 1;
    }
    return { line, col: pos - last + 1 };
  }

  async function search(tabId, inspect, a) {
    const q = String(a.query || "");
    if (!q) throw new Error("query is required");
    let re;
    try {
      re = new RegExp(a.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), a.case_sensitive ? "g" : "gi");
    } catch (err) {
      throw new Error("bad regex: " + err.message);
    }
    const scope = ["bundles", "original", "all"].includes(a.scope) ? a.scope : "all";
    const limit = Math.min(Number(a.limit) || 40, 150);
    const ctx = Math.min(Number(a.context_chars) || 100, 400);
    const includeVendor = !!a.include_vendor;
    const all = await units(tabId, inspect, scope);
    // App code first, then bundles, then vendor files.
    all.sort((x, y) => (x.kind === "original" && !x.vendor ? 0 : x.kind === "inline" ? 1 : x.kind === "bundle" ? 2 : 3) - (y.kind === "original" && !y.vendor ? 0 : y.kind === "inline" ? 1 : y.kind === "bundle" ? 2 : 3));
    const hits = [];
    let filesWithHits = 0;
    let scanned = 0;
    for (const u of all) {
      if (u.vendor && !includeVendor) continue;
      scanned++;
      re.lastIndex = 0;
      let n = 0;
      let m;
      while ((m = re.exec(u.text)) && hits.length < limit) {
        if (!n) filesWithHits++;
        if (n++ >= 6) break; // at most 6 hits per file
        const { line, col } = lineAt(u.text, m.index);
        const from = Math.max(0, m.index - ctx);
        const snippet = u.text.slice(from, m.index + m[0].length + ctx).replace(/\s+/g, " ");
        hits.push({ where: u.kind === "original" ? u.name : u.name, kind: u.kind, line, col, snippet: (from > 0 ? "…" : "") + snippet + "…" });
        if (m[0].length === 0) re.lastIndex++;
      }
      if (hits.length >= limit) break;
    }
    return { query: q, scope, units_scanned: scanned, files_with_hits: filesWithHits, hits, truncated: hits.length >= limit || undefined };
  }

  async function read(tabId, inspect, a) {
    let text = null;
    let name = "";
    if (a.file) {
      const want = String(a.file).replace(/^\.?\//, "");
      const all = await units(tabId, inspect, "original");
      const exact = all.find((u) => u.name === want) || all.find((u) => u.name.endsWith("/" + want)) || all.find((u) => u.name.endsWith(want));
      if (!exact) throw new Error(`no original file "${a.file}" (use list_sources to see the file tree; it needs source maps with sourcesContent)`);
      text = exact.text;
      name = exact.name;
    } else if (a.url) {
      if (/^inline script #\d+$/.test(a.url)) {
        const pl = await pageScripts(tabId, inspect, false);
        const x = pl.inline.find((i) => `inline script #${i.index}` === a.url);
        if (!x) throw new Error("no such inline script");
        text = x.text;
      } else {
        // Only scripts this page loaded: read_source is not a way to fetch arbitrary URLs.
        const pl = await pageScripts(tabId, inspect, false);
        if (!pl.scripts.includes(String(a.url))) throw new Error("that URL is not one of this page's scripts (see list_sources); use http_request for other URLs");
        const r = await script(String(a.url), pl.page);
        if (r.error) throw new Error(r.error);
        text = r.text;
      }
      name = a.url;
    } else throw new Error("give file (an original source path) or url (a script URL)");
    const lines = text.split("\n");
    // Minified bundles are one huge line: page by characters instead.
    if (lines.length < 5 && text.length > 20000) {
      const off = Math.max(0, Number(a.offset) || 0);
      const len = Math.min(Number(a.length) || 12000, 40000);
      return { name, chars: text.length, offset: off, text: text.slice(off, off + len), more: off + len < text.length, hint: "minified: page with offset/length, or use search_sources to find positions" };
    }
    let start = Math.max(1, Number(a.line) || 1);
    const around = Number(a.around) || 0;
    if (around) start = Math.max(1, start - around);
    const count = Math.min(Number(a.lines) || (around ? around * 2 + 1 : 200), 600);
    const slice = lines.slice(start - 1, start - 1 + count).map((l, i) => `${String(start + i).padStart(5)}  ${l.length > 400 ? l.slice(0, 400) + "…" : l}`);
    return { name, total_lines: lines.length, from_line: start, to_line: start + slice.length - 1, text: slice.join("\n"), more: start - 1 + count < lines.length };
  }

  function forget(tabId) {
    lists.delete(tabId);
  }

  return { list, search, read, forget };
})();
