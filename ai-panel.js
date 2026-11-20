/* NetScope – ai-panel.js
 * The Chat view: transcript, composer, approvals, settings sheet.
 *
 * Model output is untrusted-adjacent and captured payloads certainly are, so
 * the rule holds here without exception: textContent and createElement only,
 * never innerHTML. The "markdown" renderer builds elements; it never parses
 * model output as HTML.
 *
 * Every conversation is kept (IndexedDB, through the background worker):
 * New chat starts another one, History reopens any of them, and a page
 * reload picks the tab's current one back up. Each answer's working steps
 * (thinking, tool calls, requests) fold into one accordion once the answer
 * is in. A question can be edited or retried, which rewinds the
 * conversation to that point.
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
  let storeKey = null; // session pointer: which conversation this tab has open
  let conv = null; // { id, createdAt, page } of the open conversation
  let curRun = null; // the open answer's process accordion
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

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

  // Where a step of the current answer goes: inside its process accordion
  // while one is open, otherwise straight into the log.
  function place(n) {
    (curRun ? curRun.body : el.log).appendChild(n);
    return n;
  }

  function setEmpty() {
    const has = el.log.querySelector(".msg, .req-card, .tool, .think, .run");
    el.empty.hidden = !!has;
    el.connect.hidden = ready;
    for (const b of el.suggest.querySelectorAll("button")) b.disabled = !ready;
  }

  /* ----------------------------------------------------- persistence */

  function newConv() {
    conv = { id: uid("chat_"), createdAt: Date.now(), page: api && api.page ? api.page() : null };
  }

  let saveTimer = 0;
  function chatPayload() {
    const first = transcript.find((x) => x.t === "user");
    if (!first || !conv) return null; // nothing worth keeping yet
    return {
      id: conv.id,
      title: String(first.text || "").replace(/\s+/g, " ").trim().slice(0, 80) || "Chat",
      createdAt: conv.createdAt,
      updatedAt: Date.now(),
      page: conv.page,
      transcript: transcript.slice(-500),
      messages: AGENT().getMessages(),
      tokens: sessionTokens,
      running
    };
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    const chat = chatPayload();
    if (!chat) return;
    try {
      await api.rpc("chats.save", { chat });
    } catch (_) {}
    try {
      if (storeKey && chrome.storage && chrome.storage.session) await chrome.storage.session.set({ [storeKey]: { chatId: chat.id } });
    } catch (_) {}
  }

  // During an answer steps arrive constantly; save at most every few seconds
  // (and always when it ends, in onDone) instead of after every step.
  function persist() {
    if (!api) return;
    if (running) {
      if (!saveTimer) saveTimer = setTimeout(saveNow, 3000);
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  function clearLog() {
    for (const n of Array.from(el.log.children)) if (n !== el.empty) n.remove();
    statusEl = null;
    stream = null;
    curRun = null;
  }

  // Renders a saved transcript. A process accordion still open at the end
  // means the answer was cut off (reload, crash): say so and offer Continue.
  function renderTranscript(wasRunning, maybeLive) {
    clearLog();
    transcript.forEach((item, i) => renderItem(item, true, i));
    const interrupted = !!curRun || wasRunning;
    if (curRun) finishRunBox({ reason: "interrupted" }, true);
    if (interrupted && maybeLive) {
      // Saved moments ago while running: another tab is probably still on it.
      el.log.appendChild(node("div", "msg-note", "This conversation may still be running in another tab. Wait for it there before continuing here."));
    } else if (interrupted && transcript.some((x) => x.t === "user")) {
      const note = node("div", "msg msg-error");
      const body = node("div", "msg-body");
      body.appendChild(node("p", "", "This answer was interrupted before it finished."));
      const go = node("button", "primary", "Continue");
      go.type = "button";
      go.addEventListener("click", () => {
        note.remove();
        startRun({ kind: "continue" });
      });
      body.appendChild(go);
      note.appendChild(body);
      el.log.appendChild(note);
    }
    scrollDown(true);
    updateMeter();
    setEmpty();
  }

  function openChat(chat) {
    conv = { id: chat.id, createdAt: chat.createdAt || Date.now(), page: chat.page || null };
    sessionTokens = chat.tokens || 0;
    AGENT().setMessages(chat.messages || []);
    transcript = (chat.transcript || []).slice();
    renderTranscript(!!chat.running, !!chat.running && Date.now() - (chat.updatedAt || 0) < 15000);
    try {
      if (storeKey) chrome.storage.session.set({ [storeKey]: { chatId: chat.id } });
    } catch (_) {}
  }

  async function restore() {
    let ptr = null;
    try {
      if (storeKey && chrome.storage && chrome.storage.session) ptr = (await chrome.storage.session.get(storeKey))[storeKey];
    } catch (_) {}
    if (ptr && ptr.chatId) {
      const chat = await api.rpc("chats.get", { id: ptr.chatId }).catch(() => null);
      if (chat) return openChat(chat);
    }
    newConv();
    if (ptr && Array.isArray(ptr.transcript)) {
      // Saved by an earlier version, in session storage only: keep it.
      sessionTokens = ptr.tokens || 0;
      AGENT().setMessages(ptr.messages || []);
      transcript = ptr.transcript.slice();
      renderTranscript(false);
      saveNow();
    }
  }

  // Steps of an answer are tagged with its run, so a reload can fold them back
  // into the same accordion.
  function record(item) {
    if (curRun && item.t !== "user" && item.t !== "runbox" && item.t !== "error") item.run = curRun.id;
    transcript.push(item);
    persist();
    return transcript.length - 1;
  }

  /* ----------------------------------------------- process accordion */

  function fmtDur(ms) {
    const sec = Math.max(1, Math.round(ms / 1000));
    if (sec < 60) return `${sec} s`;
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    return r ? `${m} min ${r} s` : `${m} min`;
  }

  function beginRunBox(id, restoring) {
    const box = node("div", "run");
    const head = node("button", "run-head");
    head.type = "button";
    head.setAttribute("aria-expanded", "true");
    head.appendChild(node("span", "caret", "▸"));
    const lab = node("span", "run-lab", "Working…");
    head.appendChild(lab);
    const body = node("div", "run-body");
    head.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });
    box.append(head, body);
    el.log.appendChild(box);
    curRun = { id: id || uid("run_"), box, head, lab, body, t0: Date.now(), tools: 0 };
    if (!restoring) record({ t: "runbox", id: curRun.id, phase: "start", at: Date.now() });
    return curRun;
  }

  // The answer moves out below the accordion; the steps fold away.
  function finishRunBox(info, restoring) {
    const r = curRun;
    if (!r) return;
    curRun = null;
    if (statusEl && r.body.contains(statusEl)) clearStatus();
    const answer = [];
    for (let n = r.body.lastElementChild; n; ) {
      const prev = n.previousElementSibling;
      if (n.classList.contains("msg-assistant")) answer.unshift(n);
      else if (!n.classList.contains("think") && !n.classList.contains("msg-note")) break;
      n = prev;
    }
    let ref = r.box;
    for (const a of answer) {
      ref.after(a);
      ref = a;
    }
    const reason = (info && info.reason) || "complete";
    let summary = info && info.summary;
    if (!summary) {
      const tail = reason === "cancelled" ? " · stopped" : reason === "error" ? " · stopped by an error" : reason === "interrupted" ? " · interrupted" : "";
      summary = `Worked for ${fmtDur(Date.now() - r.t0)}${r.tools ? ` · ${r.tools} step${r.tools === 1 ? "" : "s"}` : ""}${tail}`;
    }
    if (!r.body.children.length) r.box.remove();
    else {
      r.lab.textContent = summary;
      const fold = answer.length > 0;
      r.body.hidden = fold;
      r.head.setAttribute("aria-expanded", fold ? "false" : "true");
      r.box.classList.add("done");
    }
    if (!restoring) record({ t: "runbox", id: r.id, phase: "end", summary, reason });
  }

  /* ---------------------------------------------- edit / retry / rewind */

  // Drops everything from this question on — screen, transcript and Kimi's
  // history — so it can be asked again (as is, or edited).
  function rewindTo(wrap) {
    const ti = Number(wrap.dataset.ti);
    const item = transcript[ti];
    if (!item) return null;
    for (let n = wrap; n; ) {
      const next = n.nextSibling;
      if (n !== el.empty) n.remove();
      n = next;
    }
    statusEl = null;
    stream = null;
    curRun = null;
    const later = transcript.slice(ti + 1).filter((x) => x.t === "user" && x.text === item.text).length;
    transcript = transcript.slice(0, ti);
    AGENT().truncateAt(item.text, later);
    persist();
    return item;
  }

  function retryUser(wrap) {
    if (running) return say("Wait for the current answer, or press Stop");
    const item = rewindTo(wrap);
    if (item) startRun({ kind: "chat", text: item.text });
  }

  function editUser(wrap) {
    if (running) return say("Wait for the current answer, or press Stop");
    if (wrap.querySelector(".user-edit")) return;
    const item = transcript[Number(wrap.dataset.ti)];
    if (!item) return;
    const body = wrap.querySelector(".msg-body");
    const tools = wrap.querySelector(".msg-tools");
    body.hidden = true;
    if (tools) tools.hidden = true;
    const box = node("div", "user-edit");
    const ta = node("textarea");
    ta.value = item.text;
    ta.rows = Math.min(10, Math.max(2, item.text.split("\n").length));
    ta.setAttribute("aria-label", "Edit your message");
    const row = node("div", "actions");
    const send = node("button", "primary", "Send");
    send.type = "button";
    const cancelBtn = node("button", "ghost", "Cancel");
    cancelBtn.type = "button";
    row.append(send, cancelBtn);
    box.append(ta, row);
    wrap.appendChild(box);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const close = () => {
      box.remove();
      body.hidden = false;
      if (tools) tools.hidden = false;
    };
    const go = () => {
      const text = ta.value.trim();
      if (!text || running) return;
      if (rewindTo(wrap)) startRun({ kind: "chat", text });
    };
    send.addEventListener("click", go);
    cancelBtn.addEventListener("click", close);
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        go();
      } else if (ev.key === "Escape") close();
    });
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

  // Markdown → DOM lives in markdown.js (tables, nested lists, quotes, code
  // with Copy, safe links). Plain text runs through appendRefs so "#412"
  // links to that request in Traffic.
  function renderRich(container, text) {
    container.classList.remove("streaming");
    const md = globalThis.__netscopeMarkdown;
    if (!md) {
      container.replaceChildren(node("p", "", String(text || "")));
      return;
    }
    md.render(container, text, {
      leaf: appendRefs,
      copy: (t, msg) => typeof copyText === "function" && copyText(t, msg)
    });
  }

  /* ------------------------------------------------------- transcript */

  // top: outside any accordion (questions and errors stay in plain view).
  function newMessage(cls, top) {
    const wrap = node("div", "msg msg-" + cls);
    const body = node("div", "msg-body");
    wrap.appendChild(body);
    if (top || cls === "user" || cls === "error") el.log.appendChild(wrap);
    else place(wrap);
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

  function renderItem(item, restoring, ti) {
    if (item.t === "runbox") {
      if (item.phase === "start") beginRunBox(item.id, true);
      else if (curRun && curRun.id === item.id) finishRunBox(item, true);
      return;
    }
    if (item.t === "user") {
      const m = newMessage("user", true);
      m.body.textContent = item.text;
      m.wrap.dataset.ti = String(ti);
      const tools = node("div", "msg-tools user-tools");
      const edit = node("button", "", "Edit");
      edit.type = "button";
      edit.title = "Edit this message and ask again — later replies are replaced";
      edit.addEventListener("click", () => editUser(m.wrap));
      const retry = node("button", "", "Retry");
      retry.type = "button";
      retry.title = "Ask this again from here — later replies are replaced";
      retry.addEventListener("click", () => retryUser(m.wrap));
      tools.append(edit, retry);
      m.wrap.appendChild(tools);
    } else if (item.t === "assistant") {
      if (item.reasoning) {
        const d = disclosure("think", "Thought" + (item.thinkMs ? ` for ${Math.max(1, Math.round(item.thinkMs / 1000))} s` : ""), "think-body");
        d.body.textContent = item.reasoning;
        place(d.wrap);
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
      place(node("div", "msg-note", item.text));
    } else if (item.t === "error") {
      const m = newMessage("error");
      m.body.appendChild(node("p", "", item.msg));
    } else if (item.t === "approval") {
      const card = node("div", "req-card");
      card.appendChild(node("div", "req-title", item.title));
      if (item.line) card.appendChild(node("div", "req-line", item.line));
      card.appendChild(node("div", "decided", item.approved ? "Approved." : "Declined."));
      place(card);
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
    const item = { t: "user", text };
    const ti = transcript.length;
    renderItem(item, false, ti);
    record(item);
    beginRunBox();
    scrollDown(true);
  }

  // After an error the conversation is intact up to the failure; Continue
  // picks it up there (no repeated question).
  function addErrorMessage(err, spec) {
    const msg = (err && err.message) || String(err);
    if (curRun) finishRunBox({ reason: "error" });
    const m = newMessage("error");
    m.body.appendChild(node("p", "", msg));
    if (err && err.status === 401) openSettings();
    if (err && /^(no-tab|signed-out|closed|no-bridge|nav|lost)$/.test(err.muse || "") && MUSE()) {
      const show = node("button", "", "Open muse.ai");
      show.type = "button";
      show.addEventListener("click", () => MUSE().open().catch(() => {}));
      m.body.appendChild(show);
    }
    if (spec) {
      const again = node("button", spec.kind === "continue" ? "primary" : "", spec.kind === "continue" ? "Continue" : "Try again");
      again.type = "button";
      again.addEventListener("click", () => {
        m.wrap.remove();
        startRun(spec);
      });
      m.body.appendChild(again);
    }
    record({ t: "error", msg });
    scrollDown(true);
  }

  let statusEl = null;
  function setStatus(text) {
    if (!statusEl) statusEl = node("div", "msg-status");
    statusEl.textContent = text;
    place(statusEl);
    scrollDown();
  }

  function clearStatus() {
    if (statusEl) statusEl.remove();
    statusEl = null;
  }

  // One assistant turn: optional thinking, then streamed text.
  let stream = null;
  let lastAnswer = null; // the latest finished answer message, for joining a continuation
  let joinNext = null;
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
      place(stream.think.wrap);
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
    // A continuation of a cut-off answer joins it: one message, one Copy.
    if (joinNext && final.trim() && joinNext.wrap.isConnected) {
      const merged = joinNext.text + final;
      renderRich(joinNext.body, merged);
      joinNext.wrap.querySelector(".msg-tools") && joinNext.wrap.querySelector(".msg-tools").remove();
      addReplyTools(joinNext.wrap, merged);
      if (stream.msg) stream.msg.wrap.remove();
      transcript[joinNext.ti].text = merged;
      persist();
      lastAnswer = { wrap: joinNext.wrap, body: joinNext.body, text: merged, ti: joinNext.ti };
      joinNext = null;
      stream = null;
      scrollDown();
      return;
    }
    joinNext = null;
    if (final.trim() || stream.reasoning) {
      const ti = record({ t: "assistant", text: final, reasoning: stream.reasoning.slice(0, 20000), thinkMs, stopped: !!stopped });
      if (final.trim() && stream.msg) lastAnswer = { wrap: stream.msg.wrap, body: stream.msg.body, text: final, ti };
    }
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
      place(card);
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
      place(card);
      return;
    }

    if ((item.name === "write_doc" || item.name === "edit_doc") && j && j.saved) {
      const card = node("div", "req-card doc-card");
      const line = node("div", "req-line");
      line.appendChild(node("span", "method", "doc"));
      line.appendChild(node("span", "url", `${j.created ? "Created" : "Updated"} “${j.title}”`));
      card.appendChild(line);
      const actions = node("div", "actions");
      const open = node("button", "ghost", "Open doc");
      open.type = "button";
      open.addEventListener("click", () => window.__netscopeDocsUi && window.__netscopeDocsUi.open(j.id));
      actions.appendChild(open);
      card.appendChild(actions);
      place(card);
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
    place(d.wrap);
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
    if (curRun) {
      curRun.tools++;
      curRun.lab.textContent = `Working… · ${curRun.tools} step${curRun.tools === 1 ? "" : "s"}`;
    }
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
      place(card);
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
    // A step that failed mid-stream is redone: take its partial output away.
    onContinueAnswer() {
      joinNext = lastAnswer;
    },
    onTurnReset() {
      if (!stream) return;
      if (stream.raf) cancelAnimationFrame(stream.raf);
      if (stream.msg) stream.msg.wrap.remove();
      if (stream.think) stream.think.wrap.remove();
      stream = null;
    },
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
      if (curRun) finishRunBox({ reason });
      updateRunUi();
      updateMeter();
      saveNow();
    }
  };

  function startRun(spec) {
    if (typeof switchView === "function") switchView("chat");
    if (!ready) {
      openSettings();
      return;
    }
    if (!conv) newConv();
    running = true;
    updateRunUi();
    if (spec.kind === "continue") beginRunBox(); // no new question: open the box now
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
    if (el.historyBtn) el.historyBtn.disabled = running;
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

  /* --------------------------------------------------------- history */

  let historyList = [];

  async function openHistory() {
    if (running) return;
    el.historySheet.hidden = false;
    el.historySearch.value = "";
    await saveNow();
    await loadHistory();
    el.historySearch.focus();
  }

  function closeHistory() {
    el.historySheet.hidden = true;
    el.historyBtn.focus();
  }

  async function loadHistory() {
    try {
      historyList = await api.rpc("chats.list");
    } catch (_) {
      historyList = [];
    }
    renderHistory();
  }

  function renderHistory() {
    const q = el.historySearch.value.trim().toLowerCase();
    const list = historyList.filter((c) => !q || String(c.title).toLowerCase().includes(q) || String(c.site || "").toLowerCase().includes(q));
    el.historyList.replaceChildren();
    if (!list.length) {
      el.historyList.appendChild(node("li", "hint", historyList.length ? "No conversations match." : "No saved conversations yet. Every chat you start is kept here."));
      return;
    }
    for (const c of list) {
      const li = node("li", "history-item" + (conv && c.id === conv.id ? " current" : ""));
      const open = node("button", "history-open");
      open.type = "button";
      open.appendChild(node("span", "history-title", c.title || "Chat"));
      const when = new Date(c.updatedAt);
      const meta = [when.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })];
      if (c.site) meta.push(c.site);
      meta.push(`${c.questions || 0} question${c.questions === 1 ? "" : "s"}`);
      if (conv && c.id === conv.id) meta.push("open now");
      open.appendChild(node("span", "history-meta", meta.join(" · ")));
      open.addEventListener("click", async () => {
        if (running) return;
        const chat = await api.rpc("chats.get", { id: c.id }).catch(() => null);
        if (!chat) return say("That conversation could not be loaded");
        openChat(chat);
        closeHistory();
        el.input.focus();
      });
      const del = node("button", "ghost history-del", "Delete");
      del.type = "button";
      del.setAttribute("aria-label", `Delete “${c.title}”`);
      del.addEventListener("click", async () => {
        if (!del.dataset.armed) {
          del.dataset.armed = "1";
          del.textContent = "Click again to delete";
          del.className = "danger history-del";
          return;
        }
        await api.rpc("chats.delete", { id: c.id }).catch(() => {});
        if (conv && c.id === conv.id) {
          AGENT().newConversation();
          clearLog();
          transcript = [];
          sessionTokens = 0;
          newConv();
          setEmpty();
          updateMeter();
        }
        loadHistory();
      });
      li.append(open, del);
      el.historyList.appendChild(li);
    }
  }

  /* ---------------------------------------------------- export / import */

  async function exportData() {
    const options = {
      chats: el.dataChats.checked,
      flows: el.dataFlows.checked,
      flowData: el.dataFlows.checked,
      docs: el.dataDocs.checked,
      settings: el.dataSettings.checked,
      apiKey: el.dataSettings.checked && el.dataKey.checked
    };
    el.dataExport.disabled = true;
    el.dataExport.textContent = "Exporting…";
    try {
      await saveNow();
      const data = await api.rpc("data.export", { options });
      const day = new Date().toISOString().slice(0, 10);
      if (typeof download === "function") download(`netscope-backup-${day}.json`, JSON.stringify(data, null, 1), "application/json");
      const c = data.counts || {};
      say(`Exported ${c.chats || 0} conversations, ${c.flows || 0} flows, ${c.docs || 0} docs`);
    } catch (err) {
      say("Export failed: " + err.message);
    } finally {
      el.dataExport.disabled = false;
      el.dataExport.textContent = "Export…";
    }
  }

  async function importData() {
    const file = el.dataFile.files && el.dataFile.files[0];
    el.dataFile.value = "";
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (_) {
      return say("That file is not valid JSON");
    }
    el.dataImport.disabled = true;
    el.dataImport.textContent = "Importing…";
    try {
      const r = await api.rpc("data.import", { data });
      const parts = [`${r.chats} conversations`, `${r.flows} flows`, `${r.docs} docs`];
      if (r.settings) parts.push("settings");
      say(`Imported ${parts.join(", ")}${r.skipped ? ` (${r.skipped} already up to date)` : ""}${r.errors.length ? `; ${r.errors.length} could not be imported: ${r.errors[0]}` : ""}`);
    } catch (err) {
      say("Import failed: " + err.message);
    } finally {
      el.dataImport.disabled = false;
      el.dataImport.textContent = "Import…";
    }
  }

  /* --------------------------------------------------------- settings */

  const MUSE = () => globalThis.__netscopeMuse;
  const aiName = (model) => CLIENT().providerName(model || (settings && settings.model));
  // The AI picked in the settings sheet (may differ from the saved one until Save).
  const sheetModel = () => (el.modelSetting && el.modelSetting.value) || (settings && settings.model);

  function consentText() {
    const base = CLIENT().isMuse(sheetModel())
      ? "Muse (muse.ai, by Meta) will receive your questions and the parts of the captured traffic it asks for — URLs, headers and bodies from this page — plus the responses of requests it sends, as messages in a side chat of your Muse account, where they stay in your Muse history."
      : "Kimi (api.moonshot.ai) will receive your questions and the parts of the captured traffic it asks for — URLs, headers and bodies from this page — plus the responses of requests it sends.";
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
    (settings && (settings.apiKey || CLIENT().isMuse(settings.model)) ? el.settingsClose : el.key).focus();
  }

  function closeSettings() {
    clearTimeout(museTimer);
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
    el.iter.value = String(settings.maxIterations || CLIENT().DEFAULTS.maxIterations);
    const k3 = CLIENT().isK3(settings.model);
    el.effort.disabled = !k3;
    el.effort.hidden = CLIENT().isMuse(settings.model); // Muse sets its own depth
    el.effort.title = k3 ? "How long Kimi thinks before answering" : CLIENT().isMuse(settings.model) ? "Muse sets its own thinking depth" : "Thinking depth applies to the K3 models only";
    syncSheet();
    syncNames();
  }

  // The sheet shows the key and rate limits for Kimi, the tab status for Muse.
  function syncSheet() {
    const muse = CLIENT().isMuse(sheetModel());
    for (const n of el.sheet.querySelectorAll(".kimi-only")) n.hidden = muse;
    for (const n of el.sheet.querySelectorAll(".muse-only")) n.hidden = !muse;
    el.consent.checked = !!(settings && (muse ? settings.museConsented : settings.consented));
    el.effortSetting.disabled = !CLIENT().isK3(sheetModel());
    refreshConsentText();
    if (muse && !el.sheet.hidden) refreshMuseStatus();
  }

  // "Kimi" or "Muse" wherever the page names the AI.
  function syncNames() {
    const name = aiName();
    for (const n of document.querySelectorAll(".ai-name")) n.textContent = name;
    el.input.placeholder = `Ask ${name}, paste a cURL to run, or describe a flow to automate`;
    el.input.setAttribute("aria-label", "Message " + name);
    const muse = settings && CLIENT().isMuse(settings.model);
    el.connectText.textContent = muse
      ? "Connect Muse to start: sign in at muse.ai in a tab and keep it open. Traffic, Edit & send and Flows work without it."
      : "Add your Kimi API key to start. Traffic, Edit & send and Flows work without it.";
    el.connectBtn.textContent = "Connect " + name;
  }

  let museTimer = 0;
  async function refreshMuseStatus(watch) {
    clearTimeout(museTimer);
    if (!MUSE()) return;
    let st;
    try {
      st = await MUSE().status();
    } catch (_) {
      st = null;
    }
    el.museStatus.classList.toggle("ok", !!(st && st.signedIn));
    el.museStatus.textContent = !st
      ? "Couldn't check for a muse.ai tab."
      : st.signedIn
        ? "Connected — your muse.ai tab is signed in." + (st.hidden ? " It's in the background, which is fine." : " You can minimize its window.")
        : st.open
          ? "A muse.ai tab is open but not signed in. Sign in there."
          : "No muse.ai tab is open. Open one and sign in.";
    el.museOpen.textContent = st && st.open ? "Show muse.ai tab" : "Open muse.ai";
    // After "Open muse.ai", keep checking while the user signs in.
    if (watch && !(st && st.signedIn) && !el.sheet.hidden && watch > 0) museTimer = setTimeout(() => refreshMuseStatus(watch - 1), 2500);
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

    // The current conversation is already saved; this just opens a new one.
    el.newChat.addEventListener("click", async () => {
      if (running) return;
      await saveNow();
      AGENT().newConversation();
      clearLog();
      sessionTokens = 0;
      transcript = [];
      newConv();
      try {
        if (storeKey) await chrome.storage.session.set({ [storeKey]: { chatId: conv.id } });
      } catch (_) {}
      updateRunUi();
      updateMeter();
      setEmpty();
      el.input.focus();
    });

    el.historyBtn.addEventListener("click", openHistory);
    el.historyClose.addEventListener("click", closeHistory);
    el.historySheet.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeHistory();
    });
    el.historySearch.addEventListener("input", () => renderHistory());

    el.dataExport.addEventListener("click", exportData);
    el.dataImport.addEventListener("click", () => el.dataFile.click());
    el.dataFile.addEventListener("change", importData);

    el.model.addEventListener("change", () => applySettings({ model: el.model.value }));
    el.modelSetting.addEventListener("change", syncSheet);
    el.museCheck.addEventListener("click", () => refreshMuseStatus());
    el.museOpen.addEventListener("click", async () => {
      try {
        await MUSE().open();
      } catch (err) {
        say((err && err.message) || "Couldn't open muse.ai");
      }
      refreshMuseStatus(48);
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
      const muse = CLIENT().isMuse(el.modelSetting.value);
      const common = {
        model: el.modelSetting.value,
        approval: el.approval.value,
        approvalSet: true,
        redact: el.redact.checked,
        redactPii: el.pii.checked,
        maxIterations: Math.min(CLIENT().MAX_ITERATIONS, Math.max(1, Number(el.iter.value) || CLIENT().DEFAULTS.maxIterations)),
        iterationsSet: true
      };
      if (muse) {
        if (!el.consent.checked) return say("Tick the consent box to turn on Muse");
        await applySettings(Object.assign(common, { museConsented: true }), "Muse is on — keep your muse.ai tab open");
        if (ready) {
          closeSettings();
          el.input.focus();
        }
        return;
      }
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
          maxIterations: Math.min(CLIENT().MAX_ITERATIONS, Math.max(1, Number(el.iter.value) || CLIENT().DEFAULTS.maxIterations)),
          iterationsSet: true,
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
      historyBtn: "aiHistory", historySheet: "history", historyClose: "historyClose", historySearch: "historySearch",
      historyList: "historyList", dataExport: "dataExport", dataImport: "dataImport", dataFile: "dataFile",
      dataChats: "dataChats", dataFlows: "dataFlows", dataDocs: "dataDocs", dataSettings: "dataSettings", dataKey: "dataKey",
      connectText: "aiConnectText", museStatus: "museStatus", museOpen: "museOpen", museCheck: "museCheck",
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
          syncNames();
        }
        updateRunUi();
      });
    }

    const hello = await api.whenReady();
    storeKey = "netscope.chat." + hello.tabId;
    await restore();
    api.subscribe((type) => {
      if (type === "snapshot" || type === "clear") renderContext();
      if (type === "chats-changed" && !el.historySheet.hidden) loadHistory();
    });
    // Leaving the page (reload, navigation): write the conversation now.
    window.addEventListener("pagehide", () => saveNow());
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
    canExplain,
    renderRich,
    aiName: () => aiName()
  };
})();
