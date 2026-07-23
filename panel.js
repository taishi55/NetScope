/* NetScope – panel.js
 * UI for the DevTools panel. Receives a live capture API from devtools.js via
 * window.__netscopeInit(api). All rendering uses textContent/createElement —
 * captured payloads are untrusted page data and must never hit innerHTML.
 */
"use strict";

let api = null;
let entries = [];
let filtered = []; // [{ e, hits }]
let selectedId = null;
let matcherError = false;
let activeTab = null;

const opts = {
  query: "",
  caseSensitive: false,
  regex: false,
  scopes: { url: true, reqH: true, reqB: true, resH: true, resB: true, ws: true },
  type: "all",
  collapseDupes: true
};

const $ = (id) => document.getElementById(id);
const ui = {
  search: $("search"),
  optCase: $("optCase"),
  optRegex: $("optRegex"),
  scopes: $("scopes"),
  typeFilter: $("typeFilter"),
  preserve: $("preserve"),
  collapseDupes: $("collapseDupes"),
  stats: $("stats"),
  exportAsync: $("exportAsync"),
  clearBtn: $("clearBtn"),
  rows: $("rows"),
  empty: $("empty"),
  listWrap: $("listWrap"),
  detail: $("detail"),
  tabs: $("tabs"),
  detailActions: $("detailActions"),
  detailBody: $("detailBody"),
  closeDetail: $("closeDetail"),
  toast: $("toast")
};

/* ------------------------------------------------------------ helpers */

function fmtSize(n) {
  if (!n) return "—";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " kB";
  return (n / 1048576).toFixed(1) + " MB";
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return Math.round(ms) + " ms";
  return (ms / 1000).toFixed(2) + " s";
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(d.getHours(), 2)}:${p(d.getMinutes(), 2)}:${p(d.getSeconds(), 2)}.${p(d.getMilliseconds(), 3)}`;
}

function urlParts(u) {
  try {
    const x = new URL(u);
    return { host: x.host, path: x.pathname + x.search };
  } catch (_) {
    return { host: "", path: u || "" };
  }
}

function fileName(u) {
  try {
    const x = new URL(u);
    const seg = x.pathname.split("/").filter(Boolean).pop() || "/";
    return seg + (x.search || "");
  } catch (_) {
    return u || "";
  }
}

function oneLine(s, max) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function tryJsonPretty(text) {
  const t = (text || "").trim();
  if (!t || !(t.startsWith("{") || t.startsWith("["))) return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch (_) {
    return text;
  }
}

function toast(msg) {
  ui.toast.textContent = msg;
  ui.toast.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => ui.toast.classList.add("hidden"), 1800);
}

async function copyText(text, msg) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (_) {}
  if (!ok) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch (_) {}
    ta.remove();
  }
  toast(ok ? msg || "Copied" : "Copy failed — clipboard blocked");
}

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime || "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ------------------------------------------------------------ matcher */

function buildMatcher() {
  matcherError = false;
  const q = opts.query;
  if (!q) return null;
  const source = opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, opts.caseSensitive ? "g" : "gi");
  } catch (_) {
    matcherError = true;
    return null;
  }
}

function testField(re, text) {
  if (!text) return false;
  re.lastIndex = 0;
  return re.test(text);
}

function matchEntry(e, re) {
  // null = no query; false = no match; array = matched scopes
  if (!re) return null;
  const s = opts.scopes;
  const hits = [];

  if (e.kind === "http") {
    if (s.url && testField(re, e.url)) hits.push("url");
    if (s.reqH && testField(re, e.reqHeaderText)) hits.push("req-h");
    if (s.reqB && testField(re, e.reqBody)) hits.push("req-b");
    if (s.resH && testField(re, e.resHeaderText)) hits.push("res-h");
    if (s.resB && testField(re, e.resBody)) hits.push("res-b");
  } else if (e.kind === "ws-frame") {
    if (s.url && testField(re, e.url)) hits.push("url");
    if (s.ws && testField(re, e.payload)) hits.push("frame");
  } else if (e.kind === "ws-open" || e.kind === "ws-close") {
    if (s.url && testField(re, e.url)) hits.push("url");
  } else {
    return false; // nav markers are hidden while searching
  }
  return hits.length ? hits : false;
}

// A stable signature for "the same input": for HTTP that's method + URL +
// request body (responses may differ across the group — polling, retries —
// and mixed statuses are flagged on the badge); for WS frames it's the
// connection + direction + payload. Returns null for entries that never
// collapse (nav markers, ws open/close).
function dedupeKey(e) {
  if (e.kind === "http") {
    return ["h", e.method, e.url, e.reqBody || ""].join("\u241f");
  }
  if (e.kind === "ws-frame") {
    return ["w", e.url, e.dir, e.payloadKind, e.payload || ""].join("\u241f");
  }
  return null;
}

function typeBucket(e) {
  if (e.kind === "nav") return "nav";
  if (e.kind !== "http") return "ws";
  const t = e.resourceType;
  if (t === "xhr" || t === "fetch" || t === "preflight") return "xhr";
  if (t === "document") return "doc";
  if (t === "script" || t === "stylesheet") return "js";
  if (t === "image" || t === "media" || t === "font") return "media";
  if (t === "websocket") return "ws";
  return "other";
}

/* ------------------------------------------------------------ refresh */

let rafId = 0;
function scheduleRefresh() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    refresh();
  });
}

function refresh() {
  const re = buildMatcher();
  filtered = [];
  let hitCount = 0;

  for (const e of entries) {
    if (e.kind === "nav") {
      if (!opts.query && opts.type === "all") filtered.push({ e, hits: null });
      continue;
    }
    if (opts.type !== "all" && typeBucket(e) !== opts.type) continue;
    const hits = matchEntry(e, re);
    if (re) {
      if (!hits) continue;
      hitCount++;
    }
    filtered.push({ e, hits });
  }

  filtered.sort((a, b) => a.e.startedAt - b.e.startedAt || a.e.id - b.e.id);

  let collapsedCount = 0;
  if (opts.collapseDupes) {
    const rep = new Map(); // key -> row kept in `filtered`
    const kept = [];
    for (const row of filtered) {
      const key = dedupeKey(row.e);
      if (key === null) {
        row.dup = 0;
        kept.push(row);
        continue;
      }
      const first = rep.get(key);
      if (first) {
        first.dup = (first.dup || 1) + 1;
        first.dupLastAt = row.e.startedAt;
        first.dupIds.push(row.e.id);
        if (row.e.kind === "http") {
          const s = row.e.status || 0;
          first.dupStatuses.set(s, (first.dupStatuses.get(s) || 0) + 1);
        }
        // keep the representative selectable even if a later copy was selected
        if (row.e.id === selectedId) selectedId = first.e.id;
        collapsedCount++;
      } else {
        row.dup = 1;
        row.dupIds = [row.e.id];
        row.dupLastAt = row.e.startedAt;
        row.dupStatuses = new Map(
          row.e.kind === "http" ? [[row.e.status || 0, 1]] : []
        );
        rep.set(key, row);
        kept.push(row);
      }
    }
    filtered = kept;
  } else {
    for (const row of filtered) row.dup = 0;
  }

  if (re && opts.collapseDupes) {
    hitCount = filtered.reduce((n, r) => n + (r.hits && r.hits.length ? 1 : 0), 0);
  }

  renderRows();
  renderStats(hitCount, !!re, collapsedCount);
  if (selectedId !== null) renderDetail();
}

function renderStats(hitCount, searching, collapsedCount) {
  ui.stats.replaceChildren();
  ui.search.classList.toggle("bad", matcherError);
  if (matcherError) {
    const b = document.createElement("span");
    b.className = "bad";
    b.textContent = "invalid regex";
    ui.stats.appendChild(b);
    return;
  }
  const total = document.createTextNode(entries.length + " captured");
  ui.stats.appendChild(total);
  if (searching) {
    ui.stats.appendChild(document.createTextNode(" · "));
    const h = document.createElement("span");
    h.className = "hitcount";
    h.textContent = hitCount + " match" + (hitCount === 1 ? "" : "es");
    ui.stats.appendChild(h);
  }
  if (collapsedCount > 0) {
    const c = document.createElement("span");
    c.className = "dim";
    c.textContent = " · " + collapsedCount + " duplicate" +
      (collapsedCount === 1 ? "" : "s") + " collapsed";
    ui.stats.appendChild(c);
  }
}

/* --------------------------------------------------------------- rows */

function statusClass(status) {
  if (status >= 200 && status < 300) return "s2";
  if (status >= 300 && status < 400) return "s3";
  if (status >= 400 && status < 500) return "s4";
  if (status >= 500) return "s5";
  return "s0";
}

function td(text, cls, title) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (cls) cell.className = cls;
  if (title) cell.title = title;
  return cell;
}

function nameCell(primary, secondary, title, dup, mixed) {
  const cell = document.createElement("td");
  cell.title = title || "";
  if (dup > 1) {
    const badge = document.createElement("span");
    badge.className = "dupe-badge" + (mixed ? " mixed" : "");
    badge.textContent = "\u00d7" + dup;
    badge.title = mixed
      ? dup + " requests with the same input but different statuses \u2014 open for a breakdown"
      : dup + " duplicates collapsed into one row";
    cell.appendChild(badge);
  }
  cell.appendChild(document.createTextNode(primary));
  if (secondary) {
    const sub = document.createElement("span");
    sub.className = "name-sub";
    sub.textContent = "  " + secondary;
    cell.appendChild(sub);
  }
  return cell;
}

function hitsCell(hits) {
  const cell = document.createElement("td");
  if (hits && hits.length) {
    const wrap = document.createElement("span");
    wrap.className = "hitchips";
    for (const h of hits) {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = h;
      wrap.appendChild(c);
    }
    cell.appendChild(wrap);
  }
  return cell;
}

function renderRows() {
  const nearBottom =
    ui.listWrap.scrollTop + ui.listWrap.clientHeight >= ui.listWrap.scrollHeight - 40;

  const frag = document.createDocumentFragment();

  for (const row of filtered) {
    const { e, hits, dup } = row;
    const mixed = !!(row.dupStatuses && row.dupStatuses.size > 1);
    const tr = document.createElement("tr");
    tr.dataset.id = String(e.id);
    if (e.id === selectedId) tr.classList.add("sel");

    if (e.kind === "nav") {
      tr.className = "nav-row";
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.textContent = "navigated → " + e.url;
      tr.appendChild(cell);
      frag.appendChild(tr);
      continue;
    }

    if (e.kind === "http") {
      const p = urlParts(e.url);
      tr.appendChild(nameCell(fileName(e.url), p.host, e.url, dup, mixed));
      tr.appendChild(td(e.method, "m-http"));
      tr.appendChild(
        td(e.status ? String(e.status) : "…", statusClass(e.status), e.statusText || "")
      );
      tr.appendChild(td(e.resourceType, "", ""));
      tr.appendChild(hitsCell(hits));
      tr.appendChild(td(fmtSize(e.size)));
      tr.appendChild(td(fmtDuration(e.durationMs)));
    } else if (e.kind === "ws-frame") {
      const p = urlParts(e.url);
      tr.appendChild(nameCell(oneLine(e.payload, 120) || "(empty frame)", p.path, e.url, dup, mixed));
      tr.appendChild(td(e.dir === "sent" ? "WS ↑" : "WS ↓", e.dir === "sent" ? "m-sent" : "m-recv"));
      tr.appendChild(td(e.payloadKind, "s0"));
      tr.appendChild(td("ws"));
      tr.appendChild(hitsCell(hits));
      tr.appendChild(td(fmtSize(e.size)));
      tr.appendChild(td(fmtClock(e.startedAt)));
    } else if (e.kind === "ws-open" || e.kind === "ws-close") {
      const p = urlParts(e.url);
      tr.appendChild(nameCell(p.path || e.url, p.host, e.url));
      tr.appendChild(td("WS", "m-http"));
      tr.appendChild(
        e.kind === "ws-open"
          ? td("open", "s2")
          : td("closed" + (e.code > 0 ? " " + e.code : ""), e.code === 1000 ? "s0" : "sx", e.reason)
      );
      tr.appendChild(td("ws"));
      tr.appendChild(hitsCell(hits));
      tr.appendChild(td("—"));
      tr.appendChild(td(fmtClock(e.startedAt)));
    }

    frag.appendChild(tr);
  }

  ui.rows.replaceChildren(frag);
  ui.empty.style.display = filtered.length ? "none" : "";
  if (nearBottom) ui.listWrap.scrollTop = ui.listWrap.scrollHeight;
}

/* -------------------------------------------------------------- detail */

function findEntry(id) {
  return entries.find((e) => e.id === id) || null;
}

function showDetail(id, tab) {
  selectedId = id;
  activeTab = tab || null;
  document.body.classList.add("split");
  ui.detail.classList.remove("hidden");
  for (const tr of ui.rows.children) tr.classList.toggle("sel", tr.dataset.id === String(id));
  renderDetail();
}

function hideDetail() {
  selectedId = null;
  activeTab = null;
  document.body.classList.remove("split");
  ui.detail.classList.add("hidden");
  for (const tr of ui.rows.children) tr.classList.remove("sel");
}

function highlightedPre(text) {
  const pre = document.createElement("pre");
  const re = buildMatcher();
  const src = text || "";
  if (!re || !src) {
    pre.textContent = src;
    return pre;
  }
  re.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let last = 0;
  let m;
  let count = 0;
  while ((m = re.exec(src)) && count < 2000) {
    if (m.index > last) frag.appendChild(document.createTextNode(src.slice(last, m.index)));
    const mark = document.createElement("mark");
    mark.textContent = m[0] || " ";
    frag.appendChild(mark);
    last = m.index + (m[0].length || 1);
    if (m[0].length === 0) re.lastIndex++;
    count++;
  }
  frag.appendChild(document.createTextNode(src.slice(last)));
  pre.appendChild(frag);
  return pre;
}

function kvBlock(pairs) {
  const box = document.createElement("div");
  box.className = "kv";
  for (const [k, v] of pairs) {
    const kk = document.createElement("span");
    kk.className = "k";
    kk.textContent = k;
    const vv = document.createElement("span");
    vv.className = "v";
    vv.textContent = v;
    box.append(kk, vv);
  }
  return box;
}

function h4(text) {
  const el = document.createElement("h4");
  el.textContent = text;
  return el;
}

function note(parts) {
  const p = document.createElement("p");
  p.className = "note";
  for (const part of parts) {
    if (typeof part === "string") p.appendChild(document.createTextNode(part));
    else {
      const b = document.createElement("b");
      b.textContent = part.warn;
      p.appendChild(b);
    }
  }
  return p;
}

function actionBtn(label, fn) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", fn);
  return b;
}

function tabsFor(e) {
  if (e.kind === "http") return ["summary", "request", "response", "curl"];
  if (e.kind === "ws-frame") return ["frame", "connection", "tools"];
  return ["connection", "tools"];
}

function renderDetail() {
  const e = findEntry(selectedId);
  if (!e || e.kind === "nav") {
    hideDetail();
    return;
  }

  const tabs = tabsFor(e);
  if (!tabs.includes(activeTab)) activeTab = tabs[0];

  ui.tabs.replaceChildren();
  for (const t of tabs) {
    const b = document.createElement("button");
    b.textContent = t;
    if (t === activeTab) b.classList.add("on");
    b.addEventListener("click", () => {
      activeTab = t;
      renderDetail();
    });
    ui.tabs.appendChild(b);
  }

  ui.detailActions.replaceChildren();
  if (e.kind === "http") {
    ui.detailActions.appendChild(actionBtn("Copy cURL", () => copyText(toCurl(e), "cURL copied")));
    ui.detailActions.appendChild(actionBtn("Copy URL", () => copyText(e.url, "URL copied")));
  } else if (e.kind === "ws-frame") {
    ui.detailActions.appendChild(
      actionBtn("Copy payload", () => copyText(e.payload, "Payload copied"))
    );
    ui.detailActions.appendChild(actionBtn("Copy URL", () => copyText(e.url, "URL copied")));
  } else {
    ui.detailActions.appendChild(actionBtn("Copy URL", () => copyText(e.url, "URL copied")));
  }

  const body = ui.detailBody;
  body.replaceChildren();

  const row = filtered.find((f) => f.e.id === selectedId);
  if (row && row.dup > 1) {
    const bar = document.createElement("div");
    bar.className = "dupe-bar";

    const badge = document.createElement("span");
    badge.className = "dupe-badge";
    badge.textContent = "\u00d7" + row.dup;
    bar.appendChild(badge);

    const txt = document.createElement("span");
    let s =
      (e.kind === "ws-frame"
        ? " identical frames"
        : " requests with the same input") +
      " \u00b7 first " +
      fmtClock(e.startedAt) +
      " \u00b7 last " +
      fmtClock(row.dupLastAt || e.startedAt);
    if (row.dupStatuses && row.dupStatuses.size > 1) {
      const parts = [...row.dupStatuses.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([st, n]) => (st || "pending") + " \u00d7" + n);
      s += " \u00b7 statuses: " + parts.join(" / ");
    }
    txt.textContent = s;
    bar.appendChild(txt);

    bar.appendChild(
      actionBtn("Ungroup", () => {
        opts.collapseDupes = false;
        ui.collapseDupes.checked = false;
        refresh();
      })
    );
    body.appendChild(bar);
  }

  /* ---- HTTP ---- */
  if (e.kind === "http") {
    if (activeTab === "summary") {
      body.appendChild(h4("General"));
      body.appendChild(
        kvBlock([
          ["URL", e.url],
          ["Method", e.method],
          ["Status", e.status ? `${e.status} ${e.statusText}` : "(pending)"],
          ["Type", `${e.resourceType} · ${e.mime || "?"}`],
          ["Size", fmtSize(e.size)],
          ["Duration", fmtDuration(e.durationMs)],
          ["Started", fmtClock(e.startedAt)]
        ])
      );
      body.appendChild(h4("Request headers"));
      body.appendChild(highlightedPre(e.reqHeaderText || "(none)"));
      body.appendChild(h4("Response headers"));
      body.appendChild(highlightedPre(e.resHeaderText || "(none)"));
    } else if (activeTab === "request") {
      const qs = e.url.includes("?") ? e.url.slice(e.url.indexOf("?") + 1) : "";
      if (qs) {
        body.appendChild(h4("Query string"));
        body.appendChild(highlightedPre(decodeQuery(qs)));
      }
      body.appendChild(h4("Request body"));
      if (e.reqBody) {
        if (e.reqBodyTruncated) body.appendChild(note([{ warn: "truncated " }, "— body exceeded the capture limit."]));
        body.appendChild(highlightedPre(tryJsonPretty(e.reqBody)));
      } else {
        body.appendChild(note(["No request body."]));
      }
    } else if (activeTab === "response") {
      const flags = [];
      if (e.resBodyPending) flags.push("still loading body…");
      if (e.resBodyBinary) flags.push("binary body — not searchable");
      if (e.resBodyTruncated) flags.push("truncated at capture limit");
      body.appendChild(
        note([`${e.mime || "unknown mime"} · ${fmtSize(e.size)}`, flags.length ? " · " : ""].concat(
          flags.length ? [{ warn: flags.join(" · ") }] : []
        ))
      );
      if (e.resBody) {
        body.appendChild(highlightedPre(tryJsonPretty(e.resBody)));
      } else if (!e.resBodyPending && !e.resBodyBinary) {
        body.appendChild(note(["Empty body, or the browser did not retain it."]));
      }
    } else if (activeTab === "curl") {
      body.appendChild(note(["Includes captured headers verbatim (cookies and auth tokens too) so the request replays 1:1. Share with care."]));
      body.appendChild(highlightedPre(toCurl(e)));
      body.appendChild(actionBtn("Copy cURL", () => copyText(toCurl(e), "cURL copied")));
    }
  }

  /* ---- WebSocket frame ---- */
  if (e.kind === "ws-frame") {
    if (activeTab === "frame") {
      body.appendChild(
        kvBlock([
          ["Direction", e.dir === "sent" ? "↑ client → server" : "↓ server → client"],
          ["Kind", e.payloadKind],
          ["Size", fmtSize(e.size)],
          ["Time", fmtClock(e.startedAt)],
          ["Socket", e.wsId]
        ])
      );
      if (e.payloadTruncated) body.appendChild(note([{ warn: "truncated " }, "— frame exceeded the capture limit."]));
      body.appendChild(h4("Payload"));
      body.appendChild(highlightedPre(tryJsonPretty(e.payload)));
    } else if (activeTab === "connection") {
      renderWsConnection(body, e);
    } else if (activeTab === "tools") {
      renderWsTools(body, e);
    }
  }

  /* ---- WebSocket open/close ---- */
  if (e.kind === "ws-open" || e.kind === "ws-close") {
    if (activeTab === "connection") {
      renderWsConnection(body, e);
    } else if (activeTab === "tools") {
      renderWsTools(body, e);
    }
  }
}

function renderWsConnection(body, e) {
  const frames = entries.filter((x) => x.kind === "ws-frame" && x.wsId === e.wsId);
  const sent = frames.filter((f) => f.dir === "sent").length;
  const recv = frames.length - sent;
  const closed = entries.find((x) => x.kind === "ws-close" && x.wsId === e.wsId);
  body.appendChild(h4("Connection"));
  body.appendChild(
    kvBlock([
      ["URL", e.url],
      ["Socket", e.wsId],
      ["Frames", `${frames.length} total · ${sent} sent · ${recv} received`],
      ["State", closed ? `closed ${closed.code > 0 ? closed.code : ""} ${closed.reason || ""}`.trim() : "open (or unknown)"]
    ])
  );
}

function renderWsTools(body, e) {
  body.appendChild(h4("Reconnect from a terminal"));
  body.appendChild(highlightedPre("websocat " + shq(e.url)));
  body.appendChild(actionBtn("Copy websocat", () => copyText("websocat " + shq(e.url), "Copied")));
  body.appendChild(document.createElement("br"));
  body.appendChild(document.createElement("br"));
  body.appendChild(highlightedPre("npx wscat -c " + shq(e.url)));
  body.appendChild(actionBtn("Copy wscat", () => copyText("npx wscat -c " + shq(e.url), "Copied")));

  body.appendChild(h4("Handshake probe (cURL)"));
  body.appendChild(highlightedPre(wsHandshakeCurl(e.url)));
  body.appendChild(
    actionBtn("Copy handshake cURL", () => copyText(wsHandshakeCurl(e.url), "Copied"))
  );
}

function decodeQuery(qs) {
  return qs
    .split("&")
    .map((pair) => {
      const i = pair.indexOf("=");
      const k = i === -1 ? pair : pair.slice(0, i);
      const v = i === -1 ? "" : pair.slice(i + 1);
      const dec = (s) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, " "));
        } catch (_) {
          return s;
        }
      };
      return dec(k) + " = " + dec(v);
    })
    .join("\n");
}

/* ----------------------------------------------------- cURL & friends */

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function toCurl(e) {
  const lines = ["curl " + shq(e.url)];
  if (e.method && e.method.toUpperCase() !== "GET") lines.push("-X " + e.method.toUpperCase());
  for (const h of e.reqHeaders || []) {
    const n = (h.name || "").toLowerCase();
    if (!n || n.startsWith(":") || n === "content-length" || n === "host") continue;
    lines.push("-H " + shq(h.name + ": " + h.value));
  }
  if (e.reqBody) lines.push("--data-raw " + shq(e.reqBody));
  lines.push("--compressed");
  return lines.join(" \\\n  ");
}

function wsHandshakeCurl(wsUrl) {
  const httpUrl = wsUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  return [
    "curl --include --no-buffer " + shq(httpUrl),
    "-H 'Connection: Upgrade'",
    "-H 'Upgrade: websocket'",
    "-H 'Sec-WebSocket-Version: 13'",
    "-H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw=='"
  ].join(" \\\n  ");
}

/* ---------------------------------------------------- AsyncAPI export */

function sanitizeKey(s) {
  return (
    String(s)
      .replace(/[^A-Za-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "x"
  );
}

function tryJsonValue(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return s;
  }
}

function exportAsyncAPI() {
  const frames = entries.filter((x) => x.kind === "ws-frame");
  const opens = entries.filter((x) => x.kind === "ws-open");
  if (!frames.length && !opens.length) {
    toast("No WebSocket traffic captured yet");
    return;
  }

  const byUrl = new Map();
  const touch = (url) => {
    if (!byUrl.has(url)) byUrl.set(url, { sent: [], received: [] });
    return byUrl.get(url);
  };
  for (const o of opens) touch(o.url);
  for (const f of frames) {
    const g = touch(f.url);
    const arr = f.dir === "sent" ? g.sent : g.received;
    if (arr.length < 3 && f.payloadKind === "text" && f.payload) arr.push(f.payload);
  }

  const doc = {
    asyncapi: "3.0.0",
    info: {
      title: "Captured WebSocket API",
      version: "0.1.0",
      description:
        "Skeleton generated by NetScope from live browser traffic on " +
        new Date().toISOString() +
        ". Replace the captured example payloads with proper message schemas."
    },
    servers: {},
    channels: {},
    operations: {},
    components: { messages: {} }
  };

  let idx = 0;
  for (const [url, g] of byUrl) {
    idx++;
    let u = null;
    try {
      u = new URL(url);
    } catch (_) {}

    const serverKey = u ? sanitizeKey(u.host) : "server_" + idx;
    if (u && !doc.servers[serverKey]) {
      doc.servers[serverKey] = { host: u.host, protocol: u.protocol.replace(":", "") || "wss" };
    }

    const base = sanitizeKey((u ? u.host + "_" + u.pathname : "channel_" + idx) || "root");
    let chanKey = base;
    let n = 2;
    while (doc.channels[chanKey]) chanKey = base + "_" + n++;

    const chan = {
      address: u ? u.pathname + (u.search || "") : url,
      messages: {}
    };
    if (u) chan.servers = [{ $ref: "#/servers/" + serverKey }];

    const addDirection = (dirKey, action, examples, summary) => {
      if (!examples.length) return;
      const msgKey = chanKey + "_" + dirKey;
      doc.components.messages[msgKey] = {
        name: msgKey,
        summary,
        examples: examples.map((p, i) => ({ name: "captured_" + (i + 1), payload: tryJsonValue(p) }))
      };
      chan.messages[msgKey] = { $ref: "#/components/messages/" + msgKey };
      doc.operations[action + "_" + chanKey] = {
        action,
        channel: { $ref: "#/channels/" + chanKey },
        messages: [{ $ref: "#/channels/" + chanKey + "/messages/" + msgKey }]
      };
    };

    addDirection("clientToServer", "send", g.sent, "Message sent by the client (captured examples)");
    addDirection(
      "serverToClient",
      "receive",
      g.received,
      "Message sent by the server (captured examples)"
    );

    doc.channels[chanKey] = chan;
  }

  const json = JSON.stringify(doc, null, 2);
  download("asyncapi.netscope.json", json);
  copyText(json, "AsyncAPI skeleton copied & downloaded");
}

/* ------------------------------------------------------------- wiring */

function jumpNextHit() {
  const hitRows = filtered.filter((f) => f.hits && f.hits.length);
  if (!hitRows.length) return;
  const idx = hitRows.findIndex((f) => f.e.id === selectedId);
  const next = hitRows[(idx + 1) % hitRows.length];
  showDetail(next.e.id, activeTab);
  const el = ui.rows.querySelector(`tr[data-id="${next.e.id}"]`);
  if (el) el.scrollIntoView({ block: "nearest" });
}

function wireUi() {
  let deb = 0;
  ui.search.addEventListener("input", () => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      opts.query = ui.search.value;
      refresh();
    }, 120);
  });
  ui.search.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") jumpNextHit();
  });

  ui.optCase.addEventListener("click", () => {
    opts.caseSensitive = !opts.caseSensitive;
    ui.optCase.classList.toggle("on", opts.caseSensitive);
    refresh();
  });
  ui.optRegex.addEventListener("click", () => {
    opts.regex = !opts.regex;
    ui.optRegex.classList.toggle("on", opts.regex);
    refresh();
  });

  ui.scopes.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-scope]");
    if (!btn) return;
    const key = btn.dataset.scope;
    opts.scopes[key] = !opts.scopes[key];
    btn.classList.toggle("on", opts.scopes[key]);
    refresh();
  });

  ui.typeFilter.addEventListener("change", () => {
    opts.type = ui.typeFilter.value;
    refresh();
  });

  ui.preserve.addEventListener("change", () => {
    if (api) api.setPreserveLog(ui.preserve.checked);
  });

  ui.collapseDupes.addEventListener("change", () => {
    opts.collapseDupes = ui.collapseDupes.checked;
    refresh();
  });

  ui.clearBtn.addEventListener("click", () => {
    if (api) api.clear();
    else {
      entries = [];
      refresh();
    }
  });

  ui.exportAsync.addEventListener("click", exportAsyncAPI);

  ui.rows.addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-id]");
    if (!tr || tr.classList.contains("nav-row")) return;
    showDetail(Number(tr.dataset.id));
  });

  ui.closeDetail.addEventListener("click", hideDetail);

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hideDetail();
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "f") {
      ev.preventDefault();
      ui.search.focus();
      ui.search.select();
    }
  });

  // Reasonable default before the DevTools theme arrives.
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    document.body.className = "theme-light";
  }
}

wireUi();

/* --------------------------------------------------- DevTools plumbing */

/* Called by devtools.js each time the panel is shown. */
window.__netscopeInit = (a) => {
  if (api) {
    refresh();
    return;
  }
  api = a;
  document.body.className = api.themeName === "dark" ? "theme-dark" : "theme-light";
  ui.preserve.checked = api.getPreserveLog();
  entries = api.getEntries();
  api.subscribe((type) => {
    if (type === "clear") hideDetail();
    scheduleRefresh();
  });
  refresh();
};
