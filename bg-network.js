/* NetScope – bg-network.js
 * Every request a tab makes — the page document, scripts, styles, images,
 * fonts, media, iframes, beacons, EventSource, Web Worker and Service Worker
 * requests — observed with chrome.webRequest (read-only: nothing is blocked
 * or changed). Status, headers, cache, IP, timing and errors; no bodies (the
 * page hook already captures fetch/XHR/WebSocket bodies).
 *
 * Recording is per tab and starts when NetScope is opened on that tab, so it
 * never logs the rest of the browser. Rows go to the tab's "res" ring in
 * bg-store.js. From the page document's response headers it also reports the
 * security headers and what they reveal about hosting and the backend.
 */
"use strict";

globalThis.__netscopeNet = (() => {
  const Store = globalThis.__netscopeStore;
  const ARMED_KEY = "netscope.armed";
  const MAX_HEADERS = 60;
  const OWN = "chrome-extension://" + chrome.runtime.id;

  const armed = new Map(); // tabId -> origin of the page (for worker requests without a tab)
  const live = new Map(); // requestId -> record being built

  const persist = () => chrome.storage.session.set({ [ARMED_KEY]: Object.fromEntries(armed) }).catch(() => {});

  function originOf(url) {
    try {
      return new URL(url).origin;
    } catch (_) {
      return "";
    }
  }

  function arm(tabId, url) {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const o = originOf(url || "");
    if (armed.has(tabId) && (armed.get(tabId) === o || !o)) return; // never forget a known origin
    armed.set(tabId, o);
    persist();
    listen(true);
  }
  function disarm(tabId) {
    if (armed.delete(tabId)) persist();
    if (!armed.size) listen(false);
  }
  const isArmed = (tabId) => armed.has(tabId);

  // Service Worker requests have no tab: give them to the armed tab of that origin.
  function tabFor(d) {
    if (d.tabId >= 0) return armed.has(d.tabId) ? d.tabId : -1;
    const o = d.initiator || originOf(d.documentUrl || "");
    for (const [id, origin] of armed) if (origin && origin === o) return id;
    return -1;
  }

  const headerList = (hs) =>
    (hs || []).slice(0, MAX_HEADERS).map((h) => ({ name: h.name, value: String(h.value != null ? h.value : h.binaryValue ? "<binary>" : "").slice(0, 1000) }));
  const headerText = (list) => list.map((h) => `${h.name}: ${h.value}`).join("\n");

  // Unfinished requests (long polls, streams cut off) must not pile up.
  function sweep() {
    if (live.size < 2000) return;
    const cutoff = Date.now() - 10 * 60000;
    for (const [id, x] of live) if (x.rec.startedAt < cutoff) live.delete(id);
  }

  function onBefore(d) {
    sweep();
    if (d.initiator && d.initiator.startsWith(OWN)) return; // NetScope's own requests are in Traffic already
    if (d.url.startsWith(OWN)) return;
    const tabId = tabFor(d);
    if (tabId < 0) return;
    live.set(d.requestId, {
      tabId,
      rec: {
        type: d.type,
        method: d.method,
        url: d.url,
        frame: d.frameId > 0 ? d.frameId : undefined,
        initiator: d.initiator || undefined,
        worker: d.tabId < 0 || undefined,
        startedAt: Math.round(d.timeStamp)
      }
    });
  }

  function onSend(d) {
    const x = live.get(d.requestId);
    if (!x) return;
    x.rec.reqHeaders = headerList(d.requestHeaders);
    x.rec.reqHeaderText = headerText(x.rec.reqHeaders);
  }

  function onHeaders(d) {
    const x = live.get(d.requestId);
    if (!x) return;
    x.rec.status = d.statusCode;
    x.rec.statusLine = d.statusLine;
    x.rec.resHeaders = headerList(d.responseHeaders);
    x.rec.resHeaderText = headerText(x.rec.resHeaders);
  }

  function finish(d, patch) {
    const x = live.get(d.requestId);
    if (!x) return;
    live.delete(d.requestId);
    const rec = Object.assign(x.rec, patch);
    rec.ms = Math.max(0, Math.round(d.timeStamp - rec.startedAt));
    rec.startedAt = Math.round(Date.now() - rec.ms); // wall clock, like the other logs
    const len = (rec.resHeaders || []).find((h) => /^content-length$/i.test(h.name));
    if (len) rec.size = Number(len.value) || undefined;
    const ct = (rec.resHeaders || []).find((h) => /^content-type$/i.test(h.name));
    if (ct) rec.mime = ct.value.split(";")[0].trim();
    Store.withTab(x.tabId, (t) => Store.addRes(t, rec)).catch(() => {});
  }

  // Listeners exist only while some tab is being recorded, so Chrome does not
  // wake this worker for every request in the browser.
  const filter = { urls: ["<all_urls>"] };
  const onRedirect = (d) => finish(d, { status: d.statusCode, redirectTo: d.redirectUrl, fromCache: d.fromCache || undefined, ip: d.ip });
  const onDone = (d) => finish(d, { status: d.statusCode, fromCache: d.fromCache || undefined, ip: d.ip });
  const onError = (d) => finish(d, { error: d.error });
  let listening = false;
  function listen(on) {
    const wr = chrome.webRequest;
    if (!wr || on === listening) return;
    listening = on;
    if (on) {
      wr.onBeforeRequest.addListener(onBefore, filter);
      // extraHeaders: without it Chrome hides Cookie and Set-Cookie from extensions.
      wr.onSendHeaders.addListener(onSend, filter, ["requestHeaders", "extraHeaders"]);
      wr.onHeadersReceived.addListener(onHeaders, filter, ["responseHeaders", "extraHeaders"]);
      wr.onBeforeRedirect.addListener(onRedirect, filter, ["responseHeaders"]);
      wr.onCompleted.addListener(onDone, filter, ["responseHeaders"]);
      wr.onErrorOccurred.addListener(onError, filter);
    } else {
      for (const [ev, fn] of [[wr.onBeforeRequest, onBefore], [wr.onSendHeaders, onSend], [wr.onHeadersReceived, onHeaders], [wr.onBeforeRedirect, onRedirect], [wr.onCompleted, onDone], [wr.onErrorOccurred, onError]]) ev.removeListener(fn);
      live.clear();
    }
  }

  // Tabs armed before the worker restarted keep recording.
  chrome.storage.session
    .get(ARMED_KEY)
    .then((got) => {
      for (const [id, origin] of Object.entries((got && got[ARMED_KEY]) || {})) armed.set(Number(id), origin);
      if (armed.size) listen(true);
    })
    .catch(() => {});

  /* ------------------------------------------------------------ queries */

  const hval = (rec, name) => {
    const h = (rec && rec.resHeaders ? rec.resHeaders : []).filter((x) => x.name.toLowerCase() === name);
    return h.length ? h.map((x) => x.value).join(", ") : undefined;
  };

  function list(t, a) {
    const o = a || {};
    const all = t.res || [];
    const byType = {};
    let failed = 0;
    for (const r of all) {
      const k = r.type || "other";
      byType[k] = byType[k] || { count: 0, kb: 0 };
      byType[k].count++;
      byType[k].kb += Math.round((r.size || 0) / 1024);
      if (r.error || r.status >= 400) failed++;
    }
    const want = o.contains ? String(o.contains).toLowerCase() : "";
    const rows = all.filter((r) => {
      if (o.type && o.type !== "all" && r.type !== o.type) return false;
      if (o.failed && !(r.error || r.status >= 400)) return false;
      if (o.status && String(r.status || 0)[0] !== String(o.status)[0]) return false;
      if (want && !r.url.toLowerCase().includes(want)) return false;
      if (o.host) {
        try {
          if (new URL(r.url).host !== o.host) return false;
        } catch (_) {
          return false;
        }
      }
      return true;
    });
    const off = Math.max(0, Number(o.offset) || 0);
    const lim = Math.min(Number(o.limit) || 80, 400);
    return {
      recording: isArmed(t.tabId),
      total: all.length,
      failed,
      by_type: byType,
      matched: rows.length,
      requests: rows.slice(off, off + lim).map((r) => ({
        id: r.id,
        t: Math.max(0, r.startedAt - t.startedAt),
        type: r.type,
        method: r.method,
        url: r.url.length > 300 ? r.url.slice(0, 300) + "…" : r.url,
        status: r.status,
        error: r.error,
        ms: r.ms,
        kb: r.size ? Math.round(r.size / 102.4) / 10 : undefined,
        mime: r.mime,
        cache: r.fromCache || undefined,
        redirect_to: r.redirectTo,
        frame: r.frame,
        worker: r.worker
      }))
    };
  }

  function get(t, id) {
    return (t.res || []).find((r) => r.id === Number(id)) || null;
  }

  // What the page document's headers say about security, hosting and backend.
  function security(t) {
    const docs = (t.res || []).filter((r) => r.type === "main_frame");
    const doc = docs[docs.length - 1];
    if (!doc) {
      return {
        recording: isArmed(t.tabId),
        note: isArmed(t.tabId) ? "No page document recorded yet: reload the page to capture its headers." : "Not recording this tab yet."
      };
    }
    const csp = hval(doc, "content-security-policy");
    const cspReport = hval(doc, "content-security-policy-report-only");
    const directives = {};
    for (const part of String(csp || "").split(";")) {
      const [k, ...v] = part.trim().split(/\s+/);
      if (k) directives[k.toLowerCase()] = v;
    }
    const issues = [];
    const has = (n) => hval(doc, n) !== undefined;
    if (!csp) issues.push("No Content-Security-Policy header (inline script injection is not restricted).");
    else {
      const scriptSrc = directives["script-src"] || directives["default-src"] || [];
      if (scriptSrc.includes("'unsafe-inline'") && !scriptSrc.some((s) => /^'(nonce|sha\d+)-/.test(s))) issues.push("CSP allows 'unsafe-inline' scripts.");
      if (scriptSrc.includes("'unsafe-eval'")) issues.push("CSP allows 'unsafe-eval'.");
      if (!directives["frame-ancestors"] && !has("x-frame-options")) issues.push("No frame-ancestors / X-Frame-Options: the page can be framed (clickjacking).");
    }
    if (/^https:/.test(doc.url) && !has("strict-transport-security")) issues.push("No Strict-Transport-Security header.");
    if (!has("x-content-type-options")) issues.push("No X-Content-Type-Options: nosniff.");
    if (!has("referrer-policy")) issues.push("No Referrer-Policy header (browser default applies).");
    const cookies = (doc.resHeaders || []).filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => {
      const v = h.value;
      return {
        name: v.split("=")[0],
        httpOnly: /;\s*httponly/i.test(v),
        secure: /;\s*secure/i.test(v),
        sameSite: (/;\s*samesite=(\w+)/i.exec(v) || [])[1] || "unset"
      };
    });
    // Hosting / backend fingerprints, per host: the page's own site first.
    const site = (u) => {
      try {
        return new URL(u).hostname.split(".").slice(-2).join(".");
      } catch (_) {
        return "";
      }
    };
    const ownSite = site(doc.url);
    const byHost = new Map();
    let hints = null;
    const stack = (r) => {
      let host = "";
      try {
        host = new URL(r.url).host;
      } catch (_) {
        return;
      }
      if (!byHost.has(host)) byHost.set(host, new Set());
      hints = byHost.get(host);
      const g = (n) => hval(r, n);
      if (g("server")) hints.add("Server: " + g("server"));
      if (g("x-powered-by")) hints.add("X-Powered-By: " + g("x-powered-by"));
      if (g("cf-ray")) hints.add("Cloudflare (cf-ray)");
      if (g("x-vercel-id") || g("x-vercel-cache")) hints.add("Vercel");
      if (g("x-nf-request-id")) hints.add("Netlify");
      if (g("x-amz-cf-id")) hints.add("AWS CloudFront");
      if (g("x-amzn-requestid") || g("x-amz-apigw-id")) hints.add("AWS API Gateway / Lambda");
      if (g("x-served-by") && /cache-/.test(g("x-served-by"))) hints.add("Fastly");
      if (g("x-cloud-trace-context") || /Google Frontend/i.test(g("server") || "")) hints.add("Google Cloud");
      if (g("x-azure-ref") || g("x-ms-request-id")) hints.add("Azure");
      if (g("fly-request-id")) hints.add("Fly.io");
      if (g("x-render-origin-server")) hints.add("Render");
      if (g("x-railway-request-id")) hints.add("Railway");
      if (g("x-firebase-hosting") || /firebase/i.test(g("server") || "")) hints.add("Firebase Hosting");
      if (g("x-github-request-id")) hints.add("GitHub Pages");
      if (g("x-shopify-stage") || g("x-shopid")) hints.add("Shopify");
      if (g("x-drupal-cache")) hints.add("Drupal");
      if (g("x-aspnet-version") || g("x-aspnetmvc-version")) hints.add("ASP.NET");
      if (g("x-runtime")) hints.add("Rails/Rack (x-runtime)");
      if (g("x-django-cache") || /csrftoken/.test(g("set-cookie") || "")) hints.add("Django (csrftoken cookie)");
      if (/laravel_session|XSRF-TOKEN/.test(g("set-cookie") || "")) hints.add("Laravel (session cookie)");
      if (/PHPSESSID/.test(g("set-cookie") || "")) hints.add("PHP (PHPSESSID)");
      if (/JSESSIONID/.test(g("set-cookie") || "")) hints.add("Java servlet (JSESSIONID)");
      if (/connect\.sid/.test(g("set-cookie") || "")) hints.add("Express (connect.sid)");
      if (g("x-nextjs-cache") || g("x-nextjs-prerender") || /Next\.js/.test(g("x-powered-by") || "")) hints.add("Next.js server");
      if (g("server-timing")) hints.add("Server-Timing: " + g("server-timing").slice(0, 200));
      if (g("x-cache")) hints.add("Cache: " + g("x-cache"));
    };
    for (const r of t.res || []) if (r.resHeaders) stack(r);
    // CORS: which API hosts allow which origins.
    const cors = {};
    for (const r of t.res || []) {
      const acao = hval(r, "access-control-allow-origin");
      if (!acao) continue;
      let host = "";
      try {
        host = new URL(r.url).host;
      } catch (_) {
        continue;
      }
      cors[host] = `${acao}${hval(r, "access-control-allow-credentials") === "true" ? " (credentials)" : ""}`;
    }
    const pick = ["strict-transport-security", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy", "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy", "cache-control", "vary"];
    const headers = {};
    for (const n of pick) if (has(n)) headers[n] = hval(doc, n);
    return {
      recording: isArmed(t.tabId),
      document: { url: doc.url, status: doc.status, protocol: doc.statusLine ? doc.statusLine.split(" ")[0] : undefined, ip: doc.ip },
      content_security_policy: csp ? directives : null,
      csp_report_only: cspReport || undefined,
      security_headers: headers,
      cookies_set_by_document: cookies,
      issues,
      hosting_and_backend: (() => {
        const first = {};
        const third = {};
        for (const [h, set] of byHost) {
          if (!set.size) continue;
          (site("https://" + h) === ownSite ? first : third)[h] = Array.from(set).slice(0, 8);
        }
        return { this_site: first, third_parties: Object.fromEntries(Object.entries(third).slice(0, 20)) };
      })(),
      cors_by_host: cors
    };
  }

  return { arm, disarm, isArmed, list, get, security };
})();
