/* NetScope – background.js (service worker)
 *
 *   page (MAIN) net-hook.js ─postMessage─▶ content.js ─sendMessage─▶ here ─port─▶ app.html (popup iframe)
 *
 * Responsibilities
 *   - per-tab capture log (bg-store.js, IndexedDB-backed), cleared on each new
 *     document unless "Keep logs on reload" is on
 *   - toolbar icon / Alt+Shift+N toggles the in-page popup
 *   - request runner for the AI's http_request tool, "Edit & send", and flows —
 *     runs here, with the extension's host permission, so CORS does not apply
 *   - flow schedules (chrome.alarms), run even with the popup closed
 */
"use strict";

importScripts("curl.js", "bg-store.js", "ai-client.js", "muse-client.js", "flow-engine.js", "page-inspect.js", "bg-sources.js");

const Store = globalThis.__netscopeStore;
const Flows = globalThis.__netscopeFlows;
const AI = globalThis.__netscopeAiClient;

const PREFS_KEY = "netscope.prefs";
const ALERT_KEY = "netscope.flowAlert";
const RESPONSE_MAX = 1000000; // chars kept from a response the runner fetched
const MAX_FRAME_BODY = 262144;

/* --------------------------------------------------------------- prefs */

let prefs = { preserve: false };
const prefsLoaded = chrome.storage.local
  .get(PREFS_KEY)
  .then((got) => {
    prefs = Object.assign({ preserve: false }, got[PREFS_KEY] || {});
  })
  .catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // The popup edits the AI settings; drop this worker's cached copy so flow
  // AI steps see a new key, model or "Forget key" immediately.
  if (changes["netscope.ai"]) AI.invalidate();
  if (changes[PREFS_KEY]) {
    prefs = Object.assign({ preserve: false }, changes[PREFS_KEY].newValue || {});
    broadcastAll({ type: "prefs", prefs });
  }
  if (changes["netscope.flows"]) triggerFlows = null; // re-read on the next page request
  if (changes["netscope.flows"] || changes["netscope.flowRuns"] || changes[ALERT_KEY] || changes["netscope.flowState"]) {
    broadcastAll({ type: "flows-changed" });
  }
});

/* ---------------------------------------------------------- app ports */

const appPorts = new Map(); // tabId -> Set<Port>

function broadcast(tabId, msg) {
  const set = appPorts.get(tabId);
  if (!set) return;
  for (const p of set) {
    try {
      p.postMessage(msg);
    } catch (_) {}
  }
}

function broadcastAll(msg) {
  for (const tabId of appPorts.keys()) broadcast(tabId, msg);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "netscope-app") return;
  const tab = port.sender && port.sender.tab;
  if (!tab || !Number.isInteger(tab.id)) {
    port.disconnect();
    return;
  }
  const tabId = tab.id;
  let set = appPorts.get(tabId);
  if (!set) appPorts.set(tabId, (set = new Set()));
  set.add(port);

  // The popup lives in the page (frameId > 0); a standalone tab is its own top frame.
  const standalone = port.sender.frameId === 0;

  prefsLoaded.then(() =>
    Store.withTab(tabId, (t) => {
      try {
        port.postMessage({
          type: "hello",
          tabId,
          standalone,
          prefs,
          startedAt: t.startedAt,
          ui: t.ui,
          page: { url: tab.url || "", title: tab.title || "" }
        });
        port.postMessage({ type: "snapshot", entries: t.entries, logs: t.logs, startedAt: t.startedAt });
      } catch (_) {}
    })
  );

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "rpc") return;
    handleRpc(tabId, msg.method, msg.params || {})
      .then((result) => {
        try {
          port.postMessage({ type: "rpc-result", reqId: msg.reqId, result });
        } catch (_) {}
      })
      .catch((err) => {
        try {
          port.postMessage({
            type: "rpc-result",
            reqId: msg.reqId,
            error: String((err && err.message) || err)
          });
        } catch (_) {}
      });
  });

  port.onDisconnect.addListener(() => {
    const s = appPorts.get(tabId);
    if (!s) return;
    s.delete(port);
    if (!s.size) appPorts.delete(tabId);
  });
});

/* ------------------------------------------------------------- capture */

const headerText = (list) => (list || []).map((h) => `${h.name}: ${h.value}`).join("\n");

function findByHook(t, key) {
  const hit = t.hooks.get(key);
  if (hit) return hit;
  // After a worker restart the hook index is rebuilt only for pending rows.
  for (let i = t.entries.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
    if (t.entries[i].hookId === key) return t.entries[i];
  }
  return null;
}

function handleEvent(tabId, frameId, ev) {
  const key = frameId + ":" + ev.id;

  return Store.withTab(tabId, async (t) => {
    switch (ev.type) {
      case "page": {
        if (frameId !== 0) return { ui: t.ui };
        await prefsLoaded;
        if (!prefs.preserve && (t.entries.length || t.logs.length)) {
          await Store.clear(t, true);
          broadcast(tabId, { type: "clear", logs: true, startedAt: t.startedAt });
        }
        globalThis.__netscopeSources.forget(tabId);
        const e = Store.add(t, { kind: "nav", url: String(ev.url || ""), title: String(ev.title || ""), startedAt: ev.ts || Date.now() });
        broadcast(tabId, { type: "add", entry: e });
        return { ui: t.ui };
      }
      case "ui": {
        if (["hidden", "pill", "panel", "large"].includes(ev.mode)) Store.setUi(t, ev.mode);
        return null;
      }
      case "http-start": {
        const reqHeaders = Array.isArray(ev.reqHeaders) ? ev.reqHeaders : [];
        const e = Store.add(t, {
          kind: "http",
          source: "page",
          hookId: key,
          frameId,
          method: String(ev.method || "GET"),
          url: String(ev.url || ""),
          status: 0,
          statusText: "",
          mime: "",
          resourceType: ev.api === "xhr" ? "xhr" : "fetch",
          startedAt: ev.ts || Date.now(),
          durationMs: 0,
          size: 0,
          reqHeaders,
          resHeaders: [],
          reqHeaderText: headerText(reqHeaders),
          resHeaderText: "",
          reqBody: typeof ev.reqBody === "string" ? ev.reqBody : "",
          reqBodyTruncated: !!ev.reqBodyTruncated,
          resBody: "",
          resBodyTruncated: false,
          resBodyBinary: false,
          resBodyPending: true
        });
        t.hooks.set(key, e);
        broadcast(tabId, { type: "add", entry: e });
        return null;
      }
      case "http-res": {
        const e = findByHook(t, key);
        if (!e) return null;
        const resHeaders = Array.isArray(ev.resHeaders) ? ev.resHeaders : [];
        const len = Number((resHeaders.find((h) => /^content-length$/i.test(h.name)) || {}).value) || 0;
        Store.update(t, e, {
          status: Number(ev.status) || 0,
          statusText: String(ev.statusText || ""),
          resHeaders,
          resHeaderText: headerText(resHeaders),
          mime: String(ev.mime || ""),
          durationMs: Math.max(0, Number(ev.ttfbMs) || 0),
          size: len || e.size,
          finalUrl: ev.url && ev.url !== e.url ? String(ev.url) : undefined
        });
        broadcast(tabId, { type: "update", entry: e });
        return null;
      }
      case "http-body": {
        const e = findByHook(t, key);
        if (!e) return null;
        const patch = {
          resBody: typeof ev.text === "string" ? ev.text : "",
          resBodyTruncated: !!ev.truncated,
          resBodyBinary: !!ev.binary,
          resBodyPending: !ev.done,
          size: Math.max(Number(ev.size) || 0, e.size || 0)
        };
        if (ev.done) {
          patch.durationMs = Math.max(0, Number(ev.durationMs) || e.durationMs || 0);
          t.hooks.delete(key);
        }
        const finished = !!ev.done; // a request is offered to triggers once, when its body is complete
        if (ev.opaque) patch.note = "opaque (no-cors) response — the page cannot read it either";
        if (ev.failed) {
          patch.failed = true;
          patch.error = String(ev.error || "request failed");
        } else if (ev.error) patch.error = String(ev.error);
        Store.update(t, e, patch);
        broadcast(tabId, { type: "update", entry: e });
        if (finished) maybeTrigger(tabId, e);
        return null;
      }
      case "console": {
        // A batch of console messages / errors / route changes from one frame.
        const items = Array.isArray(ev.items) ? ev.items.slice(0, 60) : [];
        const frame = frameId === 0 ? "" : String(ev.frame || "").slice(0, 500);
        const added = [];
        for (const it of items) {
          if (!it || typeof it !== "object") continue;
          const level = ["log", "info", "warn", "error", "debug", "trace", "route"].includes(it.level) ? it.level : "log";
          const l = {
            level,
            kind: String(it.kind || "console").slice(0, 20),
            text: String(it.text == null ? "" : it.text).slice(0, 4000),
            source: String(it.source || "").slice(0, 600),
            ts: Number(it.ts) || Date.now()
          };
          if (it.stack) l.stack = String(it.stack).slice(0, 3000);
          if (frame) l.frame = frame;
          added.push(Store.addLog(t, l));
        }
        if (added.length) broadcast(tabId, { type: "logs", logs: added });
        return null;
      }
      case "ws-open":
      case "ws-close":
      case "ws-error":
      case "ws-frame": {
        let e;
        if (ev.type === "ws-open") e = { kind: "ws-open", wsId: key, url: String(ev.url || ""), startedAt: ev.ts || Date.now() };
        else if (ev.type === "ws-frame") {
          const text = typeof ev.text === "string" ? ev.text.slice(0, MAX_FRAME_BODY) : "";
          e = {
            kind: "ws-frame",
            wsId: key,
            url: String(ev.url || ""),
            dir: ev.dir === "sent" ? "sent" : "received",
            payload: text,
            payloadKind: ev.kind || "text",
            payloadTruncated: !!ev.truncated,
            size: text.length,
            startedAt: ev.ts || Date.now()
          };
        } else {
          e = {
            kind: "ws-close",
            wsId: key,
            url: String(ev.url || ""),
            startedAt: ev.ts || Date.now(),
            code: ev.type === "ws-error" ? -1 : typeof ev.code === "number" ? ev.code : 0,
            reason: ev.type === "ws-error" ? "socket error" : String(ev.reason || "")
          };
        }
        Store.add(t, e);
        broadcast(tabId, { type: "add", entry: e });
        return null;
      }
      default:
        return null;
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.__netscope__ !== 1 || !msg.event || !sender.tab || !Number.isInteger(sender.tab.id)) return;
  const p = handleEvent(sender.tab.id, sender.frameId || 0, msg.event);
  if (msg.event.type === "page") {
    p.then((r) => sendResponse(r || { ui: "hidden" })).catch(() => sendResponse({ ui: "hidden" }));
    return true;
  }
});

/* --------------------------------------------------------------- pacer */

// Every Kimi call — chat in any tab, AI steps in flows — asks here first, so
// one budget covers the whole account (see the pacer in ai-client.js).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.__netscopeAi !== "string") return;
  if (sender.id !== chrome.runtime.id || !String(sender.url || "").startsWith(chrome.runtime.getURL(""))) return;
  if (msg.__netscopeAi === "acquire") sendResponse(AI.tryAcquire(Math.max(0, Number(msg.tokens) || 0), String(msg.tier || "1")));
  else if (msg.__netscopeAi === "release") sendResponse(AI.release(msg.id, !!msg.refund) || true);
  else if (msg.__netscopeAi === "penalize") sendResponse(AI.penalize(Math.max(0, Number(msg.ms) || 0)) || true);
});

/* -------------------------------------------------------------- runner */

// Headers fetch() will not let any script set. They are reported back rather
// than silently vanishing, so the user knows why a replay differs.
const FORBIDDEN = /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|te|trailer|transfer-encoding|upgrade|via|user-agent)$|^(proxy-|sec-)/i;

function toHeaderList(h) {
  if (!h) return [];
  if (Array.isArray(h)) return h.filter((x) => x && x.name).map((x) => ({ name: String(x.name), value: String(x.value == null ? "" : x.value) }));
  return Object.keys(h).map((name) => ({ name, value: String(h[name] == null ? "" : h[name]) }));
}

/* ------------------------------------------------- send from the page */

// Runs inside the page (MAIN world) via chrome.scripting, so the request has
// the page's origin, its first-party cookies (SameSite included), and passes
// through the page's own fetch wrappers — which is where anti-bot / WAF
// scripts attach their headers. Must be self-contained: it is serialized.
async function pageFetch(req, timeoutMs, maxChars) {
  const out = { ok: false, status: 0, statusText: "", url: req.url, headers: [], mime: "", body: "", bodyTruncated: false, binary: false, size: 0 };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const headers = new Headers();
  for (const h of req.headers || []) {
    try {
      headers.append(h.name, h.value);
    } catch (_) {}
  }
  let body;
  if (req.body != null && req.body !== "" && !/^(GET|HEAD)$/i.test(req.method)) {
    if (typeof req.body === "string") body = req.body;
    else if (req.body && Array.isArray(req.body.form)) {
      body = new FormData();
      for (const f of req.body.form) body.append(f.name, f.value);
      headers.delete("content-type");
    } else {
      body = JSON.stringify(req.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }
  const init = { method: req.method, headers, body, credentials: "include", redirect: "follow", signal: ctl.signal };
  try {
    if (typeof window.__netscopeOwn === "function") window.__netscopeOwn(init, req.url, req.method);
  } catch (_) {}
  const t0 = performance.now();
  try {
    const res = await fetch(req.url, init);
    out.status = res.status;
    out.statusText = res.statusText || "";
    out.ok = res.ok;
    out.url = res.url || req.url;
    out.redirected = !!res.redirected;
    res.headers.forEach((value, name) => out.headers.push({ name, value }));
    out.mime = res.headers.get("content-type") || "";
    if (!out.mime || /json|text|xml|javascript|html|urlencoded|csv|svg|yaml|graphql|event-stream|ndjson/i.test(out.mime)) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.size += value.byteLength;
        text += dec.decode(value, { stream: true });
        if (text.length > maxChars) {
          text = text.slice(0, maxChars);
          out.bodyTruncated = true;
          reader.cancel().catch(() => {});
          break;
        }
      }
      out.body = text;
    } else {
      out.size = (await res.arrayBuffer()).byteLength;
      out.binary = true;
    }
  } catch (e) {
    out.error =
      e && e.name === "AbortError"
        ? `timed out after ${Math.round(timeoutMs / 1000)} s`
        : "network error from the page: " + String((e && e.message) || e).slice(0, 200) + " (requests from the page follow its CORS rules)";
  } finally {
    clearTimeout(timer);
  }
  out.ms = Math.round(performance.now() - t0);
  return out;
}

// "example.co.uk" from "api.example.co.uk": the last two labels, or three
// when the second-to-last is a short public suffix part (co.uk, com.au …).
// A heuristic, but one that never lumps unrelated *.co.uk sites together.
function siteOf(hostname) {
  const l = String(hostname || "").toLowerCase().split(".");
  if (l.length > 2 && l[l.length - 2].length <= 3 && l[l.length - 1].length === 2) return l.slice(-3).join(".");
  return l.slice(-2).join(".");
}

// The tab to send from: one on the request's own origin first, then one on
// the same site (api.example.com ↔ www.example.com). Never a tab on another
// site — its scripts would see the request, headers and body.
async function pickTab(url, preferTabId) {
  let origin = "";
  let site = "";
  try {
    const u = new URL(url);
    origin = u.origin;
    site = siteOf(u.hostname);
  } catch (_) {
    return null;
  }
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (_) {}
  const info = (t) => {
    try {
      const u = new URL(t.url || "");
      return /^https?:$/.test(u.protocol) ? u : null;
    } catch (_) {
      return null;
    }
  };
  const rank = (t) => {
    const u = info(t);
    if (!u) return 0;
    if (u.origin === origin) return t.id === preferTabId ? 4 : 3;
    if (siteOf(u.hostname) === site) return t.id === preferTabId ? 2.5 : 2;
    return 0;
  };
  let best = null;
  for (const t of tabs) if (rank(t) > 0 && (!best || rank(t) > rank(best))) best = t;
  return best;
}

async function runHttp(input, opts) {
  const o = opts || {};
  const req = {
    method: String(input.method || "GET").toUpperCase(),
    url: String(input.url || ""),
    headers: toHeaderList(input.headers),
    body: input.body
  };
  if (!/^https?:\/\//i.test(req.url)) return { ok: false, status: 0, error: "only http(s) URLs can be requested", request: req };

  const headers = new Headers();
  const dropped = [];
  for (const h of req.headers) {
    if (FORBIDDEN.test(h.name)) {
      dropped.push(h.name);
      continue;
    }
    try {
      headers.append(h.name, h.value);
    } catch (_) {
      dropped.push(h.name);
    }
  }

  let body;
  if (req.body != null && req.body !== "" && req.method !== "GET" && req.method !== "HEAD") {
    if (typeof req.body === "string") body = req.body;
    else if (req.body && Array.isArray(req.body.form)) {
      body = new FormData();
      for (const f of req.body.form) body.append(f.name, f.value);
      headers.delete("content-type"); // let fetch write the multipart boundary
    } else {
      body = JSON.stringify(req.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }

  const timeout = Math.min(Math.max(1000, Number(o.timeoutMs) || 30000), 120000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const t0 = Date.now();
  let res;
  const result = {
    ok: false,
    status: 0,
    statusText: "",
    url: req.url,
    ms: 0,
    mime: "",
    size: 0,
    headers: [],
    body: "",
    bodyTruncated: false,
    binary: false,
    droppedHeaders: dropped,
    request: { method: req.method, url: req.url, headers: req.headers, body: typeof body === "string" ? body : body ? "<form-data>" : "" }
  };

  let logTab = Number.isInteger(o.tabId) ? o.tabId : null;
  if (o.context === "page") {
    clearTimeout(timer);
    const tab = await pickTab(req.url, o.tabId);
    if (!tab) {
      result.error = `"send from the page" needs an open tab on ${new URL(req.url).origin} — open the site, or send from the extension instead`;
    } else {
      result.sentFrom = { tabId: tab.id, url: tab.url || "", title: tab.title || "" };
      if (logTab === null) logTab = tab.id;
      try {
        const [inj] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: pageFetch,
          args: [{ method: req.method, url: req.url, headers: req.headers.filter((h) => !FORBIDDEN.test(h.name)), body: req.body }, timeout, RESPONSE_MAX]
        });
        const r = (inj && inj.result) || { error: "the page returned no result" };
        Object.assign(result, r, { droppedHeaders: dropped, request: result.request });
      } catch (err) {
        result.error = "could not run in the page: " + String((err && err.message) || err).slice(0, 200);
      }
    }
    result.ms = result.ms || Date.now() - t0;
  } else try {
    res = await fetch(req.url, {
      method: req.method,
      headers,
      body,
      credentials: o.credentials === "omit" ? "omit" : "include",
      redirect: "follow",
      cache: "no-store",
      signal: ctl.signal
    });
    result.status = res.status;
    result.statusText = res.statusText || "";
    result.ok = res.ok;
    result.url = res.url || req.url;
    result.redirected = !!res.redirected;
    res.headers.forEach((value, name) => result.headers.push({ name, value }));
    result.mime = res.headers.get("content-type") || "";
    const texty = !result.mime || /json|text|xml|javascript|html|urlencoded|csv|svg|yaml|graphql|event-stream|ndjson/i.test(result.mime);
    if (texty) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let text = "";
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        text += dec.decode(value, { stream: true });
        if (text.length > RESPONSE_MAX) {
          text = text.slice(0, RESPONSE_MAX);
          result.bodyTruncated = true;
          reader.cancel().catch(() => {});
          break;
        }
      }
      if (!result.bodyTruncated) text += dec.decode();
      result.body = text;
      result.size = bytes;
    } else {
      const buf = await res.arrayBuffer();
      result.size = buf.byteLength;
      result.binary = true;
    }
  } catch (err) {
    result.error =
      err && err.name === "AbortError"
        ? `timed out after ${Math.round(timeout / 1000)} s`
        : "network error: " + String((err && err.message) || err).slice(0, 200);
  } finally {
    clearTimeout(timer);
  }
  if (o.context !== "page") result.ms = Date.now() - t0;

  // Show the request in that tab's Traffic list, tagged with who sent it.
  if (logTab !== null && o.log !== false) {
    try {
      const entry = await Store.withTab(logTab, (t) => {
        const e = Store.add(t, {
          kind: "http",
          source: o.source || "you",
          method: req.method,
          url: req.url,
          finalUrl: result.url !== req.url ? result.url : undefined,
          status: result.status,
          statusText: result.statusText,
          mime: result.mime,
          resourceType: "netscope",
          startedAt: t0,
          durationMs: result.ms,
          size: result.size,
          reqHeaders: req.headers,
          resHeaders: result.headers,
          reqHeaderText: headerText(req.headers),
          resHeaderText: headerText(result.headers),
          reqBody: result.request.body || "",
          reqBodyTruncated: false,
          resBody: result.body.slice(0, MAX_FRAME_BODY * 4),
          resBodyTruncated: result.bodyTruncated,
          resBodyBinary: result.binary,
          resBodyPending: false,
          failed: !!result.error,
          error: result.error || undefined,
          droppedHeaders: dropped.length ? dropped : undefined,
          sentFromPage: result.sentFrom ? result.sentFrom.url : undefined
        });
        broadcast(logTab, { type: "add", entry: e });
        return e;
      });
      result.entryId = entry.id;
    } catch (_) {}
  }
  return result;
}

/* --------------------------------------------------------------- flows */

const running = new Set();
const progressAt = new Map(); // flow id -> last progress broadcast

// An MV3 worker is stopped after ~30 s without extension API calls; a long
// flow (pagination, delays, loops) must not be cut off midway.
let keepAlive = 0;
function holdWorker(on) {
  if (on && !keepAlive) keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  if (!on && keepAlive && !running.size) {
    clearInterval(keepAlive);
    keepAlive = 0;
  }
}

/* ------------------------------------------------- page-request triggers */

let triggerFlows = null; // flows with on_request, cached until flows change
const lastTriggered = new Map(); // flow id -> ms

async function maybeTrigger(tabId, e) {
  if (e.source && e.source !== "page") return; // never react to our own requests
  if (!triggerFlows) {
    triggerFlows = (await Flows.list()).filter((f) => f.on_request && f.on_request.enabled);
  }
  if (!triggerFlows.length) return;
  for (const f of triggerFlows) {
    if (!Flows.matchesRequest(f.on_request, e)) continue;
    const now = Date.now();
    if (running.has(f.id) || now - (lastTriggered.get(f.id) || 0) < f.on_request.cooldown_seconds * 1000) continue;
    lastTriggered.set(f.id, now);
    const headers = {};
    for (const h of e.resHeaders || []) headers[String(h.name).toLowerCase()] = h.value;
    const reqHeaders = {};
    for (const h of e.reqHeaders || []) reqHeaders[String(h.name).toLowerCase()] = h.value;
    const parse = (t) => {
      try {
        return JSON.parse(t);
      } catch (_) {
        return t || "";
      }
    };
    const data = {
      entry_id: e.id,
      url: e.url,
      method: e.method,
      status: e.status,
      headers,
      body: parse(e.resBody),
      request_headers: reqHeaders,
      request_body: parse(e.reqBody),
      tab_id: tabId
    };
    runFlow(f.id, { trigger: "request", tabId, trigger_data: data }).catch(() => {});
  }
}

async function aiForFlows(prompt) {
  const s = await AI.loadSettings();
  if (!AI.isReady(s)) throw new Error("AI steps need an AI connected in NetScope settings (Kimi or Muse)");
  const turn = await AI.chat({
    stream: false,
    reasoning_effort: "low",
    messages: [
      {
        role: "system",
        content:
          "You are one step inside an automated API workflow. Do exactly what the instruction asks using only the data given. " +
          "Reply with the result only — no preamble. If asked for JSON, reply with raw JSON and nothing else."
      },
      { role: "user", content: prompt }
    ]
  });
  return turn.assistantMessage.content || "";
}

async function runFlow(id, opts) {
  const o = Object.assign({}, opts || {});
  if (running.has(id)) throw new Error("this flow is already running");
  // Runs that start by themselves continue a paused job instead of wiping it.
  if (!o.resume && (o.trigger === "schedule" || o.trigger === "request") && (await Flows.getCheckpointRaw(id))) o.resume = true;
  running.add(id);
  holdWorker(true);
  // Watchdog: alarms survive the worker being stopped. If Chrome kills this
  // worker mid-run, the next tick finds the run gone and resumes it.
  chrome.alarms.create("watch:" + id, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  const tabId = Number.isInteger(o.tabId) ? o.tabId : o.trigger_data && Number.isInteger(o.trigger_data.tab_id) ? o.trigger_data.tab_id : undefined;
  try {
    const run = await Flows.run(id, {
      trigger: o.trigger || "manual",
      trigger_data: o.trigger_data,
      vars: o.vars,
      resume: !!o.resume,
      http: (req, step) =>
        runHttp(req, { tabId, source: "flow", timeoutMs: step && step.timeout_ms, context: step && step.context === "page" ? "page" : "extension" }),
      ai: aiForFlows, // with Muse, each step is a fresh side chat, archived once answered
      onStep: (sr) => {
        if (Number.isInteger(tabId)) broadcast(tabId, { type: "flow-step", flowId: id, step: sr });
        // Every open Flows tab shows a running job's progress, not just the
        // tab that started it (background jobs, schedules, triggers).
        const now = Date.now();
        if (now - (progressAt.get(id) || 0) > 1000) {
          progressAt.set(id, now);
          broadcastAll({ type: "flow-progress", flowId: id });
        }
      }
    });
    // Out of budget with auto_resume on: carry on in ~30 s (Chrome's minimum
    // alarm delay), until done or MAX_CONTINUATIONS runs.
    if (run.paused) {
      const f = await Flows.get(id);
      const cp = await Flows.getCheckpoint(id);
      if (f && f.limits && f.limits.auto_resume && cp && (cp.continuations || 0) < Flows.MAX_CONTINUATIONS) {
        chrome.alarms.create("resume:" + id, { delayInMinutes: 0.5 });
      }
    }
    if (!run.ok && (run.trigger === "schedule" || run.trigger === "request" || run.trigger === "resume")) {
      await chrome.storage.local.set({
        [ALERT_KEY]: { flowId: id, flowName: run.flowName, at: run.startedAt, error: run.error, trigger: run.trigger, failure: run.failure || null }
      });
      chrome.action.setBadgeBackgroundColor({ color: "#D64545" }).catch(() => {});
      chrome.action.setBadgeText({ text: "!" }).catch(() => {});
    }
    return run;
  } finally {
    running.delete(id);
    holdWorker(false);
    chrome.alarms.clear("watch:" + id).catch(() => {});
    broadcastAll({ type: "flow-progress", flowId: id });
  }
}

// A checkpoint still marked active while no run is in this worker means the
// worker that ran it is gone. Mark it interrupted; continue it if allowed.
async function recoverInterrupted(id) {
  if (running.has(id)) return false;
  const raw = await Flows.getCheckpointRaw(id);
  if (!raw || !raw.active) return false;
  const cp = await Flows.markCheckpoint(id, { active: false, paused_reason: "interrupted" });
  const f = await Flows.get(id);
  if (f && f.limits && f.limits.auto_resume && (cp.continuations || 0) < Flows.MAX_CONTINUATIONS) {
    runFlow(id, { resume: true, trigger: "resume" }).catch(() => {});
    return true;
  }
  return false;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("watch:")) {
    const id = alarm.name.slice(6);
    if (!running.has(id)) {
      chrome.alarms.clear(alarm.name).catch(() => {});
      recoverInterrupted(id).catch(() => {});
    }
    return;
  }
  if (alarm.name.startsWith("resume:")) {
    const id = alarm.name.slice(7);
    Flows.getCheckpoint(id).then((cp) => cp && runFlow(id, { resume: true, trigger: "resume" }).catch(() => {}));
    return;
  }
  if (!alarm.name.startsWith("flow:")) return;
  const id = alarm.name.slice(5);
  Flows.get(id).then(async (f) => {
    if (!f || !f.schedule || !f.schedule.enabled) return Flows.syncAlarms();
    // A paused job is continued by its schedule rather than thrown away.
    return runFlow(id, { trigger: "schedule" }).catch(() => {});
  });
});

// A run in progress lives in this worker's memory. If a checkpoint still
// says "active" when the worker starts, the worker that ran it is gone:
// mark it interrupted, and pick it back up if the flow auto-resumes.
(async () => {
  try {
    for (const f of await Flows.list()) await recoverInterrupted(f.id);
  } catch (_) {}
})();

/* ------------------------------------------------- conversations & docs */

// Kept in the same IndexedDB key-value store as flow data: they outlive the
// browser session, never flood storage.onChanged, and export/import sees them.
const KV = Flows.KV;
const CHAT_INDEX = "netscope.chatIndex";
const DOC_INDEX = "netscope.docIndex";
const chatKey = (id) => "netscope.chat." + id;
const docKey = (id) => "netscope.doc." + id;
let indexQ = Promise.resolve();
const inIndexQueue = (fn) => {
  const p = indexQ.then(fn);
  indexQ = p.catch(() => {});
  return p;
};
const newDataId = (prefix) => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

async function readIndex(key) {
  const got = await KV.get(key);
  return Array.isArray(got[key]) ? got[key] : [];
}

function upsertIndex(key, entry) {
  return inIndexQueue(async () => {
    const list = (await readIndex(key)).filter((x) => x.id !== entry.id);
    list.push(entry);
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    await KV.set({ [key]: list });
  });
}

function dropFromIndex(key, id) {
  return inIndexQueue(async () => {
    const list = (await readIndex(key)).filter((x) => x.id !== id);
    await KV.set({ [key]: list });
  });
}

async function saveChat(c) {
  if (!c || !c.id) throw new Error("chat needs an id");
  const now = Date.now();
  const chat = Object.assign({}, c, { updatedAt: c.updatedAt || now, createdAt: c.createdAt || now });
  await KV.set({ [chatKey(chat.id)]: chat });
  const users = (chat.transcript || []).filter((x) => x.t === "user").length;
  await upsertIndex(CHAT_INDEX, {
    id: chat.id,
    title: chat.title || "New chat",
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    site: chat.page && chat.page.url ? (() => { try { return new URL(chat.page.url).host; } catch (_) { return ""; } })() : "",
    questions: users
  });
  return { id: chat.id, updatedAt: chat.updatedAt };
}

async function saveDoc(d, by) {
  const now = Date.now();
  const existing = d.id ? (await KV.get(docKey(d.id)))[docKey(d.id)] : null;
  const doc = Object.assign({}, existing || {}, d, {
    id: d.id || newDataId("doc_"),
    title: String(d.title || (existing && existing.title) || "Untitled").slice(0, 200),
    content: String(d.content != null ? d.content : (existing && existing.content) || ""),
    createdAt: (existing && existing.createdAt) || d.createdAt || now,
    updatedAt: d.updatedAt && !existing ? d.updatedAt : now,
    updatedBy: by || d.updatedBy || "you"
  });
  if (doc.content.length > 2000000) throw new Error("doc is over 2 MB — split it into several docs");
  await KV.set({ [docKey(doc.id)]: doc });
  await upsertIndex(DOC_INDEX, { id: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt, site: doc.site || "", size: doc.content.length, updatedBy: doc.updatedBy });
  broadcastAll({ type: "docs-changed", id: doc.id });
  return doc;
}

// One JSON file with everything a new browser needs. The API key is left
// out unless asked for.
async function exportData(opts) {
  const o = Object.assign({ chats: true, flows: true, flowData: true, docs: true, settings: true, apiKey: false }, opts || {});
  const out = { format: "netscope-backup", version: 1, exportedAt: new Date().toISOString(), counts: {} };
  if (o.chats) {
    const idx = await readIndex(CHAT_INDEX);
    const got = idx.length ? await KV.get(idx.map((x) => chatKey(x.id))) : {};
    out.chats = idx.map((x) => got[chatKey(x.id)]).filter(Boolean);
    out.counts.chats = out.chats.length;
  }
  if (o.flows) {
    out.flows = (await Flows.list()).map((f) => {
      const c = Object.assign({}, f);
      delete c.lastRun;
      return c;
    });
    out.counts.flows = out.flows.length;
    if (o.flowData) {
      out.flowData = {};
      for (const f of out.flows) {
        const memory = await Flows.getState(f.id);
        const collections = await Flows.getCollections(f.id);
        if (Object.keys(memory).length || Object.keys(collections).length) out.flowData[f.id] = { memory, collections };
      }
    }
  }
  if (o.docs) {
    const idx = await readIndex(DOC_INDEX);
    const got = idx.length ? await KV.get(idx.map((x) => docKey(x.id))) : {};
    out.docs = idx.map((x) => got[docKey(x.id)]).filter(Boolean);
    out.counts.docs = out.docs.length;
  }
  if (o.settings) {
    const s = Object.assign({}, await AI.loadSettings());
    if (!o.apiKey) delete s.apiKey;
    out.settings = s;
  }
  return out;
}

async function importData(data) {
  if (!data || data.format !== "netscope-backup") throw new Error("This is not a NetScope backup file.");
  const res = { chats: 0, flows: 0, docs: 0, settings: false, skipped: 0, errors: [] };
  for (const c of Array.isArray(data.chats) ? data.chats : []) {
    if (!c || !c.id) continue;
    const cur = (await KV.get(chatKey(c.id)))[chatKey(c.id)];
    if (cur && (cur.updatedAt || 0) >= (c.updatedAt || 0)) {
      res.skipped++;
      continue;
    }
    await saveChat(c);
    res.chats++;
  }
  for (const f of Array.isArray(data.flows) ? data.flows : []) {
    try {
      const saved = await Flows.save(f);
      res.flows++;
      const fd = data.flowData && data.flowData[f.id];
      if (fd) {
        if (fd.memory && Object.keys(fd.memory).length) await Flows.setState(saved.id, fd.memory);
        if (fd.collections && Object.keys(fd.collections).length) await Flows.setCollections(saved.id, fd.collections);
      }
    } catch (err) {
      res.errors.push(`flow “${(f && f.name) || "?"}”: ${String(err.message || err).slice(0, 200)}`);
    }
  }
  for (const d of Array.isArray(data.docs) ? data.docs : []) {
    if (!d || !d.id) continue;
    const cur = (await KV.get(docKey(d.id)))[docKey(d.id)];
    if (cur && (cur.updatedAt || 0) >= (d.updatedAt || 0)) {
      res.skipped++;
      continue;
    }
    await saveDoc(Object.assign({}, d), d.updatedBy);
    res.docs++;
  }
  if (data.settings && typeof data.settings === "object") {
    const patch = Object.assign({}, data.settings);
    if (!patch.apiKey) delete patch.apiKey; // never wipe the key already here
    await AI.saveSettings(patch);
    res.settings = true;
  }
  broadcastAll({ type: "chats-changed" });
  broadcastAll({ type: "docs-changed" });
  return res;
}

/* ----------------------------------------------------------------- rpc */

/* ------------------------------------------------------------ inspect */

// Runs the read-only page inspector (page-inspect.js) in the tab's main world.
async function inspectTab(tabId, op, args) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    throw new Error("That tab is gone.");
  }
  if (!/^(https?|file):/.test(tab.url || "")) {
    throw new Error("This page can't be inspected (" + String(tab.url || "").split(":")[0] + " page). Open NetScope on the website itself.");
  }
  if (op === "cookies") return cookiesFor(tab.url, args);
  const run = chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: globalThis.__netscopeInspector,
    args: [op, args || {}]
  });
  const res = await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error("the page did not answer within 20 s")), 20000))]);
  const out = res && res[0] && res[0].result;
  if (!out) throw new Error("the inspector returned nothing (the page may be navigating)");
  return out;
}

// Every cookie the browser would send to this page, HttpOnly ones included.
async function cookiesFor(url, args) {
  if (!chrome.cookies) return { error: "cookie access is not available" };
  const list = await chrome.cookies.getAll({ url });
  const max = Math.min(Number(args && args.value_chars) || 300, 4000);
  return {
    url,
    count: list.length,
    cookies: list
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({
        name: c.name,
        value: c.value.length > max ? c.value.slice(0, max) + "…" : c.value,
        chars: c.value.length,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        session: c.session,
        expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : undefined,
        partitioned: c.partitionKey ? true : undefined
      }))
  };
}

async function handleRpc(tabId, method, p) {
  switch (method) {
    case "inspect":
      return inspectTab(tabId, String(p.op || ""), p.args || {});
    case "sources.list":
      return globalThis.__netscopeSources.list(tabId, inspectTab, p);
    case "sources.search":
      return globalThis.__netscopeSources.search(tabId, inspectTab, p);
    case "sources.read":
      return globalThis.__netscopeSources.read(tabId, inspectTab, p);
    case "clear":
      return Store.withTab(tabId, async (t) => {
        await Store.clear(t);
        broadcast(tabId, { type: "clear", startedAt: t.startedAt });
        return true;
      });
    case "snapshot":
      return Store.withTab(tabId, (t) => ({ entries: t.entries, logs: t.logs, startedAt: t.startedAt }));
    case "logs.clear":
      return Store.withTab(tabId, async (t) => {
        await Store.clearLogs(t);
        broadcast(tabId, { type: "logs-clear" });
        return true;
      });
    case "setPreserve":
      prefs = Object.assign({}, prefs, { preserve: !!p.preserve });
      await chrome.storage.local.set({ [PREFS_KEY]: prefs });
      return prefs;
    case "http": {
      const req = p.curl ? globalThis.__netscopeCurl.parse(p.curl) : p.request || {};
      return runHttp(req, {
        tabId,
        source: p.source || "you",
        timeoutMs: p.timeoutMs,
        credentials: p.credentials,
        context: p.context === "page" ? "page" : "extension"
      });
    }
    case "flows.list":
      return Flows.list();
    case "flows.get":
      return Flows.get(p.id);
    case "flows.save":
      return Flows.save(p.flow);
    case "flows.delete":
      return Flows.remove(p.id);
    case "flows.runs":
      return Flows.runs(p.id);
    case "flows.state":
      return Flows.getState(p.id);
    case "flows.resetState":
      await Flows.setState(p.id, null);
      return true;
    case "flows.collections": {
      const all = await Flows.getCollections(p.id);
      const out = {};
      for (const name of Object.keys(all)) {
        const items = all[name] || [];
        const first = items.find((x) => x && typeof x === "object");
        out[name] = { count: items.length, fields: first ? Object.keys(first).slice(0, 30) : [], sample: items.slice(0, 3) };
      }
      return out;
    }
    case "flows.collection": {
      const items = (await Flows.getCollections(p.id))[p.name] || [];
      const offset = Math.max(0, Number(p.offset) || 0);
      const limit = p.limit === "all" ? items.length : Math.min(1000, Math.max(1, Number(p.limit) || 100));
      return { total: items.length, offset, items: items.slice(offset, offset + limit) };
    }
    case "flows.clearCollection": {
      const all = await Flows.getCollections(p.id);
      delete all[p.name];
      await Flows.setCollections(p.id, all);
      return true;
    }
    case "chats.list":
      return readIndex(CHAT_INDEX);
    case "chats.get":
      return (await KV.get(chatKey(p.id)))[chatKey(p.id)] || null;
    case "chats.save":
      return saveChat(p.chat);
    case "chats.delete":
      await KV.remove(chatKey(p.id));
      await dropFromIndex(CHAT_INDEX, p.id);
      broadcastAll({ type: "chats-changed" });
      return true;
    case "docs.list":
      return readIndex(DOC_INDEX);
    case "docs.get": {
      if (p.id) return (await KV.get(docKey(p.id)))[docKey(p.id)] || null;
      // by title, case-insensitive (Kimi often knows a doc by name)
      const hit = (await readIndex(DOC_INDEX)).find((x) => String(x.title).toLowerCase() === String(p.title || "").toLowerCase());
      return hit ? (await KV.get(docKey(hit.id)))[docKey(hit.id)] || null : null;
    }
    case "docs.save":
      return saveDoc(p.doc || {}, p.by);
    case "docs.delete":
      await KV.remove(docKey(p.id));
      await dropFromIndex(DOC_INDEX, p.id);
      broadcastAll({ type: "docs-changed", id: p.id, deleted: true });
      return true;
    case "data.export":
      return exportData(p.options);
    case "data.import":
      return importData(p.data);
    case "flows.validate":
      return (({ valid, errors, warnings }) => ({ valid, errors, warnings }))(Flows.check(p.flow));
    case "flows.start": {
      // Long jobs: start now, report through the flow card / get_flow.
      if (running.has(p.id)) throw new Error("this flow is already running");
      const cp = p.resume ? await Flows.getCheckpointRaw(p.id) : null;
      runFlow(p.id, { tabId, vars: p.vars, trigger: p.resume && cp ? "resume" : p.trigger || "manual", resume: !!(p.resume && cp) }).catch(() => {});
      return { started: true, resumed: !!(p.resume && cp) };
    }
    case "flows.checkpoint": {
      const cp = await Flows.getCheckpointRaw(p.id);
      if (!cp) return null;
      return {
        step: cp.stepId,
        next: cp.loop ? cp.loop.next : null,
        of: cp.loop ? cp.loop.itemsCount || (cp.loop.items ? cp.loop.items.length : null) : null,
        failure: cp.failure || null,
        running: running.has(p.id),
        kind: cp.loop ? cp.loop.kind : null,
        reason: cp.paused_reason || (cp.active ? "running" : ""),
        active: !!cp.active,
        continuations: cp.continuations || 0,
        jobStartedAt: cp.jobStartedAt,
        autoResumePending: !!(await chrome.alarms.get("resume:" + p.id))
      };
    }
    case "flows.resume":
      return runFlow(p.id, { tabId, resume: true, trigger: "resume" });
    case "flows.discard":
      await Flows.setCheckpoint(p.id, null);
      await chrome.alarms.clear("resume:" + p.id);
      return true;
    case "flows.run":
      return runFlow(p.id, { tabId, vars: p.vars, trigger: p.trigger || "manual" });
    case "flows.alert": {
      const got = await chrome.storage.local.get(ALERT_KEY);
      return got[ALERT_KEY] || null;
    }
    case "flows.clearAlert":
      await chrome.storage.local.remove(ALERT_KEY);
      chrome.action.setBadgeText({ text: "" }).catch(() => {});
      return true;
    default:
      throw new Error("unknown method " + method);
  }
}

/* -------------------------------------------------------------- toggle */

async function toggle(tab) {
  if (!tab || !Number.isInteger(tab.id)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { __netscope__: 1, cmd: "toggle" }, { frameId: 0 });
    return;
  } catch (_) {
    /* no content script yet: tab predates install, or a restricted page */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["net-hook.js"], world: "MAIN" });
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { __netscope__: 1, cmd: "mode", mode: "panel" }, { frameId: 0 });
  } catch (_) {
    // chrome://, the Web Store, PDFs …: open the standalone workspace instead.
    chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
  }
}

chrome.action.onClicked.addListener(toggle);

/* ----------------------------------------------------------- lifecycle */

chrome.tabs.onRemoved.addListener((tabId) => {
  Store.drop(tabId);
  globalThis.__netscopeSources.forget(tabId);
});

chrome.runtime.onStartup.addListener(() => {
  Store.wipe(); // tab ids restart every browser session
  Flows.syncAlarms().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  Flows.syncAlarms().catch(() => {});
});
