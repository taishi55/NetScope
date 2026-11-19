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

importScripts("curl.js", "bg-store.js", "ai-client.js", "flow-engine.js");

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
  if (changes["netscope.flows"] || changes["netscope.flowRuns"] || changes[ALERT_KEY]) {
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
        port.postMessage({ type: "snapshot", entries: t.entries, startedAt: t.startedAt });
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
        if (!prefs.preserve && t.entries.length) {
          await Store.clear(t);
          broadcast(tabId, { type: "clear", startedAt: t.startedAt });
        }
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
        if (ev.opaque) patch.note = "opaque (no-cors) response — the page cannot read it either";
        if (ev.failed) {
          patch.failed = true;
          patch.error = String(ev.error || "request failed");
        } else if (ev.error) patch.error = String(ev.error);
        Store.update(t, e, patch);
        broadcast(tabId, { type: "update", entry: e });
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

/* -------------------------------------------------------------- runner */

// Headers fetch() will not let any script set. They are reported back rather
// than silently vanishing, so the user knows why a replay differs.
const FORBIDDEN = /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|te|trailer|transfer-encoding|upgrade|via|user-agent)$|^(proxy-|sec-)/i;

function toHeaderList(h) {
  if (!h) return [];
  if (Array.isArray(h)) return h.filter((x) => x && x.name).map((x) => ({ name: String(x.name), value: String(x.value == null ? "" : x.value) }));
  return Object.keys(h).map((name) => ({ name, value: String(h[name] == null ? "" : h[name]) }));
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

  try {
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
  result.ms = Date.now() - t0;

  // Show the request in that tab's Traffic list, tagged with who sent it.
  if (Number.isInteger(o.tabId) && o.log !== false) {
    try {
      const entry = await Store.withTab(o.tabId, (t) => {
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
          droppedHeaders: dropped.length ? dropped : undefined
        });
        broadcast(o.tabId, { type: "add", entry: e });
        return e;
      });
      result.entryId = entry.id;
    } catch (_) {}
  }
  return result;
}

/* --------------------------------------------------------------- flows */

const running = new Set();

async function aiForFlows(prompt) {
  const s = await AI.loadSettings();
  if (!AI.isReady(s)) throw new Error("AI steps need the Kimi API key set up in NetScope settings");
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
  const o = opts || {};
  if (running.has(id)) throw new Error("this flow is already running");
  running.add(id);
  try {
    const run = await Flows.run(id, {
      trigger: o.trigger || "manual",
      vars: o.vars,
      http: (req, step) => runHttp(req, { tabId: o.tabId, source: "flow", timeoutMs: step && step.timeout_ms }),
      ai: aiForFlows,
      onStep: (sr) => {
        if (Number.isInteger(o.tabId)) broadcast(o.tabId, { type: "flow-step", flowId: id, step: sr });
      }
    });
    if (!run.ok && run.trigger === "schedule") {
      await chrome.storage.local.set({ [ALERT_KEY]: { flowId: id, flowName: run.flowName, at: run.startedAt, error: run.error } });
      chrome.action.setBadgeBackgroundColor({ color: "#D64545" }).catch(() => {});
      chrome.action.setBadgeText({ text: "!" }).catch(() => {});
    }
    return run;
  } finally {
    running.delete(id);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith("flow:")) return;
  const id = alarm.name.slice(5);
  Flows.get(id).then((f) => {
    if (!f || !f.schedule || !f.schedule.enabled) return Flows.syncAlarms();
    return runFlow(id, { trigger: "schedule" }).catch(() => {});
  });
});

/* ----------------------------------------------------------------- rpc */

async function handleRpc(tabId, method, p) {
  switch (method) {
    case "clear":
      return Store.withTab(tabId, async (t) => {
        await Store.clear(t);
        broadcast(tabId, { type: "clear", startedAt: t.startedAt });
        return true;
      });
    case "snapshot":
      return Store.withTab(tabId, (t) => ({ entries: t.entries, startedAt: t.startedAt }));
    case "setPreserve":
      prefs = Object.assign({}, prefs, { preserve: !!p.preserve });
      await chrome.storage.local.set({ [PREFS_KEY]: prefs });
      return prefs;
    case "http": {
      const req = p.curl ? globalThis.__netscopeCurl.parse(p.curl) : p.request || {};
      return runHttp(req, { tabId, source: p.source || "you", timeoutMs: p.timeoutMs, credentials: p.credentials });
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
});

chrome.runtime.onStartup.addListener(() => {
  Store.wipe(); // tab ids restart every browser session
  Flows.syncAlarms().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  Flows.syncAlarms().catch(() => {});
});
