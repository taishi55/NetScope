/* NetScope – ai-panel.js
 * The AI sidebar: transcript, composer, quick actions, settings drawer.
 *
 * Model output is untrusted-adjacent and captured payloads certainly are, so
 * the panel-wide rule holds here without exception: textContent and
 * createElement only, never innerHTML. The "markdown" renderer below builds
 * elements; it never parses model output as HTML.
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
  let running = false;
  let sessionTokens = 0;

  const $ = (id) => document.getElementById(id);
  const el = {};

  /* -------------------------------------------------------------- util */

  function say(msg) {
    if (typeof toast === "function") toast(msg);
  }

  function entryFor(id) {
    const t = TOOLS();
    return id == null || !t ? null : t.entryById(id);
  }

  function canExplain(e) {
    return !!(e && e.kind === "http");
  }

  function canDebug(e) {
    return !!(e && e.kind === "http" && (e.status >= 400 || e.status === 0));
  }

  function nearBottom() {
    const box = el.log;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  }

  function scrollDown(force) {
    if (force || nearBottom()) el.log.scrollTop = el.log.scrollHeight;
  }

  function fmtBytes(n) {
    if (typeof fmtSize === "function") return fmtSize(n);
    return n + " B";
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
        a.title = "Show this entry";
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
      } else if (part) {
        appendRefs(parent, part);
      }
    }
  }

  function inline(parent, text) {
    for (const part of text.split(/(`[^`]+`)/g)) {
      if (/^`[^`]+`$/.test(part)) {
        const c = document.createElement("code");
        c.textContent = part.slice(1, -1);
        parent.appendChild(c);
      } else if (part) {
        appendBold(parent, part);
      }
    }
  }

  const isBullet = (s) => /^\s*([-*•]|\d+[.)])\s+/.test(s);
  const isFence = (s) => /^\s*```/.test(s);
  const isHeading = (s) => /^\s*#{1,6}\s+/.test(s);

  function renderRich(container, text) {
    container.replaceChildren();
    const lines = String(text || "").split(/\r?\n/);
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (isFence(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !isFence(lines[i])) buf.push(lines[i++]);
        i++;
        const pre = document.createElement("pre");
        pre.textContent = buf.join("\n");
        container.appendChild(pre);
        continue;
      }

      if (isHeading(line)) {
        const h = document.createElement("h5");
        inline(h, line.replace(/^\s*#{1,6}\s+/, ""));
        container.appendChild(h);
        i++;
        continue;
      }

      if (isBullet(line)) {
        const ul = document.createElement("ul");
        while (i < lines.length && isBullet(lines[i])) {
          const li = document.createElement("li");
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
      while (i < lines.length && lines[i].trim() && !isFence(lines[i]) && !isBullet(lines[i]) && !isHeading(lines[i])) {
        buf.push(lines[i++]);
      }
      const p = document.createElement("p");
      inline(p, buf.join(" "));
      container.appendChild(p);
    }
  }

  /* ------------------------------------------------------- transcript */

  function newMessage(role, cls) {
    const wrap = document.createElement("div");
    wrap.className = "msg msg-" + (cls || role);
    const label = document.createElement("div");
    label.className = "msg-role";
    label.textContent = role;
    const body = document.createElement("div");
    body.className = "msg-body";
    wrap.appendChild(label);
    wrap.appendChild(body);
    el.log.appendChild(wrap);
    return { wrap, body };
  }

  function addUserMessage(text) {
    const m = newMessage("you", "user");
    m.body.textContent = text;
    scrollDown(true);
  }

  function addErrorMessage(err, spec) {
    const m = newMessage("error", "error");
    const p = document.createElement("p");
    p.textContent = (err && err.message) || String(err);
    m.body.appendChild(p);
    if (err && err.status === 401) openSettings();
    if (spec) {
      const retry = document.createElement("button");
      retry.className = "retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        m.wrap.remove();
        startRun(spec);
      });
      m.body.appendChild(retry);
    }
    scrollDown(true);
  }

  let statusEl = null;
  function setStatus(text) {
    if (!statusEl) {
      const m = newMessage("", "status");
      m.wrap.querySelector(".msg-role").remove();
      statusEl = m.wrap;
    }
    statusEl.querySelector(".msg-body").textContent = text;
    el.log.appendChild(statusEl);
    scrollDown();
  }

  function clearStatus() {
    if (statusEl) statusEl.remove();
    statusEl = null;
  }

  let stream = null;
  function beginAssistant() {
    const m = newMessage("assistant", "assistant");
    stream = { wrap: m.wrap, body: m.body, text: "", raf: 0 };
    scrollDown();
  }

  function pushDelta(chunk) {
    if (!stream) return;
    stream.text += chunk;
    if (stream.raf) return;
    stream.raf = requestAnimationFrame(() => {
      if (!stream) return;
      stream.raf = 0;
      stream.body.textContent = stream.text;
      scrollDown();
    });
  }

  function endAssistant(text) {
    if (!stream) return;
    if (stream.raf) cancelAnimationFrame(stream.raf);
    const final = text || stream.text;
    if (!final.trim()) {
      stream.wrap.remove(); // a pure tool-call turn produced no prose
      stream = null;
      return;
    }
    renderRich(stream.body, final);

    const copy = document.createElement("button");
    copy.className = "msg-copy";
    copy.textContent = "Copy";
    copy.title = "Copy this reply";
    copy.addEventListener("click", () => {
      if (typeof copyText === "function") copyText(final, "Reply copied");
    });
    stream.wrap.appendChild(copy);

    stream = null;
    scrollDown();
  }

  function markStopped() {
    if (!stream) return;
    if (stream.raf) cancelAnimationFrame(stream.raf);
    const text = stream.text;
    if (text.trim()) {
      renderRich(stream.body, text);
      const note = document.createElement("div");
      note.className = "msg-note";
      note.textContent = "(stopped)";
      stream.wrap.appendChild(note);
    } else {
      stream.wrap.remove();
    }
    stream = null;
  }

  function compactArgs(args) {
    if (typeof args === "string") return args.slice(0, 80);
    const parts = [];
    for (const k of Object.keys(args || {})) {
      let v = args[k];
      if (typeof v === "string") v = `"${v.length > 24 ? v.slice(0, 24) + "…" : v}"`;
      else if (Array.isArray(v)) v = `[${v.length}]`;
      else v = String(v);
      parts.push(`${k}:${v}`);
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
    if (j.error) return "error: " + String(j.error).slice(0, 60);
    if (Array.isArray(j.endpoints)) return `${j.endpoints.length} endpoints`;
    if (Array.isArray(j.frames)) return `${j.frames.length} frames`;
    if (typeof j.returned === "number") {
      const total = j.total != null ? j.total : j.total_matching_entries;
      return `${j.returned}${total != null ? " of " + total : ""}`;
    }
    if (typeof j.total_entries === "number") return `${j.total_entries} entries`;
    if (j.id != null) return `#${j.id}`;
    return "";
  }

  let toolRow = null;
  function beginTool(name, args) {
    clearStatus();
    const wrap = document.createElement("div");
    wrap.className = "msg msg-tool";

    const head = document.createElement("button");
    head.className = "tool-head";
    head.textContent = `▸ ${name}(${compactArgs(args)})`;

    const body = document.createElement("pre");
    body.className = "tool-body hidden";

    head.addEventListener("click", () => {
      const hidden = body.classList.toggle("hidden");
      head.textContent = (hidden ? "▸ " : "▾ ") + head.textContent.slice(2);
    });

    wrap.appendChild(head);
    wrap.appendChild(body);
    el.log.appendChild(wrap);
    toolRow = { wrap, head, body, name, args };
    scrollDown();
  }

  function endTool(name, out, ms) {
    if (!toolRow) return;
    const summary = summarizeResult(out);
    toolRow.head.textContent =
      `▸ ${name}(${compactArgs(toolRow.args)})` +
      (summary ? ` · ${summary}` : "") +
      ` · ${fmtBytes(out.length)} · ${ms} ms`;
    // The expanded view is the exact payload that left this machine.
    let pretty = out;
    try {
      pretty = JSON.stringify(JSON.parse(out), null, 2);
    } catch (_) {}
    if (pretty.length > 4000) pretty = pretty.slice(0, 4000) + "\n… (display truncated)";
    toolRow.body.textContent = "arguments:\n" + JSON.stringify(toolRow.args, null, 2) + "\n\nresult:\n" + pretty;
    toolRow = null;
    scrollDown();
  }

  /* ------------------------------------------------------------- runs */

  const handlers = {
    onUserMessage: addUserMessage,
    onStatus: setStatus,
    onAssistantStart: beginAssistant,
    onDelta: pushDelta,
    onAssistantEnd: endAssistant,
    onToolCall: beginTool,
    onToolResult: endTool,
    onUsage(u) {
      if (u && typeof u.total_tokens === "number") sessionTokens += u.total_tokens;
      updateMeter();
    },
    onError: addErrorMessage,
    onDone(reason) {
      if (reason === "cancelled") markStopped();
      running = false;
      clearStatus();
      updateRunUi();
      updateMeter();
    }
  };

  function startRun(spec) {
    if (!ready) {
      openSettings();
      return;
    }
    open(true);
    running = true;
    updateRunUi();
    AGENT().run(spec, handlers);
  }

  function cancel() {
    if (!running) return;
    AGENT().cancel();
    handlers.onDone("cancelled");
  }

  function updateRunUi() {
    el.send.classList.toggle("hidden", running);
    el.stop.classList.toggle("hidden", !running);
    el.input.disabled = !ready;
    refreshButtons();
  }

  function updateMeter() {
    const chars = AGENT().contextChars();
    const approx = Math.round(chars / 3.5 / 100) / 10;
    el.ctx.textContent = chars ? `~${approx}k ctx` + (sessionTokens ? ` · ${Math.round(sessionTokens / 1000)}k used` : "") : "";
    el.ctx.title = sessionTokens
      ? `Approximate context in the conversation; ${sessionTokens} tokens billed this session.`
      : "Approximate context in the conversation.";
  }

  /* --------------------------------------------------------- settings */

  function consentText() {
    const base =
      "Captured request and response data — URLs, headers and bodies from the page you are " +
      "inspecting — will be sent to Moonshot AI (api.moonshot.ai) so the assistant can answer.";
    const tail = el.redact && el.redact.checked
      ? " Secret headers and token-shaped strings are masked first, but masking is best-effort and cannot catch secrets in arbitrary body fields."
      : " Redaction is OFF, so this includes session tokens, cookies, and any personal data the page transfers, verbatim.";
    return base + tail + " Only use this on traffic you are allowed to share.";
  }

  function refreshConsentText() {
    el.consentText.textContent = consentText();
    el.setup.classList.toggle("raw", !(el.redact && el.redact.checked));
  }

  function openSettings() {
    open(true);
    el.setup.classList.remove("hidden");
    fillSettings();
    el.key.focus();
  }

  function fillSettings() {
    if (!settings) return;
    el.key.value = settings.apiKey || "";
    el.model.value = settings.model || CLIENT().DEFAULTS.model;
    el.modelSetting.value = settings.model || CLIENT().DEFAULTS.model;
    el.redact.checked = !!settings.redact;
    el.pii.checked = !!settings.redactPii;
    el.pii.disabled = !settings.redact;
    el.iter.value = String(settings.maxIterations || 8);
    el.effort.value = settings.reasoningEffort || "medium";
    el.consent.checked = !!settings.consented;
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
    if (typeof renderDetail === "function" && el.detailHasSelection()) renderDetail();
    if (msg) say(msg);
  }

  /* ------------------------------------------------------------- shell */

  function open(force) {
    const on = force == null ? !document.body.classList.contains("ai") : !!force;
    document.body.classList.toggle("ai", on);
    el.aside.classList.toggle("hidden", !on);
    el.toggle.classList.toggle("on", on);
    if (on && !ready) el.setup.classList.remove("hidden");
    if (on) scrollDown(true);
  }

  function refreshButtons() {
    const e = entryFor(selectedId);
    el.qExplain.disabled = !ready || running || !canExplain(e);
    el.qDebug.disabled = !ready || running || !canDebug(e);
    el.qSummarize.disabled = !ready || running;
    el.send.disabled = !ready || running;
  }

  function onSelection(id) {
    selectedId = id;
    refreshButtons();
  }

  function submit() {
    const text = el.input.value.trim();
    if (!text || running || !ready) return;
    el.input.value = "";
    startRun({ kind: "chat", text, entryId: selectedId, useSelection: el.useSelection.checked });
  }

  function wire() {
    el.toggle.addEventListener("click", () => open());
    el.close.addEventListener("click", () => open(false));
    el.settingsBtn.addEventListener("click", () => {
      const hidden = el.setup.classList.toggle("hidden");
      if (!hidden) fillSettings();
    });
    el.newChat.addEventListener("click", () => {
      AGENT().newConversation();
      el.log.replaceChildren();
      statusEl = null;
      stream = null;
      toolRow = null;
      running = false;
      sessionTokens = 0;
      updateRunUi();
      updateMeter();
    });

    el.model.addEventListener("change", () => applySettings({ model: el.model.value }));
    el.modelSetting.addEventListener("change", () => applySettings({ model: el.modelSetting.value }));

    el.qSummarize.addEventListener("click", () => startRun({ kind: "summarize", maxIterations: 8 }));
    el.qExplain.addEventListener("click", () =>
      startRun({ kind: "explain", entryId: selectedId, forceTool: true, maxIterations: 6 })
    );
    el.qDebug.addEventListener("click", () =>
      startRun({ kind: "debug", entryId: selectedId, forceTool: true, maxIterations: 10 })
    );

    el.composer.addEventListener("submit", (ev) => {
      ev.preventDefault();
      submit();
    });
    el.stop.addEventListener("click", cancel);
    el.input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        submit();
      }
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
      if (!el.consent.checked) return say("Tick the consent box to enable the assistant");
      await applySettings(
        {
          apiKey: key,
          model: el.modelSetting.value,
          redact: el.redact.checked,
          redactPii: el.pii.checked,
          maxIterations: Number(el.iter.value) || 8,
          reasoningEffort: el.effort.value,
          consented: true,
          enabled: true
        },
        "AI assistant enabled"
      );
      if (ready) el.setup.classList.add("hidden");
    });

    el.test.addEventListener("click", async () => {
      const key = el.key.value.trim();
      if (!key) return say("Enter an API key first");
      el.test.disabled = true;
      el.test.textContent = "Testing…";
      try {
        await CLIENT().testKey(key, el.modelSetting.value);
        say("Key works");
      } catch (err) {
        say((err && err.message) || "Test failed");
      }
      el.test.disabled = false;
      el.test.textContent = "Test";
    });

    el.forget.addEventListener("click", async () => {
      settings = await CLIENT().forgetKey();
      ready = false;
      AGENT().newConversation();
      el.log.replaceChildren();
      sessionTokens = 0;
      fillSettings();
      updateRunUi();
      updateMeter();
      if (typeof renderDetail === "function" && el.detailHasSelection()) renderDetail();
      say("API key removed");
    });
  }

  /* -------------------------------------------------------------- init */

  async function attach(a) {
    if (api) return;
    api = a;

    el.aside = $("ai");
    el.toggle = $("aiToggle");
    el.close = $("aiClose");
    el.settingsBtn = $("aiSettingsBtn");
    el.newChat = $("aiNewChat");
    el.model = $("aiModel");
    el.ctx = $("aiCtx");
    el.setup = $("aiSetup");
    el.key = $("aiKey");
    el.modelSetting = $("aiModelSetting");
    el.redact = $("aiRedact");
    el.pii = $("aiPii");
    el.iter = $("aiIterations");
    el.effort = $("aiEffort");
    el.consent = $("aiConsent");
    el.consentText = $("aiConsentText");
    el.save = $("aiSave");
    el.test = $("aiTest");
    el.forget = $("aiForget");
    el.qSummarize = $("aiQuickSummarize");
    el.qExplain = $("aiQuickExplain");
    el.qDebug = $("aiQuickDebug");
    el.log = $("aiLog");
    el.composer = $("aiComposer");
    el.input = $("aiInput");
    el.useSelection = $("aiUseSelection");
    el.send = $("aiSend");
    el.stop = $("aiStop");
    el.detailHasSelection = () => selectedId != null;

    TOOLS().attach(api);
    // Wire before awaiting storage, so a fast click on the AI button still lands.
    wire();

    settings = await CLIENT().loadSettings();
    ready = CLIENT().isReady(settings);

    // One DevTools window per inspected tab, all sharing one settings object.
    // Without this, saving the key in one leaves the others' gate stale.
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(async (changes, area) => {
        if (area !== "local" || !changes["netscope.ai"]) return;
        CLIENT().invalidate();
        settings = await CLIENT().loadSettings();
        ready = CLIENT().isReady(settings);
        // Don't repopulate the form while it is open — the user may be typing.
        if (el.setup.classList.contains("hidden")) fillSettings();
        updateRunUi();
        if (typeof renderDetail === "function" && el.detailHasSelection()) renderDetail();
      });
    }

    fillSettings();
    updateRunUi();
    updateMeter();
  }

  return {
    attach,
    onSelection,
    isEnabled: () => ready,
    isRunning: () => running,
    cancel,
    toggle: open,
    startRun
  };
})();
