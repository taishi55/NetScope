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

  const HOOK_TYPES = new Set(["http-start", "http-res", "http-body", "ws-open", "ws-frame", "ws-close", "ws-error", "console"]);
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
    } else if (msg.cmd === "agent") {
      showAgent(msg);
      sendResponse({ ok: true });
    } else if (msg.cmd === "capture") {
      // Screenshots show the page, not NetScope's own popup or bar. The hosts'
      // :host / all:initial rules win over their inline styles, so hide what
      // is inside the shadow roots.
      for (const el of [box].concat(agent ? agent.parts : [])) if (el) el.style.setProperty("visibility", msg.hide ? "hidden" : "visible", "important");
      sendResponse({ ok: true });
    }
  });

  /* ------------------------------------------- "AI is using this tab" bar */

  // Shown while the AI clicks and types here: an amber edge, a bar with
  // Stop, and a ring where each click lands. Hides itself when idle.
  const AGENT_CSS = `
    .edge { position: fixed; inset: 0; border: 2px solid #f5a524; pointer-events: none; }
    .bar { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
      padding: 5px 5px 5px 12px; border-radius: 999px; background: #111827; color: #f9fafb; pointer-events: auto;
      font: 500 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
    .bar i { width: 7px; height: 7px; border-radius: 50%; background: #f5a524; }
    .bar button { all: unset; cursor: pointer; padding: 4px 12px; border-radius: 999px; background: #f5a524; color: #111827; font-weight: 650; }
    .bar button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .ring { position: fixed; width: 26px; height: 26px; margin: -13px 0 0 -13px; border: 2px solid #f5a524; border-radius: 50%;
      pointer-events: none; animation: ring .7s ease-out forwards; }
    @keyframes ring { from { transform: scale(.4); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .ring { animation: none; opacity: .9; } }
  `;
  let agent = null;
  let agentIdle = 0;

  function showAgent(msg) {
    if (!msg.on) return hideAgent();
    if (!agent || !agent.host.isConnected) {
      const h = document.createElement("netscope-agent");
      h.style.cssText = "all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483646 !important; pointer-events: none !important;";
      const shadow = h.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = AGENT_CSS;
      const edge = document.createElement("div");
      edge.className = "edge";
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.setAttribute("role", "status");
      const dot = document.createElement("i");
      const label = document.createElement("span");
      label.textContent = "NetScope AI is using this tab";
      const stop = document.createElement("button");
      stop.type = "button";
      stop.textContent = "Stop";
      stop.addEventListener("click", () => {
        send({ type: "agent-stop" });
        hideAgent();
      });
      bar.append(dot, label, stop);
      shadow.append(style, edge, bar);
      (document.documentElement || document).appendChild(h);
      agent = { host: h, shadow, parts: [edge, bar] };
    }
    if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
      const ring = document.createElement("div");
      ring.className = "ring";
      ring.style.left = msg.x + "px";
      ring.style.top = msg.y + "px";
      agent.shadow.appendChild(ring);
      setTimeout(() => ring.remove(), 900);
    }
    clearTimeout(agentIdle);
    agentIdle = setTimeout(hideAgent, 8000);
  }

  function hideAgent() {
    clearTimeout(agentIdle);
    if (agent && agent.host.isConnected) agent.host.remove();
    agent = null;
  }

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
