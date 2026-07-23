/* NetScope – ws-bridge.js
 * Isolated-world content script. Receives events posted by ws-hook.js (MAIN world)
 * and forwards them to the background service worker, which routes them to the
 * DevTools panel inspecting this tab.
 */
(() => {
  "use strict";

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__netscope__ !== 1 || typeof d.type !== "string") return;
    try {
      chrome.runtime.sendMessage({ __netscope__: 1, event: d });
    } catch (_) {
      /* extension was reloaded – old content script can no longer talk to it */
    }
  });
})();
