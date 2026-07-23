/* NetScope – background.js (service worker)
 * Pure message router:
 *   content script (tab N)  ──sendMessage──▶  here  ──port──▶  DevTools inspecting tab N
 * Keeps a small per-tab backlog so frames fired just before the panel connects
 * are not lost (best effort – the worker may be suspended when idle).
 */
"use strict";

const ports = new Map(); // tabId -> Set<Port>
const backlog = new Map(); // tabId -> Array<event>
const BACKLOG_MAX = 400;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "netscope") return;
  let tabId = null;

  port.onMessage.addListener((msg) => {
    if (msg && msg.type === "init" && Number.isInteger(msg.tabId)) {
      tabId = msg.tabId;
      let set = ports.get(tabId);
      if (!set) ports.set(tabId, (set = new Set()));
      set.add(port);

      const buf = backlog.get(tabId);
      if (buf && buf.length) {
        for (const ev of buf) {
          try {
            port.postMessage(ev);
          } catch (_) {}
        }
        backlog.delete(tabId);
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (tabId === null) return;
    const set = ports.get(tabId);
    if (set) {
      set.delete(port);
      if (set.size === 0) ports.delete(tabId);
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.__netscope__ !== 1 || !sender.tab || !Number.isInteger(sender.tab.id)) return;
  const tabId = sender.tab.id;
  const ev = msg.event;

  const set = ports.get(tabId);
  if (set && set.size) {
    for (const p of set) {
      try {
        p.postMessage(ev);
      } catch (_) {}
    }
  } else {
    let buf = backlog.get(tabId);
    if (!buf) backlog.set(tabId, (buf = []));
    buf.push(ev);
    if (buf.length > BACKLOG_MAX) buf.splice(0, buf.length - BACKLOG_MAX);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  backlog.delete(tabId);
});
