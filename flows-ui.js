/* NetScope – flows-ui.js
 * The Flows view: saved flows and bots — their step trees (loops, branches),
 * schedules, page-request triggers, memory and run history.
 * Flows are stored and run by the background worker (flow-engine.js); this
 * file only renders them and sends commands over the app's port.
 */
"use strict";

window.__netscopeFlowsUi = (() => {
  let api = null;
  let flows = [];
  const open = new Set(); // flow ids whose steps are expanded
  const runsCache = new Map(); // flow id -> runs[]
  const live = new Map(); // flow id -> step results while a manual run is in flight
  const stateCache = new Map(); // flow id -> memory ({{state.x}}) kept between runs
  const collCache = new Map(); // flow id -> { name: { count, fields, sample } }
  const cpCache = new Map(); // flow id -> paused-run checkpoint summary, or null
  let editing = null; // flow being edited as JSON (null = list)

  const $ = (id) => document.getElementById(id);
  const say = (m) => typeof toast === "function" && toast(m);

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function btn(label, fn, cls) {
    const b = node("button", cls || "", label);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }

  const SCHEDULES = [
    [0, "Manual only"],
    [5, "Every 5 min"],
    [15, "Every 15 min"],
    [30, "Every 30 min"],
    [60, "Every hour"],
    [360, "Every 6 hours"],
    [1440, "Every day"]
  ];

  // A small bot: only acts on posts it has not seen before, thanks to state.
  const TEMPLATE = {
    name: "New posts digest",
    description: "Every hour: fetch posts, keep user 1's posts newer than last time, look up each one's comment count, remember the newest id.",
    steps: [
      { id: "list", type: "http", method: "GET", url: "https://jsonplaceholder.typicode.com/posts", expect_status: "2xx", retry: { times: 2, delay_ms: 1000 } },
      {
        id: "fresh",
        type: "filter",
        items: "{{steps.list.body}}",
        where: "{{item.userId}} == 1 and {{item.id}} > {{state.last_id | default:0}}",
        limit: 5
      },
      {
        id: "any_new",
        type: "if",
        condition: "{{vars.fresh | length}} > 0",
        then: [
          {
            id: "each_post",
            type: "for_each",
            items: "{{vars.fresh}}",
            as: "post",
            max: 5,
            delay_ms: 200,
            on_item_error: "continue",
            collect: { save_as: "digest", value: { id: "{{post.id}}", title: "{{post.title}}", comments: "{{steps.comments.body | length}}" } },
            steps: [{ id: "comments", type: "http", method: "GET", url: "https://jsonplaceholder.typicode.com/posts/{{post.id}}/comments" }]
          },
          { id: "remember", type: "set", state: { last_id: "{{vars.fresh | pluck:id | max}}" } },
          { id: "report", type: "log", message: "{{vars.digest | length}} new: {{vars.digest | pluck:title | join:\", \"}}" }
        ],
        else: [{ id: "quiet", type: "stop", outcome: "ok", message: "nothing new since post {{state.last_id}}" }]
      }
    ],
    schedule: { enabled: false, every_minutes: 60 }
  };

  /* ------------------------------------------------------------ data */

  async function load() {
    try {
      flows = await api.rpc("flows.list");
    } catch (_) {
      flows = [];
    }
    // Every card's run history, fetched up front: "Copy as Markdown" needs it
    // and must write the clipboard while the click's activation still holds.
    await Promise.all(
      flows.flatMap((f) => [
        api
          .rpc("flows.runs", { id: f.id })
          .then((r) => runsCache.set(f.id, r))
          .catch(() => {}),
        api
          .rpc("flows.state", { id: f.id })
          .then((st) => stateCache.set(f.id, st || {}))
          .catch(() => {}),
        api
          .rpc("flows.collections", { id: f.id })
          .then((c) => collCache.set(f.id, c || {}))
          .catch(() => {}),
        api
          .rpc("flows.checkpoint", { id: f.id })
          .then((c) => cpCache.set(f.id, c))
          .catch(() => {})
      ])
    );
    if (!editing) render(); // never wipe JSON the user is typing
    renderAlert();
  }

  // Runs and memory writes arrive in bursts (a bot firing on page traffic):
  // coalesce them, and only do the full reload while the Flows tab is shown.
  let loadTimer = 0;
  function scheduleLoad() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(async () => {
      if (document.getElementById("view-flows").classList.contains("on")) return load();
      try {
        flows = await api.rpc("flows.list");
      } catch (_) {}
      renderAlert();
    }, 300);
  }

  async function renderAlert() {
    const box = $("flowAlert");
    let alert = null;
    try {
      alert = await api.rpc("flows.alert");
    } catch (_) {}
    const count = $("flowsCount");
    count.textContent = flows.length ? String(flows.length) : "";
    count.classList.toggle("alert", !!alert);
    if (!alert) {
      box.hidden = true;
      return;
    }
    box.replaceChildren();
    const p = node("p");
    p.appendChild(node("strong", "", `“${alert.flowName}” failed when it ran by itself (${alert.trigger === "request" ? "page request" : "schedule"})`));
    p.appendChild(document.createTextNode(` ${typeof fmtAgo === "function" ? fmtAgo(alert.at) : ""}: ${alert.error || "unknown error"}`));
    box.appendChild(p);
    box.appendChild(
      btn("Dismiss", async () => {
        await api.rpc("flows.clearAlert").catch(() => {});
        renderAlert();
      }, "ghost")
    );
    box.hidden = false;
  }

  /* ---------------------------------------------------------- render */

  function scheduleLabel(f) {
    if (!f.schedule || !f.schedule.enabled) return "Manual only";
    const hit = SCHEDULES.find(([m]) => m === f.schedule.every_minutes);
    return hit ? hit[1] : `Every ${f.schedule.every_minutes} min`;
  }

  function methodPill(m) {
    const w = !/^(GET|HEAD|OPTIONS)$/i.test(m);
    return node("span", "method" + (w ? " write" : ""), m);
  }

  // Saved flows are validated (type is set); approval previews may not be.
  function typeOf(st) {
    if (st.type) return st.type;
    if (st.prompt) return "ai";
    if (st.then || st.condition) return "if";
    if (st.items && Array.isArray(st.steps)) return "for_each";
    if (Array.isArray(st.steps)) return "repeat";
    if (st.items && st.where) return "filter";
    if (st.items && st.value !== undefined) return "map";
    if (st.url || st.curl || st.from_id != null) return "http";
    if (st.ms != null) return "delay";
    if (st.vars || st.state) return "set";
    if (st.flow) return "run_flow";
    if (st.collection) return "collect";
    if (st.outcome) return "stop";
    if (st.message) return "log";
    return "http";
  }

  const TYPE_LABEL = {
    ai: "Kimi",
    delay: "wait",
    set: "set",
    filter: "filter",
    map: "map",
    for_each: "for each",
    repeat: "repeat",
    if: "if",
    stop: "stop",
    log: "log",
    run_flow: "flow",
    collect: "store"
  };

  const short = (v, n) => {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return t && t.length > (n || 120) ? t.slice(0, n || 120) + "…" : t || "";
  };

  function describeStep(st, t) {
    switch (t) {
      case "ai":
        return short(st.prompt, 140);
      case "delay":
        return `${st.ms || 0} ms`;
      case "set": {
        const parts = [];
        for (const scope of ["vars", "state"]) {
          if (st[scope] && typeof st[scope] === "object") for (const k of Object.keys(st[scope])) parts.push(`${scope}.${k} = ${short(st[scope][k], 50)}`);
        }
        return parts.join(", ");
      }
      case "filter":
        return `${short(st.items, 60)} where ${short(st.where, 80)} → vars.${st.save_as || st.id}${st.limit ? ` (first ${st.limit})` : ""}`;
      case "map":
        return `${short(st.items, 60)} → ${short(st.value, 60)} → vars.${st.save_as || st.id}`;
      case "for_each":
        return `${st.as || "item"} in ${short(st.items, 80)}${st.concurrency > 1 ? ` · ${st.concurrency} at a time` : ""}${st.max ? ` · max ${st.max}` : ""}${st.on_item_error === "continue" ? " · skips failed items" : ""}`;
      case "collect":
        return st.mode === "clear"
          ? `clear collections.${st.collection}`
          : `${st.mode || (st.key ? "append new" : "append")} ${short(st.items, 60)} → collections.${st.collection}${st.key ? ` by ${st.key}` : ""}`;
      case "repeat":
        return `${st.until ? "until " + short(st.until, 80) : st.while ? "while " + short(st.while, 80) : ""} · max ${st.max || 10}`;
      case "if":
        return short(st.condition, 140);
      case "stop":
        return `${st.outcome === "fail" ? "as failed" : "as done"}${st.message ? ": " + short(st.message, 100) : ""}`;
      case "log":
        return short(st.message, 140);
      case "run_flow": {
        const sub = flows.find((x) => x.id === st.flow);
        return sub ? `“${sub.name}”` : String(st.flow);
      }
      default:
        return "";
    }
  }

  function stepSummary(st) {
    const line = node("div", "step-line");
    const t = typeOf(st);
    if (t === "http") {
      if (st.curl) {
        let parsed = null;
        try {
          parsed = globalThis.__netscopeCurl.parse(st.curl);
        } catch (_) {}
        line.appendChild(methodPill(parsed ? parsed.method : "cURL"));
        line.appendChild(node("span", "url", parsed ? parsed.url : st.curl.slice(0, 100)));
      } else {
        line.appendChild(methodPill((st.method || "GET").toUpperCase()));
        line.appendChild(node("span", "url", st.url || (st.from_id != null ? `captured request #${st.from_id}` : "")));
      }
      if (st.context === "page") {
        const tag = node("span", "chip", "from page");
        tag.title = "Sent from inside an open tab on this site";
        line.appendChild(tag);
      }
    } else {
      line.appendChild(node("span", "method kind-" + t, TYPE_LABEL[t] || t));
      line.appendChild(node("span", "url", describeStep(st, t)));
    }
    if (st.when) line.title = "Runs only when " + st.when;
    return line;
  }

  function stepResult(sr) {
    const box = node("div", "step-res" + (sr.ok ? "" : " fail"));
    const parts = [];
    const io = sr.type === "http" || sr.type === "ai";
    if (sr.skipped) parts.push("skipped" + (sr.runs > 1 ? ` all ${sr.runs} times` : "") + " — " + (sr.note || "condition was false"));
    else {
      if (sr.runs > 1) {
        parts.push(`ran ${sr.runs}×` + (sr.failCount ? `, ${sr.failCount} failed` : "") + (sr.skipCount ? `, ${sr.skipCount} skipped` : ""));
      }
      if (!sr.ok) parts.push(sr.error || "failed");
      else {
        if (sr.status) parts.push(String(sr.status));
        if (sr.ms != null) parts.push(sr.ms + " ms");
      }
      if (sr.extracted) parts.push("set " + Object.keys(sr.extracted).map((k) => `${k} = ${sr.extracted[k]}`).join(", "));
      if (!io && sr.output) parts.push(sr.output);
    }
    box.appendChild(document.createTextNode(parts.join(" · ")));
    if (sr.entryId && typeof showDetail === "function") {
      const a = node("a", "idref", ` #${sr.entryId}`);
      a.href = "#";
      a.title = "Show this request in Traffic";
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        showDetail(sr.entryId, "response");
      });
      box.appendChild(a);
    }
    if (io && sr.output && !sr.skipped) box.appendChild(node("pre", "", String(sr.output).slice(0, 1200)));
    return box;
  }

  // The step tree, with each step's latest result matched by its path:
  // loop bodies live under "<id>[]", if-branches under "<id>.then" / ".else".
  function stepTree(steps, results, prefix) {
    const ol = node("ol", "steps");
    for (const st of steps || []) {
      if (!st || typeof st !== "object") continue;
      const t = typeOf(st);
      const path = prefix ? prefix + "/" + st.id : st.id;
      const li = node("li");
      li.appendChild(stepSummary(st));
      const sr = results && results.find((x) => x.id === path);
      if (sr) li.appendChild(stepResult(sr));
      const branch = (label, list, childPrefix) => {
        if (!Array.isArray(list) || !list.length) return;
        const wrap = node("div", "branch");
        if (label) wrap.appendChild(node("div", "branch-label", label));
        wrap.appendChild(stepTree(list, results, childPrefix));
        li.appendChild(wrap);
      };
      if (t === "for_each") branch(`For each ${st.as || "item"}:`, st.steps, path + "[]");
      else if (t === "repeat") branch("Each pass:", st.steps, path + "[]");
      else if (t === "if") {
        branch("Then:", st.then, path + ".then");
        branch("Else:", st.else, path + ".else");
      }
      ol.appendChild(li);
    }
    return ol;
  }

  function countSteps(steps) {
    let n = 0;
    for (const st of steps || []) {
      n++;
      for (const k of ["steps", "then", "else"]) if (Array.isArray(st[k])) n += countSteps(st[k]);
    }
    return n;
  }

  function triggerLabel(t) {
    if (!t) return "";
    const what = [t.method, t.url_contains ? `…${t.url_contains}…` : "any URL"].filter(Boolean).join(" ");
    return `When ${t.host ? "a page on " + t.host : "a page on any site"} calls ${what}${t.status ? ` (${t.status})` : ""}`;
  }

  function render() {
    const list = $("flowList");
    const ed = $("flowEditor");
    ed.hidden = !editing;
    list.hidden = !!editing;
    $("flowsHead").hidden = !!editing;
    if (editing) return renderEditor();

    list.replaceChildren();
    if (!flows.length) {
      const empty = node("div", "flows-empty");
      empty.appendChild(node("p", "", "No flows yet."));
      empty.appendChild(
        node(
          "p",
          "hint",
          "Ask Kimi something like “whenever this page loads orders, post each new paid one to my webhook” or “every hour, page through all users and flag the inactive ones”. It builds the flow from requests this page already made, runs it once, then schedules it. Or start from New flow, which opens a small example bot."
        )
      );
      list.appendChild(empty);
      return;
    }

    for (const f of flows) {
      const card = node("div", "flow");
      const head = node("div", "flow-head");
      head.appendChild(node("span", "flow-name", f.name));
      card.appendChild(head);
      if (f.description) card.appendChild(node("p", "flow-desc", f.description));

      const meta = node("div", "flow-meta");
      const n = countSteps(f.steps);
      meta.appendChild(node("span", "", `${n} step${n === 1 ? "" : "s"}`));
      meta.appendChild(node("span", "", scheduleLabel(f)));
      if (f.on_request) {
        const tl = node("span", "", triggerLabel(f.on_request) + (f.on_request.enabled ? "" : " — paused"));
        tl.title = `Runs by itself at most once every ${f.on_request.cooldown_seconds} s`;
        meta.appendChild(tl);
      }
      if (f.lastRun) {
        const lr = node(
          "span",
          f.lastRun.paused ? "" : f.lastRun.ok ? "ok" : "fail",
          (f.lastRun.paused ? "Last run paused" : f.lastRun.ok ? "Last run ok" : "Last run failed") + ` ${typeof fmtAgo === "function" ? fmtAgo(f.lastRun.at) : ""}`
        );
        if (!f.lastRun.ok && f.lastRun.error) lr.title = f.lastRun.error;
        meta.appendChild(lr);
      } else meta.appendChild(node("span", "", "Never run"));
      card.appendChild(meta);

      const cp = cpCache.get(f.id);
      if (cp && !cp.active) card.appendChild(pausedBanner(f, cp));
      const colls = collCache.get(f.id) || {};
      if (Object.keys(colls).length) card.appendChild(collectionsBlock(f, colls));

      const actions = node("div", "flow-actions");
      const runBtn = btn("Run now", () => runNow(f, runBtn), "primary");
      actions.appendChild(runBtn);

      const sel = node("select");
      sel.setAttribute("aria-label", "Schedule for " + f.name);
      const current = f.schedule && f.schedule.enabled ? f.schedule.every_minutes : 0;
      let matched = false;
      for (const [m, label] of SCHEDULES) {
        const o = node("option", "", label);
        o.value = String(m);
        if (m === current) {
          o.selected = true;
          matched = true;
        }
        sel.appendChild(o);
      }
      if (!matched) {
        const o = node("option", "", `Every ${current} min`);
        o.value = String(current);
        o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => setSchedule(f, Number(sel.value)));
      actions.appendChild(sel);
      if (f.on_request) {
        const lab = node("label", "chk");
        lab.title = triggerLabel(f.on_request);
        const cb = node("input");
        cb.type = "checkbox";
        cb.checked = !!f.on_request.enabled;
        cb.addEventListener("change", () => setTrigger(f, cb.checked));
        lab.append(cb, document.createTextNode(" On page requests"));
        actions.appendChild(lab);
      }

      actions.appendChild(
        btn(open.has(f.id) ? "Hide steps" : "Steps & runs", async () => {
          if (open.has(f.id)) open.delete(f.id);
          else {
            open.add(f.id);
            try {
              runsCache.set(f.id, await api.rpc("flows.runs", { id: f.id }));
            } catch (_) {}
          }
          render();
        }, "ghost")
      );
      actions.appendChild(btn("Edit", () => startEdit(f), "ghost"));
      const copyBtn = btn("Copy as Markdown", () => copyMarkdown(f), "ghost");
      copyBtn.title = "Copy every step, the schedule and the last run as Markdown. Secret values are masked.";
      actions.appendChild(copyBtn);
      if (window.__netscopeAi) {
        actions.appendChild(
          btn("Ask Kimi", () => window.__netscopeAi.prefill(`Look at my flow “${f.name}” (id ${f.id}) and its recent runs. `, false), "ghost")
        );
      }
      const del = btn("Delete", () => {
        if (del.dataset.armed) return removeFlow(f);
        del.dataset.armed = "1";
        del.textContent = "Click again to delete";
        del.className = "danger";
        setTimeout(() => {
          if (!del.isConnected) return;
          delete del.dataset.armed;
          del.textContent = "Delete";
          del.className = "ghost";
        }, 3500);
      }, "ghost");
      actions.appendChild(del);
      card.appendChild(actions);

      if (open.has(f.id) || live.has(f.id)) {
        const runs = runsCache.get(f.id) || [];
        const latest = live.get(f.id) || (runs[0] && runs[0].steps) || [];
        card.appendChild(stepTree(f.steps, latest, ""));

        const last = !live.has(f.id) && runs[0];
        if (last && last.logs && last.logs.length) {
          const logBox = node("div", "flow-log");
          logBox.appendChild(node("div", "branch-label", "Run log"));
          logBox.appendChild(node("pre", "", last.logs.slice(-20).map((l) => l.message).join("\n")));
          card.appendChild(logBox);
        }
        if (last && last.note) card.appendChild(node("p", "flow-desc", "Stopped early: " + last.note));

        const mem = stateCache.get(f.id) || {};
        if (Object.keys(mem).length) {
          const memBox = node("div", "flow-meta");
          memBox.appendChild(node("span", "", "Memory: " + short(mem, 200)));
          memBox.appendChild(
            btn("Clear memory", async () => {
              await api.rpc("flows.resetState", { id: f.id }).catch((e) => say(e.message));
              stateCache.set(f.id, {});
              say(`Cleared “${f.name}”'s memory — the next run starts fresh`);
              render();
            }, "ghost")
          );
          memBox.title = "Values the flow saved with set → state, kept between runs";
          card.appendChild(memBox);
        }
        if (runs.length > 1) {
          const hist = node("div", "flow-meta");
          hist.appendChild(node("span", "", "Recent runs:"));
          for (const r of runs.slice(0, 8)) {
            const s = node("span", r.ok ? "ok" : "fail", `${r.ok ? "ok" : "failed"} ${typeof fmtAgo === "function" ? fmtAgo(r.startedAt) : ""} (${r.trigger})`);
            if (r.error) s.title = r.error;
            hist.appendChild(s);
          }
          card.appendChild(hist);
        }
      }
      list.appendChild(card);
    }
  }

  /* --------------------------------------------------------- actions */

  async function runNow(f, b) {
    b.disabled = true;
    b.textContent = "Running…";
    live.set(f.id, []);
    open.add(f.id);
    render();
    try {
      const run = await api.rpc("flows.run", { id: f.id, trigger: "manual" });
      say(run.ok ? `“${f.name}” ran in ${run.ms} ms` : `“${f.name}” failed: ${run.error}`);
      runsCache.set(f.id, await api.rpc("flows.runs", { id: f.id }));
    } catch (err) {
      say(err.message);
    } finally {
      live.delete(f.id);
      await load();
    }
  }

  async function setSchedule(f, minutes) {
    const next = JSON.parse(JSON.stringify(f));
    next.schedule = { enabled: minutes > 0, every_minutes: minutes > 0 ? minutes : (f.schedule && f.schedule.every_minutes) || 60 };
    try {
      await api.rpc("flows.save", { flow: next });
      say(minutes > 0 ? `“${f.name}” scheduled: ${scheduleLabel(next).toLowerCase()}` : `“${f.name}” is manual only now`);
    } catch (err) {
      say(err.message);
    }
    load();
  }

  function pausedBanner(f, cp) {
    const box = node("div", "flow-paused");
    const where = cp.next != null ? `at item ${(cp.next + 1).toLocaleString()}${cp.of ? ` of ${cp.of.toLocaleString()}` : ""} in ${cp.step}` : `at step ${cp.step}`;
    const why = cp.reason === "budget" ? "it reached its run budget" : cp.reason === "interrupted" ? "Chrome stopped it" : "a step failed";
    const p = node("p", "", `Paused ${where} — ${why}.`);
    if (cp.autoResumePending) p.appendChild(document.createTextNode(" Continues by itself in about 30 s."));
    if (cp.continuations) p.appendChild(document.createTextNode(` Continued ${cp.continuations}× so far.`));
    box.appendChild(p);
    const resumeBtn = btn("Resume", async () => {
      resumeBtn.disabled = true;
      resumeBtn.textContent = "Resuming…";
      live.set(f.id, []);
      open.add(f.id);
      try {
        const run = await api.rpc("flows.resume", { id: f.id });
        say(run.paused ? `“${f.name}” paused again: ${run.note}` : run.ok ? `“${f.name}” finished` : `“${f.name}” failed: ${run.error}`);
      } catch (err) {
        say(err.message);
      } finally {
        live.delete(f.id);
        load();
      }
    }, "primary");
    box.appendChild(resumeBtn);
    box.appendChild(
      btn("Discard progress", async () => {
        await api.rpc("flows.discard", { id: f.id }).catch((e) => say(e.message));
        say(`Discarded “${f.name}”'s paused run — the next run starts from the beginning`);
        load();
      }, "ghost")
    );
    return box;
  }

  // CSV of a collection: one column per top-level key (nested values as JSON).
  function toCsv(items) {
    const cols = [];
    const seen = new Set();
    for (const x of items.slice(0, 500)) {
      if (!x || typeof x !== "object" || Array.isArray(x)) continue;
      for (const k of Object.keys(x)) {
        if (seen.has(k)) continue;
        seen.add(k);
        cols.push(k);
      }
    }
    const cell = (v) => {
      const t = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    if (!cols.length) return ["value"].concat(items.map((x) => cell(x))).join("\n");
    return [cols.map(cell).join(",")].concat(items.map((x) => cols.map((k) => cell(x && x[k])).join(","))).join("\n");
  }

  function collectionsBlock(f, colls) {
    const box = node("div", "flow-colls");
    for (const name of Object.keys(colls)) {
      const c = colls[name];
      const row = node("div", "flow-coll");
      const label = node("span", "coll-name", `collections.${name}`);
      label.title = c.fields && c.fields.length ? "Fields: " + c.fields.join(", ") : "";
      row.appendChild(label);
      row.appendChild(node("span", "coll-count", `${c.count.toLocaleString()} item${c.count === 1 ? "" : "s"}`));
      const fileBase = `${f.name}-${name}`.replace(/[^\w.-]+/g, "_").slice(0, 60);
      const exportAs = async (kind) => {
        try {
          const all = await api.rpc("flows.collection", { id: f.id, name, limit: "all" });
          if (kind === "csv") download(fileBase + ".csv", toCsv(all.items), "text/csv");
          else download(fileBase + ".json", JSON.stringify(all.items, null, 2), "application/json");
          say(`Downloaded ${all.total.toLocaleString()} items as ${kind.toUpperCase()}`);
        } catch (err) {
          say(err.message);
        }
      };
      row.appendChild(btn("JSON", () => exportAs("json"), "ghost"));
      row.appendChild(btn("CSV", () => exportAs("csv"), "ghost"));
      const clear = btn("Clear", async () => {
        if (!clear.dataset.armed) {
          clear.dataset.armed = "1";
          clear.textContent = "Click again to clear";
          clear.className = "danger";
          return;
        }
        await api.rpc("flows.clearCollection", { id: f.id, name }).catch((e) => say(e.message));
        say(`Cleared collections.${name}`);
        load();
      }, "ghost");
      row.appendChild(clear);
      box.appendChild(row);
    }
    return box;
  }

  async function setTrigger(f, on) {
    const next = JSON.parse(JSON.stringify(f));
    next.on_request = Object.assign({}, f.on_request, { enabled: !!on });
    try {
      await api.rpc("flows.save", { flow: next });
      say(on ? `“${f.name}” reacts to page requests again` : `“${f.name}” no longer reacts to page requests`);
    } catch (err) {
      say(err.message);
    }
    load();
  }

  async function removeFlow(f) {
    try {
      await api.rpc("flows.delete", { id: f.id });
      open.delete(f.id);
      say(`Deleted “${f.name}”`);
    } catch (err) {
      say(err.message);
    }
    load();
  }

  /* -------------------------------------------------------- markdown */

  // A flow as a self-contained Markdown document: what it does, every step
  // with its request, data passing and conditions, a cURL per HTTP step, the
  // last run, and the JSON definition. Literal secrets are masked — steps
  // built from captured requests carry real Authorization/Cookie values, and
  // Markdown tends to get pasted into docs and chats. Template references like
  // {{vars.token}} are not secrets and stay as they are.

  const SECRET_HEADER = /^(authorization|proxy-authorization|authentication|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-session-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-goog-api-key)$/i;
  const SECRET_PARAM = /^(token|access_token|id_token|refresh_token|api_key|apikey|password|secret|signature|sig|session|auth)$/i;
  const SECRET_KEY = /passw|secret|token|api[_-]?key|apikey|credential|private[_-]?key|session[_-]?id|csrf|cookie/i;
  const hasTemplate = (s) => /\{\{[^}]*\}\}/.test(String(s));

  // Token-shaped literals inside free text (AI prompts, plain-text bodies).
  function scrubText(text, m) {
    return String(text)
      .replace(/\b(Bearer|Basic|Token)\s+(?!\{\{)[A-Za-z0-9._~+/=-]{12,}/g, (_, scheme) => {
        m.n++;
        return `${scheme} <masked>`;
      })
      .replace(/\b(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/g, () => {
        m.n++;
        return "<masked>";
      });
  }

  function maskValue(v, m) {
    const s = String(v == null ? "" : v);
    if (!s || hasTemplate(s)) return s;
    m.n++;
    const scheme = /^(Bearer|Basic|Token|Digest)\s+\S/i.exec(s);
    return `${scheme ? scheme[1] + " " : ""}<masked, ${s.length} chars>`;
  }

  function maskQuery(qs, m) {
    return qs
      .split("&")
      .map((pair) => {
        const i = pair.indexOf("=");
        if (i < 0) return pair;
        let k = pair.slice(0, i);
        try {
          k = decodeURIComponent(k);
        } catch (_) {}
        return SECRET_PARAM.test(k) ? pair.slice(0, i + 1) + maskValue(pair.slice(i + 1), m) : pair;
      })
      .join("&");
  }

  // String surgery, not new URL(): URL() would percent-encode {{templates}}.
  function maskUrl(url, m) {
    const s = String(url || "");
    const q = s.indexOf("?");
    if (q < 0) return s;
    const hash = s.indexOf("#", q);
    const qs = hash < 0 ? s.slice(q + 1) : s.slice(q + 1, hash);
    return s.slice(0, q + 1) + maskQuery(qs, m) + (hash < 0 ? "" : s.slice(hash));
  }

  function maskJson(v, m) {
    if (Array.isArray(v)) return v.map((x) => maskJson(x, m));
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) {
        out[k] = SECRET_KEY.test(k) && v[k] != null && typeof v[k] !== "object" ? maskValue(v[k], m) : maskJson(v[k], m);
      }
      return out;
    }
    return v;
  }

  function maskBody(body, m) {
    if (body == null || body === "") return body;
    if (typeof body !== "string") return maskJson(body, m);
    const t = body.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return JSON.stringify(maskJson(JSON.parse(t), m));
      } catch (_) {}
    }
    if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(t)) return maskQuery(t, m);
    return scrubText(body, m);
  }

  function headerList(h) {
    if (!h) return [];
    if (Array.isArray(h)) return h.filter((x) => x && x.name).map((x) => ({ name: String(x.name), value: x.value }));
    return Object.keys(h).map((name) => ({ name, value: h[name] }));
  }

  function maskHeaders(h, m) {
    return headerList(h).map((x) => ({ name: x.name, value: SECRET_HEADER.test(x.name) ? maskValue(x.value, m) : String(x.value == null ? "" : x.value) }));
  }

  // The concrete request an HTTP step describes, secrets masked. Templates
  // are left in place; they are filled in when the flow runs.
  function stepRequest(st, m) {
    if (st.curl) {
      try {
        const p = globalThis.__netscopeCurl.parse(st.curl);
        return { method: p.method, url: maskUrl(p.url, m), headers: maskHeaders(p.headers, m), body: maskBody(p.body, m) };
      } catch (_) {
        const masked = String(st.curl).replace(/((?:-H|--header)\s+['"]?)([A-Za-z-]+)(\s*:\s*)([^'"\n]+)/g, (all, a, name, b, value) =>
          SECRET_HEADER.test(name) ? a + name + b + maskValue(value, m) : all
        );
        return { raw: masked };
      }
    }
    let url = st.url || "";
    if (st.query && typeof st.query === "object") {
      const qs = Object.keys(st.query)
        .map((k) => encodeURIComponent(k) + "=" + (hasTemplate(st.query[k]) ? st.query[k] : encodeURIComponent(typeof st.query[k] === "object" ? JSON.stringify(st.query[k]) : String(st.query[k]))))
        .join("&");
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }
    return {
      method: String(st.method || "GET").toUpperCase(),
      url: maskUrl(url, m),
      headers: maskHeaders(st.headers, m),
      body: maskBody(st.body, m)
    };
  }

  function fence(lang, text) {
    const s = String(text == null ? "" : text);
    const longest = (s.match(/`+/g) || []).reduce((n, r) => Math.max(n, r.length), 0);
    const f = "`".repeat(Math.max(3, longest + 1));
    return `${f}${lang}\n${s}\n${f}`;
  }

  const code = (s) => {
    const t = String(s);
    return t.includes("`") ? "`` " + t + " ``" : "`" + t + "`";
  };

  function when(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function flowToMarkdown(f, runs) {
    const m = { n: 0 };
    const out = [];
    const steps = f.steps || [];
    const last = (runs && runs[0]) || null;

    out.push(`# Flow: ${f.name}`, "");
    if (f.description) out.push(f.description, "");

    const sched =
      f.schedule && f.schedule.enabled
        ? `${scheduleLabel(f)}, in the background while Chrome is open`
        : "Manual only";
    out.push(`- **Schedule:** ${sched}`);
    if (f.on_request) {
      out.push(
        `- **Trigger:** ${triggerLabel(f.on_request)}, at most once every ${f.on_request.cooldown_seconds} s${f.on_request.enabled ? "" : " (paused)"}`
      );
    }
    out.push(`- **Steps:** ${countSteps(steps)}`);
    if (f.limits) {
      out.push(`- **Budget per run:** ${f.limits.max_steps.toLocaleString()} step runs, ${f.limits.max_minutes} min${f.limits.auto_resume ? "; continues by itself when it runs out" : ""}`);
    }
    const colls = collCache.get(f.id) || {};
    for (const name of Object.keys(colls)) out.push(`- **Collection ${code(name)}:** ${colls[name].count.toLocaleString()} items${colls[name].fields.length ? ` (${colls[name].fields.slice(0, 8).join(", ")})` : ""}`);
    const cpInfo = cpCache.get(f.id);
    if (cpInfo && !cpInfo.active) out.push(`- **Paused:** at ${cpInfo.next != null ? `item ${cpInfo.next + 1}${cpInfo.of ? ` of ${cpInfo.of}` : ""} in ` : ""}${code(cpInfo.step)} (${cpInfo.reason})`);
    const vars = maskJson(f.vars || {}, m);
    if (Object.keys(vars).length) out.push(`- **Starting variables:** ${code(JSON.stringify(vars))}`);
    if (last) {
      out.push(`- **Last run:** ${last.ok ? "succeeded" : "failed"} in ${last.ms} ms, ${when(last.startedAt)} (${last.trigger})${last.error ? ` — ${last.error}` : ""}`);
    } else out.push("- **Last run:** never run");
    out.push(`- **Flow id:** ${code(f.id || "(unsaved)")}`, "");

    out.push("## Steps", "");
    const results = (last && last.steps) || [];
    const KIND = {
      http: "HTTP request",
      ai: "Kimi step",
      delay: "Delay",
      set: "Set values",
      filter: "Filter",
      map: "Map",
      for_each: "Loop over items",
      repeat: "Repeat",
      if: "Condition",
      stop: "Stop",
      log: "Log",
      run_flow: "Run another flow"
    };

    // Numbered like an outline: 2, 2.1, 2.2 … ; an if's else-steps continue
    // the numbering after its then-steps.
    const emit = (list, num, prefix, context, offset) => {
      (list || []).forEach((st, i) => {
        if (!st || typeof st !== "object") return;
        const t = typeOf(st);
        const k = (offset || 0) + i + 1;
        const n = num ? `${num}.${k}` : String(k);
        const path = prefix ? prefix + "/" + st.id : st.id;
        const level = Math.min(6, 3 + (n.split(".").length - 1));
        out.push(`${"#".repeat(level)} ${n} ${code(st.id)} — ${KIND[t] || t}${st.name ? ` (${st.name})` : ""}${context ? ` · ${context}` : ""}`, "");

        let httpReq = null;
        if (t === "ai") {
          out.push("Prompt:", "", fence("text", scrubText(st.prompt || "", m)), "");
          if (st.json) out.push("Asks for JSON back.", "");
        } else if (t === "delay") {
          out.push(`Waits ${Number(st.ms) || 0} ms.`, "");
        } else if (t === "set") {
          for (const scope of ["vars", "state"]) {
            if (!st[scope] || typeof st[scope] !== "object") continue;
            for (const k of Object.keys(st[scope])) {
              const v = st[scope][k];
              const shown = SECRET_KEY.test(k) && typeof v !== "object" ? maskValue(v, m) : typeof v === "string" ? scrubText(v, m) : JSON.stringify(maskJson(v, m));
              out.push(`- ${code(scope + "." + k)} = ${code(shown)}${scope === "state" ? " (remembered between runs)" : ""}`);
            }
          }
          out.push("");
        } else if (t === "filter") {
          out.push(`Keeps the items of ${code(st.items)} where ${code(st.where)} (each item is ${code("{{" + (st.as || "item") + "}}")})${st.limit ? `, at most ${st.limit}` : ""}. Saves the list to ${code("{{vars." + (st.save_as || st.id) + "}}")}.`, "");
        } else if (t === "map") {
          out.push(`Turns each item of ${code(st.items)} into:`, "", fence("json", JSON.stringify(maskJson(st.value, m), null, 2)), "", `Saves the list to ${code("{{vars." + (st.save_as || st.id) + "}}")}.`, "");
        } else if (t === "for_each") {
          const bits = [`Runs the steps below once per item of ${code(st.items)}, as ${code("{{" + (st.as || "item") + "}}")}`, `at most ${st.max || 100} items`];
          if (st.concurrency > 1) bits.push(`${st.concurrency} items at a time`);
          if (st.delay_ms) bits.push(`${st.delay_ms} ms between items`);
          bits.push(st.on_item_error === "continue" ? "a failed item is skipped" : "a failed item stops the flow");
          out.push(bits.join(", ") + ".", "");
          if (st.collect) {
            out.push(
              `After each item, adds ${code(JSON.stringify(maskJson(st.collect.value, m)))} to ${code("{{vars." + (st.collect.save_as || st.id) + "}}")}` +
                `${st.collect.flatten ? ", flattened" : ""}${st.collect.unique_by ? `, de-duplicated by ${code(st.collect.unique_by)}` : ""}.`,
              ""
            );
          }
        } else if (t === "repeat") {
          const cond = st.until ? `until ${code(st.until)} (checked after each pass)` : st.while ? `while ${code(st.while)} (checked before each pass)` : "";
          out.push(`Repeats the steps below ${cond}, at most ${st.max || 10} times${st.delay_ms ? `, ${st.delay_ms} ms apart` : ""}. ${code("{{loop.index}}")} counts passes from 0.`, "");
        } else if (t === "collect") {
          const mode = st.mode || (st.key ? "append" : "append");
          const verb = {
            append: st.key ? `Adds items not already in it (matched by ${code(st.key)})` : "Appends the items",
            upsert: `Adds new items and merges changes into existing ones, matched by ${code(st.key)}`,
            replace: "Replaces its contents with the items",
            remove: `Removes the matching items${st.key ? ` (by ${code(st.key)})` : ""}`,
            clear: "Empties it"
          }[mode];
          out.push(`${verb} — collection ${code(st.collection)}${mode !== "clear" ? `, from ${code(typeof st.items === "string" ? st.items : JSON.stringify(st.items))}` : ""}${st.flatten ? " (flattened)" : ""}. Kept between runs; read it as ${code("{{collections." + st.collection + "}}")}.`, "");
        } else if (t === "if") {
          out.push(`If ${code(st.condition)}, runs the “then” steps, otherwise the “else” steps.`, "");
        } else if (t === "stop") {
          out.push(`Ends the run ${st.outcome === "fail" ? "as failed" : "successfully"}${st.message ? ` with ${code(scrubText(st.message, m))}` : ""}.`, "");
        } else if (t === "log") {
          out.push(`Writes ${code(scrubText(st.message || "", m))} to the run log.`, "");
        } else if (t === "run_flow") {
          const sub = flows.find((x) => x.id === st.flow);
          out.push(`Runs ${sub ? `“${sub.name}” (${code(st.flow)})` : code(st.flow)}${st.vars ? ` with ${code(JSON.stringify(maskJson(st.vars, m)))}` : ""}. Its variables come back as ${code("{{steps." + st.id + ".body}}")}.`, "");
        } else {
          const req = (httpReq = stepRequest(st, m));
          if (req.raw) {
            out.push("cURL (could not be parsed, shown as written):", "", fence("bash", req.raw), "");
          } else {
            out.push(`**Request:** ${code(req.method + " " + req.url)}`, "");
            if (req.headers.length) out.push("Headers:", "", fence("http", req.headers.map((h) => `${h.name}: ${h.value}`).join("\n")), "");
            if (req.body != null && req.body !== "") {
              let b = req.body;
              let lang = "text";
              if (typeof b !== "string") {
                b = JSON.stringify(b, null, 2);
                lang = "json";
              } else {
                try {
                  b = JSON.stringify(JSON.parse(b), null, 2);
                  lang = "json";
                } catch (_) {}
              }
              out.push("Body:", "", fence(lang, b), "");
            }
            if (st.source_entry) out.push(`Built from captured request #${st.source_entry}.`, "");
          }
        }

        const notes = [];
        if (st.extract && typeof st.extract === "object") {
          for (const k of Object.keys(st.extract)) notes.push(`Saves ${code("{{vars." + k + "}}")} from ${code(st.extract[k])}`);
        }
        if (st.when) notes.push(`Runs only when ${code(st.when)}`);
        if (t === "http") {
          notes.push(`Expects status ${st.expect_status ? code(st.expect_status) : "2xx or 3xx"}`);
          if (st.context === "page") notes.push("Sent from inside an open tab on the site (its origin, cookies and page scripts)");
          if (st.retry && st.retry.times) notes.push(`Retries up to ${st.retry.times}× on network errors, 429 and 5xx`);
          else notes.push("Retries 429 / 503 up to 3×, honoring Retry-After");
          if (st.timeout_ms) notes.push(`Times out after ${st.timeout_ms} ms`);
        }
        if (t !== "stop") notes.push(st.continue_on_error ? "On failure: continues with the next step" : "On failure: stops the flow");
        for (const x of notes) out.push("- " + x);
        out.push("");

        if (httpReq && !httpReq.raw) out.push("As cURL:", "", fence("bash", globalThis.__netscopeCurl.build(httpReq)), "");

        const sr = results.find((x) => x.id === path);
        if (sr) {
          let res;
          if (sr.skipped) res = "skipped (condition was false)";
          else {
            const counts = sr.runs > 1 ? `ran ${sr.runs}×${sr.failCount ? `, ${sr.failCount} failed` : ""}${sr.skipCount ? `, ${sr.skipCount} skipped` : ""}; ` : "";
            if (!sr.ok) res = counts + "failed — " + (sr.error || "unknown error");
            else if (t === "http" || t === "ai") res = counts + [sr.status ? String(sr.status) : "ok", sr.ms != null ? `${sr.ms} ms` : ""].filter(Boolean).join(" in ");
            else res = counts + (sr.output ? scrubText(sr.output, m) : "ok");
          }
          if (sr.extracted) {
            const parts = Object.keys(sr.extracted).map((k) => `${k} = ${SECRET_KEY.test(k) ? maskValue(sr.extracted[k], m) : sr.extracted[k]}`);
            if (parts.length) res += "; saved " + parts.join(", ");
          }
          out.push(`Last run: ${res}`, "");
        } else if (last) out.push("Last run: not reached", "");

        if (t === "for_each") emit(st.steps, n, path + "[]", `for each ${st.as || "item"}`);
        else if (t === "repeat") emit(st.steps, n, path + "[]", "each pass");
        else if (t === "if") {
          emit(st.then, n, path + ".then", "then", 0);
          emit(st.else, n, path + ".else", "else", (st.then || []).length);
        }
      });
    };
    emit(steps, "", "", "", 0);

    if (last && last.logs && last.logs.length) {
      out.push("## Last run log", "", fence("text", last.logs.slice(-50).map((l) => scrubText(l.message, m)).join("\n")), "");
    }
    const memory = stateCache.get(f.id);
    if (memory && Object.keys(memory).length) {
      out.push("## Memory (kept between runs)", "", fence("json", JSON.stringify(maskJson(memory, m), null, 2)), "");
    }

    out.push(
      "## How values pass between steps",
      "",
      "Anything in `{{ }}` is filled in when the flow runs: `{{vars.<name>}}` (starting variables, `extract`, `set`, `filter`, `map`, `collect`), " +
        "`{{state.<name>}}` (memory kept between runs), `{{steps.<id>.status}}`, `{{steps.<id>.body.<path>}}`, `{{steps.<id>.headers.<name>}}`, " +
        "`{{item}}` / the loop's name and `{{loop.index}}` inside loops, `{{trigger.body.<path>}}` when started by a page request, `{{now}}`, `{{now_iso}}`, `{{today}}`, `{{uuid}}`. " +
        "Filters such as `| where:status=paid`, `| pluck:id`, `| max`, `| length`, `| join:\", \"` and `| add:1` transform values. " +
        "Conditions compare with `==`, `!=`, `>`, `<`, `contains`, `exists`, `missing` and combine with `and` / `or`.",
      ""
    );

    const def = JSON.parse(JSON.stringify(f));
    delete def.lastRun;
    delete def.createdAt;
    delete def.updatedAt;
    def.vars = maskJson(def.vars || {}, { n: 0 });
    const maskStep = (st) => {
      const s = Object.assign({}, st);
      for (const k of ["steps", "then", "else"]) if (Array.isArray(s[k])) s[k] = s[k].map(maskStep);
      if (s.vars && typeof s.vars === "object") s.vars = maskJson(s.vars, { n: 0 });
      if (s.state && typeof s.state === "object") s.state = maskJson(s.state, { n: 0 });
      if (typeof s.message === "string") s.message = scrubText(s.message, { n: 0 });
      if (s.headers) {
        const masked = {};
        for (const h of maskHeaders(s.headers, { n: 0 })) masked[h.name] = h.value;
        s.headers = masked;
      }
      if (s.url) s.url = maskUrl(s.url, { n: 0 });
      if (s.body != null) s.body = maskBody(s.body, { n: 0 });
      if (s.query && typeof s.query === "object") {
        const q = {};
        for (const k of Object.keys(s.query)) q[k] = SECRET_PARAM.test(k) ? maskValue(s.query[k], { n: 0 }) : s.query[k];
        s.query = q;
      }
      if (typeof s.prompt === "string") s.prompt = scrubText(s.prompt, { n: 0 });
      if (s.curl) {
        const r = stepRequest(s, { n: 0 });
        s.curl = r.raw || globalThis.__netscopeCurl.build(r);
      }
      return s;
    };
    def.steps = (def.steps || []).map(maskStep);
    out.push("## Definition (JSON)", "");
    if (m.n) out.push("Masked values must be filled in before this can be pasted into **New flow**.", "");
    out.push(fence("json", JSON.stringify(def, null, 2)), "");

    if (m.n) {
      out.splice(
        out.indexOf("## Steps"),
        0,
        `> ${m.n} secret value${m.n === 1 ? " is" : "s are"} masked (auth headers, cookies, tokens). Open **Edit** in NetScope to see the raw definition.`,
        ""
      );
    }
    return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n", masked: m.n };
  }

  async function copyMarkdown(f) {
    let runs = runsCache.get(f.id);
    if (!runs) {
      try {
        runs = await api.rpc("flows.runs", { id: f.id });
        runsCache.set(f.id, runs);
      } catch (_) {
        runs = [];
      }
    }
    const { text, masked } = flowToMarkdown(f, runs);
    const msg = masked
      ? `Copied “${f.name}” as Markdown, ${masked} secret value${masked === 1 ? "" : "s"} masked`
      : `Copied “${f.name}” as Markdown`;
    if (typeof copyText === "function") copyText(text, msg);
  }

  /* ---------------------------------------------------------- editor */

  function startEdit(f) {
    const copy = f ? JSON.parse(JSON.stringify(f)) : JSON.parse(JSON.stringify(TEMPLATE));
    if (f) {
      delete copy.lastRun;
      delete copy.createdAt;
      delete copy.updatedAt;
    }
    editing = { flow: copy, isNew: !f, error: "" };
    render();
  }

  function renderEditor() {
    const ed = $("flowEditor");
    ed.replaceChildren();
    ed.appendChild(node("h3", "", editing.isNew ? "New flow" : "Edit flow"));
    ed.appendChild(
      node(
        "p",
        "hint",
        "Steps run in order. Use {{steps.<id>.body.field}} or extract + {{vars.name}} to pass values between them. Ask Kimi in Chat for the full syntax."
      )
    );
    const ta = node("textarea");
    ta.spellcheck = false;
    ta.setAttribute("aria-label", "Flow definition (JSON)");
    ta.value = JSON.stringify(editing.flow, null, 2);
    ed.appendChild(ta);
    const err = node("p", "err", editing.error || "");
    err.hidden = !editing.error;
    ed.appendChild(err);
    const actions = node("div", "actions");
    actions.appendChild(
      btn("Save flow", async () => {
        let parsed;
        try {
          parsed = JSON.parse(ta.value);
        } catch (e) {
          err.textContent = "That is not valid JSON: " + e.message;
          err.hidden = false;
          return;
        }
        try {
          await api.rpc("flows.save", { flow: parsed });
          say(`Saved “${parsed.name}”`);
          editing = null;
          load();
        } catch (e) {
          err.textContent = e.message;
          err.hidden = false;
        }
      }, "primary")
    );
    actions.appendChild(
      btn("Cancel", () => {
        editing = null;
        render();
      })
    );
    ed.appendChild(actions);
    setTimeout(() => ta.focus(), 0);
  }

  /* ------------------------------------------------------------ init */

  function attach(a) {
    if (api) return;
    api = a;
    $("flowNew").addEventListener("click", () => startEdit(null));
    $("flowAsk").addEventListener("click", () => {
      if (window.__netscopeAi)
        window.__netscopeAi.prefill(
          "Build a flow from this page's traffic: ",
          false
        );
    });
    api.subscribe((type, msg) => {
      if (type === "flows-changed") scheduleLoad();
      if (type === "flow-step" && msg && live.has(msg.flowId)) {
        const arr = live.get(msg.flowId);
        const i = arr.findIndex((x) => x.id === msg.step.id);
        if (i >= 0) arr[i] = msg.step;
        else arr.push(msg.step);
        render();
      }
    });
    api.whenReady().then(load);
  }

  return { attach, onShown: load, flowToMarkdown, stepTree };
})();
