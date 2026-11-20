/* NetScope – bg-browser.js (service worker)
 * Lets the AI use the browser the way a person would: list, open, switch,
 * navigate and close tabs; read a tab as a numbered map of its controls;
 * click, type, press keys, pick options, hover, scroll, drag and fire any DOM
 * event (page-actor.js); and take screenshots so a vision model can see the
 * page. Also runs the SEO tab: Google results and page audits read from a
 * background tab in this browser (seo-extract.js).
 *
 * Limits that are deliberate:
 *  - http(s) pages only; never chrome://, the Web Store or other extensions.
 *  - close_tab only closes tabs the AI opened.
 *  - page-actor.js never types into password, card or one-time-code fields.
 *  - A robot check or consent page from Google is handed to the person,
 *    never answered.
 * Every tab the AI acts on shows a "NetScope AI is using this tab" bar with
 * a Stop button (content.js).
 */
"use strict";

globalThis.__netscopeBrowser = (() => {
  const KEY = "netscope.aiTabs";
  const aiTabs = new Set();
  const seoTabs = new Map(); // run id -> tab id
  const drivers = new Map(); // tab acted on -> tab whose popup is driving it
  const ready = chrome.storage.session
    .get(KEY)
    .then((g) => (g[KEY] || []).forEach((id) => aiTabs.add(id)))
    .catch(() => {});
  const persist = () => chrome.storage.session.set({ [KEY]: Array.from(aiTabs) }).catch(() => {});
  const own = (id) => {
    aiTabs.add(id);
    persist();
  };
  chrome.tabs.onRemoved.addListener((id) => {
    if (aiTabs.delete(id)) persist();
    drivers.delete(id);
    for (const [run, t] of seoTabs) if (t === id) seoTabs.delete(run);
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clip = (s, n) => (String(s || "").length > n ? String(s).slice(0, n - 1) + "…" : String(s || ""));

  function httpUrl(raw) {
    let u;
    try {
      u = new URL(String(raw || "").trim());
    } catch (_) {
      try {
        u = new URL("https://" + String(raw || "").trim());
      } catch (__) {
        throw new Error(`not a valid URL: ${clip(raw, 80)}`);
      }
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error("NetScope only opens http and https pages");
    return u.href;
  }

  async function getTab(hostTabId, tabId) {
    const id = Number.isInteger(tabId) ? tabId : hostTabId;
    const t = await chrome.tabs.get(id).catch(() => null);
    if (!t) throw new Error(`tab ${id} is closed — list_tabs shows the open ones`);
    return t;
  }

  function assertWeb(t) {
    if (!/^https?:/.test(t.url || t.pendingUrl || "")) throw new Error(`tab ${t.id} shows ${String(t.url || "a browser page").split(":")[0]}: — NetScope can only act on http and https pages`);
  }

  // Resolves once the tab finishes loading; "none" when nothing started.
  function waitLoad(tabId, opts) {
    const o = Object.assign({ startWithin: 1200, max: 30000 }, opts || {});
    return new Promise((resolve) => {
      let started = !!o.started;
      let done = false;
      const finish = (why) => {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(on);
        clearTimeout(t1);
        clearTimeout(t2);
        resolve(why);
      };
      const on = (id, info) => {
        if (id !== tabId) return;
        if (info.status === "loading") started = true;
        if (info.status === "complete" && started) finish("complete");
      };
      chrome.tabs.onUpdated.addListener(on);
      // Already loaded by the time we listen (a fast page, or a load that ended mid-action).
      if (started)
        chrome.tabs
          .get(tabId)
          .then((t) => {
            if (t.status === "complete" && !/^about:blank/.test(t.url || "")) finish("complete");
          })
          .catch(() => finish("closed"));
      const t1 = setTimeout(() => {
        if (!started) finish("none");
      }, o.startWithin);
      const t2 = setTimeout(() => finish("timeout"), o.max);
    });
  }

  async function run(tabId, frameId, func, args, timeoutMs) {
    const p = chrome.scripting.executeScript({ target: { tabId, frameIds: [Number.isInteger(frameId) ? frameId : 0] }, world: "ISOLATED", func, args: args || [] });
    const res = await Promise.race([
      p,
      sleep(timeoutMs || 25000).then(() => {
        throw new Error("the page did not answer in time — it may be busy, navigating, or showing an alert/confirm dialog that needs the person to click it");
      })
    ]);
    const r = res && res[0];
    return r ? r.result : undefined;
  }

  const tell = (tabId, msg) => chrome.tabs.sendMessage(tabId, Object.assign({ __netscope__: 1 }, msg), { frameId: 0 }).catch(() => {});

  /* --------------------------------------------------------------- tabs */

  async function listTabs(hostTabId) {
    await ready;
    const tabs = await chrome.tabs.query({});
    return {
      this_tab: hostTabId,
      tabs: tabs
        .filter((t) => !t.incognito)
        .map((t) => ({
          tab_id: t.id,
          window_id: t.windowId,
          active: t.active || undefined,
          title: clip(t.title, 100),
          url: clip(t.url || t.pendingUrl, 200),
          loading: t.status === "loading" || undefined,
          opened_by_ai: aiTabs.has(t.id) || undefined,
          this_page: t.id === hostTabId || undefined
        }))
    };
  }

  async function openTab(hostTabId, p) {
    const url = httpUrl(p.url);
    const host = await chrome.tabs.get(hostTabId).catch(() => null);
    const t = await chrome.tabs.create({ url, active: !!p.active, openerTabId: host ? host.id : undefined, index: host ? host.index + 1 : undefined, windowId: host ? host.windowId : undefined });
    own(t.id);
    const how = await waitLoad(t.id, { started: true, max: 30000 });
    const now = await chrome.tabs.get(t.id).catch(() => t);
    return { tab_id: t.id, url: now.url || url, title: now.title || "", loaded: how === "complete", note: p.active ? undefined : "Opened in the background; actions work there, and take_screenshot flips to it for a moment." };
  }

  async function switchTab(hostTabId, p) {
    const t = await getTab(hostTabId, p.tab_id);
    await chrome.tabs.update(t.id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
    return { tab_id: t.id, title: t.title, url: t.url };
  }

  async function closeTab(hostTabId, p) {
    await ready;
    const id = Number(p.tab_id);
    if (id === hostTabId) throw new Error("that is the page NetScope is open on; it stays open");
    if (!aiTabs.has(id)) throw new Error("NetScope only closes tabs it opened. Ask the person to close this one.");
    await chrome.tabs.remove(id);
    return { closed: id };
  }

  async function navigate(hostTabId, p) {
    const t = await getTab(hostTabId, p.tab_id);
    const action = String(p.action || (p.url ? "go" : ""));
    const wait = waitLoad(t.id, { startWithin: 2500, max: 30000 });
    if (action === "back") await chrome.tabs.goBack(t.id);
    else if (action === "forward") await chrome.tabs.goForward(t.id);
    else if (action === "reload") await chrome.tabs.reload(t.id);
    else if (action === "go") await chrome.tabs.update(t.id, { url: httpUrl(p.url) });
    else throw new Error("give a url, or action back, forward or reload");
    const how = await wait;
    const now = await chrome.tabs.get(t.id);
    return { tab_id: t.id, url: now.url, title: now.title, loaded: how === "complete", navigated: how !== "none" };
  }

  /* ------------------------------------------------------------ actions */

  const QUIET = new Set(["snapshot", "read", "state", "describe", "wait"]);

  async function act(hostTabId, p) {
    const t = await getTab(hostTabId, p.tab_id);
    assertWeb(t);
    const op = String(p.op || "");
    const frameId = Number.isInteger(p.frame_id) ? p.frame_id : 0;
    const quiet = QUIET.has(op);
    if (quiet) {
      const r = await run(t.id, frameId, globalThis.__netscopeActor, [op, p.args || {}], op === "wait" ? 25000 : 20000);
      return Object.assign({ tab_id: t.id }, r || { error: "the page returned nothing (it may be navigating)" });
    }

    const created = [];
    let started = false;
    const onCreated = (nt) => {
      if (nt.openerTabId === t.id) created.push(nt.id);
    };
    const onUpd = (id, info) => {
      if (id === t.id && info.status === "loading") started = true;
    };
    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onUpdated.addListener(onUpd);
    drivers.set(t.id, hostTabId);
    try {
      tell(t.id, { cmd: "agent", on: true });
      const r = await run(t.id, frameId, globalThis.__netscopeActor, [op, p.args || {}], 25000);
      if (!r) return { tab_id: t.id, error: "the page returned nothing (it may be navigating)" };
      if (r.error) return Object.assign({ tab_id: t.id }, r);
      if (r.point && frameId === 0) tell(t.id, { cmd: "agent", on: true, x: r.point.x, y: r.point.y });
      if (r.open_url) {
        const nt = await chrome.tabs.create({ url: httpUrl(r.open_url), active: false, openerTabId: t.id, index: t.index + 1, windowId: t.windowId });
        created.push(nt.id);
      }
      await sleep(500);
      if (started) await waitLoad(t.id, { started: true, max: 20000 });
      for (const id of created) own(id);
      const now = await chrome.tabs.get(t.id).catch(() => null);
      let state = null;
      if (now && /^https?:/.test(now.url || "")) state = await run(t.id, 0, globalThis.__netscopeActor, ["state", {}], 8000).catch(() => null);
      const out = Object.assign({ tab_id: t.id }, r);
      delete out.point;
      delete out.open_url;
      if (now && now.url !== t.url) out.navigated_to = now.url;
      if (created.length) out.new_tabs = created;
      if (state) {
        out.page = { title: state.title, focused: state.focused, dialogs: state.dialogs, messages: state.messages, invalid_fields: state.invalid_fields };
        if (started || (now && now.url !== t.url)) out.note = "The page changed: refs from the last snapshot no longer apply. Call page_snapshot.";
      }
      return out;
    } finally {
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.tabs.onUpdated.removeListener(onUpd);
    }
  }

  // The visible area of a tab as a JPEG data URL. A tab that is not in front
  // is brought forward for a moment, then the previous tab comes back.
  async function screenshot(hostTabId, p) {
    const t = await getTab(hostTabId, p.tab_id);
    assertWeb(t);
    const win = await chrome.windows.get(t.windowId);
    if (win.state === "minimized") throw new Error("that tab's window is minimized; ask the person to restore it, or use page_snapshot");
    let restore = null;
    if (!t.active) {
      const [cur] = await chrome.tabs.query({ active: true, windowId: t.windowId });
      restore = cur ? cur.id : null;
      await chrome.tabs.update(t.id, { active: true });
      await sleep(450);
    }
    await tell(t.id, { cmd: "capture", hide: true });
    await sleep(140);
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: "jpeg", quality: 82 });
    } finally {
      tell(t.id, { cmd: "capture", hide: false });
      if (restore != null) await chrome.tabs.update(restore, { active: true }).catch(() => {});
    }
    return { tab_id: t.id, url: t.url, title: t.title, data_url: dataUrl, flashed: restore != null || undefined };
  }

  /* ---------------------------------------------------------------- SEO */

  async function seoTab(hostTabId, runId) {
    const have = seoTabs.get(runId);
    if (have != null) {
      const t = await chrome.tabs.get(have).catch(() => null);
      if (t) return t;
    }
    const host = await chrome.tabs.get(hostTabId).catch(() => null);
    const t = await chrome.tabs.create({ url: "about:blank", active: false, openerTabId: host ? host.id : undefined, index: host ? host.index + 1 : undefined, windowId: host ? host.windowId : undefined });
    seoTabs.set(runId, t.id);
    own(t.id);
    return t;
  }

  async function load(tabId, url, settleMs) {
    const wait = waitLoad(tabId, { startWithin: 4000, max: 30000 });
    await chrome.tabs.update(tabId, { url });
    const how = await wait;
    await sleep(settleMs || 900);
    return how;
  }

  async function serp(hostTabId, p) {
    const q = String(p.query || "").trim();
    if (!q) throw new Error("give a search query");
    const base = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(p.base || "")) ? p.base : "https://www.google.com/search";
    const u = new URL(base);
    u.searchParams.set("q", q);
    if (p.hl) u.searchParams.set("hl", String(p.hl));
    if (p.gl) u.searchParams.set("gl", String(p.gl));
    u.searchParams.set("pws", "0");
    const t = await seoTab(hostTabId, String(p.run || "tool"));
    await load(t.id, u.href, 700);
    const r = await run(t.id, 0, globalThis.__netscopeSerp, [], 20000);
    return Object.assign({ tab_id: t.id }, r || { error: "Google's page returned nothing" });
  }

  async function audit(hostTabId, p) {
    const url = httpUrl(p.url);
    const t = await seoTab(hostTabId, String(p.run || "tool"));
    const how = await load(t.id, url, 1300);
    const r = await run(t.id, 0, globalThis.__netscopeSeoAudit, [String(p.query || "")], 20000);
    if (!r) return { url, error: how === "timeout" ? "the page did not finish loading in 30 s" : "the page returned nothing" };
    if (!p.keep_text) delete r.text;
    return r;
  }

  // Plain fetch without cookies, for robots.txt, sitemaps and page HTML.
  async function fetchText(p) {
    const url = httpUrl(p.url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { credentials: "omit", redirect: "follow", signal: ctl.signal, cache: "no-store" });
      const type = res.headers.get("content-type") || "";
      let text = "";
      if (/text|xml|html|json/.test(type) || !type) text = (await res.text()).slice(0, 3000000);
      return { url: res.url, status: res.status, type, text };
    } catch (err) {
      return { url, error: String((err && err.message) || err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function seoDone(p) {
    const id = seoTabs.get(String(p.run || ""));
    seoTabs.delete(String(p.run || ""));
    if (id != null) await chrome.tabs.remove(id).catch(() => {});
    return true;
  }

  async function seoShow(p) {
    const id = seoTabs.get(String(p.run || ""));
    if (id == null) throw new Error("the search tab is closed");
    const t = await chrome.tabs.update(id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
    return true;
  }

  /* ------------------------------------------------------------- router */

  function handle(hostTabId, method, p) {
    switch (method) {
      case "browser.tabs":
        return listTabs(hostTabId);
      case "browser.open":
        return openTab(hostTabId, p);
      case "browser.switch":
        return switchTab(hostTabId, p);
      case "browser.close":
        return closeTab(hostTabId, p);
      case "browser.navigate":
        return navigate(hostTabId, p);
      case "browser.act":
        return act(hostTabId, p);
      case "browser.screenshot":
        return screenshot(hostTabId, p);
      case "seo.serp":
        return serp(hostTabId, p);
      case "seo.audit":
        return audit(hostTabId, p);
      case "seo.fetch":
        return fetchText(p);
      case "seo.done":
        return seoDone(p);
      case "seo.show":
        return seoShow(p);
      default:
        return null;
    }
  }

  return { handle, isOwn: (id) => aiTabs.has(id), driverOf: (id) => drivers.get(id) };
})();
