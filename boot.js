/* NetScope – boot.js
 * Last script on app.html: every module is defined by now, so connect to the
 * background worker and hand the shared `api` to each view.
 */
"use strict";

(() => {
  const standalone = window.top === window;
  document.body.classList.toggle("standalone", standalone);
  if (standalone) applyMode("large");

  if (window.__netscopeInspectTools) window.__netscopeInspectTools.attach(api);
  if (window.__netscopeConsoleUi) window.__netscopeConsoleUi.attach(api);
  if (window.__netscopeAppUi) window.__netscopeAppUi.attach(api);
  if (window.__netscopeAi) window.__netscopeAi.attach(api);
  if (window.__netscopeFlowsUi) window.__netscopeFlowsUi.attach(api);
  if (window.__netscopeDocsUi) window.__netscopeDocsUi.attach(api);
  connect();

  // Ask the content script for the current popup mode (pill / panel / large).
  if (!standalone) {
    try {
      window.parent.postMessage({ __netscopeUi: 1, request: "hello" }, "*");
    } catch (_) {}
  }
  drawTraces();
})();
