/* NetScope – app.js
 * The popup shell and the Traffic view. Runs in app.html, an extension page
 * shown in an iframe inside the inspected page (or as a standalone tab).
 *
 * Captured payloads are untrusted page data: everything here renders with
 * textContent / createElement, never innerHTML.
 *
 * Globals other scripts rely on: api, typeBucket, fmtSize, fmtDuration,
 * toast, copyText, showDetail, renderDetail, switchView, showComposer.
 */
"use strict";

const CURL = () => globalThis.__netscopeCurl;

let api = null;
let entries = [];
let logs = []; // console messages, errors and route changes (separate from network entries)
let filtered = []; // [{ e, hits, dup… }]
let selectedId = null;
let matcherError = false;
let activeTab = null;
let composer = null; // { curl } while the "New request" composer is open
let currentView = "chat";
let uiMode = "panel";

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
  newRequest: $("newRequest"),
  rows: $("rows"),
  empty: $("empty"),
  listWrap: $("listWrap"),
  detail: $("detail"),
  tabs: $("tabs"),
  detailActions: $("detailActions"),
  detailBody: $("detailBody"),
  closeDetail: $("closeDetail"),
  toast: $("toast"),
  trafficCount: $("trafficCount"),
  trace: $("trace"),
  pillTrace: $("pillTrace"),
  pillCount: $("pillCount")
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

function fmtAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s <= 1 ? "just now" : s + " s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  if (h < 48) return h + " h ago";
  return Math.round(h / 24) + " days ago";
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
  ui.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (ui.toast.hidden = true), 2200);
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
  toast(ok ? msg || "Copied" : "Copy failed — the clipboard is blocked here");
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

const isWrite = (m) => !/^(GET|HEAD|OPTIONS)$/i.test(m || "GET");

function sourceLabel(e) {
  if (e.source === "ai") return "AI";
  if (e.source === "flow") return "Flow";
  if (e.source === "you") return "You";
  return "";
}

/* -------------------------------------------------------- connection */

const listeners = new Set();
const pending = new Map(); // reqId -> {resolve, reject}
let port = null;
let reqSeq = 0;
let hello = null;
const helloWaiters = [];

function emit(type, entry) {
  for (const fn of listeners) {
    try {
      fn(type, entry);
    } catch (_) {}
  }
}

function connect() {
  try {
    port = chrome.runtime.connect({ name: "netscope-app" });
  } catch (_) {
    setTimeout(connect, 1000);
    return;
  }
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    for (const [, p] of pending) p.reject(new Error("NetScope's background worker restarted — try again"));
    pending.clear();
    setTimeout(connect, 500); // worker suspended; reconnecting re-sends the snapshot
  });
}

function onPortMessage(msg) {
  if (!msg) return;
  switch (msg.type) {
    case "hello":
      hello = msg;
      document.body.classList.toggle("standalone", !!msg.standalone || window.top === window);
      ui.preserve.checked = !!(msg.prefs && msg.prefs.preserve);
      while (helloWaiters.length) helloWaiters.shift()(msg);
      break;
    case "snapshot":
      entries = Array.isArray(msg.entries) ? msg.entries : [];
      logs = Array.isArray(msg.logs) ? msg.logs : [];
      emit("logs");
      api._startedAt = msg.startedAt || Date.now();
      emit("snapshot");
      scheduleRefresh();
      break;
    case "add":
      entries.push(msg.entry);
      if (entries.length > 3000) entries.splice(0, entries.length - 3000);
      emit("add", msg.entry);
      scheduleRefresh();
      break;
    case "update": {
      const i = findIndex(msg.entry.id);
      if (i >= 0) entries[i] = msg.entry;
      emit("update", msg.entry);
      scheduleRefresh();
      break;
    }
    case "logs":
      for (const l of msg.logs || []) logs.push(l);
      if (logs.length > 2000) logs.splice(0, logs.length - 2000);
      emit("logs", msg.logs);
      break;
    case "logs-clear":
      logs = [];
      emit("logs");
      break;
    case "clear":
      entries = [];
      if (msg.logs) {
        logs = [];
        emit("logs");
      }
      api._startedAt = msg.startedAt || Date.now();
      hideDetail();
      emit("clear");
      scheduleRefresh();
      break;
    case "prefs":
      ui.preserve.checked = !!(msg.prefs && msg.prefs.preserve);
      break;
    case "flows-changed":
    case "flow-progress":
    case "flow-step":
    case "docs-changed":
    case "chats-changed":
      emit(msg.type, msg);
      break;
    case "rpc-result": {
      const p = pending.get(msg.reqId);
      if (!p) return;
      pending.delete(msg.reqId);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      break;
    }
  }
}

function findIndex(id) {
  // Updates almost always hit recent rows; scan from the end.
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].id === id) return i;
  return -1;
}

// The AI the user picked in Settings: "Kimi" or "Muse".
function aiName() {
  const a = window.__netscopeAi;
  return (a && a.aiName && a.aiName()) || "Kimi";
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error("Not connected to NetScope's background worker yet"));
    const reqId = ++reqSeq;
    pending.set(reqId, { resolve, reject });
    try {
      port.postMessage({ type: "rpc", reqId, method, params: params || {} });
    } catch (err) {
      pending.delete(reqId);
      reject(err);
    }
  });
}

api = {
  _startedAt: Date.now(),
  getEntries: () => entries,
  getLogs: () => logs, // console messages, errors, route changes
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  clear: () => rpc("clear"),
  getStartedAt: () => api._startedAt,
  rpc,
  whenReady: () => (hello ? Promise.resolve(hello) : new Promise((r) => helloWaiters.push(r))),
  tabId: () => (hello ? hello.tabId : null),
  page: () => {
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].kind === "nav") return { url: entries[i].url, title: entries[i].title || "" };
    return hello ? hello.page : { url: "", title: "" };
  }
};

/* ------------------------------------------------------------- shell */

function requestMode(mode) {
  if (window.top === window) return; // standalone tab
  try {
    window.parent.postMessage({ __netscopeUi: 1, request: "mode", mode }, "*");
  } catch (_) {}
}

function applyMode(mode) {
  uiMode = mode;
  document.body.classList.toggle("mode-pill", mode === "pill");
  document.body.classList.toggle("mode-panel", mode === "panel");
  document.body.classList.toggle("mode-large", mode === "large");
  $("pill").hidden = mode !== "pill";
  const large = mode === "large";
  const btn = $("btnLarge");
  btn.title = large ? "Shrink" : "Expand";
  btn.setAttribute("aria-label", btn.title);
  btn.querySelector("use").setAttribute("href", large ? "#i-shrink" : "#i-expand");
  drawTraces();
  if (mode === "panel" || mode === "large") {
    if (currentView === "chat") setTimeout(() => $("aiInput").focus(), 30);
  }
}

window.addEventListener("message", (ev) => {
  // Mode updates come from our content script in the parent page. The page
  // itself could post the same shape; at worst it resizes the popup.
  const d = ev.data;
  if (ev.source !== window.parent || !d || d.__netscopeUi !== 1 || typeof d.mode !== "string") return;
  if (["pill", "panel", "large", "hidden"].includes(d.mode)) applyMode(d.mode);
});

const INSPECT_VIEWS = { traffic: "Traffic", console: "Console", app: "App" };

// The small popup shows one "Inspect" tab for Traffic, Console and App.
function syncInspectTab() {
  const tab = $("tab-inspect");
  if (!tab) return;
  const inside = !!INSPECT_VIEWS[currentView];
  tab.setAttribute("aria-selected", inside ? "true" : "false");
  $("inspectLabel").textContent = inside ? INSPECT_VIEWS[currentView] : "Inspect";
  // Errors stay visible even when the Console is folded away.
  const con = $("consoleCount");
  const err = con && con.classList.contains("err") ? con.textContent : "";
  $("inspectCount").textContent = err;
  $("inspectCount").classList.toggle("err", !!err);
}

function setInspectMenu(open) {
  const menu = $("inspectMenu");
  const tab = $("tab-inspect");
  if (!menu || !tab) return;
  menu.hidden = !open;
  tab.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) return;
  menu.style.left = tab.offsetLeft + "px";
  for (const item of menu.querySelectorAll("[role=menuitem]")) {
    const src = item.querySelector("[data-count]");
    if (src) {
      const from = $(src.dataset.count);
      src.textContent = from ? from.textContent : "";
      src.classList.toggle("err", !!(from && from.classList.contains("err")));
    }
    item.classList.toggle("current", item.dataset.view === currentView);
  }
  (menu.querySelector(".current") || menu.querySelector("[role=menuitem]")).focus();
}

function switchView(view) {
  if (view === "inspect") return setInspectMenu($("inspectMenu").hidden);
  setInspectMenu(false);
  currentView = view;
  for (const tab of document.querySelectorAll("#views [role=tab]")) {
    const on = tab.dataset.view === view;
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
  }
  for (const v of document.querySelectorAll(".view")) v.classList.toggle("on", v.id === "view-" + view);
  if (view === "traffic") scheduleRefresh();
  if (view === "chat") setTimeout(() => $("aiInput").focus(), 0);
  if (window.__netscopeFlowsUi && view === "flows") window.__netscopeFlowsUi.onShown();
  if (window.__netscopeDocsUi && view === "docs") window.__netscopeDocsUi.onShown();
  if (window.__netscopeConsoleUi && view === "console") window.__netscopeConsoleUi.onShown();
  if (window.__netscopeAppUi && view === "app") window.__netscopeAppUi.onShown();
  syncInspectTab();
}

/* ------------------------------------------------------------- trace */

// Requests per second over the last 90 s. Errors are drawn as ticks so a
// burst of failures is visible without opening the list.
function traceSeries(n) {
  const now = Date.now();
  const counts = new Array(n).fill(0);
  const errs = new Array(n).fill(0);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const age = Math.floor((now - (e.startedAt || 0)) / 1000);
    if (age >= n) break;
    if (age < 0 || e.kind === "nav") continue;
    const b = n - 1 - age;
    counts[b]++;
    if (e.kind === "http" && (e.status >= 400 || e.failed)) errs[b]++;
  }
  return { counts, errs };
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawTrace(canvas, seconds) {
  if (!canvas || !canvas.isConnected || canvas.offsetParent === null) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const { counts, errs } = traceSeries(seconds);
  const max = Math.max(3, ...counts);
  const step = w / (seconds - 1);
  const y = (v) => h - 3 - (v / max) * (h - 7);

  ctx.strokeStyle = cssVar("--line");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 2.5);
  ctx.lineTo(w, h - 2.5);
  ctx.stroke();

  ctx.strokeStyle = cssVar("--signal");
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.beginPath();
  counts.forEach((c, i) => {
    const x = i * step;
    if (i === 0) ctx.moveTo(x, y(c));
    else ctx.lineTo(x, y(c));
  });
  ctx.stroke();

  ctx.fillStyle = cssVar("--server-err");
  errs.forEach((c, i) => {
    if (c) ctx.fillRect(i * step - 1, h - 6, 2, 5);
  });
}

function drawTraces() {
  drawTrace(ui.trace, 90);
  drawTrace(ui.pillTrace, 40);
}

setInterval(() => {
  if (document.visibilityState === "visible") drawTraces();
}, 1000);

function updateCounts() {
  let n = 0;
  for (const e of entries) if (e.kind !== "nav") n++;
  ui.trafficCount.textContent = n ? String(n) : "";
  ui.pillCount.textContent = n ? String(n) : "";
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
    return false;
  }
  return hits.length ? hits : false;
}

function dedupeKey(e) {
  if (e.kind === "http") return ["h", e.source || "", e.method, e.url, e.reqBody || ""].join("␟");
  if (e.kind === "ws-frame") return ["w", e.url, e.dir, e.payloadKind, e.payload || ""].join("␟");
  return null;
}

function typeBucket(e) {
  if (e.kind === "nav") return "nav";
  if (e.kind !== "http") return "ws";
  if (e.resourceType === "netscope") return "netscope";
  return "api";
}

function passesType(e) {
  if (opts.type === "all") return true;
  if (opts.type === "errors") return e.kind === "http" ? e.status >= 400 || !!e.failed : e.kind === "ws-close" && e.code !== 1000;
  return typeBucket(e) === opts.type;
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
  updateCounts();
  if (currentView !== "traffic") return;

  const re = buildMatcher();
  filtered = [];
  let hitCount = 0;

  for (const e of entries) {
    if (e.kind === "nav") {
      if (!opts.query && opts.type === "all") filtered.push({ e, hits: null });
      continue;
    }
    if (!passesType(e)) continue;
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
    const rep = new Map();
    const kept = [];
    for (const row of filtered) {
      const key = dedupeKey(row.e);
      // A body still streaming may yet differ; never hide it inside a group.
      if (key === null || (row.e.kind === "http" && row.e.resBodyPending)) {
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
        if (row.e.id === selectedId) selectedId = first.e.id;
        collapsedCount++;
      } else {
        row.dup = 1;
        row.dupIds = [row.e.id];
        row.dupLastAt = row.e.startedAt;
        row.dupStatuses = new Map(row.e.kind === "http" ? [[row.e.status || 0, 1]] : []);
        rep.set(key, row);
        kept.push(row);
      }
    }
    filtered = kept;
  } else {
    for (const row of filtered) row.dup = 0;
  }

  if (re && opts.collapseDupes) hitCount = filtered.reduce((n, r) => n + (r.hits && r.hits.length ? 1 : 0), 0);

  renderRows();
  renderStats(hitCount, !!re, collapsedCount);
  if (selectedId !== null && !composer) renderDetail();
}

function renderStats(hitCount, searching, collapsedCount) {
  document.getElementById("toolbar").classList.toggle("searching", !!opts.query);
  ui.exportAsync.hidden = !entries.some((e) => e.kind === "ws-open" || e.kind === "ws-frame");
  ui.stats.replaceChildren();
  ui.search.classList.toggle("bad", matcherError);
  if (matcherError) {
    const b = document.createElement("span");
    b.className = "bad";
    b.textContent = "invalid regex";
    ui.stats.appendChild(b);
    return;
  }
  let n = 0;
  for (const e of entries) if (e.kind !== "nav") n++;
  ui.stats.appendChild(document.createTextNode(n + " captured"));
  if (searching) {
    ui.stats.appendChild(document.createTextNode(", "));
    const h = document.createElement("span");
    h.className = "hitcount";
    h.textContent = hitCount + " match" + (hitCount === 1 ? "" : "es");
    ui.stats.appendChild(h);
  }
  if (collapsedCount > 0) {
    ui.stats.appendChild(document.createTextNode(`, ${collapsedCount} grouped`));
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

function nameCell(primary, secondary, title, dup, mixed, source) {
  const cell = document.createElement("td");
  cell.title = title || "";
  if (source) {
    const s = document.createElement("span");
    s.className = "src";
    s.textContent = source;
    s.title = source === "AI" ? "Sent by the AI assistant" : source === "Flow" ? "Sent by a flow" : "Sent by you from NetScope";
    cell.appendChild(s);
  }
  if (dup > 1) {
    const badge = document.createElement("span");
    badge.className = "dupe-badge" + (mixed ? " mixed" : "");
    badge.textContent = "×" + dup;
    badge.title = mixed
      ? dup + " requests with the same input but different statuses — open for a breakdown"
      : dup + " identical requests grouped into one row";
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

// The narrow panel hides some columns; a full-width row must span only the
// visible ones, or the fixed table layout grows phantom columns.
function visibleColumns() {
  let n = 0;
  for (const th of document.querySelectorAll("#list thead th")) if (th.offsetWidth > 0) n++;
  return n || 7;
}

let navSpan = 7;
function renderRows() {
  navSpan = visibleColumns();
  const nearBottom = ui.listWrap.scrollTop + ui.listWrap.clientHeight >= ui.listWrap.scrollHeight - 40;
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
      cell.colSpan = navSpan;
      cell.textContent = "Page loaded: " + e.url;
      tr.appendChild(cell);
      frag.appendChild(tr);
      continue;
    }

    if (e.kind === "http") {
      const p = urlParts(e.url);
      tr.appendChild(nameCell(fileName(e.url), p.host, e.url, dup, mixed, sourceLabel(e)));
      tr.appendChild(td(e.method, "m-http"));
      const st = e.failed ? "failed" : e.status ? String(e.status) : "…";
      tr.appendChild(td(st, e.failed ? "sx" : statusClass(e.status), e.error || e.statusText || ""));
      tr.appendChild(td(e.resourceType === "netscope" ? "sent" : e.resourceType));
      tr.appendChild(hitsCell(hits));
      tr.appendChild(td(fmtSize(e.size)));
      tr.appendChild(td(e.resBodyPending && e.status ? "streaming" : fmtDuration(e.durationMs)));
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
  const i = findIndex(id);
  return i >= 0 ? entries[i] : null;
}

function showDetail(id, tab) {
  composer = null;
  selectedId = id;
  activeTab = tab || null;
  if (currentView !== "traffic") switchView("traffic");
  document.body.classList.add("split");
  ui.detail.classList.remove("hidden");
  for (const tr of ui.rows.children) tr.classList.toggle("sel", tr.dataset.id === String(id));
  refresh(); // also renders the detail pane
  const row = ui.rows.querySelector(`tr[data-id="${id}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
  notifyAiSelection();
}

function hideDetail() {
  selectedId = null;
  activeTab = null;
  composer = null;
  document.body.classList.remove("split");
  ui.detail.classList.add("hidden");
  for (const tr of ui.rows.children) tr.classList.remove("sel");
  notifyAiSelection();
}

function notifyAiSelection() {
  if (window.__netscopeAi) window.__netscopeAi.onSelection(selectedId);
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

function actionBtn(label, fn, cls) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", fn);
  return b;
}

function tabsFor(e) {
  if (e.kind === "http") return ["summary", "request", "response", "edit & send"];
  if (e.kind === "ws-frame") return ["frame", "connection", "tools"];
  return ["connection", "tools"];
}

function toCurl(e) {
  return CURL().build({ method: e.method, url: e.url, headers: e.reqHeaders || [], body: e.reqBody || "" });
}

function renderDetail() {
  if (composer) return renderComposer();
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
    b.type = "button";
    b.textContent = t.charAt(0).toUpperCase() + t.slice(1);
    if (t === activeTab) b.classList.add("on");
    b.addEventListener("click", () => {
      activeTab = t;
      renderDetail();
    });
    ui.tabs.appendChild(b);
  }

  ui.detailActions.replaceChildren();
  const ai = window.__netscopeAi;
  if (e.kind === "http") {
    if (ai) {
      ui.detailActions.appendChild(
        actionBtn("Ask " + aiName(), () => ai.startRun({ kind: "explain", entryId: e.id, forceTool: true, maxIterations: 6 }))
      );
      if (e.status >= 400 || e.status === 0) {
        ui.detailActions.appendChild(
          actionBtn("Debug", () => ai.startRun({ kind: "debug", entryId: e.id, forceTool: true, maxIterations: 10 }))
        );
      }
    }
    ui.detailActions.appendChild(actionBtn("Copy cURL", () => copyText(toCurl(e), "cURL copied")));
  } else if (e.kind === "ws-frame") {
    ui.detailActions.appendChild(actionBtn("Copy payload", () => copyText(e.payload, "Payload copied")));
  } else {
    ui.detailActions.appendChild(actionBtn("Copy URL", () => copyText(e.url, "URL copied")));
  }

  const body = ui.detailBody;
  const keepScroll = body.dataset.for === String(e.id) + activeTab ? body.scrollTop : 0;
  body.replaceChildren();
  body.dataset.for = String(e.id) + activeTab;

  const row = filtered.find((f) => f.e.id === selectedId);
  if (row && row.dup > 1) {
    const bar = document.createElement("div");
    bar.className = "dupe-bar";
    const badge = document.createElement("span");
    badge.className = "dupe-badge";
    badge.textContent = "×" + row.dup;
    bar.appendChild(badge);
    const txt = document.createElement("span");
    let s =
      (e.kind === "ws-frame" ? " identical frames" : " requests with the same input") +
      ", first " + fmtClock(e.startedAt) + ", last " + fmtClock(row.dupLastAt || e.startedAt);
    if (row.dupStatuses && row.dupStatuses.size > 1) {
      const parts = [...row.dupStatuses.entries()].sort((a, b) => b[1] - a[1]).map(([st, n]) => (st || "pending") + " ×" + n);
      s += ". Statuses: " + parts.join(" / ");
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

  if (e.kind === "http") {
    if (activeTab === "summary") {
      body.appendChild(h4("General"));
      const pairs = [
        ["URL", e.url],
        ["Method", e.method],
        ["Status", e.failed ? "failed — " + (e.error || "network error") : e.status ? `${e.status} ${e.statusText || ""}` : "(waiting)"],
        ["Type", `${e.resourceType} · ${e.mime || "?"}`],
        ["Size", fmtSize(e.size)],
        ["Duration", fmtDuration(e.durationMs)],
        ["Started", fmtClock(e.startedAt)]
      ];
      if (e.finalUrl) pairs.splice(1, 0, ["Final URL", e.finalUrl]);
      if (sourceLabel(e)) pairs.push(["Sent by", sourceLabel(e) === "AI" ? "the AI assistant" : sourceLabel(e) === "Flow" ? "a flow" : "you, from NetScope"]);
      if (e.sentFromPage) pairs.push(["Sent from", "inside the page " + e.sentFromPage]);
      body.appendChild(kvBlock(pairs));
      if (e.droppedHeaders && e.droppedHeaders.length) {
        body.appendChild(
          note([
            { warn: "Not sent: " },
            e.droppedHeaders.join(", ") + ". Browsers block scripts from setting these; the browser's own cookies for this site were sent instead."
          ])
        );
      }
      body.appendChild(h4("Request headers"));
      body.appendChild(highlightedPre(e.reqHeaderText || "(none set by the page)"));
      if (e.source === "page") {
        body.appendChild(note(["Headers the page set. The browser adds cookies, user-agent and similar on its own."]));
      }
      body.appendChild(h4("Response headers"));
      body.appendChild(highlightedPre(e.resHeaderText || "(none readable)"));
    } else if (activeTab === "request") {
      const qs = e.url.includes("?") ? e.url.slice(e.url.indexOf("?") + 1) : "";
      if (qs) {
        body.appendChild(h4("Query string"));
        body.appendChild(highlightedPre(decodeQuery(qs)));
      }
      body.appendChild(h4("Request body"));
      if (e.reqBody) {
        if (e.reqBodyTruncated) body.appendChild(note([{ warn: "truncated " }, "— the body exceeded the capture limit."]));
        body.appendChild(highlightedPre(tryJsonPretty(e.reqBody)));
      } else body.appendChild(note(["No request body."]));
    } else if (activeTab === "response") {
      const flags = [];
      if (e.resBodyPending) flags.push(e.status ? "still streaming…" : "waiting for a response…");
      if (e.resBodyBinary) flags.push("binary body, not captured as text");
      if (e.resBodyTruncated) flags.push("truncated at the capture limit");
      if (e.note) flags.push(e.note);
      if (e.failed) flags.push(e.error || "request failed");
      body.appendChild(
        note([`${e.mime || "unknown type"} · ${fmtSize(e.size)}`, flags.length ? " · " : ""].concat(flags.length ? [{ warn: flags.join(" · ") }] : []))
      );
      if (e.resBody) body.appendChild(highlightedPre(tryJsonPretty(e.resBody)));
      else if (!e.resBodyPending && !e.resBodyBinary && !e.failed) body.appendChild(note(["Empty body."]));
    } else if (activeTab === "edit & send") {
      renderSendBox(body, toCurl(e), e);
    }
  }

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
      if (e.payloadTruncated) body.appendChild(note([{ warn: "truncated " }, "— the frame exceeded the capture limit."]));
      body.appendChild(h4("Payload"));
      body.appendChild(highlightedPre(tryJsonPretty(e.payload)));
    } else if (activeTab === "connection") renderWsConnection(body, e);
    else if (activeTab === "tools") renderWsTools(body, e);
  }

  if (e.kind === "ws-open" || e.kind === "ws-close") {
    if (activeTab === "connection") renderWsConnection(body, e);
    else if (activeTab === "tools") renderWsTools(body, e);
  }

  if (keepScroll) body.scrollTop = keepScroll;
}

/* ------------------------------------------------ Edit & send (Postman) */

function renderSendBox(body, curlText, fromEntry) {
  const box = document.createElement("div");
  box.className = "send-box";
  box.appendChild(
    note([
      fromEntry
        ? "Edit the cURL and send it. Captured headers are included verbatim, so treat it as a secret."
        : "Paste a cURL command (Chrome's Copy as cURL, Postman, or hand-written) and send it."
    ])
  );
  const ta = document.createElement("textarea");
  ta.spellcheck = false;
  ta.value = curlText || "";
  ta.setAttribute("aria-label", "cURL command");
  box.appendChild(ta);
  const actions = document.createElement("div");
  actions.className = "actions";
  const fromPage = document.createElement("label");
  fromPage.className = "chk";
  fromPage.title = "Send it from inside an open tab on that site, with the site's own cookies, origin and page scripts — for endpoints that reject replays (WAF, anti-bot, CSRF)";
  const fromPageBox = document.createElement("input");
  fromPageBox.type = "checkbox";
  fromPage.append(fromPageBox, document.createTextNode(" From the page"));
  const send = actionBtn("Send", () => sendCurl(ta.value, send, fromPageBox.checked), "primary");
  actions.appendChild(send);
  actions.appendChild(fromPage);
  actions.appendChild(actionBtn("Copy", () => copyText(ta.value, "cURL copied")));
  if (window.__netscopeAi) {
    actions.appendChild(
      actionBtn(`Ask ${aiName()} to run it`, () => {
        window.__netscopeAi.prefill("Run this request, then explain the response:\n\n" + ta.value, true);
      }, "ghost")
    );
  }
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = "⌘/Ctrl+Enter sends";
  actions.appendChild(hint);
  box.appendChild(actions);
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      sendCurl(ta.value, send, fromPageBox.checked);
    }
  });
  body.appendChild(box);
  if (!fromEntry) setTimeout(() => ta.focus(), 0);
}

async function sendCurl(text, btn, fromPage) {
  let parsed;
  try {
    parsed = CURL().parse(text);
  } catch (err) {
    toast("Could not read that cURL: " + err.message);
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending…";
  }
  try {
    const res = await rpc("http", { request: parsed, source: "you", context: fromPage ? "page" : "extension" });
    if (parsed.warnings && parsed.warnings.length) toast(parsed.warnings[0]);
    if (res && res.entryId) {
      // Wait for the new row to arrive over the port, then open it.
      let tries = 0;
      const open = () => {
        if (findEntry(res.entryId)) showDetail(res.entryId, "response");
        else if (++tries < 40) setTimeout(open, 50); // give up after ~2 s
      };
      open();
    } else if (res && res.error) toast(res.error);
  } catch (err) {
    toast(String(err.message || err));
  } finally {
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  }
}

function showComposer(curlText) {
  if (currentView !== "traffic") switchView("traffic");
  selectedId = null;
  composer = { curl: curlText || "" };
  document.body.classList.add("split");
  ui.detail.classList.remove("hidden");
  for (const tr of ui.rows.children) tr.classList.remove("sel");
  renderComposer();
}

function renderComposer() {
  ui.tabs.replaceChildren();
  const b = document.createElement("button");
  b.type = "button";
  b.className = "on";
  b.textContent = "New request";
  ui.tabs.appendChild(b);
  ui.detailActions.replaceChildren();
  ui.detailBody.replaceChildren();
  ui.detailBody.dataset.for = "";
  renderSendBox(ui.detailBody, composer.curl || "curl 'https://httpbin.org/get' \\\n  -H 'Accept: application/json'", null);
}

/* ------------------------------------------------------------ WS bits */

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
      ["Frames", `${frames.length} total, ${sent} sent, ${recv} received`],
      ["State", closed ? `closed ${closed.code > 0 ? closed.code : ""} ${closed.reason || ""}`.trim() : "open (or unknown)"]
    ])
  );
}

function renderWsTools(body, e) {
  const shq = CURL().shq;
  body.appendChild(h4("Reconnect from a terminal"));
  body.appendChild(highlightedPre("websocat " + shq(e.url)));
  body.appendChild(actionBtn("Copy websocat", () => copyText("websocat " + shq(e.url), "Copied")));
  body.appendChild(document.createElement("br"));
  body.appendChild(document.createElement("br"));
  body.appendChild(highlightedPre("npx wscat -c " + shq(e.url)));
  body.appendChild(actionBtn("Copy wscat", () => copyText("npx wscat -c " + shq(e.url), "Copied")));
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

/* ---------------------------------------------------- AsyncAPI export */

function sanitizeKey(s) {
  return String(s).replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "x";
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
      description: "Skeleton generated by NetScope from live browser traffic on " + new Date().toISOString() + ". Replace the captured example payloads with proper message schemas."
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
    if (u && !doc.servers[serverKey]) doc.servers[serverKey] = { host: u.host, protocol: u.protocol.replace(":", "") || "wss" };
    const base = sanitizeKey((u ? u.host + "_" + u.pathname : "channel_" + idx) || "root");
    let chanKey = base;
    let n = 2;
    while (doc.channels[chanKey]) chanKey = base + "_" + n++;
    const chan = { address: u ? u.pathname + (u.search || "") : url, messages: {} };
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
    addDirection("serverToClient", "receive", g.received, "Message sent by the server (captured examples)");
    doc.channels[chanKey] = chan;
  }
  const json = JSON.stringify(doc, null, 2);
  download("asyncapi.netscope.json", json);
  copyText(json, "AsyncAPI file downloaded and copied");
}

/* ------------------------------------------------------------- wiring */

function jumpNextHit() {
  const hitRows = filtered.filter((f) => f.hits && f.hits.length);
  if (!hitRows.length) return;
  const idx = hitRows.findIndex((f) => f.e.id === selectedId);
  const next = hitRows[(idx + 1) % hitRows.length];
  showDetail(next.e.id, activeTab);
}

function wireUi() {
  // Shell
  $("btnLarge").addEventListener("click", () => requestMode(uiMode === "large" ? "panel" : "large"));
  $("btnCollapse").addEventListener("click", () => requestMode("pill"));
  $("btnClose").addEventListener("click", () => requestMode("hidden"));
  $("pillOpen").addEventListener("click", () => requestMode("panel"));
  $("pillClose").addEventListener("click", () => requestMode("hidden"));

  const allTabs = Array.from(document.querySelectorAll("#views [role=tab]"));
  for (const tab of allTabs) {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
    tab.addEventListener("keydown", (ev) => {
      if (tab.id === "tab-inspect" && (ev.key === "ArrowDown" || ev.key === "Enter" || ev.key === " ")) {
        ev.preventDefault();
        return setInspectMenu(true);
      }
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
      // Only the tabs this popup size shows.
      const tabs = allTabs.filter((t) => t.offsetParent !== null);
      const i = tabs.indexOf(tab);
      const next = tabs[(i + (ev.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      if (next.id !== "tab-inspect") switchView(next.dataset.view);
      next.focus();
    });
  }
  const menu = $("inspectMenu");
  if (menu) {
    for (const item of menu.querySelectorAll("[role=menuitem]")) item.addEventListener("click", () => switchView(item.dataset.view));
    menu.addEventListener("keydown", (ev) => {
      const items = Array.from(menu.querySelectorAll("[role=menuitem]"));
      const i = items.indexOf(document.activeElement);
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        items[(i + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
      } else if (ev.key === "Escape" || ev.key === "Tab") {
        setInspectMenu(false);
        if (ev.key === "Escape") $("tab-inspect").focus();
      }
    });
    document.addEventListener("pointerdown", (ev) => {
      if (!menu.hidden && !menu.contains(ev.target) && ev.target.closest("#tab-inspect") === null) setInspectMenu(false);
    });
  }

  ui.preserve.addEventListener("change", () => {
    rpc("setPreserve", { preserve: ui.preserve.checked })
      .then(() => toast(ui.preserve.checked ? "Logs will be kept when the page reloads" : "Logs reset on each page load"))
      .catch((err) => toast(err.message));
  });

  // Traffic
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

  const toggleBtn = (btn, on) => {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  };
  ui.optCase.addEventListener("click", () => {
    opts.caseSensitive = !opts.caseSensitive;
    toggleBtn(ui.optCase, opts.caseSensitive);
    refresh();
  });
  ui.optRegex.addEventListener("click", () => {
    opts.regex = !opts.regex;
    toggleBtn(ui.optRegex, opts.regex);
    refresh();
  });
  ui.scopes.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-scope]");
    if (!btn) return;
    const key = btn.dataset.scope;
    opts.scopes[key] = !opts.scopes[key];
    toggleBtn(btn, opts.scopes[key]);
    refresh();
  });
  ui.typeFilter.addEventListener("change", () => {
    opts.type = ui.typeFilter.value;
    refresh();
  });
  ui.collapseDupes.addEventListener("change", () => {
    opts.collapseDupes = ui.collapseDupes.checked;
    refresh();
  });
  ui.clearBtn.addEventListener("click", () => {
    if (window.__netscopeAi && window.__netscopeAi.isRunning()) {
      window.__netscopeAi.cancel();
      toast(`Cleared — ${aiName()}'s answer was stopped because it cited these requests`);
    }
    rpc("clear").catch((err) => toast(err.message));
  });
  ui.exportAsync.addEventListener("click", exportAsyncAPI);
  ui.newRequest.addEventListener("click", () => showComposer(""));
  ui.rows.addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-id]");
    if (!tr || tr.classList.contains("nav-row")) return;
    showDetail(Number(tr.dataset.id));
  });
  ui.closeDetail.addEventListener("click", hideDetail);

  document.addEventListener("keydown", (ev) => {
    if (ev.target && ev.target.closest && ev.target.closest("#view-chat, #settings, #flowEditor, textarea")) return;
    if (ev.key === "Escape" && currentView === "traffic" && !ui.detail.classList.contains("hidden")) hideDetail();
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "f" && currentView === "traffic") {
      ev.preventDefault();
      ui.search.focus();
      ui.search.select();
    }
  });

  // An open sheet (Settings, History) is a modal dialog: keep Tab inside it.
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab") return;
    const sheet = document.querySelector(".sheet:not([hidden])");
    if (!sheet) return;
    const focusable = Array.from(sheet.querySelectorAll("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")).filter(
      (n) => !n.disabled && !n.hidden && n.offsetParent !== null
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!sheet.contains(document.activeElement)) {
      ev.preventDefault();
      first.focus();
    } else if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  });

  window.addEventListener("resize", () => {
    drawTraces();
    if (currentView === "traffic" && visibleColumns() !== navSpan) scheduleRefresh();
  });
}

wireUi();
