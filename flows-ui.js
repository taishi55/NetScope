/* NetScope – flows-ui.js
 * The Flows view: saved request chains, their schedules and run history.
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

  const TEMPLATE = {
    name: "List then detail",
    description: "Fetch a list, take the first item's id, then fetch that item.",
    steps: [
      {
        id: "list",
        type: "http",
        method: "GET",
        url: "https://jsonplaceholder.typicode.com/posts",
        extract: { first_id: "body[0].id" }
      },
      {
        id: "detail",
        type: "http",
        method: "GET",
        url: "https://jsonplaceholder.typicode.com/posts/{{vars.first_id}}",
        when: "{{vars.first_id}} exists"
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
    for (const id of open) {
      try {
        runsCache.set(id, await api.rpc("flows.runs", { id }));
      } catch (_) {}
    }
    if (!editing) render(); // never wipe JSON the user is typing
    renderAlert();
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
    p.appendChild(node("strong", "", `“${alert.flowName}” failed on its schedule`));
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

  function stepSummary(st) {
    const line = node("div", "step-line");
    if (st.type === "http") {
      if (st.curl) {
        let parsed = null;
        try {
          parsed = globalThis.__netscopeCurl.parse(st.curl);
        } catch (_) {}
        line.appendChild(methodPill(parsed ? parsed.method : "cURL"));
        line.appendChild(node("span", "url", parsed ? parsed.url : st.curl.slice(0, 100)));
      } else {
        line.appendChild(methodPill((st.method || "GET").toUpperCase()));
        line.appendChild(node("span", "url", st.url || ""));
      }
    } else if (st.type === "ai") {
      line.appendChild(node("span", "method", "Kimi"));
      line.appendChild(node("span", "url", String(st.prompt || "").slice(0, 140)));
    } else {
      line.appendChild(node("span", "method", "wait"));
      line.appendChild(node("span", "", `${st.ms || 0} ms`));
    }
    return line;
  }

  function stepResult(sr) {
    const box = node("div", "step-res" + (sr.ok ? "" : " fail"));
    const parts = [];
    if (sr.skipped) parts.push("skipped — " + (sr.note || "condition was false"));
    else if (!sr.ok) parts.push(sr.error || "failed");
    else {
      if (sr.status) parts.push(String(sr.status));
      if (sr.ms != null) parts.push(sr.ms + " ms");
      if (sr.extracted) parts.push("set " + Object.keys(sr.extracted).map((k) => `${k} = ${sr.extracted[k]}`).join(", "));
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
    if (sr.output && !sr.skipped) box.appendChild(node("pre", "", String(sr.output).slice(0, 1200)));
    return box;
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
          "Ask Kimi something like “every hour, get the newest order and post its id to my webhook”. It builds the flow from requests this page already made, runs it once, then schedules it."
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
      meta.appendChild(node("span", "", `${(f.steps || []).length} step${(f.steps || []).length === 1 ? "" : "s"}`));
      meta.appendChild(node("span", "", scheduleLabel(f)));
      if (f.lastRun) {
        const lr = node("span", f.lastRun.ok ? "ok" : "fail", (f.lastRun.ok ? "Last run ok" : "Last run failed") + ` ${typeof fmtAgo === "function" ? fmtAgo(f.lastRun.at) : ""}`);
        if (!f.lastRun.ok && f.lastRun.error) lr.title = f.lastRun.error;
        meta.appendChild(lr);
      } else meta.appendChild(node("span", "", "Never run"));
      card.appendChild(meta);

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
        const ol = node("ol", "steps");
        for (const st of f.steps || []) {
          const li = node("li");
          li.appendChild(stepSummary(st));
          const sr = latest.find((x) => x.id === st.id);
          if (sr) li.appendChild(stepResult(sr));
          ol.appendChild(li);
        }
        card.appendChild(ol);
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
      if (type === "flows-changed") load();
      if (type === "flow-step" && msg && live.has(msg.flowId)) {
        live.get(msg.flowId).push(msg.step);
        render();
      }
    });
    api.whenReady().then(load);
  }

  return { attach, onShown: load };
})();
