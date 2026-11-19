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
  const MAX_EXEC = 2000; // step executions per run, loops included
  const RUN_TIME_LIMIT = 240000; // ms per run
  const MAX_SUBFLOW_DEPTH = 3;
  const OUT_MAX = 4000;
  const LOG_MAX = 200;

  const TYPES = ["http", "ai", "delay", "set", "filter", "map", "for_each", "repeat", "if", "stop", "log", "run_flow"];
  const RESERVED = new Set(["vars", "steps", "state", "trigger", "loop", "now", "now_iso", "today", "uuid"]);

  const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
  const newId = () => "fl_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------ storage */

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

  async function getState(id) {
    try {
      const got = await chrome.storage.local.get(STATE_KEY);
      return Object.assign({}, (got[STATE_KEY] || {})[id] || {});
    } catch (_) {
      return {};
    }
  }

  async function setState(id, state) {
    try {
      const got = await chrome.storage.local.get(STATE_KEY);
      const all = got[STATE_KEY] || {};
      if (state && Object.keys(state).length) all[id] = state;
      else delete all[id];
      await chrome.storage.local.set({ [STATE_KEY]: all });
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
    if (errors.length) {
      const err = new Error("Invalid flow: " + errors.join("; "));
      err.errors = errors;
      throw err;
    }
    return f;
  }

  async function save(input) {
    const f = validate(input);
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
    await syncAlarms();
    return f;
  }

  async function remove(id) {
    const flows = await list();
    const next = flows.filter((f) => f.id !== id);
    await writeAll(next);
    try {
      const got = await chrome.storage.local.get(RUNS_KEY);
      const runs = got[RUNS_KEY] || {};
      delete runs[id];
      await chrome.storage.local.set({ [RUNS_KEY]: runs });
    } catch (_) {}
    await setState(id, null);
    await syncAlarms();
    return next.length !== flows.length;
  }

  async function runs(id) {
    try {
      const got = await chrome.storage.local.get(RUNS_KEY);
      return ((got[RUNS_KEY] || {})[id] || []).slice();
    } catch (_) {
      return [];
    }
  }

  async function recordRun(run) {
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
        f.lastRun = { id: run.id, at: run.startedAt, ok: run.ok, ms: run.ms, error: run.error || "", trigger: run.trigger };
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

  /* ---------------------------------------------------------------- run */

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

  async function withLoopScope(ctx, as, fn) {
    const prevItem = Object.prototype.hasOwnProperty.call(ctx, as) ? ctx[as] : undefined;
    const prevLoop = ctx.loop;
    try {
      return await fn();
    } finally {
      if (prevItem === undefined) delete ctx[as];
      else ctx[as] = prevItem;
      ctx.loop = prevLoop;
    }
  }

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
    if (++rt.executed > MAX_EXEC) throw new StepFailure(`stopped: more than ${MAX_EXEC} step runs in one flow run — lower a loop's max`);
    if (Date.now() > rt.deadline) throw new StepFailure(`stopped: the run took longer than ${RUN_TIME_LIMIT / 1000} s`);

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
      if (err instanceof StepFailure && err.fromChild) failed = err;
      else failed = err instanceof StepFailure ? err : new StepFailure(String((err && err.message) || err));
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
      if (step.continue_on_error) return null;
      const e = new StepFailure(failed.fromChild ? failed.message : `step "${path}" failed: ${failed.message}`);
      e.fromChild = true;
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
        const items = resolveItems(step.items, ctx);
        const as = step.as || "item";
        const out = await withLoopScope(ctx, as, async () => {
          const acc = [];
          for (let i = 0; i < items.length; i++) {
            ctx[as] = items[i];
            ctx.loop = { index: i, number: i + 1, count: items.length, first: i === 0, last: i === items.length - 1 };
            if (step.type === "filter") {
              if (evalWhen(step.where, ctx)) acc.push(items[i]);
              if (step.limit && acc.length >= Number(step.limit)) break;
            } else acc.push(renderDeep(step.value, ctx));
          }
          return acc;
        });
        const name = step.save_as || step.id;
        ctx.vars[name] = out;
        ctx.steps[step.id] = { body: out, count: out.length, ok: true };
        r.output = `${step.type === "filter" ? "kept" : "made"} ${out.length} of ${items.length} → vars.${name}`;
        return null;
      }

      case "for_each": {
        const items = resolveItems(step.items, ctx);
        const max = Math.min(Math.max(1, Number(step.max) || 100), 1000);
        const as = step.as || "item";
        const list = items.slice(0, max);
        const collected = [];
        let failures = 0;
        const sig = await withLoopScope(ctx, as, async () => {
          for (let i = 0; i < list.length; i++) {
            ctx[as] = list[i];
            ctx.loop = { index: i, number: i + 1, count: list.length, first: i === 0, last: i === list.length - 1 };
            try {
              const s = await execSteps(step.steps, ctx, rt, path + "[]", depth + 1);
              if (s) return s;
              if (step.collect && step.collect.value !== undefined) collected.push(renderDeep(step.collect.value, ctx));
            } catch (err) {
              // Run limits ("stopped: …") always end the run, even mid-loop.
              if (step.on_item_error === "continue" && !String(err.message).includes("stopped: ")) {
                failures++;
                continue;
              }
              throw err;
            }
            if (step.delay_ms && i < list.length - 1) await sleep(Math.min(Number(step.delay_ms) || 0, 60000));
          }
          return null;
        });
        if (step.collect) ctx.vars[step.collect.save_as || step.id] = collected;
        ctx.steps[step.id] = { body: collected, count: list.length, failed: failures, ok: true };
        r.output =
          `${list.length} item${list.length === 1 ? "" : "s"}` +
          (items.length > list.length ? ` (stopped at max ${max} of ${items.length})` : "") +
          (failures ? `, ${failures} failed` : "") +
          (step.collect ? ` → vars.${step.collect.save_as || step.id}` : "");
        return sig;
      }

      case "repeat": {
        const max = Math.min(Math.max(1, Number(step.max) || 10), 500);
        let i = 0;
        let reason = `reached max ${max}`;
        const prevLoop = ctx.loop;
        try {
          for (; i < max; i++) {
            ctx.loop = { index: i, number: i + 1, count: max, first: i === 0, last: i === max - 1 };
            if (step.while && !evalWhen(step.while, ctx)) {
              reason = "while became false";
              break;
            }
            const s = await execSteps(step.steps, ctx, rt, path + "[]", depth + 1);
            if (s) return s;
            if (step.until && evalWhen(step.until, ctx)) {
              i++;
              reason = "until became true";
              break;
            }
            if (step.delay_ms) await sleep(Math.min(Number(step.delay_ms) || 0, 60000));
          }
        } finally {
          ctx.loop = prevLoop;
        }
        ctx.steps[step.id] = { count: i, ok: true };
        r.output = `${i} iteration${i === 1 ? "" : "s"}, ${reason}`;
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
        if (step.outcome === "fail") throw new StepFailure(msg || "stopped by a stop step");
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
        if (!ok) throw new StepFailure(`flow “${sub.name}” failed: ${msg}`);
        return null;
      }

      case "ai": {
        if (!rt.ai) throw new StepFailure("AI steps need the Kimi API key set up");
        let prompt = render(step.prompt, ctx);
        if (step.json) prompt += "\n\nReply with raw JSON only.";
        const text = await rt.ai(prompt);
        let body = text;
        try {
          const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
          if (t.startsWith("{") || t.startsWith("[")) body = JSON.parse(t);
        } catch (_) {
          if (step.json) throw new StepFailure("Kimi did not return valid JSON");
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
        const times = Math.min(Math.max(0, Number(retry.times) || 0), 5);
        let res;
        for (let attempt = 0; ; attempt++) {
          res = await rt.http(req, step);
          const bad = res.error || !statusOk(res.status, step.expect_status);
          const retryable = res.error || res.status === 429 || res.status >= 500;
          if (!bad || !retryable || attempt >= times) break;
          await sleep(Math.min(Number(retry.delay_ms) || 1000 * (attempt + 1), 30000));
        }
        const view = responseView(res);
        ctx.steps[step.id] = view;
        r.status = res.status;
        if (res.entryId) r.entryId = res.entryId;
        r.output = clipOut(view.body);
        if (res.error) throw new StepFailure(res.error);
        if (!statusOk(res.status, step.expect_status)) {
          throw new StepFailure(`unexpected status ${res.status}${step.expect_status ? " (expected " + step.expect_status + ")" : ""}`);
        }
        return null;
      }
    }
  }

  // deps: { http(req, step) -> result, ai(prompt) -> text, onStep(aggregate),
  //         trigger, vars, record }
  async function run(flowOrId, opts) {
    const o = opts || {};
    const flow = typeof flowOrId === "string" ? await get(flowOrId) : flowOrId;
    if (!flow) throw new Error("flow not found");

    const startedAt = Date.now();
    const state = o.state !== undefined ? o.state : flow.id ? await getState(flow.id) : {};
    const ctx = { vars: Object.assign({}, flow.vars || {}, o.vars || {}), steps: {}, state, trigger: o.trigger_data || null };
    const rt = {
      http: o.http,
      ai: o.ai,
      onStep: o.onStep,
      agg: new Map(),
      order: [],
      logs: [],
      executed: 0,
      deadline: startedAt + (o.timeLimit || RUN_TIME_LIMIT),
      lastEmit: 0,
      stateDirty: false,
      subDepth: 0
    };
    const rec = {
      id: "run_" + startedAt.toString(36),
      flowId: flow.id,
      flowName: flow.name,
      trigger: o.trigger || "manual",
      startedAt,
      ok: true,
      error: ""
    };

    try {
      const sig = await execSteps(flow.steps, ctx, rt, "", 1);
      if (sig && sig.message) rec.note = sig.message;
    } catch (err) {
      rec.ok = false;
      rec.error = String((err && err.message) || err).slice(0, 500);
    }

    if (rt.stateDirty && flow.id && o.record !== false) await setState(flow.id, ctx.state);
    rec.finishedAt = Date.now();
    rec.ms = rec.finishedAt - startedAt;
    rec.steps = rt.order;
    rec.logs = rt.logs;
    rec.executed = rt.executed;
    rec.vars = {};
    for (const k of Object.keys(ctx.vars)) rec.vars[k] = clipOut(ctx.vars[k]).slice(0, 500);
    rec.state = {};
    for (const k of Object.keys(ctx.state || {})) rec.state[k] = clipOut(ctx.state[k]).slice(0, 500);
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
    matchesRequest,
    walk,
    childLists,
    TYPES,
    FILTERS: Object.keys(FILTERS)
  };
})();
