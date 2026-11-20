/* NetScope – bg-store.js
 * Per-tab capture log, owned by the background worker and mirrored to
 * IndexedDB so it survives both page reloads ("Keep logs on reload") and the
 * MV3 service worker being suspended mid-session.
 *
 *   entries  keyPath [tabId, id]   one row per captured entry
 *   logs     keyPath [tabId, id]   console messages, errors and route changes
 *   tabs     keyPath tabId         { seq, logSeq, startedAt, ui }
 *
 * Writes are batched: mutations mark an entry dirty and one transaction per
 * ~400 ms flushes them. Tab ids are only unique within a browser session, so
 * the whole database is wiped on browser startup.
 */
"use strict";

globalThis.__netscopeStore = (() => {
  const DB_NAME = "netscope";
  const MAX_ENTRIES = 3000; // per tab
  const MAX_CHARS = 48 * 1024 * 1024; // body/payload chars per tab before evicting oldest
  const FLUSH_MS = 400;
  const MAX_LOGS = 2000; // console messages per tab
  const MAX_LOG_CHARS = 6 * 1024 * 1024;

  let dbPromise = null;
  const tabs = new Map(); // tabId -> Tab

  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("entries")) d.createObjectStore("entries", { keyPath: ["tabId", "id"] });
        if (!d.objectStoreNames.contains("tabs")) d.createObjectStore("tabs", { keyPath: "tabId" });
        if (!d.objectStoreNames.contains("logs")) d.createObjectStore("logs", { keyPath: ["tabId", "id"] });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
    return dbPromise;
  }

  const reqP = (r) =>
    new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });

  const txDone = (tx) =>
    new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

  function weight(e) {
    return (
      (e.resBody ? e.resBody.length : 0) +
      (e.reqBody ? e.reqBody.length : 0) +
      (e.payload ? e.payload.length : 0) +
      (e.reqHeaderText ? e.reqHeaderText.length : 0) +
      (e.resHeaderText ? e.resHeaderText.length : 0) +
      200
    );
  }

  const logWeight = (l) => (l.text ? l.text.length : 0) + (l.stack ? l.stack.length : 0) + 120;
  const STORES = ["entries", "logs", "tabs"];

  async function load(tabId) {
    const t = {
      tabId,
      entries: [],
      logs: [],
      logSeq: 0,
      logChars: 0,
      logsDirty: new Set(),
      logsDeleted: new Set(),
      seq: 0,
      startedAt: Date.now(),
      ui: "hidden",
      chars: 0,
      hooks: new Map(), // hook id -> entry
      dirty: new Set(),
      deleted: new Set(),
      metaDirty: false,
      timer: 0,
      gen: 0 // bumped by clear(); a flush that started before it must not resurrect rows
    };
    try {
      const d = await db();
      const tx = d.transaction(STORES, "readonly");
      const meta = await reqP(tx.objectStore("tabs").get(tabId));
      const range = IDBKeyRange.bound([tabId, -Infinity], [tabId, Infinity]);
      const rows = await reqP(tx.objectStore("entries").getAll(range));
      const logRows = await reqP(tx.objectStore("logs").getAll(range));
      logRows.sort((a, b) => a.id - b.id);
      for (const l of logRows) {
        t.logs.push(l);
        t.logChars += logWeight(l);
        if (l.id > t.logSeq) t.logSeq = l.id;
      }
      if (meta) {
        t.seq = meta.seq || 0;
        t.logSeq = Math.max(t.logSeq, meta.logSeq || 0);
        t.startedAt = meta.startedAt || t.startedAt;
        t.ui = meta.ui || "hidden";
      }
      rows.sort((a, b) => a.id - b.id);
      for (const e of rows) {
        t.entries.push(e);
        t.chars += weight(e);
        if (e.hookId && e.resBodyPending) t.hooks.set(e.hookId, e);
        if (e.id > t.seq) t.seq = e.id;
      }
    } catch (_) {
      /* IndexedDB unavailable — run memory-only */
    }
    return t;
  }

  // Serializes all work on one tab, so a burst of events cannot interleave
  // with the initial load or with a clear.
  const queues = new Map(); // tabId -> Promise
  const loading = new Map(); // tabId -> Promise<Tab>

  function getTab(tabId) {
    if (tabs.has(tabId)) return Promise.resolve(tabs.get(tabId));
    if (!loading.has(tabId)) {
      loading.set(
        tabId,
        load(tabId).then((t) => {
          tabs.set(tabId, t);
          loading.delete(tabId);
          return t;
        })
      );
    }
    return loading.get(tabId);
  }

  function withTab(tabId, fn) {
    const prev = queues.get(tabId) || Promise.resolve();
    const run = prev.then(() => getTab(tabId)).then(fn);
    queues.set(tabId, run.catch(() => {}));
    return run;
  }

  function scheduleFlush(t) {
    if (t.timer) return;
    t.timer = setTimeout(() => {
      t.timer = 0;
      flush(t).catch(() => {});
    }, FLUSH_MS);
  }

  async function flush(t) {
    if (!t.dirty.size && !t.deleted.size && !t.metaDirty && !t.logsDirty.size && !t.logsDeleted.size) return;
    const dirty = Array.from(t.dirty);
    const deleted = Array.from(t.deleted);
    const logsDirty = Array.from(t.logsDirty);
    const logsDeleted = Array.from(t.logsDeleted);
    t.dirty.clear();
    t.deleted.clear();
    t.logsDirty.clear();
    t.logsDeleted.clear();
    const metaDirty = t.metaDirty;
    t.metaDirty = false;
    const gen = t.gen;
    try {
      const d = await db();
      if (gen !== t.gen) {
        // Cleared meanwhile: entries are gone, but console messages may survive a Traffic clear.
        for (const l of logsDirty) if (t.logs.includes(l)) t.logsDirty.add(l);
        if (t.logsDirty.size) scheduleFlush(t);
        return;
      }
      const tx = d.transaction(STORES, "readwrite");
      const es = tx.objectStore("entries");
      for (const id of deleted) es.delete([t.tabId, id]);
      for (const e of dirty) es.put(Object.assign({ tabId: t.tabId }, e));
      const ls = tx.objectStore("logs");
      for (const id of logsDeleted) ls.delete([t.tabId, id]);
      for (const l of logsDirty) ls.put(Object.assign({ tabId: t.tabId }, l));
      if (metaDirty || dirty.length || logsDirty.length) {
        tx.objectStore("tabs").put(meta(t));
      }
      await txDone(tx);
    } catch (_) {}
  }

  const meta = (t) => ({ tabId: t.tabId, seq: t.seq, logSeq: t.logSeq, startedAt: t.startedAt, ui: t.ui });

  // Console messages, errors and route changes: their own ring, so the
  // network list and its tools never see them.
  function addLog(t, l) {
    l.id = ++t.logSeq;
    t.logs.push(l);
    t.logChars += logWeight(l);
    while (t.logs.length > MAX_LOGS || (t.logChars > MAX_LOG_CHARS && t.logs.length > 1)) {
      const old = t.logs.shift();
      t.logChars -= logWeight(old);
      t.logsDirty.delete(old);
      t.logsDeleted.add(old.id);
    }
    t.logsDirty.add(l);
    scheduleFlush(t);
    return l;
  }

  async function clearLogs(t) {
    t.logs = [];
    t.logChars = 0;
    t.logsDirty.clear();
    t.logsDeleted.clear();
    try {
      const d = await db();
      const tx = d.transaction(["logs"], "readwrite");
      tx.objectStore("logs").delete(IDBKeyRange.bound([t.tabId, -Infinity], [t.tabId, Infinity]));
      await txDone(tx);
    } catch (_) {}
  }

  function touch(t, e) {
    t.dirty.add(e);
    scheduleFlush(t);
  }

  function add(t, e) {
    e.id = ++t.seq;
    t.entries.push(e);
    t.chars += weight(e);
    while (t.entries.length > MAX_ENTRIES || (t.chars > MAX_CHARS && t.entries.length > 1)) {
      const old = t.entries.shift();
      t.chars -= weight(old);
      t.dirty.delete(old);
      t.deleted.add(old.id);
      if (old.hookId) t.hooks.delete(old.hookId);
    }
    touch(t, e);
    return e;
  }

  function update(t, e, patch) {
    const before = weight(e);
    Object.assign(e, patch);
    t.chars += weight(e) - before;
    touch(t, e);
    return e;
  }

  // withLogs: a page reload clears the console too; the Traffic Clear button doesn't.
  async function clear(t, withLogs) {
    t.gen++;
    if (withLogs) {
      t.logs = [];
      t.logChars = 0;
      t.logsDirty.clear();
      t.logsDeleted.clear();
    }
    t.entries = [];
    t.chars = 0;
    t.hooks.clear();
    t.dirty.clear();
    t.deleted.clear(); // the range delete below covers them
    t.startedAt = Date.now();
    t.metaDirty = true;
    try {
      const d = await db();
      const tx = d.transaction(STORES, "readwrite");
      const range = IDBKeyRange.bound([t.tabId, -Infinity], [t.tabId, Infinity]);
      tx.objectStore("entries").delete(range);
      if (withLogs) tx.objectStore("logs").delete(range);
      tx.objectStore("tabs").put(meta(t));
      await txDone(tx);
      t.metaDirty = false;
    } catch (_) {}
  }

  function setUi(t, ui) {
    t.ui = ui;
    t.metaDirty = true;
    scheduleFlush(t);
  }

  async function drop(tabId) {
    const t = tabs.get(tabId);
    if (t) {
      if (t.timer) clearTimeout(t.timer);
      t.gen++;
    }
    tabs.delete(tabId);
    queues.delete(tabId);
    try {
      const d = await db();
      const tx = d.transaction(STORES, "readwrite");
      tx.objectStore("entries").delete(IDBKeyRange.bound([tabId, -Infinity], [tabId, Infinity]));
      tx.objectStore("logs").delete(IDBKeyRange.bound([tabId, -Infinity], [tabId, Infinity]));
      tx.objectStore("tabs").delete(tabId);
      await txDone(tx);
    } catch (_) {}
  }

  async function wipe() {
    for (const t of tabs.values()) t.gen++;
    tabs.clear();
    queues.clear();
    try {
      const d = await db();
      const tx = d.transaction(STORES, "readwrite");
      tx.objectStore("entries").clear();
      tx.objectStore("logs").clear();
      tx.objectStore("tabs").clear();
      await txDone(tx);
    } catch (_) {}
  }

  return { withTab, add, update, clear, setUi, drop, wipe, flush, addLog, clearLogs };
})();
