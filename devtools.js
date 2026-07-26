/* NetScope – devtools.js
 * Lives for the whole DevTools session (even while the panel is hidden), so
 * capture starts the moment DevTools opens.
 *
 *   HTTP        chrome.devtools.network.onRequestFinished (+ getContent for bodies)
 *   Backfill    chrome.devtools.network.getHAR at startup
 *   WebSocket   port to background.js, fed by the MAIN-world hook in the page
 *
 * The panel gets a live `api` object through panel.onShown → panelWindow.__netscopeInit.
 */
"use strict";

const MAX_ENTRIES = 4000; // ring buffer size
const MAX_BODY = 1000000; // max chars kept per body

const state = {
  entries: [],
  seq: 0,
  startedAt: Date.now(),
  preserveLog: false,
  listeners: new Set()
};

function emit(type, entry) {
  for (const fn of state.listeners) {
    try {
      fn(type, entry);
    } catch (_) {}
  }
}

function pushEntry(e) {
  e.id = ++state.seq;
  state.entries.push(e);
  if (state.entries.length > MAX_ENTRIES) {
    state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  }
  emit("add", e);
}

function clearEntries() {
  state.entries.length = 0;
  emit("clear");
}

/* ---------------------------------------------------------------- HTTP */

function headerText(headers) {
  return (headers || []).map((h) => `${h.name}: ${h.value}`).join("\n");
}

function truncate(text) {
  if (typeof text !== "string") return { text: "", truncated: false };
  if (text.length > MAX_BODY) return { text: text.slice(0, MAX_BODY), truncated: true };
  return { text, truncated: false };
}

function harToEntry(req) {
  const r = req.request || {};
  const s = req.response || {};
  const post =
    r.postData && typeof r.postData.text === "string"
      ? truncate(r.postData.text)
      : { text: "", truncated: false };

  return {
    kind: "http",
    method: r.method || "GET",
    url: r.url || "",
    status: s.status || 0,
    statusText: s.statusText || "",
    mime: (s.content && s.content.mimeType) || "",
    resourceType: req._resourceType || "other",
    startedAt: req.startedDateTime ? Date.parse(req.startedDateTime) || Date.now() : Date.now(),
    durationMs: typeof req.time === "number" ? Math.max(0, req.time) : 0,
    size:
      (s.content && s.content.size) ||
      (typeof s.bodySize === "number" && s.bodySize > 0 ? s.bodySize : 0) ||
      0,
    reqHeaders: r.headers || [],
    resHeaders: s.headers || [],
    reqHeaderText: headerText(r.headers),
    resHeaderText: headerText(s.headers),
    reqBody: post.text,
    reqBodyTruncated: post.truncated,
    resBody: "",
    resBodyTruncated: false,
    resBodyBinary: false,
    resBodyPending: true,
    // Per-phase breakdown, so slow DNS can be told apart from slow TTFB.
    timings: req.timings || null,
    serverIP: req.serverIPAddress || "",
    fromCache: !!(req._fromCache || s.status === 304),
    httpVersion: s.httpVersion || ""
  };
}

function attachContent(entry, getContent) {
  if (typeof getContent !== "function") {
    entry.resBodyPending = false;
    return;
  }
  try {
    getContent((content, encoding) => {
      entry.resBodyPending = false;
      if (typeof content === "string" && content.length) {
        if (encoding === "base64") {
          const texty = /json|text|xml|javascript|html|urlencoded|csv|svg|yaml|ndjson|graphql/i.test(
            entry.mime || ""
          );
          if (texty) {
            try {
              const bin = atob(content);
              const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
              const t = truncate(new TextDecoder("utf-8").decode(bytes));
              entry.resBody = t.text;
              entry.resBodyTruncated = t.truncated;
            } catch (_) {
              entry.resBodyBinary = true;
            }
          } else {
            entry.resBodyBinary = true;
          }
        } else {
          const t = truncate(content);
          entry.resBody = t.text;
          entry.resBodyTruncated = t.truncated;
        }
      }
      emit("update", entry);
    });
  } catch (_) {
    entry.resBodyPending = false;
  }
}

chrome.devtools.network.onRequestFinished.addListener((req) => {
  const entry = harToEntry(req);
  pushEntry(entry);
  attachContent(entry, typeof req.getContent === "function" ? req.getContent.bind(req) : null);
});

// Backfill whatever the Network panel already recorded in this DevTools session.
chrome.devtools.network.getHAR((log) => {
  const list = (log && log.entries) || [];
  for (const req of list) {
    const entry = harToEntry(req);
    pushEntry(entry);
    attachContent(entry, typeof req.getContent === "function" ? req.getContent.bind(req) : null);
  }
});

chrome.devtools.network.onNavigated.addListener((url) => {
  if (!state.preserveLog) clearEntries();
  pushEntry({ kind: "nav", url: url || "", startedAt: Date.now() });
});

/* ----------------------------------------------------------- WebSocket */

const tabId = chrome.devtools.inspectedWindow.tabId;
let wsPort = null;

function onWsEvent(ev) {
  if (!ev || typeof ev !== "object") return;

  if (ev.type === "ws-open") {
    pushEntry({ kind: "ws-open", wsId: ev.id, url: ev.url || "", startedAt: ev.ts || Date.now() });
  } else if (ev.type === "ws-close") {
    pushEntry({
      kind: "ws-close",
      wsId: ev.id,
      url: ev.url || "",
      startedAt: ev.ts || Date.now(),
      code: typeof ev.code === "number" ? ev.code : 0,
      reason: ev.reason || ""
    });
  } else if (ev.type === "ws-error") {
    pushEntry({
      kind: "ws-close",
      wsId: ev.id,
      url: ev.url || "",
      startedAt: ev.ts || Date.now(),
      code: -1,
      reason: "socket error"
    });
  } else if (ev.type === "ws-frame") {
    pushEntry({
      kind: "ws-frame",
      wsId: ev.id,
      url: ev.url || "",
      dir: ev.dir === "sent" ? "sent" : "received",
      payload: typeof ev.text === "string" ? ev.text : "",
      payloadKind: ev.kind || "text",
      payloadTruncated: !!ev.truncated,
      size: typeof ev.text === "string" ? ev.text.length : 0,
      startedAt: ev.ts || Date.now()
    });
  }
}

function connectPort() {
  if (!(chrome.runtime && chrome.runtime.id)) return;
  try {
    wsPort = chrome.runtime.connect({ name: "netscope" });
  } catch (_) {
    return;
  }
  try {
    wsPort.postMessage({ type: "init", tabId });
  } catch (_) {}
  wsPort.onMessage.addListener(onWsEvent);
  wsPort.onDisconnect.addListener(() => {
    wsPort = null;
    setTimeout(connectPort, 800); // service worker may have been suspended
  });
}
connectPort();

/* --------------------------------------------------------------- Panel */

const api = {
  getEntries: () => state.entries,
  subscribe(fn) {
    state.listeners.add(fn);
    return () => state.listeners.delete(fn);
  },
  clear: clearEntries,
  setPreserveLog(v) {
    state.preserveLog = !!v;
  },
  getPreserveLog: () => state.preserveLog,
  getStartedAt: () => state.startedAt,
  themeName: (chrome.devtools.panels && chrome.devtools.panels.themeName) || "default",
  tabId
};

chrome.devtools.panels.create("NetScope", "icons/icon32.png", "panel.html", (panel) => {
  panel.onShown.addListener((win) => {
    if (!win) return;
    const tryInit = (attempts) => {
      if (typeof win.__netscopeInit === "function") {
        win.__netscopeInit(api);
      } else if (attempts > 0) {
        setTimeout(() => tryInit(attempts - 1), 50);
      }
    };
    tryInit(40);
  });
});
