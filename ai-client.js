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
 *
 * Rate limits (platform.kimi.ai/docs/introduction#rate-limits) are per
 * account, across all models: concurrency, requests/min, tokens/min, and on
 * Tier 0 tokens/day. A request is charged against them as its input tokens
 * PLUS max_completion_tokens — not what the reply really uses — and K3's
 * default max is 131,072. So every call here sets an explicit, effort-sized
 * cap, and a pacer (one per browser, in the background worker) delays calls
 * that would cross the account's limits instead of letting them bounce.
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
    maxIterations: 20, // building, validating and testing a full flow takes a few rounds
    reasoningEffort: "high",
    // Which AI actions wait for a click: "never" = autopilot (default);
    // "writes" = requests that can change data (POST/PUT/PATCH/DELETE), calls
    // to hosts the page never used, and flows that run by themselves;
    // "all" = every outgoing request too.
    approval: "never",
    tier: "1", // the Kimi account's usage tier; sets the pacer's budget
    maxReply: "auto", // max_completion_tokens: "auto" sizes it from the thinking depth
    stream: true
  };

  // Per-tier limits as published on Moonshot's recharge page (Nov 2026).
  // The pacer aims for 90 % of them, leaving room for estimate error.
  const TIERS = {
    "0": { label: "Tier 0", concurrency: 1, rpm: 3, tpm: 500000, tpd: 1500000 },
    "1": { label: "Tier 1", concurrency: 15, rpm: 100, tpm: 2000000, tpd: 0 },
    "2": { label: "Tier 2", concurrency: 40, rpm: 100, tpm: 3000000, tpd: 0 },
    "3": { label: "Tier 3", concurrency: 50, rpm: 200, tpm: 3000000, tpd: 0 },
    "4": { label: "Tier 4", concurrency: 60, rpm: 200, tpm: 4000000, tpd: 0 },
    "5": { label: "Tier 5", concurrency: 100, rpm: 300, tpm: 5000000, tpd: 0 }
  };
  const MARGIN = 0.9;

  // The reply budget reserved per call. Thinking tokens come out of it too,
  // so deeper thinking gets more room.
  const REPLY_BY_EFFORT = { low: 8192, high: 16384, max: 32768 };
  const REPLY_CHOICES = ["auto", "4096", "8192", "16384", "32768", "65536"];

  function replyCap(s, effort) {
    if (s.maxReply && s.maxReply !== "auto") return Number(s.maxReply) || 16384;
    return REPLY_BY_EFFORT[effort] || 16384;
  }

  const isK3 = (model) => /^kimi-k3/.test(model || "");

  // Settings written by older versions: retired models, the old "medium" effort.
  function migrate(s) {
    if (!MODEL_IDS.includes(s.model)) s.model = DEFAULTS.model;
    if (!EFFORTS.includes(s.reasoningEffort)) s.reasoningEffort = DEFAULTS.reasoningEffort;
    if (!["writes", "all", "never"].includes(s.approval)) s.approval = DEFAULTS.approval;
    // "writes" was the default before autopilot. Settings saved back then hold
    // it without anyone having picked it, so they move to the new default once;
    // a choice saved from Settings from now on (approvalSet) is kept.
    if (s.approval === "writes" && !s.approvalSet) s.approval = DEFAULTS.approval;
    if (!TIERS[s.tier]) s.tier = DEFAULTS.tier;
    if (!REPLY_CHOICES.includes(String(s.maxReply))) s.maxReply = DEFAULTS.maxReply;
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

  // Which limit a 429 hit, from Moonshot's error type and message.
  function limitKind(type, detail) {
    const t = `${type || ""} ${detail || ""}`;
    if (/exceeded_current_quota|insufficient|balance|suspended/i.test(t)) return "quota";
    if (/\bTPD\b|per day|daily/i.test(t)) return "tpd";
    if (/\bTPM\b|tokens? per minute/i.test(t)) return "tpm";
    if (/\bRPM\b|requests? per minute/i.test(t)) return "rpm";
    if (/concurren/i.test(t)) return "concurrency";
    if (/overload/i.test(t)) return "overloaded";
    return "rate";
  }

  const LIMIT_TEXT = {
    tpm: "tokens-per-minute limit",
    rpm: "requests-per-minute limit",
    concurrency: "limit on simultaneous requests",
    rate: "rate limit",
    overloaded: "servers are busy"
  };

  function describe(status, detail, kind) {
    if (status === 401) return "API key rejected — check it in AI settings.";
    if (status === 403) return "Access denied — this key may not have access to that model or region.";
    if (status === 404) return "Model not found for this key. Pick another model from the dropdown.";
    if (status === 429 && kind === "quota") return "Your Moonshot balance is used up. Recharge at platform.kimi.ai/console/pay, then try again.";
    if (status === 429 && kind === "tpd") return "Your Kimi account reached its daily token limit (Tier 0). It resets within 24 hours, or recharge to move up a tier.";
    if (status === 429) return kind === "overloaded" ? "Kimi's servers are busy." : `Kimi's ${LIMIT_TEXT[kind] || "rate limit"} was reached.`;
    if (status === 400) return detail || "Moonshot rejected the request.";
    if (status >= 500) return `Moonshot returned ${status}.`;
    return detail || `Request failed with status ${status}.`;
  }

  async function httpError(res) {
    let detail = "";
    let type = "";
    try {
      const j = await res.json();
      detail = (j && j.error && (j.error.message || j.error.type)) || "";
      type = (j && j.error && j.error.type) || "";
    } catch (_) {}
    const kind = res.status === 429 ? limitKind(type, detail) : "";
    const err = new Error(describe(res.status, detail, kind));
    err.status = res.status;
    err.detail = detail;
    err.limit = kind;
    // A daily cap or an empty balance will not clear in seconds.
    err.retryable = (res.status === 429 && kind !== "tpd" && kind !== "quota") || res.status >= 500;
    const ra = res.headers.get("retry-after");
    const reset = res.headers.get("x-ratelimit-reset");
    let wait = NaN;
    if (ra) wait = Number(ra) * 1000;
    else if (reset) {
      const n = Number(reset);
      wait = n > 1e12 ? n - Date.now() : n > 1e9 ? n * 1000 - Date.now() : n * 1000;
    }
    if (!isNaN(wait) && wait > 0) err.retryAfter = Math.min(65000, wait);
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

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) {
        if (signal.aborted) {
          clearTimeout(t);
          return reject(new DOMException("aborted", "AbortError"));
        }
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true }
        );
      }
    });

  /* ------------------------------------------------------------- pacer */

  // Runs in the background worker only, so every tab and every flow shares
  // one view of the account's budget. tryAcquire is synchronous, which makes
  // check-then-record atomic: two callers can never both take the last slot.
  const pacer = { minute: [], day: [], inflight: new Map(), cooldownUntil: 0, seq: 0 };
  const PACER_KEY = "netscope.pacer";

  // The worker can be stopped between calls; keep the windows in session
  // storage so a restart does not forget what this minute (or day) has used.
  let saveTimer = 0;
  function persistPacer() {
    if (typeof window !== "undefined" || !chrome.storage || !chrome.storage.session) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.session
        .set({ [PACER_KEY]: { minute: pacer.minute, day: pacer.day, cooldownUntil: pacer.cooldownUntil } })
        .catch(() => {});
    }, 200);
  }
  if (typeof window === "undefined" && chrome.storage && chrome.storage.session) {
    chrome.storage.session
      .get(PACER_KEY)
      .then((got) => {
        const saved = got && got[PACER_KEY];
        if (!saved) return;
        const known = new Set(pacer.minute.map((e) => e.id));
        pacer.minute = (saved.minute || []).filter((e) => !known.has(e.id)).concat(pacer.minute);
        pacer.day = (saved.day || []).concat(pacer.day);
        pacer.cooldownUntil = Math.max(pacer.cooldownUntil, saved.cooldownUntil || 0);
        pacer.seq = Math.max(pacer.seq, ...pacer.minute.map((e) => e.id || 0));
      })
      .catch(() => {});
  }

  function tryAcquire(tokens, tierKey) {
    const tier = TIERS[tierKey] || TIERS[DEFAULTS.tier];
    const now = Date.now();
    pacer.minute = pacer.minute.filter((e) => now - e.t < 60000);
    if (tier.tpd) pacer.day = pacer.day.filter((e) => now - e.t < 86400000);
    for (const [id, exp] of pacer.inflight) if (exp < now) pacer.inflight.delete(id); // lost releases

    const rpm = Math.max(1, Math.floor(tier.rpm * MARGIN));
    const tpm = Math.floor(tier.tpm * MARGIN);
    const conc = Math.max(1, Math.floor(tier.concurrency * MARGIN));
    const used = pacer.minute.reduce((t, e) => t + e.tokens, 0);
    const wanted = Math.min(tokens, tpm); // a request bigger than the budget still gets to try alone

    const until = (list, budget, windowMs) => {
      // When enough of the oldest reservations expire to fit this one.
      let total = list.reduce((t, e) => t + e.tokens, 0);
      for (const e of list) {
        total -= e.tokens;
        if (total + wanted <= budget) return e.t + windowMs - now + 50;
      }
      return windowMs;
    };

    if (now < pacer.cooldownUntil) return { wait: pacer.cooldownUntil - now, reason: "cooldown", tier: tier.label };
    if (pacer.inflight.size >= conc) return { wait: 700, reason: "concurrency", tier: tier.label };
    if (pacer.minute.length >= rpm) return { wait: pacer.minute[0].t + 60000 - now + 50, reason: "rpm", tier: tier.label };
    if (used + wanted > tpm) return { wait: until(pacer.minute, tpm, 60000), reason: "tpm", tier: tier.label };
    if (tier.tpd) {
      const day = pacer.day.reduce((t, e) => t + e.tokens, 0);
      if (day + wanted > tier.tpd * MARGIN) return { wait: until(pacer.day, tier.tpd * MARGIN, 86400000), reason: "tpd", tier: tier.label };
    }

    const id = ++pacer.seq;
    pacer.minute.push({ id, t: now, tokens: wanted });
    if (tier.tpd) pacer.day.push({ id, t: now, tokens: wanted });
    pacer.inflight.set(id, now + REQUEST_TIMEOUT + 10000);
    persistPacer();
    return { id };
  }

  // refund: the request was refused (429), and Kimi does not count refused
  // requests — give its tokens back so the retry is not budgeted twice.
  function release(id, refund) {
    pacer.inflight.delete(id);
    if (refund) {
      pacer.minute = pacer.minute.filter((e) => e.id !== id);
      pacer.day = pacer.day.filter((e) => e.id !== id);
      persistPacer();
    }
  }

  // After a 429 every caller holds off, not just the one that was refused.
  function penalize(ms) {
    pacer.cooldownUntil = Math.max(pacer.cooldownUntil, Date.now() + Math.min(ms, 65000));
    persistPacer();
  }

  const inWorker = typeof window === "undefined";

  function pacerCall(msg) {
    if (inWorker) {
      if (msg.op === "acquire") return Promise.resolve(tryAcquire(msg.tokens, msg.tier));
      if (msg.op === "release") return Promise.resolve(release(msg.id, msg.refund));
      return Promise.resolve(penalize(msg.ms));
    }
    return chrome.runtime.sendMessage({ __netscopeAi: msg.op, ...msg }).catch(() => ({ id: 0 })); // worker unreachable: don't block
  }

  // Waits (reporting why) until the account has room for this request.
  async function acquire(tokens, s, signal, onWait) {
    const t0 = Date.now();
    for (;;) {
      const r = (await pacerCall({ op: "acquire", tokens, tier: s.tier })) || { id: 0 };
      if (!r.wait) return { id: r.id, waited: Date.now() - t0 };
      if (onWait) onWait({ ms: r.wait, reason: r.reason, tier: r.tier });
      await sleep(Math.min(r.wait, 3000), signal);
    }
  }

  // ~3 characters per token over the JSON actually sent: errs high for
  // English/JSON, which is the safe direction for a budget.
  const estimateTokens = (body) => Math.ceil(JSON.stringify(body).length / 3) + (body.max_completion_tokens || 131072);

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
    // Always explicit: the rate limiter reserves input + this, and the
    // server-side default (131,072 on K3) would eat a Tier 1 minute in a few calls.
    body.max_completion_tokens =
      typeof opts.max_completion_tokens === "number" ? opts.max_completion_tokens : replyCap(s, opts.reasoning_effort || s.reasoningEffort);

    const callOpts = { signal: opts.signal, onDelta: opts.onDelta, onReasoning: opts.onReasoning, apiKey: s.apiKey };
    const tokens = estimateTokens(body);

    for (let tries = 0; ; tries++) {
      let streamed = false;
      let refused = false;
      const slot = await acquire(tokens, s, opts.signal, opts.onWait);
      try {
        return await attempt(body, callOpts, () => {
          streamed = true;
        });
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        refused = !!(err && err.status === 429);
        if (err && err.status === 429 && err.retryable) {
          // Tell every caller to back off, then wait our turn again.
          const backoff = err.retryAfter || Math.min(60000, 4000 * 2 ** tries);
          pacerCall({ op: "penalize", ms: backoff });
        }
        // Retrying after tokens have reached the transcript would duplicate them.
        const maxTries = err && err.status === 429 ? 5 : 2;
        if (streamed || !err.retryable || tries >= maxTries) throw err;
        const backoff = err.retryAfter || (err.status === 429 ? Math.min(60000, 4000 * 2 ** tries) : tries === 0 ? 1000 : 3000);
        if (opts.onRetry) opts.onRetry(err, tries + 1, maxTries, backoff);
        await sleep(backoff + Math.floor(Math.random() * 400), opts.signal);
      } finally {
        if (slot.id) pacerCall({ op: "release", id: slot.id, refund: refused });
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
    TIERS,
    REPLY_CHOICES,
    replyCap,
    tryAcquire,
    release,
    penalize,
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
