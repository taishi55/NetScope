/* NetScope – flow-engine.js
 * Flows: saved API automations — from "call A, then B with a field from A"
 * up to small bots that page through results, filter them, loop over the
 * matches, branch, remember what they saw last time, and react to the page.
 * Runs in the background worker so schedules and triggers fire with the
 * popup closed.
 *
 * A flow:
 *   { id, name, description, vars: {…},
 *     schedule:   { enabled, every_minutes },
 *     on_request: { enabled, url_contains, method, status, cooldown_seconds },
 *     steps: [ …step… ] }
 *
 * Steps (every step: id, optional name, when, continue_on_error):
 *   http      method, url, headers, body, query | curl;  extract, expect_status,
 *             retry: { times, delay_ms }, timeout_ms
 *   ai        prompt; json: true asks for JSON back;  extract
 *   delay     ms
 *   set       vars: { name: value }, state: { name: value }   (state persists between runs)
 *   filter    items, where, as ("item"), limit, save_as (default: the step id)
 *   map       items, value, as, save_as
 *   for_each  items, as ("item"), steps: […], max (100), delay_ms, on_item_error
 *             ("stop" | "continue"), collect: { save_as, value }
 *   repeat    steps: […], until | while, max (10), delay_ms        (pagination, polling)
 *   if        condition, then: […], else: […]
 *   stop      outcome ("ok" | "fail"), message
 *   log       message
 *   run_flow  flow (id), vars
 *
 * Templates: {{vars.x}}, {{state.x}}, {{steps.<id>.status|body.<path>|headers.<name>|text}},
 * {{item.x}} (or the loop's `as` name), {{loop.index|number|count|first|last}},
 * {{trigger.url|method|status|body.<path>|headers.<name>}}, {{now}}, {{now_iso}},
 * {{today}}, {{uuid}}; filters after |, e.g. {{steps.list.body.items | where:status=paid | pluck:id | join:", "}}
 * (quote an argument to keep its spaces).
 * A JSON value that is exactly one template keeps its type.
 * Conditions: A == B, !=, >, <, >=, <=, contains, !contains, matches, exists,
 * missing, combined with and / or, negated with a leading not.
 */
"use strict";

globalThis.__netscopeFlows = (() => {
  const FLOWS_KEY = "netscope.flows";
  const RUNS_KEY = "netscope.flowRuns";
  const STATE_KEY = "netscope.flowState";
  const MAX_RUNS = 15;
  const MAX_DEF_STEPS = 80; // steps in a definition, nested ones included
  const MAX_DEPTH = 4; // nesting of for_each / repeat / if
  // Per-run budgets. Flows can raise them (limits.max_steps / max_minutes)
  // up to the caps; past that, a run pauses at a checkpoint and resumes.
  const MAX_EXEC = 5000; // default step executions per run, loops included
  const MAX_EXEC_CAP = 100000;
  const RUN_TIME_LIMIT = 600000; // default ms per run
  const RUN_TIME_CAP = 3600000;
  const MAX_CONCURRENCY = 10;
  const MAX_COLLECTION = 100000; // items per persistent collection
  const CHECKPOINT_EVERY_MS = 1000; // durable progress at least once a second inside loops
  const MAX_CONTINUATIONS = 200;
  const MAX_SUBFLOW_DEPTH = 3;
  const OUT_MAX = 4000;
  const LOG_MAX = 200;

  const TYPES = ["http", "ai", "delay", "set", "filter", "map", "for_each", "repeat", "if", "stop", "log", "run_flow", "collect"];
  const RESERVED = new Set(["vars", "steps", "state", "trigger", "loop", "collections", "now", "now_iso", "today", "uuid"]);
  const DATA_PREFIX = "netscope.flowData."; // + flow id: { collections: { name: [...] } }
  const CP_PREFIX = "netscope.flowCheckpoint."; // + flow id

  const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
  const newId = () => "fl_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------ storage */

  // Big, frequently rewritten data — collections, checkpoints, memory — lives
  // in IndexedDB, not chrome.storage.local: every storage.local write is
  // broadcast with its full old and new value to every extension context
  // (each open popup), which a 15 MB collection rewritten every second would
  // choke. IndexedDB also makes a checkpoint one atomic transaction.
  const KV = (() => {
    if (typeof indexedDB === "undefined") {
      return {
        get: async (keys) => chrome.storage.local.get(keys),
        set: (obj) => chrome.storage.local.set(obj),
        remove: (keys) => chrome.storage.local.remove(keys)
      };
    }
    let dbp = null;
    const db = () =>
      dbp ||
      (dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open("netscope-flows", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => {
          dbp = null;
          reject(r.error);
        };
      }));
    const tx = async (mode, fn) => {
      const d = await db();
      return new Promise((resolve, reject) => {
        const t = d.transaction("kv", mode);
        const out = fn(t.objectStore("kv"));
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    };
    return {
      get: (keys) =>
        tx("readonly", (st) => {
          const out = {};
          for (const k of [].concat(keys)) {
            const r = st.get(k);
            r.onsuccess = () => {
              if (r.result !== undefined) out[k] = r.result;
            };
          }
          return out;
        }),
      set: (obj) =>
        tx("readwrite", (st) => {
          for (const k of Object.keys(obj)) st.put(obj[k], k);
        }),
      remove: (keys) =>
        tx("readwrite", (st) => {
          for (const k of [].concat(keys)) st.delete(k);
        })
    };
  })();
  const KV_IS_IDB = typeof indexedDB !== "undefined";

  // Data written by an earlier version sits in chrome.storage.local: read it
  // once, move it to the KV store.
  async function legacyMove(key) {
    if (!KV_IS_IDB) return undefined;
    try {
      const got = await chrome.storage.local.get(key);
      if (got[key] === undefined) return undefined;
      await KV.set({ [key]: got[key] });
      await chrome.storage.local.remove(key);
      return got[key];
    } catch (_) {
      return undefined;
    }
  }

  // The flow list and run histories are shared read-modify-write keys; one
  // queue keeps two writers (two runs finishing, a run and a save) from
  // overwriting each other's changes.
  let serialQ = Promise.resolve();
  const serial = (fn) => {
    const p = serialQ.then(fn);
    serialQ = p.catch(() => {});
    return p;
  };

  async function list() {
    try {
      const got = await chrome.storage.local.get(FLOWS_KEY);
      return Array.isArray(got[FLOWS_KEY]) ? got[FLOWS_KEY] : [];
    } catch (_) {
      return [];
    }
  }

  async function writeAll(flows) {
    await chrome.storage.local.set({ [FLOWS_KEY]: flows });
  }

  async function get(id) {
    return (await list()).find((f) => f.id === id) || null;
  }

  const stateKey = (id) => "netscope.flowMemory." + id;

  async function getState(id) {
    try {
      const got = await KV.get(stateKey(id));
      if (got[stateKey(id)] !== undefined) return Object.assign({}, got[stateKey(id)]);
      // Earlier versions kept every flow's memory in one storage.local map.
      return serial(async () => {
        const old = await chrome.storage.local.get(STATE_KEY);
        const all = old[STATE_KEY] || {};
        if (!all[id]) return {};
        const st = all[id];
        await KV.set({ [stateKey(id)]: st });
        delete all[id];
        await chrome.storage.local.set({ [STATE_KEY]: all });
        return Object.assign({}, st);
      });
    } catch (_) {
      return {};
    }
  }

  async function setState(id, state) {
    try {
      if (state && Object.keys(state).length) await KV.set({ [stateKey(id)]: state });
      else await KV.remove(stateKey(id));
    } catch (_) {}
  }

  async function getCollections(id) {
    try {
      const got = await KV.get(DATA_PREFIX + id);
      const d = got[DATA_PREFIX + id] !== undefined ? got[DATA_PREFIX + id] : await legacyMove(DATA_PREFIX + id);
      return (d && d.collections) || {};
    } catch (_) {
      return {};
    }
  }

  async function setCollections(id, collections) {
    const key = DATA_PREFIX + id;
    if (!collections || !Object.keys(collections).length) await KV.remove(key);
    else await KV.set({ [key]: { collections } });
  }

  // A checkpoint is two keys: the small, often-rewritten progress record, and
  // the loop's item list, written once when the loop first checkpoints.
  const ITEMS_SUFFIX = ".items";

  async function getCheckpointRaw(id) {
    try {
      const got = await KV.get(CP_PREFIX + id);
      return got[CP_PREFIX + id] || (await legacyMove(CP_PREFIX + id)) || null;
    } catch (_) {
      return null;
    }
  }

  // Updates a few fields of the stored progress record (not the items).
  async function markCheckpoint(id, patch) {
    const cp = await getCheckpointRaw(id);
    if (!cp) return null;
    Object.assign(cp, patch);
    await KV.set({ [CP_PREFIX + id]: cp }).catch(() => {});
    return cp;
  }

  async function getCheckpoint(id) {
    const cp = await getCheckpointRaw(id);
    if (cp && cp.loop && !cp.loop.items) {
      try {
        const got = await KV.get(CP_PREFIX + id + ITEMS_SUFFIX);
        cp.loop.items = got[CP_PREFIX + id + ITEMS_SUFFIX] || (await legacyMove(CP_PREFIX + id + ITEMS_SUFFIX)) || [];
      } catch (_) {
        cp.loop.items = [];
      }
    }
    return cp;
  }

  async function setCheckpoint(id, cp) {
    try {
      if (cp) {
        const payload = { [CP_PREFIX + id]: cp };
        if (cp.loop && cp.loop.items) {
          payload[CP_PREFIX + id + ITEMS_SUFFIX] = cp.loop.items;
          cp.loop = Object.assign({}, cp.loop, { itemsCount: cp.loop.items.length });
          delete cp.loop.items;
        }
        await KV.set(payload);
      } else await KV.remove([CP_PREFIX + id, CP_PREFIX + id + ITEMS_SUFFIX]);
    } catch (_) {}
  }

  /* --------------------------------------------------------- validation */

  const childLists = (s) =>
    s.type === "for_each" || s.type === "repeat" ? [["steps", s.steps]] : s.type === "if" ? [["then", s.then], ["else", s.else]] : [];

  function inferType(s) {
    if (s.type) return s.type;
    if (s.prompt) return "ai";
    if (s.then || s.condition) return "if";
    if (s.items && Array.isArray(s.steps)) return "for_each";
    if (Array.isArray(s.steps)) return "repeat";
    if (s.items && s.where) return "filter";
    if (s.items && s.value !== undefined) return "map";
    if (s.url || s.curl || s.from_id != null) return "http";
    if (s.ms != null) return "delay";
    if (s.vars || s.state) return "set";
    if (s.flow) return "run_flow";
    if (s.collection) return "collect";
    if (s.outcome) return "stop";
    if (s.message) return "log";
    return "http";
  }

  function validateSteps(steps, errors, seen, depth, prefix, counter) {
    if (!Array.isArray(steps)) return [];
    if (depth > MAX_DEPTH) {
      errors.push(`steps nest deeper than ${MAX_DEPTH} levels`);
      return [];
    }
    return steps.map((raw, i) => {
      if (!raw || typeof raw !== "object") {
        errors.push(`step ${prefix}${i + 1} is not an object`);
        return raw;
      }
      const s = raw;
      counter.n++;
      s.type = inferType(s);
      if (!s.id) s.id = (prefix ? prefix.replace(/\W+$/, "") + "_" : "s") + (i + 1);
      s.id = String(s.id).replace(/[^A-Za-z0-9_]/g, "_");
      if (seen.has(s.id)) errors.push(`duplicate step id "${s.id}" — ids must be unique across the whole flow`);
      seen.add(s.id);
      const at = `step "${s.id}"`;
      if (!TYPES.includes(s.type)) errors.push(`${at} has unknown type "${s.type}" (use ${TYPES.join(", ")})`);
      if (s.type === "http" && !s.url && !s.curl) errors.push(`${at} needs url or curl`);
      if (s.type === "ai" && !s.prompt) errors.push(`${at} needs a prompt`);
      if (["filter", "map", "for_each"].includes(s.type) && s.items == null) errors.push(`${at} needs items`);
      if (s.type === "filter" && !s.where) errors.push(`${at} needs where`);
      if (s.type === "map" && s.value === undefined) errors.push(`${at} needs value`);
      if (s.type === "if" && !s.condition) errors.push(`${at} needs condition`);
      if (s.type === "run_flow" && !s.flow) errors.push(`${at} needs flow (a flow id)`);
      if (s.type === "set" && !s.vars && !s.state) errors.push(`${at} needs vars or state`);
      if (s.type === "collect") {
        if (!s.collection || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(s.collection))) errors.push(`${at} needs collection, a simple name`);
        if (s.mode && !["append", "upsert", "replace", "remove", "clear"].includes(s.mode)) errors.push(`${at}: mode must be append, upsert, replace, remove or clear`);
        if (s.mode !== "clear" && s.items == null) errors.push(`${at} needs items`);
        if (s.mode === "upsert" && !s.key) errors.push(`${at}: upsert needs key`);
      }
      if (s.concurrency != null) s.concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Number(s.concurrency) || 1));
      if (s.context && !["extension", "page"].includes(s.context)) errors.push(`${at}: context must be "extension" or "page"`);
      if ((s.type === "for_each" || s.type === "repeat") && (!Array.isArray(s.steps) || !s.steps.length)) {
        errors.push(`${at} needs a non-empty steps array`);
      }
      if (s.type === "if" && !(Array.isArray(s.then) && s.then.length) && !(Array.isArray(s.else) && s.else.length)) {
        errors.push(`${at} needs then or else steps`);
      }
      if (s.as && RESERVED.has(s.as)) errors.push(`${at}: "as" cannot be "${s.as}" (reserved)`);
      if (s.as && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.as)) errors.push(`${at}: "as" must be a simple name`);
      if (s.type === "stop" && s.outcome && !["ok", "fail"].includes(s.outcome)) errors.push(`${at}: outcome must be "ok" or "fail"`);
      for (const [key, list] of childLists(s)) {
        if (Array.isArray(list)) s[key] = validateSteps(list, errors, seen, depth + 1, s.id + "_", counter);
      }
      return s;
    });
  }

  function validate(input) {
    const f = clone(input || {});
    delete f.warnings; // a check result echoed back is never stored
    const errors = [];
    if (!f.name || typeof f.name !== "string") errors.push("name is required");
    if (!Array.isArray(f.steps) || !f.steps.length) errors.push("steps must be a non-empty array");
    const counter = { n: 0 };
    f.steps = validateSteps(f.steps || [], errors, new Set(), 1, "", counter);
    if (counter.n > MAX_DEF_STEPS) errors.push(`at most ${MAX_DEF_STEPS} steps in total, nested ones included`);

    const sch = f.schedule || {};
    let every = Number(sch.every_minutes || 0);
    if (sch.enabled && (!every || every < 1)) errors.push("schedule.every_minutes must be at least 1");
    if (every > 10080) every = 10080;
    f.schedule = { enabled: !!sch.enabled && every >= 1, every_minutes: every || 60 };

    if (f.on_request) {
      const t = f.on_request;
      if (!t.url_contains && !t.method && !t.status) errors.push("on_request needs url_contains, method or status");
      f.on_request = {
        enabled: t.enabled !== false,
        // The site the trigger belongs to; empty means any site.
        host: t.host ? String(t.host).replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase() : "",
        url_contains: t.url_contains ? String(t.url_contains) : "",
        method: t.method ? String(t.method).toUpperCase() : "",
        status: t.status ? String(t.status) : "",
        cooldown_seconds: Math.min(86400, Math.max(5, Number(t.cooldown_seconds) || 30))
      };
    }
    if (f.vars && typeof f.vars !== "object") errors.push("vars must be an object");
    const lim = f.limits || {};
    f.limits = {
      max_steps: Math.min(MAX_EXEC_CAP, Math.max(100, Number(lim.max_steps) || MAX_EXEC)),
      max_minutes: Math.min(RUN_TIME_CAP / 60000, Math.max(1, Number(lim.max_minutes) || RUN_TIME_LIMIT / 60000)),
      // On by default: a job that outgrows one run should finish, not stall.
      auto_resume: lim.auto_resume !== false
    };
    if (errors.length) {
      const err = new Error("Invalid flow: " + errors.join("; "));
      err.errors = errors;
      throw err;
    }
    return f;
  }

  // Structure (validate) plus meaning (analyze): every problem at once, with
  // the step it is in, before anything is stored or run.
  function check(input) {
    let f;
    try {
      f = validate(input);
    } catch (err) {
      return { valid: false, errors: err.errors || [err.message], warnings: [] };
    }
    const a = analyze(f);
    return { valid: !a.errors.length, errors: a.errors, warnings: a.warnings, flow: f };
  }

  async function save(input) {
    const c = check(input);
    if (!c.valid) {
      const err = new Error("Invalid flow: " + c.errors.join("; "));
      err.errors = c.errors;
      throw err;
    }
    await serial(() => storeFlow(c.flow));
    await syncAlarms();
    return Object.assign({}, c.flow, { warnings: c.warnings });
  }

  async function storeFlow(f) {
    const flows = await list();
    const now = Date.now();
    const i = f.id ? flows.findIndex((x) => x.id === f.id) : -1;
    if (i >= 0) {
      f.createdAt = flows[i].createdAt || now;
      f.lastRun = flows[i].lastRun || null;
      f.updatedAt = now;
      flows[i] = f;
    } else {
      f.id = f.id || newId();
      f.createdAt = now;
      f.updatedAt = now;
      f.lastRun = null;
      flows.push(f);
    }
    await writeAll(flows);
  }

  async function remove(id) {
    const removed = await serial(async () => {
      const cur = await list();
      const next = cur.filter((f) => f.id !== id);
      await writeAll(next);
      try {
        const got = await chrome.storage.local.get(RUNS_KEY);
        const runs = got[RUNS_KEY] || {};
        delete runs[id];
        await chrome.storage.local.set({ [RUNS_KEY]: runs });
      } catch (_) {}
      return next.length !== cur.length;
    });
    await setState(id, null);
    await setCollections(id, null).catch(() => {});
    await setCheckpoint(id, null);
    await syncAlarms();
    return removed;
  }

  async function runs(id) {
    try {
      const got = await chrome.storage.local.get(RUNS_KEY);
      return ((got[RUNS_KEY] || {})[id] || []).slice();
    } catch (_) {
      return [];
    }
  }

  function recordRun(run) {
    return serial(() => recordRunNow(run));
  }

  async function recordRunNow(run) {
    try {
      const got = await chrome.storage.local.get(RUNS_KEY);
      const all = got[RUNS_KEY] || {};
      const arr = all[run.flowId] || [];
      arr.unshift(run);
      all[run.flowId] = arr.slice(0, MAX_RUNS);
      await chrome.storage.local.set({ [RUNS_KEY]: all });

      const flows = await list();
      const f = flows.find((x) => x.id === run.flowId);
      if (f) {
        f.lastRun = { id: run.id, at: run.startedAt, ok: run.ok, paused: !!run.paused, ms: run.ms, error: run.error || "", trigger: run.trigger };
        await writeAll(flows);
      }
    } catch (_) {}
  }

  /* ---------------------------------------------------------- schedules */

  async function syncAlarms() {
    if (!chrome.alarms) return;
    const flows = await list();
    const want = new Map();
    for (const f of flows) if (f.schedule && f.schedule.enabled) want.set("flow:" + f.id, f.schedule.every_minutes);
    const have = await chrome.alarms.getAll();
    for (const a of have) {
      if (!a.name.startsWith("flow:")) continue;
      if (!want.has(a.name) || a.periodInMinutes !== want.get(a.name)) await chrome.alarms.clear(a.name);
    }
    const left = new Set((await chrome.alarms.getAll()).map((a) => a.name));
    for (const [name, every] of want) {
      if (!left.has(name)) chrome.alarms.create(name, { delayInMinutes: every, periodInMinutes: every });
    }
  }

  /* ---------------------------------------------------------- templates */

  function getPath(root, path) {
    const parts = String(path).match(/[^.[\]"']+/g) || [];
    let cur = root;
    for (const p of parts) {
      if (cur == null) return undefined;
      if (typeof cur === "string" && p !== "length") {
        try {
          cur = JSON.parse(cur); // allow drilling into a JSON string body
        } catch (_) {
          return undefined;
        }
      }
      cur = cur[/^\d+$/.test(p) && Array.isArray(cur) ? Number(p) : p];
    }
    return cur;
  }

  function uuid() {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  const asText = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const num = (v) => (typeof v === "number" ? v : Number(v));
  const isNum = (v) => v !== "" && v !== null && typeof v !== "object" && typeof v !== "boolean" && !isNaN(Number(v));

  function compare(a, op, b) {
    const numeric = isNum(a) && isNum(b);
    if (op === "=" || op === "==") return numeric ? num(a) === num(b) : asText(a) === asText(b);
    if (op === "!=") return numeric ? num(a) !== num(b) : asText(a) !== asText(b);
    if (op === ">") return numeric && num(a) > num(b);
    if (op === "<") return numeric && num(a) < num(b);
    if (op === ">=") return numeric && num(a) >= num(b);
    if (op === "<=") return numeric && num(a) <= num(b);
    if (op === "~" || op === "contains") return asText(a).includes(asText(b));
    if (op === "!contains") return !asText(a).includes(asText(b));
    return false;
  }

  const toList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  function flattenList(list, depth) {
    const out = [];
    for (const x of list) {
      if (Array.isArray(x) && depth > 0) {
        for (const y of flattenList(x, depth - 1)) out.push(y); // no spread: huge arrays would overflow the stack
      } else out.push(x);
    }
    return out;
  }

  // Shared by collect options and the collect step: optional flatten, then
  // de-duplication by a key path (or by the whole value).
  function shapeList(list, opts) {
    let out = toList(list);
    if (opts.flatten) out = flattenList(out, opts.flatten === "deep" ? Infinity : opts.flatten === true ? 1 : Number(opts.flatten) || 1);
    if (opts.unique_by || opts.unique) {
      const seen = new Set();
      out = out.filter((x) => {
        const k = asText(opts.unique_by ? getPath(x, opts.unique_by) : x);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return out;
  }
  const pick = (x, field) => (field ? getPath(x, field) : x);

  // filter name -> (value, arg string) => value
  const FILTERS = {
    json: (v) => JSON.stringify(v === undefined ? null : v),
    json_parse: (v) => {
      if (typeof v !== "string") return v;
      try {
        return JSON.parse(v);
      } catch (_) {
        return v;
      }
    },
    urlencode: (v) => encodeURIComponent(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)),
    first: (v) => (Array.isArray(v) ? v[0] : v),
    last: (v) => (Array.isArray(v) ? v[v.length - 1] : v),
    length: (v) => (v == null ? 0 : v.length != null ? v.length : typeof v === "object" ? Object.keys(v).length : String(v).length),
    count: (v) => FILTERS.length(v),
    trim: (v) => (v == null ? "" : String(v).trim()),
    upper: (v) => (v == null ? "" : String(v).toUpperCase()),
    lower: (v) => (v == null ? "" : String(v).toLowerCase()),
    default: (v, a) => (v == null || v === "" ? a : v),
    number: (v) => (isNum(v) ? num(v) : 0),
    string: (v) => asText(v),
    not: (v) => !v || v === "false" || v === "0",
    bool: (v) => !!v && v !== "false" && v !== "0",
    round: (v, a) => {
      const d = Number(a) || 0;
      return Math.round(num(v) * 10 ** d) / 10 ** d;
    },
    abs: (v) => Math.abs(num(v)),
    add: (v, a) => num(v) + num(a),
    sub: (v, a) => num(v) - num(a),
    mul: (v, a) => num(v) * num(a),
    div: (v, a) => (num(a) ? num(v) / num(a) : null),
    keys: (v) => (v && typeof v === "object" ? Object.keys(v) : []),
    values: (v) => (v && typeof v === "object" ? Object.values(v) : []),
    get: (v, a) => getPath(v, a),
    pluck: (v, a) => toList(v).map((x) => getPath(x, a)),
    where: (v, a) => {
      const m = /^(.+?)\s*(!=|>=|<=|==|=|>|<|~)\s*(.*)$/.exec(a || "");
      if (!m) return toList(v).filter((x) => !!getPath(x, a));
      return toList(v).filter((x) => compare(getPath(x, m[1].trim()), m[2], m[3].trim()));
    },
    sort: (v, a) => {
      const desc = (a || "").startsWith("-");
      const field = desc ? a.slice(1) : a;
      const out = toList(v).slice();
      out.sort((x, y) => {
        const p = pick(x, field);
        const q = pick(y, field);
        const r = isNum(p) && isNum(q) ? num(p) - num(q) : asText(p).localeCompare(asText(q));
        return desc ? -r : r;
      });
      return out;
    },
    reverse: (v) => toList(v).slice().reverse(),
    // flatten (one level), flatten:2, flatten:deep — e.g. pages of rank_list arrays into one list
    flatten: (v, a) => flattenList(toList(v), a === "deep" ? Infinity : Number(a) || 1),
    compact: (v) => toList(v).filter((x) => x !== null && x !== undefined && x !== ""),
    chunk: (v, a) => {
      const n = Math.max(1, Number(a) || 1);
      const l = toList(v);
      const out = [];
      for (let i = 0; i < l.length; i += n) out.push(l.slice(i, i + n));
      return out;
    },
    group_by: (v, a) => {
      const out = {};
      for (const x of toList(v)) (out[asText(pick(x, a))] = out[asText(pick(x, a))] || []).push(x);
      return out;
    },
    index_by: (v, a) => {
      const out = {};
      for (const x of toList(v)) out[asText(pick(x, a))] = x;
      return out;
    },
    count_by: (v, a) => {
      const out = {};
      for (const x of toList(v)) out[asText(pick(x, a))] = (out[asText(pick(x, a))] || 0) + 1;
      return out;
    },
    merge: (v) => Object.assign({}, ...toList(v).filter((x) => x && typeof x === "object" && !Array.isArray(x))),
    uniq: (v, a) => FILTERS.unique(v, a),
    unique: (v, a) => {
      const seen = new Set();
      return toList(v).filter((x) => {
        const k = asText(pick(x, a));
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    },
    sum: (v, a) => toList(v).reduce((t, x) => t + (isNum(pick(x, a)) ? num(pick(x, a)) : 0), 0),
    min: (v, a) => {
      const n = toList(v).map((x) => pick(x, a)).filter(isNum).map(num);
      return n.length ? Math.min(...n) : null;
    },
    max: (v, a) => {
      const n = toList(v).map((x) => pick(x, a)).filter(isNum).map(num);
      return n.length ? Math.max(...n) : null;
    },
    slice: (v, a) => {
      const [s, e] = String(a || "0").split(":").map((x) => (x === "" ? undefined : Number(x)));
      return Array.isArray(v) || typeof v === "string" ? v.slice(s, e) : v;
    },
    join: (v, a) => toList(v).map(asText).join(a == null ? "," : a),
    split: (v, a) => (v == null ? [] : String(v).split(a == null ? "," : a)),
    replace: (v, a) => {
      const i = (a || "").indexOf(":");
      return i < 0 ? asText(v) : asText(v).split(a.slice(0, i)).join(a.slice(i + 1));
    },
    contains: (v, a) => (Array.isArray(v) ? v.some((x) => asText(x) === a) : asText(v).includes(a || "")),
    date: (v) => {
      const d = isNum(v) ? new Date(num(v)) : new Date(String(v));
      return isNaN(d.getTime()) ? "" : d.toISOString();
    },
    timestamp: (v) => {
      const d = isNum(v) ? new Date(num(v)) : new Date(String(v));
      return isNaN(d.getTime()) ? null : d.getTime();
    }
  };

  function lookup(ctx, expr) {
    const [head, ...filters] = expr.split("|").map((s) => s.trim());
    let v;
    if (head === "now") v = Date.now();
    else if (head === "now_iso") v = new Date().toISOString();
    else if (head === "today") v = new Date().toISOString().slice(0, 10);
    else if (head === "uuid") v = uuid();
    else if (/^(["']).*\1$/.test(head)) v = head.slice(1, -1);
    else if (/^-?\d+(\.\d+)?$/.test(head)) v = Number(head);
    else v = getPath(ctx, head);
    for (const f of filters) {
      const i = f.indexOf(":");
      const name = i < 0 ? f : f.slice(0, i).trim();
      let arg = i < 0 ? undefined : f.slice(i + 1).trim();
      // Quote an argument to keep its spaces: join:", "
      if (arg && /^(["']).*\1$/.test(arg)) arg = arg.slice(1, -1);
      const fn = FILTERS[name];
      if (!fn) throw new Error(`unknown filter "${name}" in {{${expr}}}`);
      v = fn(v, arg);
    }
    return v;
  }

  const TEMPLATE = /\{\{\s*([^}]+?)\s*\}\}/g;

  function render(str, ctx) {
    if (typeof str !== "string") return str;
    return str.replace(TEMPLATE, (_, expr) => asText(lookup(ctx, expr)));
  }

  function renderDeep(value, ctx) {
    if (typeof value === "string") {
      const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
      if (whole) {
        const v = lookup(ctx, whole[1]);
        return v === undefined ? null : v;
      }
      return render(value, ctx);
    }
    if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx));
    if (value && typeof value === "object") {
      const out = {};
      for (const k of Object.keys(value)) out[render(k, ctx)] = renderDeep(value[k], ctx);
      return out;
    }
    return value;
  }

  const OPS = ["!contains", "contains", "matches", "exists", "missing", "==", "!=", ">=", "<=", ">", "<"];

  function evalAtom(masked, unmask, ctx) {
    let s = masked.trim();
    let negate = false;
    while (/^not\s+/i.test(s)) {
      negate = !negate;
      s = s.replace(/^not\s+/i, "");
    }
    const val = (x) => {
      const t = unmask(x).trim();
      const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(t);
      if (whole) return lookup(ctx, whole[1]);
      return render(t.replace(/^(["'])(.*)\1$/, "$2"), ctx);
    };
    let result = null;
    for (const op of OPS) {
      const re = new RegExp(`^(.*?)\\s+${op.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+(.*))?$`);
      const m = re.exec(s);
      if (!m) continue;
      const a = val(m[1]);
      if (op === "exists") result = a !== undefined && a !== null && a !== "" && !(Array.isArray(a) && !a.length);
      else if (op === "missing") result = a === undefined || a === null || a === "" || (Array.isArray(a) && !a.length);
      else if (op === "matches") {
        try {
          result = new RegExp(asText(val(m[2] || ""))).test(asText(a));
        } catch (_) {
          result = false;
        }
      } else result = compare(a, op, val(m[2] || ""));
      break;
    }
    if (result === null) {
      const v = val(s);
      result = !(v === undefined || v === null || v === "" || v === false || v === 0 || (Array.isArray(v) && !v.length) || /^(false|0|null|undefined)$/i.test(String(v)));
    }
    return negate ? !result : result;
  }

  function evalWhen(expr, ctx) {
    if (expr == null || expr === "") return true;
    if (typeof expr === "boolean") return expr;
    const raw = String(expr);
    const holes = [];
    // Templates and quoted literals are opaque: and/or/operators inside them
    // ('rock and roll', "a > b") are text, not syntax.
    const masked = raw.replace(/\{\{\s*[^}]+?\s*\}\}|"[^"]*"|'[^']*'/g, (m) => {
      holes.push(m);
      return `\u0001${holes.length - 1}\u0002`;
    });
    const unmask = (s) => s.replace(/\u0001(\d+)\u0002/g, (_, i) => holes[Number(i)]);
    // or of ands; keywords only count outside templates (already masked).
    return masked.split(/\s+or\s+/i).some((clause) => clause.split(/\s+and\s+/i).every((atom) => evalAtom(atom, unmask, ctx)));
  }

  function statusOk(status, expect) {
    if (!expect) return status >= 200 && status < 400;
    return String(expect)
      .split(",")
      .map((s) => s.trim())
      .some((q) => (/^[1-5]xx$/i.test(q) ? Math.floor(status / 100) === Number(q[0]) : Number(q) === status));
  }

  function matchesRequest(trig, e) {
    if (!trig || !trig.enabled || !e || e.kind !== "http") return false;
    if (trig.host) {
      let h = "";
      try {
        h = new URL(e.url).host.toLowerCase();
      } catch (_) {}
      if (h !== trig.host && !h.endsWith("." + trig.host)) return false;
    }
    if (trig.url_contains && !String(e.url || "").toLowerCase().includes(trig.url_contains.toLowerCase())) return false;
    if (trig.method && trig.method !== String(e.method || "").toUpperCase()) return false;
    if (trig.status && !statusOk(e.status || 0, trig.status)) return false;
    return true;
  }

  /* ----------------------------------------------------------- analysis */

  // Finds what validate() cannot: references to steps that don't exist (or
  // haven't run yet), unknown filters, loop names used outside their loop,
  // URLs that can't work, cURL that won't parse. Errors block saving;
  // warnings explain likely surprises.
  function analyze(flow) {
    const errors = [];
    const warnings = [];
    const ids = new Set();
    const collected = new Set();
    walk(flow.steps, (st) => {
      ids.add(st.id);
      if (st.type === "collect") collected.add(String(st.collection));
    });
    const knownFilters = new Set(Object.keys(FILTERS));
    const done = new Set(); // steps that have run before the point being checked
    const idsIn = (steps) => {
      const out = new Set();
      walk(steps, (st) => out.add(st.id));
      return out;
    };

    const checkExpr = (expr, where, scope, soft) => {
      const parts = expr.split("|").map((x) => x.trim());
      const head = parts[0];
      for (const f of parts.slice(1)) {
        const name = f.split(":")[0].trim();
        if (!knownFilters.has(name)) errors.push(`${where}: unknown filter "${name}" in {{${expr}}}`);
      }
      if (/^(["']).*\1$/.test(head) || /^-?\d+(\.\d+)?$/.test(head)) return;
      const segs = head.match(/[^.[\]"']+/g) || [];
      const root = segs[0];
      if (!root || ["now", "now_iso", "today", "uuid", "vars", "state"].includes(root) || scope.has(root)) return;
      if (root === "loop") {
        errors.push(`${where}: {{${head}}} only exists inside a for_each, repeat, filter or map`);
        return;
      }
      if (root === "trigger") {
        if (!flow.on_request) warnings.push(`${where}: {{${head}}} is empty unless the flow is started by a page request (on_request)`);
        return;
      }
      if (root === "collections") {
        if (segs[1] && !collected.has(segs[1])) warnings.push(`${where}: collections.${segs[1]} is never written by this flow, so it is empty unless an earlier run filled it`);
        return;
      }
      if (root === "steps") {
        const id = segs[1];
        if (!id) return;
        if (!ids.has(id)) errors.push(`${where}: {{${head}}} refers to step "${id}", which this flow does not have`);
        else if (!done.has(id) && !soft.has(id)) warnings.push(`${where}: {{${head}}} is used before step "${id}" runs, so it is empty here`);
        return;
      }
      errors.push(`${where}: unknown name "${root}" in {{${head}}} — write vars.${root}, or use it inside a loop that has as: "${root}"`);
    };

    const scan = (val, where, scope, soft) => {
      if (typeof val === "string") {
        for (const m of val.matchAll(TEMPLATE)) checkExpr(m[1], where, scope, soft);
      } else if (Array.isArray(val)) val.forEach((v) => scan(v, where, scope, soft));
      else if (val && typeof val === "object") for (const k of Object.keys(val)) scan(val[k], where, scope, soft);
    };

    const visit = (steps, scope, prefix, soft, parallel) => {
      for (const st of steps || []) {
        if (!st || typeof st !== "object") continue;
        const where = `step "${prefix}${st.id}"`;
        const t = st.type;
        scan(st.when, where, scope, soft);

        if (t === "http") {
          for (const k of ["url", "curl", "headers", "body", "query"]) scan(st[k], where, scope, soft);
          if (st.url && !/^\s*(https?:\/\/|\{\{)/i.test(String(st.url))) errors.push(`${where}: url must start with http:// or https:// (got "${String(st.url).slice(0, 60)}")`);
          if (st.curl) {
            try {
              globalThis.__netscopeCurl.parse(String(st.curl).replace(TEMPLATE, "x"));
            } catch (e) {
              errors.push(`${where}: the cURL command does not parse — ${e.message}`);
            }
          }
        } else if (t === "ai") scan(st.prompt, where, scope, soft);
        else if (t === "log" || t === "stop") scan(st.message, where, scope, soft);
        else if (t === "set") {
          scan(st.vars, where, scope, soft);
          scan(st.state, where, scope, soft);
          if (parallel && st.vars) {
            warnings.push(`${where}: sets vars inside a parallel loop — items finish in any order, so the last one to finish wins. Use collect to gather results instead.`);
          }
        } else if (t === "collect") {
          scan(st.items, where, scope, soft);
          if (parallel && (st.mode || "append") === "append" && !st.key) {
            warnings.push(`${where}: appends without a key inside a parallel loop — after a pause or restart a few items run again and would be added twice. Give it key (e.g. "user_id").`);
          }
        }
        else if (t === "run_flow") scan(st.vars, where, scope, soft);
        else if (t === "filter" || t === "map") {
          scan(st.items, where, scope, soft);
          const inner = new Set(scope).add(st.as || "item").add("loop");
          scan(t === "filter" ? st.where : st.value, where, inner, soft);
        } else if (t === "for_each") {
          scan(st.items, where, scope, soft);
          const inner = new Set(scope).add(st.as || "item").add("loop");
          visit(st.steps, inner, prefix + st.id + "[]/", soft, parallel || (Number(st.concurrency) || 1) > 1);
          if (st.collect) scan(st.collect.value, where + " collect", inner, soft);
          if ((Number(st.max) || 100) > 1000 && !(flow.limits && flow.limits.max_steps > MAX_EXEC)) {
            warnings.push(`${where}: up to ${st.max} items may need more than the default ${MAX_EXEC} step runs — set limits.max_steps, or let it pause and auto-resume`);
          }
        } else if (t === "repeat") {
          const loopSoft = new Set([...soft, ...idsIn(st.steps)]);
          const inner = new Set(scope).add("loop");
          if (!st.until && !st.while) warnings.push(`${where}: has no until or while, so it always runs ${st.max || 10} times`);
          scan(st.while, where, inner, loopSoft);
          visit(st.steps, inner, prefix + st.id + "[]/", loopSoft, parallel);
          scan(st.until, where, inner, loopSoft);
          if (st.collect) scan(st.collect.value, where + " collect", inner, loopSoft);
        } else if (t === "if") {
          scan(st.condition, where, scope, soft);
          visit(st.then, scope, prefix + st.id + ".then/", soft, parallel);
          visit(st.else, scope, prefix + st.id + ".else/", soft, parallel);
        }
        done.add(st.id);
        if (t === "for_each" || t === "repeat" || t === "if") for (const id of idsIn([st])) done.add(id);
      }
    };
    visit(flow.steps, new Set(), "", new Set(), false);
    const uniq = (a) => Array.from(new Set(a));
    return { errors: uniq(errors), warnings: uniq(warnings) };
  }

  /* ---------------------------------------------------------------- run */

  function hostOf(u) {
    try {
      return new URL(u).host;
    } catch (_) {
      return "";
    }
  }

  function retryAfterMs(res) {
    const h = (res.headers || []).find((x) => /^retry-after$/i.test(x.name));
    if (!h) return 0;
    const n = Number(h.value);
    if (!isNaN(n)) return Math.min(120000, Math.max(0, n * 1000));
    const d = Date.parse(h.value);
    return isNaN(d) ? 0 : Math.min(120000, Math.max(0, d - Date.now()));
  }

  // Per-host parallelism that adapts: starts at the loop's concurrency, halves
  // on a 429/503, and grows back by one after a run of successes.
  async function hostAcquire(rt, host, conc) {
    if (conc <= 1) return null;
    let g = rt.gates.get(host);
    if (!g) {
      g = { limit: conc, max: conc, lowest: conc, inflight: 0, ok: 0, queue: [] };
      rt.gates.set(host, g);
    }
    if (conc > g.max) g.max = conc;
    while (g.inflight >= g.limit) await new Promise((resolve) => g.queue.push(resolve));
    g.inflight++;
    return g;
  }

  function hostRelease(g, outcome) {
    if (!g) return;
    g.inflight--;
    if (outcome === "limited") {
      g.limit = Math.max(1, Math.floor(g.limit / 2));
      g.lowest = Math.min(g.lowest, g.limit);
      g.ok = 0;
    } else if (outcome === "ok" && g.limit < g.max && ++g.ok >= g.limit * 2) {
      g.limit++;
      g.ok = 0;
    }
    const wake = g.queue.splice(0, g.queue.length);
    for (const w of wake) w(); // each re-checks the limit
  }

  function buildHttpRequest(step, ctx) {
    let req;
    if (step.curl) {
      req = globalThis.__netscopeCurl.parse(render(step.curl, ctx));
    } else {
      req = { method: (step.method || "GET").toUpperCase(), url: render(step.url, ctx), headers: [], body: null };
      const h = renderDeep(step.headers || {}, ctx);
      req.headers = Array.isArray(h) ? h : Object.keys(h).map((name) => ({ name, value: asText(h[name]) }));
      if (step.body != null && step.body !== "") req.body = renderDeep(step.body, ctx);
    }
    if (step.query && typeof step.query === "object") {
      const q = renderDeep(step.query, ctx);
      const u = new URL(req.url);
      for (const k of Object.keys(q)) if (q[k] != null) u.searchParams.set(k, asText(q[k]));
      req.url = u.toString();
    }
    return req;
  }

  function parseBody(text, mime) {
    if (typeof text !== "string") return text;
    const t = text.trim();
    if (/json/i.test(mime || "") || t.startsWith("{") || t.startsWith("[")) {
      try {
        return JSON.parse(t);
      } catch (_) {}
    }
    return text;
  }

  function responseView(res) {
    const headers = {};
    for (const h of res.headers || []) headers[String(h.name).toLowerCase()] = h.value;
    return {
      status: res.status,
      ok: !!res.ok,
      status_text: res.statusText || "",
      headers,
      body: parseBody(res.body, res.mime),
      text: res.body || "",
      ms: res.ms,
      url: res.url
    };
  }

  const clipOut = (v) => {
    const s = asText(v);
    return s.length > OUT_MAX ? s.slice(0, OUT_MAX) + "…" : s;
  };

  function resolveItems(spec, ctx) {
    let v = typeof spec === "string" ? renderDeep(spec, ctx) : renderDeep(spec, ctx);
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch (_) {}
    }
    if (Array.isArray(v)) return v;
    if (typeof v === "number" && v >= 0) return Array.from({ length: Math.min(v, 10000) }, (_, i) => i);
    if (v && typeof v === "object") return Object.keys(v).map((key) => ({ key, value: v[key] }));
    if (v == null || v === "") return [];
    throw new Error("items must resolve to a list (got " + typeof v + ")");
  }

  class StepFailure extends Error {}

  // kind: budget_steps | budget_time | network | timeout | rate_limited |
  // http_status | template | ai | stopped | subflow | error
  function stepFail(kind, message, extra) {
    const e = new StepFailure(message);
    e.kind = kind;
    if (extra) Object.assign(e, extra);
    return e;
  }

  const TEMPLATE_ERR = /unknown filter|items must resolve|Invalid URL|cURL|no URL found|needs a value|unterminated/i;
  class StopSignal {
    constructor(ok, message) {
      this.ok = ok;
      this.message = message;
    }
  }

  // One aggregate per step path: loop bodies run many times, the record
  // shows how many runs, how many failed, and the last result.
  function record(rt, path, step, depth) {
    let r = rt.agg.get(path);
    if (!r) {
      r = { id: path, type: step.type, name: step.name || "", depth, runs: 0, okCount: 0, failCount: 0, skipCount: 0, ms: 0, ok: true, skipped: false };
      rt.agg.set(path, r);
      rt.order.push(r);
    }
    return r;
  }

  function emit(rt, r, force) {
    if (!rt.onStep) return;
    const t = Date.now();
    if (!force && t - rt.lastEmit < 300) return;
    rt.lastEmit = t;
    try {
      rt.onStep(Object.assign({}, r));
    } catch (_) {}
  }

  // A loop iteration's own scope: reads fall through to the run (vars, state,
  // collections, trigger, outer loop names), but {{item}}, {{loop}} and
  // {{steps.x}} written inside belong to this iteration — which is what lets
  // parallel iterations run without trampling each other.
  function iterCtx(ctx, as, item, loop) {
    const c = Object.create(ctx);
    c.steps = Object.create(ctx.steps);
    c[as] = item;
    c.loop = loop;
    return c;
  }

  // After an iteration, its step results become the run's "latest".
  function settleIter(ctx, c) {
    for (const k of Object.keys(c.steps)) ctx.steps[k] = c.steps[k];
  }

  const loopInfo = (i, n) => ({ index: i, number: i + 1, count: n, first: i === 0, last: i === n - 1 });

  async function execSteps(steps, ctx, rt, prefix, depth) {
    for (const step of steps || []) {
      const sig = await execStep(step, ctx, rt, prefix, depth);
      if (sig instanceof StopSignal) return sig;
    }
    return null;
  }

  async function execStep(step, ctx, rt, prefix, depth) {
    const path = prefix ? prefix + "/" + step.id : step.id;
    const r = record(rt, path, step, depth);
    if (++rt.executed > rt.maxExec) {
      throw stepFail("budget_steps", `stopped: reached this run's budget of ${rt.maxExec} step runs`, { budget: true, step: path });
    }
    if (Date.now() > rt.deadline) {
      throw stepFail("budget_time", `stopped: reached this run's time budget of ${Math.round(rt.timeLimit / 60000)} min`, { budget: true, step: path });
    }

    r.runs++;
    const t0 = Date.now();
    let signal = null;
    let failed = null;
    let skipped = false;

    try {
      if (!evalWhen(step.when, ctx)) {
        skipped = true;
        r.note = "condition was false: " + String(step.when).slice(0, 120);
      } else {
        signal = await runStepBody(step, ctx, rt, path, depth, r);
      }
      if (!skipped && step.extract && typeof step.extract === "object") {
        r.extracted = {};
        const local = ctx.steps[step.id] || {};
        for (const name of Object.keys(step.extract)) {
          const p = String(step.extract[name]);
          const v = /^(vars|steps|state|trigger|loop)\.|^(vars|state)$/.test(p) ? getPath(ctx, p) : getPath(local, p);
          ctx.vars[name] = v;
          r.extracted[name] = clipOut(v).slice(0, 300);
        }
      }
    } catch (err) {
      if (err instanceof StepFailure) failed = err;
      else {
        const msg = String((err && err.message) || err);
        failed = stepFail(TEMPLATE_ERR.test(msg) ? "template" : "error", msg);
      }
    }

    r.ms += Date.now() - t0;
    if (skipped) {
      r.skipCount++;
      r.skipped = r.skipCount === r.runs;
    } else if (failed) {
      r.failCount++;
      r.ok = false;
      if (!r.error) r.error = failed.message.slice(0, 400);
    } else {
      r.okCount++;
    }
    emit(rt, r, depth === 1);

    if (failed) {
      if (step.continue_on_error && !failed.budget) return null;
      const e = new StepFailure(failed.fromChild ? failed.message : `step "${path}" failed: ${failed.message}`);
      e.fromChild = true;
      e.budget = !!failed.budget;
      // The deepest step, the cause and the item travel up unchanged.
      e.kind = failed.kind || "error";
      e.step = failed.step || path;
      e.reason = failed.reason || failed.message;
      e.status = failed.status;
      e.url = failed.url;
      e.item = failed.item;
      throw e;
    }
    return signal;
  }

  async function runStepBody(step, ctx, rt, path, depth, r) {
    switch (step.type) {
      case "delay": {
        const ms = Math.min(Math.max(0, Number(step.ms) || 0), 60000);
        await sleep(ms);
        r.output = `waited ${ms} ms`;
        return null;
      }

      case "log": {
        const msg = render(String(step.message || ""), ctx);
        if (rt.logs.length < LOG_MAX) rt.logs.push({ step: path, at: Date.now(), message: msg.slice(0, 1000) });
        r.output = msg.slice(0, 500);
        return null;
      }

      case "set": {
        const parts = [];
        for (const [scope, target] of [["vars", ctx.vars], ["state", ctx.state]]) {
          const spec = step[scope];
          if (!spec || typeof spec !== "object") continue;
          for (const k of Object.keys(spec)) {
            target[k] = renderDeep(spec[k], ctx);
            parts.push(`${scope}.${k} = ${clipOut(target[k]).slice(0, 80)}`);
          }
          if (scope === "state") rt.stateDirty = true;
        }
        r.output = parts.join(", ");
        return null;
      }

      case "filter":
      case "map": {
        const items = shapeList(resolveItems(step.items, ctx), { flatten: step.flatten });
        const as = step.as || "item";
        let out = [];
        for (let i = 0; i < items.length; i++) {
          const c = iterCtx(ctx, as, items[i], loopInfo(i, items.length));
          if (step.type === "filter") {
            if (evalWhen(step.where, c)) out.push(items[i]);
            if (step.limit && out.length >= Number(step.limit)) break;
          } else out.push(renderDeep(step.value, c));
        }
        out = shapeList(out, { unique_by: step.unique_by, unique: step.unique });
        const name = step.save_as || step.id;
        ctx.vars[name] = out;
        ctx.steps[step.id] = { body: out, count: out.length, ok: true };
        r.output = `${step.type === "filter" ? "kept" : "made"} ${out.length} of ${items.length} → vars.${name}`;
        return null;
      }

      case "for_each": {
        const top = depth === 1;
        const resume = top && rt.resume && rt.resume.stepId === step.id && rt.resume.kind === "for_each" ? rt.resume : null;
        if (resume) rt.resume = null; // consumed
        const items = resume ? resume.items : shapeList(resolveItems(step.items, ctx), { flatten: step.flatten });
        const max = Math.min(Math.max(1, Number(step.max) || 100), 10000);
        const as = step.as || "item";
        const list = items.slice(0, max);
        const conc = Math.min(MAX_CONCURRENCY, Math.max(1, Number(step.concurrency) || 1));
        const results = resume && Array.isArray(resume.results) ? resume.results.slice() : [];
        const done = new Set();
        let low = resume ? resume.next : 0; // every index below this is finished
        for (let i = 0; i < low; i++) done.add(i);
        let next = low;
        let failures = resume ? resume.failures || 0 : 0;
        let stopSig = null;
        let fatal = null;

        const advance = (i) => {
          done.add(i);
          while (done.has(low)) low++;
          if (top) rt.checkpoint({ stepId: step.id, kind: "for_each", items: list, next: low, results: results.slice(0, low), failures });
        };

        const worker = async () => {
          while (!stopSig && !fatal) {
            const i = next++;
            if (i >= list.length) return;
            const c = iterCtx(ctx, as, list[i], loopInfo(i, list.length));
            c.__conc = conc; // the per-host gate starts at the loop's concurrency
            try {
              const sig = await execSteps(step.steps, c, rt, path + "[]", depth + 1);
              settleIter(ctx, c);
              if (sig) {
                stopSig = sig;
                return;
              }
              if (step.collect && step.collect.value !== undefined) results[i] = renderDeep(step.collect.value, c);
            } catch (err) {
              settleIter(ctx, c);
              if (!err.item) err.item = { loop: path, index: i, value: clipOut(list[i]).slice(0, 160) };
              // Run budgets always end the run (it can resume); other item
              // failures may be skipped.
              if (step.on_item_error === "continue" && !err.budget && !String(err.message).includes("stopped: ")) {
                failures++;
                if (!r.failedItems) r.failedItems = [];
                if (r.failedItems.length < 25) r.failedItems.push({ index: i, value: clipOut(list[i]).slice(0, 120), reason: String(err.reason || err.message).slice(0, 200) });
              } else {
                fatal = err;
                return;
              }
            }
            advance(i);
            if (step.delay_ms && next < list.length) await sleep(Math.min(Number(step.delay_ms) || 0, 60000));
          }
        };
        await Promise.all(Array.from({ length: Math.min(conc, Math.max(1, list.length - next)) }, worker));
        if (fatal) {
          // Keep what finished: the partial list is still usable after a failure.
          if (step.collect) ctx.vars[step.collect.save_as || step.id] = shapeList(results.filter((x) => x !== undefined), step.collect);
          throw fatal;
        }

        let collected = [];
        if (step.collect) {
          collected = shapeList(results.filter((x) => x !== undefined), step.collect);
          ctx.vars[step.collect.save_as || step.id] = collected;
        }
        ctx.steps[step.id] = { body: collected, count: list.length, failed: failures, ok: true };
        r.output =
          `${list.length} item${list.length === 1 ? "" : "s"}` +
          (conc > 1 ? `, ${conc} at a time` : "") +
          (items.length > list.length ? ` (stopped at max ${max} of ${items.length})` : "") +
          (failures ? `, ${failures} failed` : "") +
          (resume ? `, resumed at ${resume.next + 1}` : "") +
          (step.collect ? ` → vars.${step.collect.save_as || step.id} (${collected.length})` : "");
        return stopSig;
      }

      case "repeat": {
        const top = depth === 1;
        const resume = top && rt.resume && rt.resume.stepId === step.id && rt.resume.kind === "repeat" ? rt.resume : null;
        if (resume) rt.resume = null;
        const max = Math.min(Math.max(1, Number(step.max) || 10), 5000);
        let i = resume ? resume.next : 0;
        const results = resume && Array.isArray(resume.results) ? resume.results.slice() : [];
        let reason = `reached max ${max}`;
        const prevLoop = ctx.loop;
        try {
          for (; i < max; i++) {
            ctx.loop = loopInfo(i, max);
            if (step.while && !evalWhen(step.while, ctx)) {
              reason = "while became false";
              break;
            }
            const sig = await execSteps(step.steps, ctx, rt, path + "[]", depth + 1);
            if (sig) return sig;
            // Collect each pass's value (e.g. a page's rank_list) as we go.
            if (step.collect && step.collect.value !== undefined) results.push(renderDeep(step.collect.value, ctx));
            if (top) rt.checkpoint({ stepId: step.id, kind: "repeat", next: i + 1, results });
            if (step.until && evalWhen(step.until, ctx)) {
              i++;
              reason = "until became true";
              break;
            }
            if (step.delay_ms) await sleep(Math.min(Number(step.delay_ms) || 0, 60000));
          }
        } catch (err) {
          // Keep the pages gathered so far, and say which pass stopped.
          if (step.collect) ctx.vars[step.collect.save_as || step.id] = shapeList(results, step.collect);
          if (!err.item) err.item = { loop: path, index: i, value: `pass ${i + 1}` };
          throw err;
        } finally {
          ctx.loop = prevLoop;
        }
        let collected = [];
        if (step.collect) {
          collected = shapeList(results, step.collect);
          ctx.vars[step.collect.save_as || step.id] = collected;
        }
        ctx.steps[step.id] = { count: i, body: collected, ok: true };
        r.output =
          `${i} iteration${i === 1 ? "" : "s"}, ${reason}` +
          (resume ? `, resumed at ${resume.next + 1}` : "") +
          (step.collect ? ` → vars.${step.collect.save_as || step.id} (${collected.length})` : "");
        return null;
      }

      case "if": {
        const yes = evalWhen(step.condition, ctx);
        r.output = yes ? "condition true → then" : "condition false → else";
        ctx.steps[step.id] = { body: yes, ok: true };
        return execSteps(yes ? step.then : step.else, ctx, rt, path + (yes ? ".then" : ".else"), depth + 1);
      }

      case "stop": {
        const msg = render(String(step.message || ""), ctx);
        r.output = (step.outcome === "fail" ? "stopped the run as failed" : "stopped the run") + (msg ? ": " + msg : "");
        if (step.outcome === "fail") throw stepFail("stopped", msg || "stopped by a stop step");
        return new StopSignal(true, msg);
      }

      case "run_flow": {
        if ((rt.subDepth || 0) >= MAX_SUBFLOW_DEPTH) throw new StepFailure(`flows can call other flows at most ${MAX_SUBFLOW_DEPTH} deep`);
        const sub = await get(step.flow);
        if (!sub) throw new StepFailure(`no flow with id ${step.flow}`);
        const vars = Object.assign({}, sub.vars || {}, renderDeep(step.vars || {}, ctx));
        const subCtx = { vars, steps: {}, state: await getState(sub.id), trigger: ctx.trigger };
        const subRt = Object.assign({}, rt, { agg: new Map(), order: [], subDepth: (rt.subDepth || 0) + 1, onStep: null, stateDirty: false });
        let ok = true;
        let msg = "";
        try {
          await execSteps(sub.steps, subCtx, subRt, "", 1);
        } catch (err) {
          ok = false;
          msg = err.message;
        }
        rt.executed = subRt.executed;
        if (subRt.stateDirty) await setState(sub.id, subCtx.state);
        ctx.steps[step.id] = { body: subCtx.vars, ok };
        r.output = `ran “${sub.name}”` + (ok ? "" : `: ${msg}`);
        if (!ok) throw stepFail("subflow", `flow “${sub.name}” failed: ${msg}`);
        return null;
      }

      case "collect": {
        const name = String(step.collection);
        const col = rt.coll.get(name);
        const mode = step.mode || (step.key ? "upsert" : "append");
        let items = mode === "clear" ? [] : shapeList(renderDeep(step.items, ctx), { flatten: step.flatten });
        const keyOf = (x) => (step.key ? asText(getPath(x, step.key)) : null);
        let added = 0;
        let updated = 0;
        let removed = 0;
        if (mode === "clear") {
          removed = col.items.length;
          rt.coll.replace(name, []);
        } else if (mode === "replace") {
          rt.coll.replace(name, shapeList(items, { unique_by: step.key }));
          added = rt.coll.get(name).items.length;
        } else if (mode === "remove") {
          const drop = new Set(items.map((x) => (x && typeof x === "object" && step.key ? keyOf(x) : asText(x))));
          const kept = col.items.filter((x) => !drop.has(step.key ? keyOf(x) : asText(x)));
          removed = col.items.length - kept.length;
          rt.coll.replace(name, kept);
        } else {
          for (const x of items) {
            const k = keyOf(x);
            if (k !== null && k !== "") {
              const at = col.index.get(k);
              if (at !== undefined) {
                if (mode === "upsert") {
                  const prev = col.items[at];
                  col.items[at] = prev && typeof prev === "object" && x && typeof x === "object" && !Array.isArray(x) ? Object.assign({}, prev, x) : x;
                  updated++;
                }
                continue; // append with a key = append only new keys
              }
              col.index.set(k, col.items.length);
            }
            col.items.push(x);
            added++;
          }
          if (col.items.length > MAX_COLLECTION) rt.coll.replace(name, col.items.slice(-MAX_COLLECTION));
        }
        rt.coll.touch(name);
        const count = rt.coll.get(name).items.length;
        ctx.steps[step.id] = { added, updated, removed, count, ok: true };
        r.output = `${mode}: ${added} added${updated ? `, ${updated} updated` : ""}${removed ? `, ${removed} removed` : ""} → collections.${name} now ${count}`;
        return null;
      }

      case "ai": {
        if (!rt.ai) throw stepFail("ai", "AI steps need the Kimi API key set up");
        let prompt = render(step.prompt, ctx);
        if (step.json) prompt += "\n\nReply with raw JSON only.";
        const text = await rt.ai(prompt);
        let body = text;
        try {
          const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
          if (t.startsWith("{") || t.startsWith("[")) body = JSON.parse(t);
        } catch (_) {
          if (step.json) throw stepFail("ai", "Kimi did not return valid JSON");
        }
        ctx.steps[step.id] = { text, body, ok: true, status: 200 };
        r.output = clipOut(text);
        return null;
      }

      default: {
        // http
        const req = buildHttpRequest(step, ctx);
        r.method = req.method;
        r.url = req.url;
        const retry = step.retry || {};
        const explicit = retry.times != null ? Math.min(Math.max(0, Number(retry.times) || 0), 8) : null;
        // Adaptive, not blanket: no delay while the API answers normally.
        //   429 / 503      retried 3× by default, Retry-After honored, every
        //                  worker on that host pauses, and its parallelism halves
        //   502 / 504      retried 3× by default with exponential backoff
        //   network error  retried 2× by default
        //   timeout / 500  retried only when retry.times says so
        const host = hostOf(req.url);
        const gateConc = Number(ctx.__conc) || 1;
        let res;
        for (let attempt = 0; ; attempt++) {
          const wait = (rt.hostWait.get(host) || 0) - Date.now();
          if (wait > 0) await sleep(Math.min(wait, 120000));
          const gate = await hostAcquire(rt, host, gateConc);
          let outcome = "other";
          try {
            res = await rt.http(req, step);
            outcome = res.status === 429 || res.status === 503 ? "limited" : !res.error && res.status < 500 ? "ok" : "other";
          } finally {
            hostRelease(gate, outcome);
          }
          const bad = res.error || !statusOk(res.status, step.expect_status);
          if (!bad) break;
          const limited = res.status === 429 || res.status === 503;
          const gateway = res.status === 502 || res.status === 504;
          const network = !!res.error && !/timed out/i.test(res.error);
          const allowed = explicit != null ? explicit : limited || gateway ? 3 : network ? 2 : 0;
          if (!(limited || gateway || res.error || res.status >= 500) || attempt >= allowed) break;
          const backoff = (retryAfterMs(res) || Math.min(60000, (Number(retry.delay_ms) || 1000) * 2 ** attempt)) + Math.floor(Math.random() * 250);
          if (limited) rt.hostWait.set(host, Math.max(rt.hostWait.get(host) || 0, Date.now() + backoff));
          else await sleep(backoff);
          r.retries = (r.retries || 0) + 1;
        }
        const view = responseView(res);
        ctx.steps[step.id] = view;
        r.status = res.status;
        if (res.entryId) r.entryId = res.entryId;
        r.output = clipOut(view.body);
        if (res.error) throw stepFail(/timed out/i.test(res.error) ? "timeout" : "network", res.error, { url: req.url });
        if (!statusOk(res.status, step.expect_status)) {
          throw stepFail(
            res.status === 429 || res.status === 503 ? "rate_limited" : "http_status",
            `unexpected status ${res.status}${step.expect_status ? " (expected " + step.expect_status + ")" : ""}${r.retries ? ` after ${r.retries} retr${r.retries === 1 ? "y" : "ies"}` : ""}`,
            { status: res.status, url: req.url }
          );
        }
        return null;
      }
    }
  }

  // Persistent collections for one run: loaded once, written back when dirty
  // (at checkpoints and at the end), with a key index for upserts.
  function collectionStore(initial) {
    const map = new Map();
    const dirty = new Set();
    for (const name of Object.keys(initial || {})) map.set(name, { items: initial[name], index: null, key: null });
    const ensure = (name) => {
      if (!map.has(name)) map.set(name, { items: [], index: null });
      return map.get(name);
    };
    return {
      get(name) {
        const c = ensure(name);
        if (!c.index) c.index = new Map();
        return c;
      },
      replace(name, items) {
        map.set(name, { items, index: new Map() });
        dirty.add(name);
      },
      touch(name) {
        dirty.add(name);
      },
      // The plain object templates see as {{collections.<name>}}.
      view(target) {
        for (const [name, c] of map) target[name] = c.items;
        return target;
      },
      dirty: () => dirty.size > 0,
      snapshot() {
        const out = {};
        for (const [name, c] of map) if (c.items.length) out[name] = c.items;
        dirty.clear();
        return out;
      }
    };
  }

  // Keyed collections need their index rebuilt from stored items.
  function indexCollections(store, flow) {
    walk(flow.steps, (st) => {
      if (st.type !== "collect" || !st.key) return;
      const c = store.get(String(st.collection));
      if (c.index.size || !c.items.length) return;
      c.items.forEach((x, i) => {
        const k = asText(getPath(x, st.key));
        if (k !== "") c.index.set(k, i);
      });
    });
  }

  // Step results kept in a checkpoint: bodies over 256 KB are dropped so a
  // checkpoint stays writable; later steps rarely need old huge bodies.
  function slimSteps(steps) {
    const out = {};
    for (const k of Object.keys(steps)) {
      const v = steps[k];
      try {
        out[k] = JSON.stringify(v).length > 262144 ? { status: v.status, ok: v.ok, note: "body dropped from checkpoint (over 256 KB)" } : v;
      } catch (_) {}
    }
    return out;
  }

  // deps: { http(req, step) -> result, ai(prompt) -> text, onStep(aggregate),
  //         trigger, trigger_data, vars, resume, record, timeLimit, maxExec }
  async function run(flowOrId, opts) {
    const o = opts || {};
    const flow = typeof flowOrId === "string" ? await get(flowOrId) : flowOrId;
    if (!flow) throw new Error("flow not found");
    const limits = flow.limits || {};
    const persist = o.record !== false && !!flow.id;

    const startedAt = Date.now();
    let cp = null;
    if (o.resume && flow.id) {
      cp = await getCheckpoint(flow.id);
      if (!cp) throw new Error("this flow has no paused run to resume");
    } else if (persist) await setCheckpoint(flow.id, null); // a fresh run starts over

    const state = o.state !== undefined ? o.state : flow.id ? await getState(flow.id) : {};
    const store = collectionStore(o.collections !== undefined ? o.collections : flow.id ? await getCollections(flow.id) : {});
    indexCollections(store, flow);
    const ctx = {
      vars: cp ? cp.vars || {} : Object.assign({}, flow.vars || {}, o.vars || {}),
      steps: cp ? cp.steps || {} : {},
      state,
      trigger: cp ? cp.trigger || null : o.trigger_data || null
    };
    Object.defineProperty(ctx, "collections", { get: () => store.view({}), enumerable: true });

    const timeLimit = o.timeLimit || Math.round((limits.max_minutes || RUN_TIME_LIMIT / 60000) * 60000);
    const rec = {
      id: "run_" + startedAt.toString(36),
      flowId: flow.id,
      flowName: flow.name,
      trigger: o.trigger || "manual",
      startedAt,
      ok: true,
      error: ""
    };
    if (cp) rec.resumed = { from_step: cp.stepId, at_item: (cp.loop && cp.loop.next) || 0, continuation: (cp.continuations || 0) + 1 };

    let lastCp = 0;
    const rt = {
      http: o.http,
      ai: o.ai,
      onStep: o.onStep,
      agg: new Map(),
      order: [],
      logs: [],
      executed: 0,
      maxExec: o.maxExec || limits.max_steps || MAX_EXEC,
      timeLimit,
      deadline: startedAt + timeLimit,
      lastEmit: 0,
      stateDirty: false,
      subDepth: 0,
      hostWait: new Map(),
      gates: new Map(),
      coll: store,
      resume: cp && cp.loop ? Object.assign({ stepId: cp.stepId }, cp.loop) : null,
      cpStep: 0,
      checkpoint: () => {}
    };

    let itemsSavedFor = cp && cp.loop ? cp.stepId : null; // the item list is stored once per loop
    const writeCheckpoint = async (loop, nextStep) => {
      if (!persist) return;
      lastCp = Date.now();
      const cpNew = {
        flowId: flow.id,
        jobStartedAt: cp ? cp.jobStartedAt : startedAt,
        continuations: cp ? (cp.continuations || 0) + 1 : 0,
        active: true,
        heartbeat: lastCp,
        stepIndex: nextStep,
        stepId: loop ? loop.stepId : (flow.steps[nextStep] || {}).id,
        loop: loop
          ? { kind: loop.kind, next: loop.next, results: loop.results, failures: loop.failures, itemsCount: loop.items ? loop.items.length : loop.itemsCount }
          : null,
        vars: ctx.vars,
        steps: slimSteps(ctx.steps),
        trigger: ctx.trigger,
        trigger_kind: cp ? cp.trigger_kind : rec.trigger
      };
      // One storage write for progress, results and memory together, so a
      // crash can never leave a checkpoint pointing past unsaved results.
      const payload = { [CP_PREFIX + flow.id]: JSON.parse(JSON.stringify(cpNew)) };
      if (loop && loop.items && itemsSavedFor !== loop.stepId) payload[CP_PREFIX + flow.id + ITEMS_SUFFIX] = loop.items;
      const dirty = store.dirty();
      if (dirty) payload[DATA_PREFIX + flow.id] = { collections: store.snapshot() };
      try {
        if (rt.stateDirty) payload[stateKey(flow.id)] = JSON.parse(JSON.stringify(ctx.state || {}));
        await KV.set(payload);
        if (payload[CP_PREFIX + flow.id + ITEMS_SUFFIX]) itemsSavedFor = loop.stepId;
      } catch (_) {
        if (dirty) for (const name of Object.keys(payload[DATA_PREFIX + flow.id].collections)) store.touch(name); // try again next time
      }
    };
    // Writes are chained so a slow write can never land after a newer one.
    let cpChain = Promise.resolve();
    const queueCheckpoint = (loop, nextStep) => (cpChain = cpChain.then(() => writeCheckpoint(loop, nextStep)).catch(() => {}));
    // Loops call this after every finished item / pass; it writes at most
    // every couple of seconds.
    rt.checkpoint = (loop) => {
      rt.lastLoop = Object.assign({}, loop);
      if (Date.now() - lastCp >= CHECKPOINT_EVERY_MS) {
        lastCp = Date.now();
        queueCheckpoint(rt.lastLoop, rt.cpStep);
      }
    };

    let startIndex = 0;
    if (cp) {
      startIndex = flow.steps.findIndex((st) => st.id === cp.stepId);
      if (startIndex < 0) {
        throw new Error(`the paused run stopped at step "${cp.stepId}", which this flow no longer has — discard the paused run and start again`);
      }
    }

    // Mark the run as in progress before any step: if the worker is stopped
    // during the first (possibly long) step, the watchdog still finds it.
    if (persist && !cp) await queueCheckpoint(null, 0);

    let paused = false;
    try {
      for (let i = startIndex; i < flow.steps.length; i++) {
        rt.cpStep = i;
        // A resumed loop's saved progress stands until the loop makes more.
        rt.lastLoop = cp && cp.loop && i === startIndex ? Object.assign({ stepId: cp.stepId }, cp.loop) : null;
        const sig = await execStep(flow.steps[i], ctx, rt, "", 1);
        if (persist) await queueCheckpoint(null, i + 1); // every finished top-level step is durable
        if (sig) {
          if (sig.message) rec.note = sig.message;
          break;
        }
      }
    } catch (err) {
      const msg = String((err && err.message) || err).slice(0, 500);
      rec.failure = {
        kind: (err && err.kind) || "error",
        step: (err && err.step) || (flow.steps[rt.cpStep] || {}).id,
        reason: String((err && (err.reason || err.message)) || "").slice(0, 400),
        status: err && err.status,
        url: err && err.url,
        item: err && err.item
      };
      if (err && err.budget && persist) {
        // Out of budget: not a failure. Save where we are so it can go on.
        paused = true;
        rec.paused = true;
        rec.note = msg.replace(/^step "[^"]*" failed: /, "");
        await queueCheckpoint(rt.lastLoop, rt.cpStep);
      } else {
        rec.ok = false;
        rec.error = msg;
        // Keep progress made inside a big loop — or carried over from an
        // earlier run — so "Resume" picks up from there.
        if (persist && rt.lastLoop && rt.lastLoop.next > 0) {
          await queueCheckpoint(rt.lastLoop, rt.cpStep);
          rec.resumable = true;
        } else if (persist && cp) {
          await queueCheckpoint(cp.loop ? Object.assign({ stepId: cp.stepId }, cp.loop) : null, rt.cpStep);
          rec.resumable = true;
        }
      }
    }

    await cpChain;
    if (persist) {
      if (paused || rec.resumable) {
        const saved = await getCheckpointRaw(flow.id);
        if (saved) {
          saved.active = false;
          saved.paused_reason = paused ? "budget" : "failed";
          saved.failure = rec.failure;
          await KV.set({ [CP_PREFIX + flow.id]: saved }).catch(() => {});
          rec.progress = saved.loop ? { step: saved.stepId, next: saved.loop.next, of: saved.loop.itemsCount || null } : { step: saved.stepId };
        }
      } else await setCheckpoint(flow.id, null);
      if (store.dirty()) await setCollections(flow.id, store.snapshot()).catch(() => {});
      if (rt.stateDirty) await setState(flow.id, ctx.state);
    }

    rec.finishedAt = Date.now();
    rec.ms = rec.finishedAt - startedAt;
    rec.steps = rt.order;
    rec.logs = rt.logs;
    rec.executed = rt.executed;
    rec.vars = {};
    for (const k of Object.keys(ctx.vars)) rec.vars[k] = clipOut(ctx.vars[k]).slice(0, 500);
    rec.state = {};
    for (const k of Object.keys(ctx.state || {})) rec.state[k] = clipOut(ctx.state[k]).slice(0, 500);
    rec.collections = {};
    const view = store.view({});
    for (const k of Object.keys(view)) rec.collections[k] = view[k].length;
    // What survives a failure or pause: stored collections and partial lists.
    if (!rec.ok || rec.paused) {
      rec.preserved = { collections: rec.collections, partial_vars: [] };
      walk(flow.steps, (st) => {
        if (st.collect && ctx.vars[st.collect.save_as || st.id] !== undefined) rec.preserved.partial_vars.push(st.collect.save_as || st.id);
      });
    }
    rec.rate = {};
    for (const [h, g] of rt.gates) if (g.lowest < g.max) rec.rate[h] = { slowed_to: g.lowest, now: g.limit, of: g.max };
    if (o.record !== false) await recordRun(rec);
    return rec;
  }

  // Walks every step, nested ones included: fn(step, depth, parentKey).
  function walk(steps, fn, depth, key) {
    for (const s of steps || []) {
      fn(s, depth || 1, key || "");
      for (const [k, l] of childLists(s)) walk(l, fn, (depth || 1) + 1, k);
    }
  }

  return {
    list,
    get,
    save,
    remove,
    run,
    runs,
    validate,
    syncAlarms,
    render,
    renderDeep,
    evalWhen,
    getPath,
    getState,
    setState,
    getCollections,
    setCollections,
    getCheckpoint,
    getCheckpointRaw,
    markCheckpoint,
    KV, // shared with background.js for conversations and docs
    setCheckpoint,
    check,
    analyze,
    MAX_CONTINUATIONS,
    matchesRequest,
    walk,
    childLists,
    TYPES,
    FILTERS: Object.keys(FILTERS)
  };
})();
