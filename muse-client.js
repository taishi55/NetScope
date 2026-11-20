/* NetScope – muse-client.js
 * Muse (Meta's agent at muse.ai) as a second AI next to Kimi. No API key: the
 * user signs in at muse.ai in a normal tab and keeps it open (minimized is
 * fine). NetScope types each turn into a Muse side chat there through
 * muse-bridge.js and reads the reply back.
 *
 * Loaded by the app iframe and the background worker, like ai-client.js:
 *   - protocol: Muse has no function-calling API, so the first message
 *     teaches it to call NetScope's tools with ```tool JSON blocks; replies
 *     are parsed back into OpenAI-style tool_calls for the agent loop.
 *   - threads: each NetScope conversation maps to one Muse side chat, found
 *     by a hash of the last answer, so only new turns are sent (Muse keeps
 *     the history). An edited or rewound conversation starts a new side chat
 *     with a condensed replay.
 *   - driver (worker only): finds the Muse tab, opens the side chat, fills
 *     and submits, then polls until Muse is done. The worker does the
 *     waiting because a hidden tab's own timers are throttled.
 */
"use strict";

globalThis.__netscopeMuse = (() => {
  const ID = "muse";
  const ORIGIN = "https://muse.ai";
  const TAB_MATCH = ["https://muse.ai/*"];
  const THREADS_KEY = "netscope.muse.threads";
  const MAX_THREADS = 300;
  const RESULT_CAP = 14000; // chars of one tool result sent to Muse
  const TURN_CAP = 60000; // chars of one message sent to Muse
  const REPLAY_CAP = 40000; // chars of earlier conversation replayed into a new side chat
  const IDLE_LIMIT = 8 * 60000; // Muse silent this long while busy: give up
  const HARD_LIMIT = 20 * 60000; // one reply, start to finish
  const inWorker = typeof window === "undefined";

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const t = setTimeout(done, ms);
      function done() {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(t);
        reject(abortError());
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });

  function abortError() {
    const e = new Error("Stopped");
    e.name = "AbortError";
    return e;
  }

  function museError(code, message) {
    const e = new Error(message);
    e.code = "muse-" + code;
    e.muse = code;
    return e;
  }

  /* ---------------------------------------------------------- threads */

  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  const hashAnswer = (m) =>
    fnv(String((m && m.content) || "") + "|" + JSON.stringify(((m && m.tool_calls) || []).map((c) => [c.function && c.function.name, c.function && c.function.arguments])));

  async function threadFor(hash) {
    try {
      const got = await chrome.storage.local.get(THREADS_KEY);
      const map = (got && got[THREADS_KEY]) || {};
      return map[hash] ? map[hash].thread : null;
    } catch (_) {
      return null;
    }
  }

  // Only the newest answer of a side chat maps to it: after Edit or Retry
  // rewinds a conversation to an older answer, that answer no longer matches
  // and the conversation moves to a fresh side chat with a replay, instead of
  // one whose history still holds the removed turns.
  async function rememberThread(key, thread) {
    if (!thread || thread === "new" || thread === "main") return;
    try {
      const got = await chrome.storage.local.get(THREADS_KEY);
      const map = (got && got[THREADS_KEY]) || {};
      if (!key.startsWith("session:")) for (const k of Object.keys(map)) if (map[k].thread === thread && !k.startsWith("session:")) delete map[k];
      map[key] = { thread, t: Date.now() };
      const keys = Object.keys(map);
      if (keys.length > MAX_THREADS) {
        keys.sort((a, b) => map[a].t - map[b].t);
        for (const k of keys.slice(0, keys.length - MAX_THREADS)) delete map[k];
      }
      await chrome.storage.local.set({ [THREADS_KEY]: map });
    } catch (_) {}
  }

  /* --------------------------------------------------------- protocol */

  const clip = (s, n) => {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + `\n… [${(s.length - n).toLocaleString()} more characters cut; ask for a narrower slice if you need them]` : s;
  };

  function toolCatalog(tools) {
    return tools
      .map((t) => {
        const f = t.function || t;
        return `### ${f.name}\n${f.description || ""}\nparameters: ${JSON.stringify(f.parameters || { type: "object", properties: {} })}`;
      })
      .join("\n\n");
  }

  function header(system, tools, forceTool) {
    const lines = [
      "[NetScope] This side chat is run by NetScope, a browser extension the user installed. You are its reasoning engine for this conversation.",
      "",
      "Rules for this side chat:",
      "- Work only with what NetScope sends you and the NetScope tools listed below. Do not use your own computer, browser, web search, email, memory, files, scheduled tasks or approvals for this conversation, and do not ask the user to approve anything in Muse.",
      "- Every message here comes from NetScope. Each starts with a reference like (ns-1a2b3c); ignore it."
    ];
    if (tools && tools.length) {
      lines.push(
        "- To call NetScope tools, reply with one or more blocks exactly like this, each holding one JSON object:",
        "```tool",
        '{"name": "list_endpoints", "arguments": {"limit": 20}}',
        "```",
        "  Put no text after your last tool block. You may call several tools in one reply. NetScope runs them and sends back \"NetScope tool results\".",
        "- When you have the final answer, reply in Markdown with no tool block. Never invent a tool result."
      );
      if (forceTool) lines.push("- Start by calling a tool.");
    } else {
      lines.push("- Answer directly in Markdown.");
    }
    if (system) lines.push("", "=== NetScope instructions ===", system);
    if (tools && tools.length) lines.push("", "=== NetScope tools (parameters are JSON Schema) ===", toolCatalog(tools));
    return lines.join("\n");
  }

  function callBlocks(calls) {
    return (calls || [])
      .map((c) => {
        let args = {};
        try {
          args = JSON.parse((c.function && c.function.arguments) || "{}");
        } catch (_) {}
        return "```tool\n" + JSON.stringify({ name: c.function && c.function.name, arguments: args }) + "\n```";
      })
      .join("\n");
  }

  function renderMsg(m, resultCap) {
    if (m.role === "tool") return `Result of ${m.name || "tool"}:\n\`\`\`json\n${clip(m.content, resultCap)}\n\`\`\``;
    if (m.role === "assistant") return "You (earlier):\n" + [m.content || "", callBlocks(m.tool_calls)].filter(Boolean).join("\n");
    if (m.role === "user") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return "";
  }

  // What happened since Muse's last answer: tool results and/or a new question.
  function renderTail(tail) {
    const results = tail.filter((m) => m.role === "tool");
    const users = tail.filter((m) => m.role === "user");
    const parts = [];
    if (results.length) {
      const cap = Math.max(2000, Math.min(RESULT_CAP, Math.floor((TURN_CAP - 2000) / results.length)));
      parts.push("NetScope tool results:\n\n" + results.map((m) => renderMsg(m, cap)).join("\n\n"));
    }
    for (const u of users) parts.push((results.length ? "The user adds:\n" : "") + renderMsg(u));
    return parts.join("\n\n") || "Continue.";
  }

  // Earlier turns, newest kept when it is too long.
  function renderReplay(msgs) {
    const out = [];
    let used = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "system") continue;
      const s = (m.role === "user" ? "User:\n" : "") + renderMsg(m, 3000);
      if (used + s.length > REPLAY_CAP) {
        out.unshift("[Earlier messages left out for length.]");
        break;
      }
      out.unshift(s);
      used += s.length;
    }
    return out.join("\n\n");
  }

  const FENCE = /(`{3,})[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)\n?\1/g;

  function asCall(obj, known) {
    if (!obj || typeof obj !== "object") return null;
    const fn = obj.function && typeof obj.function === "object" ? obj.function : obj;
    const name = fn.name || fn.tool || obj.tool;
    if (typeof name !== "string" || (known && !known.has(name) && !obj.arguments && !obj.args)) return null;
    let args = fn.arguments != null ? fn.arguments : fn.args != null ? fn.args : fn.parameters != null ? fn.parameters : {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch (_) {}
    }
    return { name, args };
  }

  // Splits Muse's reply into text and tool calls. A ```tool block that is not
  // valid JSON is reported in `bad` so Muse can be asked to resend it.
  function parse(text, known) {
    const calls = [];
    let bad = "";
    const body = String(text || "").replace(FENCE, (whole, ticks, lang, inner) => {
      const tagged = /^(tool|tool_call|tool_calls|netscope)$/i.test(lang);
      if (!tagged && !/^(json)?$/i.test(lang)) return whole;
      let data;
      try {
        data = JSON.parse(inner.trim());
      } catch (err) {
        if (tagged) {
          bad = `${err.message} in: ${inner.trim().slice(0, 200)}`;
          return "";
        }
        return whole;
      }
      const list = Array.isArray(data) ? data : [data];
      const found = list.map((o) => asCall(o, tagged ? null : known)).filter(Boolean);
      if (!found.length || (!tagged && found.length !== list.length)) return whole;
      calls.push(...found);
      return "";
    });
    return {
      content: body.replace(/\n{3,}/g, "\n\n").trim(),
      calls: calls.map((c, i) => ({
        id: `muse_${Date.now().toString(36)}_${i}`,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args && typeof c.args === "object" ? c.args : {}) }
      })),
      bad
    };
  }

  // The part of a streaming reply that is safe to show: everything before the
  // first fenced block (which may be a tool call).
  const shownPart = (t) => {
    const k = t.search(/(^|\n)\s*```/);
    return (k < 0 ? t : t.slice(0, k)).replace(/\s+$/, "");
  };

  /* -------------------------------------------------------- transport */

  function transport(req, hooks) {
    if (inWorker) return driver.ask(req, hooks);
    return new Promise((resolve, reject) => {
      let settled = false;
      const port = chrome.runtime.connect({ name: "netscope-muse" });
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        if (hooks.signal) hooks.signal.removeEventListener("abort", onAbort);
        try {
          port.disconnect();
        } catch (_) {}
        fn(v);
      };
      function onAbort() {
        try {
          port.postMessage({ op: "cancel" });
        } catch (_) {}
        finish(reject, abortError());
      }
      port.onMessage.addListener((m) => {
        if (!m) return;
        if (m.type === "partial" && hooks.onPartial) hooks.onPartial(m.text);
        else if (m.type === "status" && hooks.onStatus) hooks.onStatus(m.text);
        else if (m.type === "done") finish(resolve, m.result);
        else if (m.type === "error") finish(reject, Object.assign(new Error(m.message), { code: m.code, muse: m.muse }));
      });
      port.onDisconnect.addListener(() => finish(reject, museError("worker", "Lost the connection to NetScope's background worker while waiting for Muse. Press Continue to try again.")));
      if (hooks.signal) {
        if (hooks.signal.aborted) return onAbort();
        hooks.signal.addEventListener("abort", onAbort, { once: true });
      }
      port.postMessage({ op: "ask", req });
    });
  }

  /* ------------------------------------------------------------- chat */

  // Same contract as the Kimi transport in ai-client.js: resolves to
  // { assistantMessage, toolCalls, finishReason, usage, reasoning }.
  async function chat(opts) {
    const msgs = opts.messages || [];
    const tools = opts.tools || [];
    const known = new Set(tools.map((t) => (t.function || t).name));
    const system = (msgs.find((m) => m.role === "system") || {}).content || "";
    let last = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") {
        last = i;
        break;
      }
    }
    const tail = msgs.slice(last + 1).filter((m) => m.role !== "system");
    // A named session (AI steps in flows) reuses one side chat; every message
    // in it is self-contained, so the side chat's history doesn't matter.
    const named = opts.museSession ? "session:" + opts.museSession : "";
    // Keyed by the conversation's first question too, so two chats whose last
    // answers happen to match never share a side chat.
    const firstUser = msgs.find((m) => m.role === "user");
    const convKey = (answer) => fnv(String((firstUser && firstUser.content) || "").slice(0, 4000)) + hashAnswer(answer);
    let thread = named ? await threadFor(named) : last >= 0 ? await threadFor(convKey(msgs[last])) : null;
    let text;
    if (named) text = header(system, tools, false) + "\n\n=== Request ===\n" + renderTail(tail);
    else if (thread) text = renderTail(tail);
    else {
      text = header(system, tools, opts.tool_choice === "required");
      if (last >= 0) text += "\n\n=== The conversation so far ===\n" + renderReplay(msgs.slice(0, last + 1));
      text += "\n\n=== " + (last >= 0 ? "Now" : "Request") + " ===\n" + renderTail(tail);
    }

    let shown = "";
    const hooks = {
      signal: opts.signal,
      onStatus: opts.onStatus,
      onPartial: (full) => {
        if (!opts.onDelta) return;
        const part = shownPart(full || "");
        if (part.length > shown.length && part.startsWith(shown)) {
          opts.onDelta(part.slice(shown.length));
          shown = part;
        }
      }
    };

    for (let fix = 0; ; fix++) {
      const r = await transport({ text, thread: thread || "new" }, hooks);
      thread = r.thread && r.thread !== "new" ? r.thread : thread;
      const p = parse(r.text, known);
      if (p.bad && fix < 2) {
        if (opts.onStatus) opts.onStatus("Muse sent a tool call NetScope could not read — asking it to resend…");
        text = `Your tool block was not valid JSON (${p.bad}). Send the tool call again as one JSON object in a \`\`\`tool block.`;
        continue;
      }
      if (!p.content && !p.calls.length) throw Object.assign(museError("empty", "Muse's reply was empty. Check the muse.ai tab, then press Continue."), { retryable: false });
      const message = { role: "assistant", content: p.content };
      if (p.calls.length) message.tool_calls = p.calls;
      await rememberThread(named || convKey(message), thread);
      return { assistantMessage: message, toolCalls: p.calls, finishReason: p.calls.length ? "tool_calls" : "stop", usage: null, reasoning: "" };
    }
  }

  /* ------------------------------------------- driver (worker only) */

  const driver = (() => {
    let queue = Promise.resolve();

    const tell = (tabId, msg) => chrome.tabs.sendMessage(tabId, Object.assign({ __netscopeMuse: 1 }, msg), { frameId: 0 });

    async function stateOf(tabId) {
      try {
        const s = await tell(tabId, { op: "state" });
        return s && s.ok ? s : null;
      } catch (_) {
        return null;
      }
    }

    // A muse.ai tab opened before NetScope was installed or updated has no
    // bridge yet; inject it instead of asking for a reload.
    async function bridgeOf(tabId) {
      let s = await stateOf(tabId);
      if (s) return s;
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["muse-bridge.js"] });
      } catch (_) {
        return null;
      }
      return stateOf(tabId);
    }

    async function findTab() {
      let tabs = [];
      try {
        tabs = await chrome.tabs.query({ url: TAB_MATCH });
      } catch (_) {}
      tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      let fallback = null;
      for (const tab of tabs) {
        if (tab.discarded || tab.status === "unloaded") {
          if (!fallback) fallback = { tab, st: null };
          continue;
        }
        const st = await bridgeOf(tab.id);
        if (st && st.signedIn) return { tab, st };
        if (!fallback) fallback = { tab, st };
      }
      return fallback;
    }

    async function status() {
      const f = await findTab();
      if (!f) return { open: false, signedIn: false };
      return { open: true, signedIn: !!(f.st && f.st.signedIn), hidden: !!(f.st && f.st.hidden), tabId: f.tab.id, windowId: f.tab.windowId };
    }

    async function open() {
      const f = await findTab();
      if (f) {
        await chrome.windows.update(f.tab.windowId, { focused: true }).catch(() => {});
        await chrome.tabs.update(f.tab.id, { active: true }).catch(() => {});
        return { opened: false };
      }
      await chrome.windows.create({ url: ORIGIN + "/", focused: true, width: 1100, height: 820 });
      return { opened: true };
    }

    async function waitState(tabId, ms, ok, signal) {
      const t0 = Date.now();
      for (;;) {
        const s = await stateOf(tabId);
        if (s && ok(s)) return s;
        if (Date.now() - t0 > ms) return s;
        await sleep(400, signal);
      }
    }

    function ask(req, hooks) {
      const run = queue.then(() => askNow(req, hooks || {}));
      queue = run.catch(() => {});
      return run;
    }

    async function askNow(req, hooks) {
      const { signal } = hooks;
      const say = (t) => hooks.onStatus && hooks.onStatus(t);
      if (signal && signal.aborted) throw abortError();

      say("Finding your Muse tab…");
      const f = await findTab();
      if (!f) throw museError("no-tab", "No muse.ai tab is open. Open muse.ai, sign in and keep the tab open (minimized is fine), then press Continue.");
      const tabId = f.tab.id;
      chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
      if (f.tab.discarded || f.tab.status === "unloaded") {
        say("Waking your Muse tab…");
        await chrome.tabs.reload(tabId).catch(() => {});
      }
      let st = f.st && f.st.signedIn ? f.st : await waitState(tabId, 20000, (s) => s.signedIn, signal);
      if (!st) throw museError("no-bridge", "NetScope can't reach your muse.ai tab. Reload that tab once, then press Continue.");
      if (!st.signedIn) throw museError("signed-out", "Your muse.ai tab isn't signed in. Sign in there, keep the tab open, then press Continue.");

      // Never type over, or navigate away from, something the user is writing in Muse.
      if (st.draft) throw museError("draft", "Your muse.ai tab has an unsent message in its box. Send or clear it, then press Continue.");
      const want = req.thread || "new";
      const here = want === "new" ? st.path === "/thread/new" : st.thread === want;
      if (!here) {
        say(want === "new" ? "Starting a Muse side chat…" : "Opening the Muse side chat…");
        await tell(tabId, { op: "goto", url: ORIGIN + "/thread/" + want }).catch(() => {});
        await sleep(800, signal);
        st = await waitState(tabId, 30000, (s) => s.ready && (want === "new" ? s.path === "/thread/new" : s.thread === want), signal);
        if (!st || !st.ready) throw museError("nav", "Muse's chat didn't load in its tab. Check the muse.ai tab, then press Continue.");
        if (want !== "new" && st.thread !== want) throw museError("nav", "That Muse side chat didn't open (it may have been deleted). Start a new NetScope chat to continue with Muse.");
      }
      if (st.busy) {
        say("Muse is still finishing an earlier message…");
        st = await waitState(tabId, 120000, (s) => !s.busy, signal);
        if (st && st.busy) throw museError("busy", "Muse is still busy in its tab. Wait for it to finish, then press Continue.");
      }

      const marker = "ns-" + Math.random().toString(36).slice(2, 8);
      // The marker leads, so it is found even if Muse folds a long message.
      const text = `(${marker}) ` + String(req.text || "").slice(0, TURN_CAP);
      const filled = await tell(tabId, { op: "fill", text }).catch(() => null);
      if (!filled || !filled.ok) {
        const why = filled && filled.error;
        throw museError("fill", why === "busy" ? "Muse is busy in its tab. Wait for it to finish, then press Continue." : why === "signed-out" ? "Your muse.ai tab isn't signed in. Sign in there, then press Continue." : "NetScope couldn't type into Muse's message box. Reload the muse.ai tab, then press Continue.");
      }
      // React shows Send a moment after the input event; submit falls back to Enter.
      await sleep(350, signal);
      const sent = await tell(tabId, { op: "submit" }).catch(() => null);
      if (!sent || !sent.ok) throw museError("send", "Muse didn't take the message. Check the muse.ai tab, then press Continue.");

      const onAbort = () => tell(tabId, { op: "stop" }).catch(() => {});
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        const t0 = Date.now();
        let lastText = "";
        let lastChange = Date.now();
        let lastSay = "";
        let missing = 0;
        for (;;) {
          await sleep(900, signal);
          let r = null;
          try {
            r = await tell(tabId, { op: "read", marker });
          } catch (_) {
            const alive = await chrome.tabs.get(tabId).catch(() => null);
            if (!alive) throw museError("closed", "The muse.ai tab was closed while Muse was answering. Open muse.ai again, then press Continue.");
            if (++missing > 40) throw museError("lost", "Lost contact with the muse.ai tab. Check it, then press Continue.");
            continue;
          }
          missing = 0;
          const now = Date.now();
          if (r && r.found && r.text !== lastText) {
            lastText = r.text;
            lastChange = now;
            if (hooks.onPartial) hooks.onPartial(lastText);
          }
          if (r && r.found && r.count > 0 && !r.busy && !r.streaming && now - lastChange >= 1800) {
            return { text: lastText, thread: r.thread, url: r.url };
          }
          const line = !r || !r.found ? "Sending to Muse…" : r.count ? "Muse is writing…" : r.busy ? "Muse is thinking…" : "Waiting for Muse…";
          if (line !== lastSay) say((lastSay = line));
          if ((!r || !r.found) && now - t0 > 25000) throw museError("lost", "Muse didn't show the message NetScope sent. Check the muse.ai tab, then press Continue.");
          if (r && r.found && !r.busy && !r.count && now - t0 > 60000) throw museError("no-answer", "Muse stopped without answering. Check the muse.ai tab (it may be waiting for you), then press Continue.");
          if (now - lastChange > IDLE_LIMIT) throw museError("stalled", "Muse has been silent for 8 minutes. Check the muse.ai tab, then press Continue.");
          if (now - t0 > HARD_LIMIT) throw museError("timeout", "Muse took more than 20 minutes on one reply. Check the muse.ai tab, then press Continue.");
        }
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    }

    return { ask, status, open };
  })();

  // App iframes reach the driver over a port: partial text and status lines
  // stream back while the worker waits on the Muse tab.
  if (inWorker && chrome.runtime && chrome.runtime.onConnect) {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== "netscope-muse") return;
      const from = port.sender || {};
      if (from.id !== chrome.runtime.id || !String(from.url || "").startsWith(chrome.runtime.getURL(""))) {
        port.disconnect();
        return;
      }
      const ctl = new AbortController();
      const post = (m) => {
        try {
          port.postMessage(m);
        } catch (_) {}
      };
      port.onDisconnect.addListener(() => ctl.abort());
      port.onMessage.addListener((m) => {
        if (!m) return;
        if (m.op === "cancel") return ctl.abort();
        if (m.op !== "ask") return;
        driver
          .ask(m.req || {}, {
            signal: ctl.signal,
            onPartial: (text) => post({ type: "partial", text }),
            onStatus: (text) => post({ type: "status", text })
          })
          .then((result) => post({ type: "done", result }))
          .catch((err) => {
            if (err && err.name === "AbortError") return;
            post({ type: "error", message: (err && err.message) || String(err), code: err && err.code, muse: err && err.muse });
          });
      });
    });
  }

  return { ID, ORIGIN, chat, parse, header, renderTail, shownPart, status: () => driver.status(), open: () => driver.open() };
})();
