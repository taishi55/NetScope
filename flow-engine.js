/* NetScope – flow-engine.js
 * Flows: saved, chainable API automations ("call A, take a field from its
 * response, call B"), runnable on demand or on a schedule. Runs in the
 * background worker so schedules fire with the popup closed.
 *
 * A flow:
 *   { id, name, description, vars: {…},
 *     schedule: { enabled, every_minutes },
 *     steps: [
 *       { id: "login", type: "http", method, url, headers: {…}, body, query: {…},
 *         curl: "curl …"            // alternative to method/url/headers/body
 *         extract: { token: "body.data.token" },
 *         expect_status: "2xx",      // default: any 2xx/3xx
 *         when: "{{vars.token}} exists",
 *         continue_on_error: false },
 *       { id: "summary", type: "ai", prompt: "Summarize {{steps.login.body | json}}" },
 *       { id: "wait", type: "delay", ms: 1000 } ] }
 *
 * Templates: {{vars.x}}, {{steps.<id>.status|body.<path>|headers.<name>|text}},
 * {{now}}, {{now_iso}}, {{today}}, {{uuid}}; filters: | json | urlencode |
 * first | last | length | trim | upper | lower. A JSON body leaf that is exactly
 * one template keeps the value's type (number, object …).
 */
"use strict";

globalThis.__netscopeFlows = (() => {
  const FLOWS_KEY = "netscope.flows";
  const RUNS_KEY = "netscope.flowRuns";
  const MAX_RUNS = 15;
  const MAX_STEPS = 25;
  const OUT_MAX = 4000;

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const newId = () => "fl_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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

  function validate(input) {
    const f = clone(input || {});
    const errors = [];
    if (!f.name || typeof f.name !== "string") errors.push("name is required");
    if (!Array.isArray(f.steps) || !f.steps.length) errors.push("steps must be a non-empty array");
    else if (f.steps.length > MAX_STEPS) errors.push(`at most ${MAX_STEPS} steps`);
    const seen = new Set();
    (f.steps || []).forEach((s, i) => {
      if (!s || typeof s !== "object") return errors.push(`step ${i + 1} is not an object`);
      s.type = s.type || (s.prompt ? "ai" : s.ms != null ? "delay" : "http");
      if (!s.id) s.id = "s" + (i + 1);
      s.id = String(s.id).replace(/[^A-Za-z0-9_]/g, "_");
      if (seen.has(s.id)) errors.push(`duplicate step id "${s.id}"`);
      seen.add(s.id);
      if (s.type === "http" && !s.url && !s.curl) errors.push(`step "${s.id}" needs url or curl`);
      if (s.type === "ai" && !s.prompt) errors.push(`step "${s.id}" needs a prompt`);
      if (!["http", "ai", "delay"].includes(s.type)) errors.push(`step "${s.id}" has unknown type "${s.type}"`);
    });
    const sch = f.schedule || {};
    let every = Number(sch.every_minutes || 0);
    if (sch.enabled && (!every || every < 1)) errors.push("schedule.every_minutes must be at least 1");
    if (every > 10080) every = 10080;
    f.schedule = { enabled: !!sch.enabled && every >= 1, every_minutes: every || 60 };
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
        // Allow drilling into a JSON string body.
        try {
          cur = JSON.parse(cur);
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

  function lookup(ctx, expr) {
    const [head, ...filters] = expr.split("|").map((s) => s.trim());
    let v;
    if (head === "now") v = Date.now();
    else if (head === "now_iso") v = new Date().toISOString();
    else if (head === "today") v = new Date().toISOString().slice(0, 10);
    else if (head === "uuid") v = uuid();
    else if (/^(["']).*\1$/.test(head)) v = head.slice(1, -1);
    else v = getPath(ctx, head);
    for (const f of filters) {
      if (f === "json") v = JSON.stringify(v === undefined ? null : v);
      else if (f === "urlencode") v = encodeURIComponent(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
      else if (f === "first") v = Array.isArray(v) ? v[0] : v;
      else if (f === "last") v = Array.isArray(v) ? v[v.length - 1] : v;
      else if (f === "length") v = v == null ? 0 : v.length != null ? v.length : Object.keys(v).length;
      else if (f === "trim") v = v == null ? "" : String(v).trim();
      else if (f === "upper") v = v == null ? "" : String(v).toUpperCase();
      else if (f === "lower") v = v == null ? "" : String(v).toLowerCase();
      else if (f.startsWith("default:")) v = v == null || v === "" ? f.slice(8).trim() : v;
    }
    return v;
  }

  const TEMPLATE = /\{\{\s*([^}]+?)\s*\}\}/g;
  const asText = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

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

  function evalWhen(expr, ctx) {
    if (expr == null || expr === "") return true;
    if (typeof expr === "boolean") return expr;
    const raw = String(expr);
    const holes = [];
    const masked = raw.replace(TEMPLATE, (m) => {
      holes.push(m);
      return `\u0001${holes.length - 1}\u0002`;
    });
    const unmask = (s) => s.replace(/\u0001(\d+)\u0002/g, (_, i) => holes[Number(i)]);
    const val = (s) => {
      const t = unmask(s).trim();
      const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(t);
      if (whole) return lookup(ctx, whole[1]);
      return render(t.replace(/^(["'])(.*)\1$/, "$2"), ctx);
    };
    for (const op of OPS) {
      const re = new RegExp(`^(.*?)\\s+${op.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+(.*))?$`);
      const m = re.exec(masked);
      if (!m) continue;
      const a = val(m[1]);
      if (op === "exists") return a !== undefined && a !== null && a !== "";
      if (op === "missing") return a === undefined || a === null || a === "";
      const b = val(m[2] || "");
      const na = Number(a);
      const nb = Number(b);
      const numeric = a !== "" && b !== "" && !isNaN(na) && !isNaN(nb) && typeof a !== "object";
      if (op === "==") return numeric ? na === nb : asText(a) === asText(b);
      if (op === "!=") return numeric ? na !== nb : asText(a) !== asText(b);
      if (op === ">") return numeric && na > nb;
      if (op === "<") return numeric && na < nb;
      if (op === ">=") return numeric && na >= nb;
      if (op === "<=") return numeric && na <= nb;
      if (op === "contains") return asText(a).includes(asText(b));
      if (op === "!contains") return !asText(a).includes(asText(b));
      if (op === "matches") {
        try {
          return new RegExp(asText(b)).test(asText(a));
        } catch (_) {
          return false;
        }
      }
    }
    const v = val(masked);
    return !(v === undefined || v === null || v === "" || v === false || v === 0 || /^(false|0|null|undefined)$/i.test(String(v)));
  }

  function statusOk(status, expect) {
    if (!expect) return status >= 200 && status < 400;
    return String(expect)
      .split(",")
      .map((s) => s.trim())
      .some((q) => (/^[1-5]xx$/i.test(q) ? Math.floor(status / 100) === Number(q[0]) : Number(q) === status));
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
      for (const k of Object.keys(q)) u.searchParams.set(k, asText(q[k]));
      req.url = u.toString();
    }
    return req;
  }

  function responseView(res) {
    let body = res.body;
    if (typeof body === "string" && /json/i.test(res.mime || "")) {
      try {
        body = JSON.parse(body);
      } catch (_) {}
    } else if (typeof body === "string") {
      const t = body.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          body = JSON.parse(t);
        } catch (_) {}
      }
    }
    const headers = {};
    for (const h of res.headers || []) headers[String(h.name).toLowerCase()] = h.value;
    return { status: res.status, ok: !!res.ok, status_text: res.statusText || "", headers, body, text: res.body || "", ms: res.ms, url: res.url };
  }

  const clipOut = (v) => {
    const s = asText(v);
    return s.length > OUT_MAX ? s.slice(0, OUT_MAX) + "…" : s;
  };

  // deps: { http(req) -> result, ai(prompt) -> text, onStep(stepResult) }
  async function run(flowOrId, opts) {
    const o = opts || {};
    const flow = typeof flowOrId === "string" ? await get(flowOrId) : flowOrId;
    if (!flow) throw new Error("flow not found");

    const startedAt = Date.now();
    const ctx = { vars: Object.assign({}, flow.vars || {}, o.vars || {}), steps: {} };
    const rec = {
      id: "run_" + startedAt.toString(36),
      flowId: flow.id,
      flowName: flow.name,
      trigger: o.trigger || "manual",
      startedAt,
      steps: [],
      ok: true,
      error: ""
    };

    for (const step of flow.steps) {
      const sr = { id: step.id, name: step.name || "", type: step.type, ok: true, skipped: false };
      const t0 = Date.now();
      try {
        if (!evalWhen(step.when, ctx)) {
          sr.skipped = true;
          sr.note = "condition was false: " + String(step.when).slice(0, 120);
        } else if (step.type === "delay") {
          const ms = Math.min(Math.max(0, Number(step.ms) || 0), 60000);
          await new Promise((r) => setTimeout(r, ms));
          sr.output = `waited ${ms} ms`;
        } else if (step.type === "ai") {
          if (!o.ai) throw new Error("AI steps need the Kimi API key set up");
          const text = await o.ai(render(step.prompt, ctx));
          let body = text;
          try {
            const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
            if (t.startsWith("{") || t.startsWith("[")) body = JSON.parse(t);
          } catch (_) {}
          ctx.steps[step.id] = { text, body, ok: true, status: 200 };
          sr.output = clipOut(text);
        } else {
          const req = buildHttpRequest(step, ctx);
          sr.method = req.method;
          sr.url = req.url;
          const res = await o.http(req, step);
          const view = responseView(res);
          ctx.steps[step.id] = view;
          sr.status = res.status;
          if (res.entryId) sr.entryId = res.entryId;
          if (res.error) throw new Error(res.error);
          if (!statusOk(res.status, step.expect_status)) {
            sr.output = clipOut(view.body);
            throw new Error(`unexpected status ${res.status}${step.expect_status ? " (expected " + step.expect_status + ")" : ""}`);
          }
          sr.output = clipOut(view.body);
        }

        if (!sr.skipped && step.extract && typeof step.extract === "object") {
          sr.extracted = {};
          const local = ctx.steps[step.id] || {};
          for (const name of Object.keys(step.extract)) {
            const path = String(step.extract[name]);
            const v = /^(vars|steps)\./.test(path) ? getPath(ctx, path) : getPath(local, path);
            ctx.vars[name] = v;
            sr.extracted[name] = clipOut(v).slice(0, 300);
          }
        }
      } catch (err) {
        sr.ok = false;
        sr.error = String((err && err.message) || err).slice(0, 400);
      }
      sr.ms = Date.now() - t0;
      rec.steps.push(sr);
      if (o.onStep) {
        try {
          o.onStep(sr);
        } catch (_) {}
      }
      if (!sr.ok && !step.continue_on_error) {
        rec.ok = false;
        rec.error = `step "${step.id}" failed: ${sr.error}`;
        break;
      }
    }

    rec.finishedAt = Date.now();
    rec.ms = rec.finishedAt - startedAt;
    rec.vars = {};
    for (const k of Object.keys(ctx.vars)) rec.vars[k] = clipOut(ctx.vars[k]).slice(0, 500);
    if (o.record !== false) await recordRun(rec);
    return rec;
  }

  return { list, get, save, remove, run, runs, validate, syncAlarms, render, renderDeep, evalWhen, getPath };
})();
