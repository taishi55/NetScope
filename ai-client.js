/* NetScope – ai-client.js
 * Settings storage and the Moonshot (Kimi) transport.
 *
 * The endpoint is OpenAI-compatible, so the request/response shapes here are
 * the standard chat-completions ones. The base URL is hardcoded on purpose:
 * the only host this extension can ever reach is the one in host_permissions,
 * which keeps the audit story to a single line and removes an obvious way to
 * exfiltrate the user's key.
 */
"use strict";

window.__netscopeAiClient = (() => {
  const ENDPOINT = "https://api.moonshot.ai/v1/chat/completions";
  const STORE_KEY = "netscope.ai";
  const REQUEST_TIMEOUT = 120000;

  const DEFAULTS = {
    apiKey: "",
    model: "kimi-k3",
    enabled: false,
    consented: false,
    redact: false,
    redactPii: false,
    maxIterations: 8,
    reasoningEffort: "medium",
    stream: true
  };

  const MODELS = ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5"];

  let cache = null;

  /* ---------------------------------------------------------- settings */

  async function loadSettings() {
    if (cache) return cache;
    let stored = {};
    try {
      const got = await chrome.storage.local.get(STORE_KEY);
      stored = (got && got[STORE_KEY]) || {};
    } catch (_) {}
    cache = Object.assign({}, DEFAULTS, stored);
    applyRedaction(cache);
    return cache;
  }

  async function saveSettings(patch) {
    const current = await loadSettings();
    cache = Object.assign({}, current, patch);
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
    const tools = window.__netscopeAiTools;
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
    if (status === 404) return "Model not found. Try another model from the dropdown.";
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
  function normalize(text, toolCalls, finishReason, usage) {
    const message = { role: "assistant", content: text || "" };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { assistantMessage: message, toolCalls, finishReason, usage };
  }

  function collectToolCalls(byIndex) {
    return Array.from(byIndex.keys())
      .sort((a, b) => a - b)
      .map((i) => byIndex.get(i))
      .filter((tc) => tc.id && tc.function.name);
  }

  async function readStream(res, onDelta, markStreamed) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const byIndex = new Map();
    let buffer = "";
    let text = "";
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

    return normalize(text, collectToolCalls(byIndex), finishReason, usage);
  }

  function readWhole(json) {
    const choice = (json.choices && json.choices[0]) || {};
    const msg = choice.message || {};
    const calls = (msg.tool_calls || []).filter((tc) => tc && tc.id && tc.function && tc.function.name);
    return normalize(msg.content || "", calls, choice.finish_reason || null, json.usage || null);
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
      if (body.stream && res.body) return await readStream(res, opts.onDelta, markStreamed);
      return readWhole(await res.json());
    } finally {
      link.release();
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function chat(opts) {
    const s = await loadSettings();
    if (!isReady(s)) throw new Error("The AI assistant is not configured. Add an API key in AI settings.");

    const body = {
      model: opts.model || s.model || DEFAULTS.model,
      messages: opts.messages,
      stream: opts.stream !== false && s.stream !== false
    };
    if (opts.tools && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.tool_choice || "auto";
    }
    if (opts.reasoning_effort) body.reasoning_effort = opts.reasoning_effort;
    if (typeof opts.temperature === "number") body.temperature = opts.temperature;

    const callOpts = { signal: opts.signal, onDelta: opts.onDelta, apiKey: s.apiKey };

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

  // Cheapest possible round trip that still proves the key and model work.
  async function testKey(apiKey, model) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({
        model: model || DEFAULTS.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false
      })
    }).catch((err) => {
      throw networkError(err);
    });
    if (!res.ok) throw await httpError(res);
    return true;
  }

  return {
    DEFAULTS,
    MODELS,
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
