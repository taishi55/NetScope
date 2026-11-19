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
    // Every card's run history, fetched up front: "Copy as Markdown" needs it
    // and must write the clipboard while the click's activation still holds.
    await Promise.all(
      flows.map((f) =>
        api
          .rpc("flows.runs", { id: f.id })
          .then((r) => runsCache.set(f.id, r))
          .catch(() => {})
      )
    );
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
    out.push(`- **Steps:** ${steps.length}`);
    const vars = maskJson(f.vars || {}, m);
    if (Object.keys(vars).length) out.push(`- **Starting variables:** ${code(JSON.stringify(vars))}`);
    if (last) {
      out.push(`- **Last run:** ${last.ok ? "succeeded" : "failed"} in ${last.ms} ms, ${when(last.startedAt)} (${last.trigger})${last.error ? ` — ${last.error}` : ""}`);
    } else out.push("- **Last run:** never run");
    out.push(`- **Flow id:** ${code(f.id || "(unsaved)")}`, "");

    out.push("## Steps", "");
    steps.forEach((st, i) => {
      const kind = st.type === "ai" ? "Kimi step" : st.type === "delay" ? "Delay" : "HTTP request";
      out.push(`### ${i + 1}. ${code(st.id)} — ${kind}${st.name ? ` (${st.name})` : ""}`, "");

      let httpReq = null;
      if (st.type === "ai") {
        out.push("Prompt:", "", fence("text", scrubText(st.prompt || "", m)), "");
      } else if (st.type === "delay") {
        out.push(`Waits ${Number(st.ms) || 0} ms.`, "");
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
      if (st.type === "http" || !st.type) notes.push(`Expects status ${st.expect_status ? code(st.expect_status) : "2xx or 3xx"}`);
      if (st.timeout_ms) notes.push(`Times out after ${st.timeout_ms} ms`);
      notes.push(st.continue_on_error ? "On failure: continues with the next step" : "On failure: stops the flow");
      for (const n of notes) out.push("- " + n);
      out.push("");

      if (httpReq && !httpReq.raw) out.push("As cURL:", "", fence("bash", globalThis.__netscopeCurl.build(httpReq)), "");

      const sr = last && (last.steps || []).find((x) => x.id === st.id);
      if (sr) {
        let res;
        if (sr.skipped) res = "skipped (condition was false)";
        else if (!sr.ok) res = "failed — " + (sr.error || "unknown error");
        else res = [sr.status ? String(sr.status) : "ok", sr.ms != null ? `${sr.ms} ms` : ""].filter(Boolean).join(" in ");
        if (sr.extracted) {
          const parts = Object.keys(sr.extracted).map((k) => `${k} = ${SECRET_KEY.test(k) ? maskValue(sr.extracted[k], m) : sr.extracted[k]}`);
          if (parts.length) res += "; saved " + parts.join(", ");
        }
        out.push(`Last run: ${res}`, "");
      } else if (last) out.push("Last run: not reached", "");
    });

    out.push(
      "## How values pass between steps",
      "",
      "Anything in `{{ }}` is filled in when the flow runs: `{{vars.<name>}}` (starting variables and values saved by `extract`), " +
        "`{{steps.<id>.status}}`, `{{steps.<id>.body.<path>}}`, `{{steps.<id>.headers.<name>}}`, `{{now}}`, `{{now_iso}}`, `{{today}}`, `{{uuid}}`. " +
        "Filters: `| json`, `| urlencode`, `| first`, `| last`, `| length`, `| trim`, `| upper`, `| lower`, `| default:x`.",
      ""
    );

    const def = JSON.parse(JSON.stringify(f));
    delete def.lastRun;
    delete def.createdAt;
    delete def.updatedAt;
    def.vars = maskJson(def.vars || {}, { n: 0 });
    def.steps = (def.steps || []).map((st) => {
      const s = Object.assign({}, st);
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
    });
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
      if (type === "flows-changed") load();
      if (type === "flow-step" && msg && live.has(msg.flowId)) {
        live.get(msg.flowId).push(msg.step);
        render();
      }
    });
    api.whenReady().then(load);
  }

  return { attach, onShown: load, flowToMarkdown };
})();
