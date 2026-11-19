/* NetScope – ai-client.js
 * Settings storage and the Moonshot (Kimi) transport. Loaded by both the app
 * iframe (chat) and the background worker (AI steps inside scheduled flows),
 * so it touches globalThis and chrome.storage only — never the DOM.
 *
 * The endpoint is OpenAI-compatible. The base URL is hardcoded on purpose:
 * the API key is only ever sent to api.moonshot.ai.
 *
 * Kimi K3-series specifics (platform.kimi.ai/docs/api/chat):
 *   - thinking is always on; depth is `reasoning_effort` = low | high | max
 *   - `reasoning_content` streams before `content` and must be sent back
 *     unchanged on assistant turns that made tool calls (preserved thinking)
 */
"use strict";

globalThis.__netscopeAiClient = (() => {
  const BASE = "https://api.moonshot.ai/v1";
  const ENDPOINT = BASE + "/chat/completions";
  const STORE_KEY = "netscope.ai";
  const REQUEST_TIMEOUT = 180000;

  const MODELS = [
    { id: "kimi-k3.1-pro", label: "Kimi K3.1 Pro", note: "Newest, strongest reasoning" },
    { id: "kimi-k3.1-pro-highspeed", label: "Kimi K3.1 Pro Highspeed", note: "Same model, 2–3× faster" },
    { id: "kimi-k3", label: "Kimi K3", note: "1M context" },
    { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", note: "Legacy" },
    { id: "kimi-k2.6", label: "Kimi K2.6", note: "Legacy" }
  ];
  const MODEL_IDS = MODELS.map((m) => m.id);
  const EFFORTS = ["low", "high", "max"];

  const DEFAULTS = {
    apiKey: "",
    model: "kimi-k3.1-pro",
    enabled: false,
    consented: false,
    redact: false,
    redactPii: false,
    maxIterations: 12,
    reasoningEffort: "high",
    // Which AI actions wait for a click: "writes" = requests that can change
    // data (POST/PUT/PATCH/DELETE) plus saving or scheduling flows;
    // "all" = every outgoing request too; "never" = autopilot.
    approval: "writes",
    stream: true
  };

  const isK3 = (model) => /^kimi-k3/.test(model || "");

  // Settings written by older versions: retired models, the old "medium" effort.
  function migrate(s) {
    if (!MODEL_IDS.includes(s.model)) s.model = DEFAULTS.model;
    if (!EFFORTS.includes(s.reasoningEffort)) s.reasoningEffort = DEFAULTS.reasoningEffort;
    if (!["writes", "all", "never"].includes(s.approval)) s.approval = DEFAULTS.approval;
    return s;
  }

  let cache = null;

  /* ---------------------------------------------------------- settings */

  async function loadSettings() {
    if (cache) return cache;
    let stored = {};
    try {
      const got = await chrome.storage.local.get(STORE_KEY);
      stored = (got && got[STORE_KEY]) || {};
    } catch (_) {}
    cache = migrate(Object.assign({}, DEFAULTS, stored));
    applyRedaction(cache);
    return cache;
  }

  async function saveSettings(patch) {
    const current = await loadSettings();
    cache = migrate(Object.assign({}, current, patch));
    applyRedaction(cache);
    try {
      await chrome.storage.local.set({ [STORE_KEY]: cache });
    } catch (err) {
      throw new Error("Could not save settings: " + ((err && err.message) || err));
    }
    return cache;
  }

  // Drops the cache so the next load re-reads storage. Used when another
  // DevTools window changes the settings underneath this one.
  function invalidate() {
    cache = null;
  }

  async function forgetKey() {
    cache = Object.assign({}, DEFAULTS);
    applyRedaction(cache);
    try {
      await chrome.storage.local.remove(STORE_KEY);
    } catch (_) {}
    return cache;
  }

  function applyRedaction(s) {
    const tools = globalThis.__netscopeAiTools;
    if (tools) tools.setRedaction(s.redact, s.redactPii);
  }

  // The single gate. Nothing leaves the machine unless all three hold.
  function isReady(s) {
    return !!(s && s.enabled && s.consented && s.apiKey);
  }

  /* ------------------------------------------------------------ errors */

  function describe(status, detail) {
    if (status === 401) return "API key rejected — check it in AI settings.";
    if (status === 403) return "Access denied — this key may not have access to that model or region.";
    if (status === 404) return "Model not found for this key. Pick another model from the dropdown.";
    if (status === 429) return "Rate limited by Moonshot.";
    if (status === 400) return detail || "Moonshot rejected the request.";
    if (status >= 500) return `Moonshot returned ${status}.`;
    return detail || `Request failed with status ${status}.`;
  }

  async function httpError(res) {
    let detail = "";
    try {
      const j = await res.json();
      detail = (j && j.error && (j.error.message || j.error.type)) || "";
    } catch (_) {}
    const err = new Error(describe(res.status, detail));
    err.status = res.status;
    err.detail = detail;
    err.retryable = res.status === 429 || res.status >= 500;
    const ra = res.headers.get("retry-after");
    if (ra) {
      const secs = Number(ra);
      if (!isNaN(secs)) err.retryAfter = Math.min(30000, secs * 1000);
    }
    return err;
  }

  function networkError(cause) {
    const err = new Error("Could not reach api.moonshot.ai — check your connection.");
    err.retryable = true;
    err.cause = cause;
    return err;
  }

  // Aborts on whichever comes first: the caller cancelling, or the timeout.
  function linkAbort(outer, ms) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (outer) {
      if (outer.aborted) ctl.abort();
      else outer.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => ctl.abort(), ms);
    return {
      signal: ctl.signal,
      release() {
        clearTimeout(timer);
        if (outer) outer.removeEventListener("abort", onAbort);
      }
    };
  }

  /* ---------------------------------------------------------- response */

  // Both paths return this shape so the agent loop never branches on transport.
  function normalize(text, toolCalls, finishReason, usage, reasoning) {
    const message = { role: "assistant", content: text || "" };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { assistantMessage: message, toolCalls, finishReason, usage, reasoning: reasoning || "" };
  }

  function collectToolCalls(byIndex) {
    return Array.from(byIndex.keys())
      .sort((a, b) => a - b)
      .map((i) => byIndex.get(i))
      .filter((tc) => tc.id && tc.function.name);
  }

  async function readStream(res, onDelta, markStreamed, onReasoning) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const byIndex = new Map();
    let buffer = "";
    let text = "";
    let reasoning = "";
    let finishReason = null;
    let usage = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop();

      for (const block of blocks) {
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue; // ':' keepalive comments included
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let json;
          try {
            json = JSON.parse(payload);
          } catch (_) {
            continue; // a partial frame; the next chunk completes it
          }
          if (json.usage) usage = json.usage;

          const choice = json.choices && json.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta || {};
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            markStreamed();
            if (onReasoning) onReasoning(delta.reasoning_content);
          }
          if (typeof delta.content === "string" && delta.content) {
            text += delta.content;
            markStreamed();
            if (onDelta) onDelta(delta.content);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === "number" ? tc.index : 0;
              let acc = byIndex.get(idx);
              if (!acc) {
                acc = { id: "", type: "function", function: { name: "", arguments: "" } };
                byIndex.set(idx, acc);
              }
              if (tc.id) acc.id = tc.id;
              if (tc.type) acc.type = tc.type;
              if (tc.function) {
                if (tc.function.name) acc.function.name += tc.function.name;
                if (typeof tc.function.arguments === "string") acc.function.arguments += tc.function.arguments;
              }
            }
          }
        }
      }
    }

    return normalize(text, collectToolCalls(byIndex), finishReason, usage, reasoning);
  }

  function readWhole(json) {
    const choice = (json.choices && json.choices[0]) || {};
    const msg = choice.message || {};
    const calls = (msg.tool_calls || []).filter((tc) => tc && tc.id && tc.function && tc.function.name);
    return normalize(msg.content || "", calls, choice.finish_reason || null, json.usage || null, msg.reasoning_content || "");
  }

  /* ----------------------------------------------------------- request */

  async function attempt(body, opts, markStreamed) {
    const link = linkAbort(opts.signal, REQUEST_TIMEOUT);
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + opts.apiKey
        },
        body: JSON.stringify(body),
        signal: link.signal
      });
    } catch (err) {
      link.release();
      if (err && err.name === "AbortError") throw err;
      throw networkError(err);
    }

    try {
      if (!res.ok) throw await httpError(res);
      if (body.stream && res.body) return await readStream(res, opts.onDelta, markStreamed, opts.onReasoning);
      return readWhole(await res.json());
    } finally {
      link.release();
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function chat(opts) {
    const s = await loadSettings();
    if (!isReady(s)) throw new Error("The AI assistant is not configured. Add an API key in AI settings.");

    const model = opts.model || s.model || DEFAULTS.model;
    const body = {
      model,
      messages: opts.messages,
      stream: opts.stream !== false && s.stream !== false
    };
    if (body.stream) body.stream_options = { include_usage: true };
    if (opts.tools && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.tool_choice || "auto";
    }
    // reasoning_effort exists only on the K3 series; K2.x would reject it.
    if (isK3(model) && EFFORTS.includes(opts.reasoning_effort)) body.reasoning_effort = opts.reasoning_effort;
    if (typeof opts.max_completion_tokens === "number") body.max_completion_tokens = opts.max_completion_tokens;

    const callOpts = { signal: opts.signal, onDelta: opts.onDelta, onReasoning: opts.onReasoning, apiKey: s.apiKey };

    for (let tries = 0; ; tries++) {
      let streamed = false;
      try {
        return await attempt(body, callOpts, () => {
          streamed = true;
        });
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        // Retrying after tokens have reached the transcript would duplicate them.
        if (streamed || !err.retryable || tries >= 2) throw err;
        const backoff = err.retryAfter || (tries === 0 ? 1000 : 3000);
        if (opts.onRetry) opts.onRetry(err, tries + 1);
        await sleep(backoff + Math.floor(Math.random() * 300));
      }
    }
  }

  // GET /v1/models costs nothing and proves both the key and model access.
  async function testKey(apiKey, model) {
    const res = await fetch(BASE + "/models", {
      headers: { Authorization: "Bearer " + apiKey }
    }).catch((err) => {
      throw networkError(err);
    });
    if (!res.ok) throw await httpError(res);
    let ids = [];
    try {
      const j = await res.json();
      ids = ((j && j.data) || []).map((m) => m.id);
    } catch (_) {}
    const want = model || DEFAULTS.model;
    if (ids.length && !ids.includes(want)) {
      const err = new Error(`Key works, but ${want} is not available to it. Available: ${ids.slice(0, 6).join(", ")}`);
      err.status = 404;
      throw err;
    }
    return true;
  }

  return {
    DEFAULTS,
    MODELS,
    EFFORTS,
    isK3,
    ENDPOINT,
    loadSettings,
    saveSettings,
    invalidate,
    forgetKey,
    isReady,
    chat,
    testKey
  };
})();
