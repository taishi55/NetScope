/* NetScope – content.js
 * Isolated-world content script, every frame.
 *
 * 1. Bridge: events posted by net-hook.js (MAIN world) are forwarded to the
 *    background worker, which keeps the per-tab log.
 * 2. Top frame only: hosts the NetScope popup — an extension-page <iframe>
 *    (app.html) inside a closed shadow root, toggled by the toolbar icon.
 *    The UI runs in the iframe, not here, so the page can neither read it nor
 *    keylog the API key field: the frame is cross-origin to the page.
 *
 * Modes:  hidden · pill (collapsed) · panel (default) · large
 */
(() => {
  "use strict";

  // Re-injection guard (chrome.scripting). A copy left behind by a previous
  // install of the extension can no longer reach chrome.runtime, so a fresh
  // copy takes over instead of bowing out to a dead one.
  const prev = window.__netscopeContent;
  if (prev && typeof prev.alive === "function" && prev.alive()) return;
  window.__netscopeContent = {
    alive: () => {
      try {
        return !!(chrome.runtime && chrome.runtime.id);
      } catch (_) {
        return false;
      }
    }
  };

  const HOOK_TYPES = new Set(["http-start", "http-res", "http-body", "ws-open", "ws-frame", "ws-close", "ws-error"]);
  const isTop = window.top === window;

  function send(event) {
    try {
      const p = chrome.runtime.sendMessage({ __netscope__: 1, event });
      if (p && typeof p.catch === "function") p.catch(() => {});
      return p;
    } catch (_) {
      return null; // extension reloaded — this script is orphaned
    }
  }

  /* -------------------------------------------------------------- bridge */

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__netscope__ !== 1 || !HOOK_TYPES.has(d.type)) return;
    send(d);
  });

  if (!isTop) return;

  /* ------------------------------------------------------------ UI host */

  const EXT_ORIGIN = new URL(chrome.runtime.getURL("/")).origin;
  let host = null;
  let box = null;
  let frame = null;
  let mode = "hidden";
  let frameReady = false;

  const CSS = `
    :host { all: initial !important; }
    .box {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      overflow: hidden; border-radius: 14px; background: transparent;
      box-shadow: 0 18px 50px rgba(9, 16, 28, .32), 0 2px 8px rgba(9, 16, 28, .18);
      transition: width .18s ease, height .18s ease, border-radius .18s ease;
      color-scheme: normal;
    }
    .box[data-mode="hidden"] { display: none; }
    .box[data-mode="pill"] { width: 232px; height: 46px; border-radius: 23px; }
    .box[data-mode="panel"] { width: min(460px, calc(100vw - 24px)); height: min(720px, calc(100vh - 32px)); }
    .box[data-mode="large"] { width: min(1120px, calc(100vw - 32px)); height: calc(100vh - 32px); }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
    @media (max-width: 520px) {
      .box { right: 8px; bottom: 8px; }
      .box[data-mode="panel"], .box[data-mode="large"] { width: calc(100vw - 16px); height: calc(100vh - 16px); }
    }
    @media (prefers-reduced-motion: reduce) { .box { transition: none; } }
  `;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement("netscope-root");
    host.style.cssText = "all: initial !important; position: fixed !important; z-index: 2147483647 !important;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    box = document.createElement("div");
    box.className = "box";
    box.dataset.mode = "hidden";
    frame = document.createElement("iframe");
    frame.title = "NetScope";
    frame.allow = "clipboard-write";
    frame.src = chrome.runtime.getURL("app.html");
    frameReady = false;
    frame.addEventListener("load", () => {
      frameReady = true;
      tellFrame();
    });
    box.appendChild(frame);
    shadow.append(style, box);
    (document.documentElement || document).appendChild(host);
  }

  function tellFrame() {
    if (!frame || !frameReady || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage({ __netscopeUi: 1, mode }, EXT_ORIGIN);
    } catch (_) {}
  }

  function setMode(next, opts) {
    if (!["hidden", "pill", "panel", "large"].includes(next)) return;
    if (next !== "hidden") ensureHost();
    if (!box) return;
    mode = next;
    box.dataset.mode = next;
    tellFrame();
    if (!opts || opts.remember !== false) send({ type: "ui", mode: next });
    if ((next === "panel" || next === "large") && frame) {
      try {
        frame.focus();
      } catch (_) {}
    }
  }

  // Mode requests from the app iframe. Only the frame we created can send
  // these, and the worst a spoof could do is resize the popup.
  window.addEventListener("message", (ev) => {
    if (!frame || ev.source !== frame.contentWindow || ev.origin !== EXT_ORIGIN) return;
    const d = ev.data;
    if (!d || d.__netscopeUi !== 1) return;
    if (d.request === "mode") setMode(d.mode);
    else if (d.request === "hello") tellFrame();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.__netscope__ !== 1) return;
    if (msg.cmd === "toggle") {
      setMode(mode === "hidden" ? "panel" : "hidden");
      sendResponse({ mode });
    } else if (msg.cmd === "mode") {
      setMode(msg.mode);
      sendResponse({ mode });
    } else if (msg.cmd === "ping") {
      sendResponse({ ok: true, mode });
    }
  });

  // A new document in this tab. The background clears the log unless
  // "Keep logs on reload" is on, and says whether the popup was open so a
  // refresh does not close it.
  const announce = () => {
    const p = send({ type: "page", url: location.href, title: document.title || "", ts: Date.now() });
    if (p && typeof p.then === "function") {
      p.then((resp) => {
        if (resp && resp.ui && resp.ui !== "hidden") {
          const restore = () => setMode(resp.ui, { remember: false });
          if (document.documentElement) restore();
          else document.addEventListener("DOMContentLoaded", restore, { once: true });
        }
      }).catch(() => {});
    }
  };
  announce();

  // Back/forward cache restores do not re-run content scripts.
  window.addEventListener("pageshow", (ev) => {
    if (ev.persisted) announce();
  });
})();
