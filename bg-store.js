/* NetScope – bg-store.js
 * Per-tab capture log, owned by the background worker and mirrored to
 * IndexedDB so it survives both page reloads ("Keep logs") and the MV3
 * service worker being suspended mid-session.
 *
 *   entries  keyPath [tabId, id]   API traffic (fetch / XHR / WebSocket) with bodies
 *   logs     keyPath [tabId, id]   console messages, errors and route changes
 *   res      keyPath [tabId, id]   every request the tab made (documents, scripts,
 *                                  images, fonts, workers…): status and headers, no bodies
 *   tabs     keyPath tabId         { seq, logSeq, resSeq, startedAt, ui }
 *
 * Writes are batched: mutations mark a row dirty and one transaction per
 * ~400 ms flushes them. Tab ids are only unique within a browser session, so
 * the whole database is wiped on browser startup.
 */
"use strict";

globalThis.__netscopeStore = (() => {
  const DB_NAME = "netscope";
  const MAX_ENTRIES = 3000; // per tab
  const MAX_CHARS = 48 * 1024 * 1024; // body/payload chars per tab before evicting oldest
  const FLUSH_MS = 400;

  // Side logs that live next to the API entries, each its own ring buffer.
  const RINGS = {
    logs: { seq: "logSeq", max: 2000, maxChars: 6 * 1024 * 1024, weight: (l) => (l.text ? l.text.length : 0) + (l.stack ? l.stack.length : 0) + 120 },
    res: { seq: "resSeq", max: 4000, maxChars: 12 * 1024 * 1024, weight: (r) => (r.url ? r.url.length : 0) + (r.resHeaderText ? r.resHeaderText.length : 0) + (r.reqHeaderText ? r.reqHeaderText.length : 0) + 160 }
  };
  const RING_NAMES = Object.keys(RINGS);
  const STORES = ["entries", "tabs"].concat(RING_NAMES);

  let dbPromise = null;
  const tabs = new Map(); // tabId -> Tab

  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 3);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("entries")) d.createObjectStore("entries", { keyPath: ["tabId", "id"] });
        if (!d.objectStoreNames.contains("tabs")) d.createObjectStore("tabs", { keyPath: "tabId" });
        for (const name of RING_NAMES) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: ["tabId", "id"] });
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

  // t[name] is the array (t.logs, t.res); t.ring[name] holds its bookkeeping.
  const newRing = () => ({ chars: 0, dirty: new Set(), deleted: new Set() });

  async function load(tabId) {
    const t = {
      tabId,
      entries: [],
      seq: 0,
      startedAt: Date.now(),
      ui: "hidden",
      chars: 0,
      hooks: new Map(), // hook id -> entry
      dirty: new Set(),
      deleted: new Set(),
      metaDirty: false,
      timer: 0,
      gen: 0, // bumped by clear(); a flush that started before it must not resurrect rows
      ring: {}
    };
    for (const name of RING_NAMES) {
      t[name] = [];
      t[RINGS[name].seq] = 0;
      t.ring[name] = newRing();
    }
    try {
      const d = await db();
      const tx = d.transaction(STORES, "readonly");
      const meta = await reqP(tx.objectStore("tabs").get(tabId));
      const range = IDBKeyRange.bound([tabId, -Infinity], [tabId, Infinity]);
      const rows = await reqP(tx.objectStore("entries").getAll(range));
      for (const name of RING_NAMES) {
        const cfg = RINGS[name];
        const items = await reqP(tx.objectStore(name).getAll(range));
        items.sort((a, b) => a.id - b.id);
        for (const it of items) {
          t[name].push(it);
          t.ring[name].chars += cfg.weight(it);
          if (it.id > t[cfg.seq]) t[cfg.seq] = it.id;
        }
        if (meta) t[cfg.seq] = Math.max(t[cfg.seq], meta[cfg.seq] || 0);
      }
      if (meta) {
        t.seq = meta.seq || 0;
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

  const meta = (t) => {
    const m = { tabId: t.tabId, seq: t.seq, startedAt: t.startedAt, ui: t.ui };
    for (const name of RING_NAMES) m[RINGS[name].seq] = t[RINGS[name].seq];
    return m;
  };

  async function flush(t) {
    const ringBusy = RING_NAMES.some((n) => t.ring[n].dirty.size || t.ring[n].deleted.size);
    if (!t.dirty.size && !t.deleted.size && !t.metaDirty && !ringBusy) return;
    const dirty = Array.from(t.dirty);
    const deleted = Array.from(t.deleted);
    t.dirty.clear();
    t.deleted.clear();
    const ringWork = {};
    for (const n of RING_NAMES) {
      ringWork[n] = { dirty: Array.from(t.ring[n].dirty), deleted: Array.from(t.ring[n].deleted) };
      t.ring[n].dirty.clear();
      t.ring[n].deleted.clear();
    }
    const metaDirty = t.metaDirty;
    t.metaDirty = false;
    const gen = t.gen;
    try {
      const d = await db();
      if (gen !== t.gen) {
        // Cleared meanwhile: entries are gone, but side-log rows that survived the clear still need writing.
        for (const n of RING_NAMES) for (const it of ringWork[n].dirty) if (t[n].includes(it)) t.ring[n].dirty.add(it);
        if (RING_NAMES.some((n) => t.ring[n].dirty.size)) scheduleFlush(t);
        return;
      }
      const tx = d.transaction(STORES, "readwrite");
      const es = tx.objectStore("entries");
      for (const id of deleted) es.delete([t.tabId, id]);
      for (const e of dirty) es.put(Object.assign({ tabId: t.tabId }, e));
      let ringWrites = 0;
      for (const n of RING_NAMES) {
        const st = tx.objectStore(n);
        for (const id of ringWork[n].deleted) st.delete([t.tabId, id]);
        for (const it of ringWork[n].dirty) st.put(Object.assign({ tabId: t.tabId }, it));
        ringWrites += ringWork[n].dirty.length;
      }
      if (metaDirty || dirty.length || ringWrites) tx.objectStore("tabs").put(meta(t));
      await txDone(tx);
    } catch (_) {}
  }

  // Appends to a side log (console messages, page requests), evicting the oldest.
  function addTo(name, t, item) {
    const cfg = RINGS[name];
    const r = t.ring[name];
    item.id = ++t[cfg.seq];
    t[name].push(item);
    r.chars += cfg.weight(item);
    while (t[name].length > cfg.max || (r.chars > cfg.maxChars && t[name].length > 1)) {
      const old = t[name].shift();
      r.chars -= cfg.weight(old);
      r.dirty.delete(old);
      r.deleted.add(old.id);
    }
    r.dirty.add(item);
    scheduleFlush(t);
    return item;
  }

  // Updates a side-log row in place (a request that completed).
  function touchIn(name, t, item) {
    t.ring[name].dirty.add(item);
    scheduleFlush(t);
  }

  async function clearRing(name, t) {
    t[name] = [];
    t.ring[name] = newRing();
    try {
      const d = await db();
      const tx = d.transaction([name], "readwrite");
      tx.objectStore(name).delete(IDBKeyRange.bound([t.tabId, -Infinity], [t.tabId, Infinity]));
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

  // withSideLogs: a page reload clears the console and page requests too; the
  // Traffic Clear button only clears API entries.
  async function clear(t, withSideLogs) {
    t.gen++;
    if (withSideLogs) {
      for (const n of RING_NAMES) {
        t[n] = [];
        t.ring[n] = newRing();
      }
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
      if (withSideLogs) for (const n of RING_NAMES) tx.objectStore(n).delete(range);
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
      const range = IDBKeyRange.bound([tabId, -Infinity], [tabId, Infinity]);
      tx.objectStore("entries").delete(range);
      for (const n of RING_NAMES) tx.objectStore(n).delete(range);
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
      for (const n of STORES) tx.objectStore(n).clear();
      await txDone(tx);
    } catch (_) {}
  }

  return {
    withTab,
    add,
    update,
    clear,
    setUi,
    drop,
    wipe,
    flush,
    addLog: (t, l) => addTo("logs", t, l),
    clearLogs: (t) => clearRing("logs", t),
    addRes: (t, r) => addTo("res", t, r),
    touchRes: (t, r) => touchIn("res", t, r),
    clearRes: (t) => clearRing("res", t)
  };
})();
