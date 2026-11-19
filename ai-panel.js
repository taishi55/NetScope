/* NetScope – ai-panel.js
 * The Chat view: transcript, composer, approvals, settings sheet.
 *
 * Model output is untrusted-adjacent and captured payloads certainly are, so
 * the rule holds here without exception: textContent and createElement only,
 * never innerHTML. The "markdown" renderer builds elements; it never parses
 * model output as HTML.
 *
 * The transcript and the agent's message history are saved per tab in
 * chrome.storage.session, so a page reload does not lose the conversation.
 */
"use strict";

window.__netscopeAi = (() => {
  const AGENT = () => window.__netscopeAiAgent;
  const CLIENT = () => window.__netscopeAiClient;
  const TOOLS = () => window.__netscopeAiTools;

  let api = null;
  let settings = null;
  let ready = false;
  let selectedId = null;
  let contextOff = false; // user dismissed the "About #id" chip for this selection
  let running = false;
  let sessionTokens = 0;
  let transcript = []; // what the log shows, for restoring after a reload
  let storeKey = null;

  const $ = (id) => document.getElementById(id);
  const el = {};

  /* -------------------------------------------------------------- util */

  const say = (msg) => typeof toast === "function" && toast(msg);
  const entryFor = (id) => (id == null || !TOOLS() ? null : TOOLS().entryById(id));
  const canExplain = (e) => !!(e && e.kind === "http");

  // Follow new output unless the user has scrolled up to read something.
  let stick = true;
  function nearBottom() {
    const box = el.log;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  }

  function scrollDown(force) {
    if (force) stick = true;
    if (stick) el.log.scrollTop = el.log.scrollHeight;
  }

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function setEmpty() {
    const has = el.log.querySelector(".msg, .req-card, .tool, .think");
    el.empty.hidden = !!has;
    el.connect.hidden = ready;
    for (const b of el.suggest.querySelectorAll("button")) b.disabled = !ready;
  }

  /* ----------------------------------------------------- persistence */

  let saveTimer = 0;
  function persist() {
    if (!storeKey || !chrome.storage || !chrome.storage.session) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const data = { transcript: transcript.slice(-200), messages: AGENT().getMessages(), tokens: sessionTokens };
      try {
        await chrome.storage.session.set({ [storeKey]: data });
      } catch (_) {
        // Over quota: keep the visible transcript, drop the model history.
        try {
          await chrome.storage.session.set({ [storeKey]: { transcript: transcript.slice(-60), messages: [], tokens: sessionTokens } });
        } catch (_) {}
      }
    }, 300);
  }

  async function restore() {
    if (!storeKey || !chrome.storage || !chrome.storage.session) return;
    let data = null;
    try {
      const got = await chrome.storage.session.get(storeKey);
      data = got[storeKey];
    } catch (_) {}
    if (!data) return;
    sessionTokens = data.tokens || 0;
    AGENT().setMessages(data.messages || []);
    transcript = [];
    for (const item of data.transcript || []) renderItem(item, true);
    transcript = (data.transcript || []).slice();
    scrollDown(true);
    updateMeter();
    setEmpty();
  }

  function record(item) {
    transcript.push(item);
    persist();
  }

  /* ---------------------------------------------------- rich rendering */

  function appendRefs(parent, text) {
    for (const part of text.split(/(#\d+)/g)) {
      const m = /^#(\d+)$/.exec(part);
      if (m && entryFor(Number(m[1]))) {
        const a = document.createElement("a");
        a.className = "idref";
        a.href = "#";
        a.textContent = part;
        a.title = "Show this request in Traffic";
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          if (typeof showDetail === "function") showDetail(Number(m[1]));
        });
        parent.appendChild(a);
      } else if (part) {
        parent.appendChild(document.createTextNode(part));
      }
    }
  }

  function appendBold(parent, text) {
    for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
      if (/^\*\*[^*]+\*\*$/.test(part)) {
        const b = document.createElement("strong");
        appendRefs(b, part.slice(2, -2));
        parent.appendChild(b);
      } else if (part) appendRefs(parent, part);
    }
  }

  function inline(parent, text) {
    for (const part of text.split(/(`[^`]+`)/g)) {
      if (/^`[^`]+`$/.test(part)) parent.appendChild(node("code", "", part.slice(1, -1)));
      else if (part) appendBold(parent, part);
    }
  }

  const isBullet = (s) => /^\s*([-*•]|\d+[.)])\s+/.test(s);
  const isFence = (s) => /^\s*```/.test(s);
  const isHeading = (s) => /^\s*#{1,6}\s+/.test(s);

  function renderRich(container, text) {
    container.replaceChildren();
    container.classList.remove("streaming");
    const lines = String(text || "").split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isFence(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !isFence(lines[i])) buf.push(lines[i++]);
        i++;
        container.appendChild(node("pre", "", buf.join("\n")));
        continue;
      }
      if (isHeading(line)) {
        const h = node("h5");
        inline(h, line.replace(/^\s*#{1,6}\s+/, ""));
        container.appendChild(h);
        i++;
        continue;
      }
      if (isBullet(line)) {
        const ul = node("ul");
        while (i < lines.length && isBullet(lines[i])) {
          const li = node("li");
          inline(li, lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
          ul.appendChild(li);
          i++;
        }
        container.appendChild(ul);
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !isFence(lines[i]) && !isBullet(lines[i]) && !isHeading(lines[i])) buf.push(lines[i++]);
      const p = node("p");
      inline(p, buf.join(" "));
      container.appendChild(p);
    }
  }

  /* ------------------------------------------------------- transcript */

  function newMessage(cls) {
    const wrap = node("div", "msg msg-" + cls);
    const body = node("div", "msg-body");
    wrap.appendChild(body);
    el.log.appendChild(wrap);
    setEmpty();
    return { wrap, body };
  }

  function disclosure(cls, label, bodyCls) {
    const wrap = node("div", cls);
    const head = node("button");
    head.type = "button";
    head.setAttribute("aria-expanded", "false");
    head.appendChild(node("span", "caret", "▸"));
    const lab = node("span", "lab", label);
    head.appendChild(lab);
    const body = node("div", bodyCls);
    body.hidden = true;
    head.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });
    wrap.append(head, body);
    return { wrap, head, lab, body };
  }

  function renderItem(item, restoring) {
    if (item.t === "user") {
      const m = newMessage("user");
      m.body.textContent = item.text;
    } else if (item.t === "assistant") {
      if (item.reasoning) {
        const d = disclosure("think", "Thought" + (item.thinkMs ? ` for ${Math.max(1, Math.round(item.thinkMs / 1000))} s` : ""), "think-body");
        d.body.textContent = item.reasoning;
        el.log.appendChild(d.wrap);
      }
      if (item.text && item.text.trim()) {
        const m = newMessage("assistant");
        renderRich(m.body, item.text);
        addReplyTools(m.wrap, item.text);
        if (item.stopped) m.wrap.appendChild(node("div", "msg-note", "Stopped."));
      }
    } else if (item.t === "tool") {
      renderToolItem(item);
    } else if (item.t === "notice") {
      el.log.appendChild(node("div", "msg-note", item.text));
    } else if (item.t === "error") {
      const m = newMessage("error");
      m.body.appendChild(node("p", "", item.msg));
    } else if (item.t === "approval") {
      const card = node("div", "req-card");
      card.appendChild(node("div", "req-title", item.title));
      if (item.line) card.appendChild(node("div", "req-line", item.line));
      card.appendChild(node("div", "decided", item.approved ? "Approved." : "Declined."));
      el.log.appendChild(card);
    }
    if (!restoring) scrollDown();
    setEmpty();
  }

  function addReplyTools(wrap, text) {
    const tools = node("div", "msg-tools");
    const copy = node("button", "", "Copy");
    copy.type = "button";
    copy.title = "Copy this reply";
    copy.addEventListener("click", () => typeof copyText === "function" && copyText(text, "Reply copied"));
    tools.appendChild(copy);
    wrap.appendChild(tools);
  }

  function addUserMessage(text) {
    renderItem({ t: "user", text });
    record({ t: "user", text });
    scrollDown(true);
  }

  function addErrorMessage(err, spec) {
    const msg = (err && err.message) || String(err);
    const m = newMessage("error");
    m.body.appendChild(node("p", "", msg));
    if (err && err.status === 401) openSettings();
    if (spec) {
      const retry = node("button", "", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => {
        m.wrap.remove();
        startRun(spec);
      });
      m.body.appendChild(retry);
    }
    record({ t: "error", msg });
    scrollDown(true);
  }

  let statusEl = null;
  function setStatus(text) {
    if (!statusEl) statusEl = node("div", "msg-status");
    statusEl.textContent = text;
    el.log.appendChild(statusEl);
    scrollDown();
  }

  function clearStatus() {
    if (statusEl) statusEl.remove();
    statusEl = null;
  }

  // One assistant turn: optional thinking, then streamed text.
  let stream = null;
  function beginAssistant() {
    stream = { text: "", reasoning: "", raf: 0, think: null, msg: null, t0: Date.now(), thinkEnd: 0 };
  }

  function ensureMsg() {
    if (!stream.msg) {
      clearStatus();
      stream.msg = newMessage("assistant");
      stream.msg.body.classList.add("streaming");
    }
    return stream.msg;
  }

  function pushReasoning(chunk) {
    if (!stream) return;
    if (!stream.think) {
      clearStatus();
      stream.think = disclosure("think", "Thinking…", "think-body");
      el.log.appendChild(stream.think.wrap);
    }
    stream.reasoning += chunk;
    schedulePaint();
  }

  function pushDelta(chunk) {
    if (!stream) return;
    if (!stream.thinkEnd) stream.thinkEnd = Date.now();
    stream.text += chunk;
    ensureMsg();
    schedulePaint();
  }

  function schedulePaint() {
    if (stream.raf) return;
    stream.raf = requestAnimationFrame(() => {
      if (!stream) return;
      stream.raf = 0;
      if (stream.think) stream.think.body.textContent = stream.reasoning;
      if (stream.msg) stream.msg.body.textContent = stream.text;
      scrollDown();
    });
  }

  function endAssistant(text, stopped) {
    if (!stream) return;
    if (stream.raf) cancelAnimationFrame(stream.raf);
    const final = text || stream.text;
    const thinkMs = stream.reasoning ? (stream.thinkEnd || Date.now()) - stream.t0 : 0;
    if (stream.think) {
      stream.think.body.textContent = stream.reasoning;
      stream.think.lab.textContent = `Thought for ${Math.max(1, Math.round(thinkMs / 1000))} s`;
    }
    if (final.trim()) {
      const m = ensureMsg();
      renderRich(m.body, final);
      addReplyTools(m.wrap, final);
      if (stopped) m.wrap.appendChild(node("div", "msg-note", "Stopped."));
    } else if (stream.msg) stream.msg.wrap.remove();
    if (final.trim() || stream.reasoning) record({ t: "assistant", text: final, reasoning: stream.reasoning.slice(0, 20000), thinkMs, stopped: !!stopped });
    stream = null;
    scrollDown();
  }

  /* ------------------------------------------------------------ tools */

  function compactArgs(args) {
    if (typeof args === "string") return args.slice(0, 80);
    const parts = [];
    for (const k of Object.keys(args || {})) {
      let v = args[k];
      if (typeof v === "string") v = `"${v.length > 24 ? v.slice(0, 24) + "…" : v}"`;
      else if (Array.isArray(v)) v = `[${v.length}]`;
      else if (v && typeof v === "object") v = "{…}";
      else v = String(v);
      parts.push(`${k}: ${v}`);
    }
    const s = parts.join(", ");
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  }

  function summarizeResult(out) {
    let j;
    try {
      j = JSON.parse(out);
    } catch (_) {
      return "";
    }
    if (j.error) return "error";
    if (Array.isArray(j.endpoints)) return `${j.endpoints.length} endpoints`;
    if (Array.isArray(j.frames)) return `${j.frames.length} frames`;
    if (Array.isArray(j.flows)) return `${j.flows.length} flows`;
    if (j.saved) return "saved";
    if (typeof j.returned === "number") {
      const total = j.total != null ? j.total : j.total_matching_entries;
      return `${j.returned}${total != null ? " of " + total : ""}`;
    }
    if (typeof j.total_entries === "number") return `${j.total_entries} entries`;
    if (j.id != null) return `#${j.id}`;
    return "";
  }

  function statusCls(s) {
    if (!s) return "s0";
    if (s < 300) return "s2";
    if (s < 400) return "s3";
    if (s < 500) return "s4";
    return "s5";
  }

  function methodPill(method) {
    const m = node("span", "method" + (TOOLS().isWriteMethod(method) ? " write" : ""), method);
    return m;
  }

  function prettyJson(out) {
    try {
      return JSON.stringify(JSON.parse(out), null, 2);
    } catch (_) {
      return out;
    }
  }

  // http_request and run_flow get a card; everything else a one-line row.
  function renderToolItem(item) {
    let j = null;
    try {
      j = JSON.parse(item.out || "");
    } catch (_) {}

    if (item.name === "http_request" && j && j.request) {
      const card = node("div", "req-card");
      const line = node("div", "req-line");
      line.appendChild(methodPill(j.request.method));
      line.appendChild(node("span", "url", j.final_url || j.request.url));
      const st = node("span", "status " + (j.error && !j.status ? "sx" : statusCls(j.status)), j.status ? String(j.status) : "failed");
      line.appendChild(st);
      line.appendChild(node("span", "meter", `${item.ms} ms`));
      card.appendChild(line);
      if (j.error) card.appendChild(node("p", "why", j.error));
      const d = disclosure("tool", "Response", "tool-body");
      d.body.textContent = prettyJson(item.out).slice(0, 6000);
      const actions = node("div", "actions");
      if (j.captured_as) {
        const open = node("button", "ghost", "Open in Traffic");
        open.type = "button";
        open.addEventListener("click", () => typeof showDetail === "function" && showDetail(Number(String(j.captured_as).slice(1)), "response"));
        actions.appendChild(open);
      }
      card.appendChild(d.wrap);
      if (actions.children.length) card.appendChild(actions);
      el.log.appendChild(card);
      return;
    }

    if (item.name === "run_flow" && j && Array.isArray(j.steps)) {
      const card = node("div", "req-card");
      card.appendChild(node("div", "req-title", (j.ok ? "Flow run succeeded" : "Flow run failed") + ` in ${j.ms} ms`));
      for (const s of j.steps) {
        const line = node("div", "req-line");
        if (s.method) line.appendChild(methodPill(s.method));
        line.appendChild(node("span", "url", s.url || s.id));
        line.appendChild(node("span", "status " + (s.skipped ? "s0" : s.ok ? statusCls(s.status || 200) : "sx"), s.skipped ? "skipped" : s.ok ? String(s.status || "ok") : "failed"));
        card.appendChild(line);
      }
      if (j.error) card.appendChild(node("p", "why", j.error));
      const d = disclosure("tool", "Details", "tool-body");
      d.body.textContent = prettyJson(item.out).slice(0, 6000);
      card.appendChild(d.wrap);
      el.log.appendChild(card);
      return;
    }

    const summary = summarizeResult(item.out || "");
    const d = disclosure("tool", "", "tool-body");
    d.lab.replaceChildren(
      node("span", "tname", `${item.name}(${compactArgs(item.args)})`),
      node("span", "tsum", (summary ? summary + " · " : "") + `${item.ms} ms`)
    );
    let pretty = prettyJson(item.out || "");
    if (pretty.length > 4000) pretty = pretty.slice(0, 4000) + "\n… (display truncated)";
    // The expanded view is the exact payload that left this machine.
    d.body.textContent = "arguments:\n" + JSON.stringify(item.args, null, 2) + "\n\nresult:\n" + pretty;
    el.log.appendChild(d.wrap);
  }

  let toolArgs = null;
  function beginTool(name, args) {
    clearStatus();
    toolArgs = args;
    setStatus(name === "http_request" ? "Sending request…" : name === "run_flow" ? "Running flow…" : `Running ${name}…`);
  }

  function endTool(name, out, ms) {
    clearStatus();
    const item = { t: "tool", name, args: toolArgs, out: out.length > 12000 ? out.slice(0, 12000) : out, ms };
    renderItem(item);
    record(item);
    toolArgs = null;
  }

  /* --------------------------------------------------------- approvals */

  function approvalLine(ask) {
    if (ask.kind === "http") return `${ask.method} ${ask.url}`;
    if (ask.flow) return `${ask.flow.name} · ${(ask.flow.steps || []).length} steps`;
    return "";
  }

  function onApproval(ask, signal) {
    clearStatus();
    return new Promise((resolve) => {
      const card = node("div", "req-card ask");
      card.appendChild(node("div", "req-title", ask.title));

      if (ask.kind === "http") {
        const line = node("div", "req-line");
        line.appendChild(methodPill(ask.method));
        line.appendChild(node("span", "url", ask.url));
        card.appendChild(line);
        const parts = [];
        if (ask.fromId != null) parts.push(`Based on captured request #${ask.fromId}; its headers are copied as captured.`);
        if (ask.fromPage) parts.push("Sent from inside the page, with the site's own cookies and origin.");
        const hs = (ask.headers || []).map((h) => `${h.name}: ${/^(authorization|cookie|x-api-key)$/i.test(h.name) ? "•••• (" + String(h.value).length + " chars)" : h.value}`);
        let preview = hs.join("\n");
        if (ask.body) preview += (preview ? "\n\n" : "") + (typeof ask.body === "string" ? ask.body : JSON.stringify(ask.body, null, 2));
        if (parts.length) card.appendChild(node("p", "why", parts.join(" ")));
        if (preview) card.appendChild(node("pre", "", preview.slice(0, 3000)));
      } else if (ask.flow) {
        const f = ask.flow;
        if (f.description) card.appendChild(node("p", "why", f.description));
        if (window.__netscopeFlowsUi) card.appendChild(window.__netscopeFlowsUi.stepTree(f.steps || []));
        if (ask.kind === "flow-delete") card.appendChild(node("p", "why", "Deleting removes the flow, its schedule and its run history."));
      }

      const actions = node("div", "actions");
      const yes = node("button", ask.kind === "flow-delete" ? "danger" : "primary", ask.kind === "http" ? "Send request" : ask.kind === "flow-run" ? "Run flow" : ask.kind === "flow-delete" ? "Delete flow" : "Save flow");
      yes.type = "button";
      const no = node("button", "", ask.kind === "http" ? "Don't send" : "Cancel");
      no.type = "button";
      actions.append(yes, no);
      card.appendChild(actions);
      el.log.appendChild(card);
      scrollDown(true);
      yes.focus();

      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        actions.replaceWith(node("div", "decided", ok ? "Approved." : "Declined."));
        card.classList.remove("ask");
        record({ t: "approval", title: ask.title, line: approvalLine(ask), approved: ok });
        if (ok) setStatus("Working…");
        resolve(ok);
      };
      yes.addEventListener("click", () => finish(true));
      no.addEventListener("click", () => finish(false));
      if (signal) signal.addEventListener("abort", () => finish(false), { once: true });
    });
  }

  /* ------------------------------------------------------------- runs */

  const handlers = {
    onUserMessage: addUserMessage,
    onStatus: setStatus,
    onAssistantStart: beginAssistant,
    onDelta: pushDelta,
    onReasoning: pushReasoning,
    onAssistantEnd: (text) => endAssistant(text),
    onToolCall: beginTool,
    onToolResult: endTool,
    onApproval,
    onNotice(text) {
      renderItem({ t: "notice", text });
      record({ t: "notice", text });
    },
    onUsage(u) {
      if (u && typeof u.total_tokens === "number") sessionTokens += u.total_tokens;
      updateMeter();
    },
    onError: addErrorMessage,
    onDone(reason) {
      if (reason === "cancelled" && stream) endAssistant("", true);
      stream = null;
      running = false;
      clearStatus();
      updateRunUi();
      updateMeter();
      persist();
    }
  };

  function startRun(spec) {
    if (typeof switchView === "function") switchView("chat");
    if (!ready) {
      openSettings();
      return;
    }
    running = true;
    updateRunUi();
    setStatus("Thinking…");
    AGENT().run(spec, handlers);
  }

  function cancel() {
    if (!running) return;
    AGENT().cancel();
    handlers.onDone("cancelled");
  }

  function updateRunUi() {
    el.send.hidden = running;
    el.stop.hidden = !running;
    el.send.disabled = !ready;
    el.newChat.disabled = running;
    setEmpty();
  }

  function updateMeter() {
    const chars = AGENT().contextChars();
    const approx = Math.round(chars / 3.5 / 100) / 10;
    el.ctx.textContent = chars ? `~${approx}k context` + (sessionTokens ? `, ${Math.round(sessionTokens / 1000)}k used` : "") : "";
    el.ctx.title = sessionTokens
      ? `Approximate context in this chat; ${sessionTokens} tokens billed on this page.`
      : "Approximate context in this chat.";
    el.newChat.title = "Start a new chat" + (chars ? ` (this one: ${el.ctx.textContent})` : "");
  }

  /* ------------------------------------------------------- selection */

  function onSelection(id) {
    if (id !== selectedId) contextOff = false;
    selectedId = id;
    renderContext();
  }

  function renderContext() {
    const e = entryFor(selectedId);
    const show = !!(e && !contextOff && e.kind !== "nav");
    el.context.hidden = !show;
    if (!show) return;
    const label =
      e.kind === "http"
        ? `#${e.id} ${e.method} ${fileNameOf(e.url)} · ${e.failed ? "failed" : e.status || "…"}`
        : `#${e.id} ${e.kind === "ws-frame" ? "WS frame" : "WebSocket"} ${fileNameOf(e.url)}`;
    el.contextOpen.textContent = label;
    el.contextOpen.title = "Show #" + e.id + " in Traffic";
  }

  function fileNameOf(u) {
    try {
      const x = new URL(u);
      return x.pathname.length > 40 ? "…" + x.pathname.slice(-40) : x.pathname || "/";
    } catch (_) {
      return String(u || "").slice(0, 40);
    }
  }

  /* -------------------------------------------------------- composer */

  function submit() {
    const text = el.input.value.trim();
    if (!text || running) return;
    if (!ready) {
      openSettings();
      return;
    }
    el.input.value = "";
    autosize();
    const useSel = !el.context.hidden && selectedId != null;
    startRun({ kind: "chat", text, entryId: selectedId, useSelection: useSel });
  }

  function prefill(text, send) {
    if (typeof switchView === "function") switchView("chat");
    el.input.value = text;
    autosize();
    if (send && ready && !running) submit();
    else el.input.focus();
  }

  function autosize() {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(180, Math.max(40, el.input.scrollHeight + 2)) + "px";
  }

  /* --------------------------------------------------------- settings */

  function consentText() {
    const base =
      "Kimi (api.moonshot.ai) will receive your questions and the parts of the captured traffic it asks for — URLs, headers and bodies from this page — plus the responses of requests it sends.";
    const tail =
      el.redact && el.redact.checked
        ? " Secret headers and token-shaped strings are masked first, but masking is best-effort and cannot catch secrets in arbitrary body fields."
        : " Masking is off, so this includes session tokens, cookies and any personal data the page transfers, verbatim.";
    return base + tail + " Only use this on traffic you are allowed to share.";
  }

  function refreshConsentText() {
    el.consentText.textContent = consentText();
    el.sheet.classList.toggle("raw", !(el.redact && el.redact.checked));
  }

  function openSettings() {
    el.sheet.hidden = false;
    fillSettings();
    (settings && settings.apiKey ? el.settingsClose : el.key).focus();
  }

  function closeSettings() {
    el.sheet.hidden = true;
    el.settingsBtn.focus();
  }

  function fillModelSelect(sel) {
    if (sel.options.length) return;
    for (const m of CLIENT().MODELS) {
      const o = node("option", "", m.label + (m.note ? " — " + m.note : ""));
      o.value = m.id;
      sel.appendChild(o);
    }
  }

  function fillSettings() {
    if (!settings) return;
    el.key.value = settings.apiKey || "";
    el.model.value = settings.model;
    el.modelSetting.value = settings.model;
    el.effort.value = settings.reasoningEffort;
    el.effortSetting.value = settings.reasoningEffort;
    el.approval.value = settings.approval;
    el.tier.value = settings.tier;
    el.maxReply.value = String(settings.maxReply);
    el.redact.checked = !!settings.redact;
    el.pii.checked = !!settings.redactPii;
    el.pii.disabled = !settings.redact;
    el.iter.value = String(settings.maxIterations || 12);
    el.consent.checked = !!settings.consented;
    const k3 = CLIENT().isK3(settings.model);
    el.effort.disabled = !k3;
    el.effort.title = k3 ? "How long Kimi thinks before answering" : "Thinking depth applies to the K3 models only";
    refreshConsentText();
  }

  async function applySettings(patch, msg) {
    try {
      settings = await CLIENT().saveSettings(patch);
    } catch (err) {
      say((err && err.message) || "Could not save settings");
      return;
    }
    ready = CLIENT().isReady(settings);
    fillSettings();
    updateRunUi();
    updateMeter();
    if (typeof renderDetail === "function" && selectedId != null) renderDetail();
    if (msg) say(msg);
  }

  /* ------------------------------------------------------------ wire */

  function wire() {
    el.settingsBtn.addEventListener("click", () => (el.sheet.hidden ? openSettings() : closeSettings()));
    el.settingsClose.addEventListener("click", closeSettings);
    el.sheet.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeSettings();
    });
    el.connectBtn.addEventListener("click", openSettings);

    el.newChat.addEventListener("click", () => {
      AGENT().newConversation();
      for (const n of Array.from(el.log.children)) if (n !== el.empty) n.remove();
      statusEl = null;
      stream = null;
      running = false;
      sessionTokens = 0;
      transcript = [];
      persist();
      updateRunUi();
      updateMeter();
      el.input.focus();
    });

    el.model.addEventListener("change", () => applySettings({ model: el.model.value }));
    el.modelSetting.addEventListener("change", () => {
      el.effortSetting.disabled = !CLIENT().isK3(el.modelSetting.value);
    });
    el.effort.addEventListener("change", () => applySettings({ reasoningEffort: el.effort.value }));

    el.suggest.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-prompt]");
      if (!b) return;
      if (b.dataset.prompt === "summarize") startRun({ kind: "summarize", maxIterations: 10 });
      else startRun({ kind: "chat", text: b.dataset.prompt });
    });

    el.composer.addEventListener("submit", (ev) => {
      ev.preventDefault();
      submit();
    });
    el.stop.addEventListener("click", cancel);
    el.input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        submit();
      }
    });
    el.input.addEventListener("input", autosize);
    el.log.addEventListener("scroll", () => {
      stick = nearBottom();
    });

    el.contextOpen.addEventListener("click", () => selectedId != null && typeof showDetail === "function" && showDetail(selectedId));
    el.contextClear.addEventListener("click", () => {
      contextOff = true;
      renderContext();
    });

    el.redact.addEventListener("change", () => {
      el.pii.disabled = !el.redact.checked;
      if (!el.redact.checked) el.pii.checked = false;
      refreshConsentText();
    });
    el.consent.addEventListener("change", refreshConsentText);

    el.save.addEventListener("click", async () => {
      const key = el.key.value.trim();
      if (!key) return say("Enter an API key first");
      if (!el.consent.checked) return say("Tick the consent box to turn on Kimi");
      await applySettings(
        {
          apiKey: key,
          model: el.modelSetting.value,
          reasoningEffort: el.effortSetting.value,
          approval: el.approval.value,
          approvalSet: true,
          tier: el.tier.value,
          maxReply: el.maxReply.value,
          redact: el.redact.checked,
          redactPii: el.pii.checked,
          maxIterations: Math.min(30, Math.max(1, Number(el.iter.value) || 12)),
          consented: true,
          enabled: true
        },
        "Kimi is on"
      );
      if (ready) {
        closeSettings();
        el.input.focus();
      }
    });

    el.test.addEventListener("click", async () => {
      const key = el.key.value.trim();
      if (!key) return say("Enter an API key first");
      el.test.disabled = true;
      el.test.textContent = "Testing…";
      try {
        await CLIENT().testKey(key, el.modelSetting.value);
        say("Key works with " + el.modelSetting.value);
      } catch (err) {
        say((err && err.message) || "Test failed");
      }
      el.test.disabled = false;
      el.test.textContent = "Test key";
    });

    el.forget.addEventListener("click", async () => {
      settings = await CLIENT().forgetKey();
      ready = false;
      fillSettings();
      updateRunUi();
      updateMeter();
      say("API key removed");
    });
  }

  /* -------------------------------------------------------------- init */

  async function attach(a) {
    if (api) return;
    api = a;
    const ids = {
      log: "aiLog", empty: "aiEmpty", connect: "aiConnect", connectBtn: "aiConnectBtn", suggest: "aiSuggest",
      composer: "aiComposer", context: "aiContext", contextOpen: "aiContextOpen", contextClear: "aiContextClear",
      input: "aiInput", model: "aiModel", effort: "aiEffort", ctx: "aiCtx", newChat: "aiNewChat", send: "aiSend",
      stop: "aiStop", sheet: "settings", settingsBtn: "btnSettings", settingsClose: "settingsClose", key: "aiKey",
      modelSetting: "aiModelSetting", effortSetting: "aiEffortSetting", approval: "aiApproval", iter: "aiIterations",
      tier: "aiTier", maxReply: "aiMaxReply",
      redact: "aiRedact", pii: "aiPii", consent: "aiConsent", consentText: "aiConsentText", save: "aiSave",
      test: "aiTest", forget: "aiForget"
    };
    for (const k of Object.keys(ids)) el[k] = $(ids[k]);

    fillModelSelect(el.model);
    fillModelSelect(el.modelSetting);
    const fmt = (n) => (n >= 1000000 ? n / 1000000 + "M" : n >= 1000 ? n / 1000 + "k" : String(n));
    for (const [key, t] of Object.entries(CLIENT().TIERS)) {
      const o = node("option", "", `${t.label} — ${t.rpm} requests and ${fmt(t.tpm)} tokens a minute${t.tpd ? `, ${fmt(t.tpd)} a day` : ""}`);
      o.value = key;
      el.tier.appendChild(o);
    }
    for (const v of CLIENT().REPLY_CHOICES) {
      const o = node("option", "", v === "auto" ? "Auto — 8k, 16k or 32k by thinking depth" : `${Number(v).toLocaleString()} tokens`);
      o.value = v;
      el.maxReply.appendChild(o);
    }
    // Short labels in the composer; the settings sheet keeps the notes.
    for (const o of el.model.options) o.textContent = o.textContent.split(" — ")[0];

    TOOLS().attach(api);
    wire();

    settings = await CLIENT().loadSettings();
    ready = CLIENT().isReady(settings);
    fillSettings();
    updateRunUi();
    updateMeter();
    setEmpty();

    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(async (changes, area) => {
        if (area !== "local" || !changes["netscope.ai"]) return;
        CLIENT().invalidate();
        settings = await CLIENT().loadSettings();
        ready = CLIENT().isReady(settings);
        if (el.sheet.hidden) fillSettings();
        else {
          el.model.value = settings.model;
          el.effort.value = settings.reasoningEffort;
        }
        updateRunUi();
      });
    }

    const hello = await api.whenReady();
    storeKey = "netscope.chat." + hello.tabId;
    await restore();
    api.subscribe((type) => {
      if (type === "snapshot" || type === "clear") renderContext();
    });
  }

  return {
    attach,
    onSelection,
    isEnabled: () => ready,
    isRunning: () => running,
    cancel,
    startRun,
    prefill,
    openSettings,
    canExplain
  };
})();
