/* NetScope – ai-agent.js
 * The agent loop: prompt, quick-action seeds, and the tool-calling iteration.
 *
 * The model never sees the capture directly. It calls tools from ai-tools.js,
 * which is what makes this usable at all — the store can hold thousands of
 * entries with large bodies, so the only workable strategy is broad-then-
 * narrow drilling. Tools with side effects (sending requests, saving or
 * running flows) pass through an approval gate first, per the user's policy.
 */
"use strict";

window.__netscopeAiAgent = (() => {
  const ELIDED = '{"note":"tool result elided to save context"}';
  // Every turn resends the whole conversation, and Kimi's per-minute limit
  // counts it each time — keep the history lean (~45k tokens).
  const MAX_HISTORY_CHARS = 150000;
  const REASON_TEXT = {
    tpm: "tokens per minute",
    rpm: "requests per minute",
    concurrency: "requests at once",
    tpd: "tokens per day",
    cooldown: "Kimi asked to slow down"
  };
  const RUN_TIME_LIMIT = 300000;

  const T = () => window.__netscopeAiTools;
  const C = () => window.__netscopeAiClient;

  let messages = [];
  let currentRun = null;

  function isRunning() {
    return !!currentRun;
  }

  function cancel() {
    if (!currentRun) return;
    currentRun.cancelled = true;
    try {
      currentRun.controller.abort();
    } catch (_) {}
    currentRun = null;
  }

  function newConversation() {
    cancel();
    messages = [];
  }

  // The conversation outlives page reloads: ai-panel.js stores it per tab.
  function getMessages() {
    return messages;
  }

  function setMessages(list) {
    if (currentRun) return;
    messages = Array.isArray(list) ? list : [];
  }

  const msgChars = (m) => ((m.content && m.content.length) || 0) + ((m.reasoning_content && m.reasoning_content.length) || 0);

  function contextChars() {
    return messages.reduce((t, m) => t + msgChars(m), 0);
  }

  /* ------------------------------------------------------------ prompt */

  function systemPrompt() {
    return [
      "You are NetScope AI, an API copilot inside a popup on the web page the developer is looking at.",
      "NetScope records the page's API traffic (fetch, XHR and WebSocket frames). With your tools you can:",
      "- read that capture: get_capture_summary, list_endpoints, list_requests, search_traffic, get_request,",
      "  describe_json, get_websocket_frames, compare_requests, get_curl;",
      "- call APIs like Postman: http_request (from a cURL, a captured request via from_id, or a URL);",
      "- automate: save_flow, run_flow, list_flows, get_flow, delete_flow — from a chain of requests to a bot",
      "  with filters, loops, branches and memory, run on demand, every N minutes, or when the page makes a",
      "  matching request.",
      "",
      "Ground every factual claim about a request, endpoint, header, status or field in a tool result. Never guess",
      "a URL, status code, header name or JSON field name.",
      "",
      "Reading the capture:",
      "- Broad then narrow: get_capture_summary -> list_endpoints -> list_requests or search_traffic ->",
      "  get_request, describe_json, compare_requests. Prefer describe_json or a snippet over a full body.",
      "- Entry ids are stable integers. Cite them as \"#412\" so the developer can click through.",
      "- If a result says \"truncated\": true, narrow the filter rather than repeating the call.",
      "- Only traffic made after the page loaded with NetScope active exists. Requests the browser makes on its own",
      "  (documents, images, scripts) are not captured. If something is missing, say what to do (for example: turn",
      "  on Keep logs on reload, then reload the page).",
      "- Values shown as <redacted ...> were masked locally. You cannot send them; use from_id instead, which",
      "  copies the real values inside the extension. Never ask the developer to paste a secret.",
      "",
      "Calling APIs:",
      "- To repeat or tweak something the page did, use http_request with from_id and override only what changes.",
      "- If the developer pastes a cURL, pass it as `curl` unchanged unless they ask for edits.",
      "- Requests run from the extension with the browser's cookies for that site; Cookie/Origin/Referer/User-Agent",
      "  headers cannot be set by scripts and are reported as dropped.",
      "- Some actions wait for the developer to approve them. If a result says the user declined, do not retry",
      "  the same action; explain or offer an alternative.",
      "- Do not send requests that delete or modify data unless the developer clearly asked for that outcome.",
      "",
      "Building flows:",
      "- Before save_flow, look at the real responses (get_request / describe_json) so extract paths and",
      "  templates point at fields that exist. Use step ids that describe the step (\"list_orders\", \"get_order\").",
      "- Prefer from_id for steps based on captured requests so authentication carries over.",
      "- Bots: page with repeat + until, narrow with filter, act with for_each, branch with if, and keep a",
      "  high-water mark in state (e.g. the last id handled) so a scheduled bot never acts on the same item twice.",
      "  Give every loop a sensible max, a delay_ms when calling a rate-limited API, and expect_status on writes.",
      "- Big jobs (hundreds of pages or profiles): collect page arrays with repeat + collect {flatten, unique_by},",
      "  enrich with for_each concurrency 3–5 (not more unless asked), store results in a keyed collection",
      "  (collect … key, mode upsert) and set limits {max_steps, max_minutes, auto_resume: true} so it finishes",
      "  across continuations. Read results back with get_collection rather than dumping them in a log.",
      "- If extension replays of an endpoint fail (403/401, WAF or bot pages, missing CSRF) while the page's",
      "  own request succeeds, retry with context \"page\" — it sends from an open tab on that site.",
      "- Use on_request when the developer wants a reaction to something the page does (\"whenever the page",
      "  loads orders, …\"); its response is {{trigger.body}}.",
      "- Build the whole flow in one definition: validate_flow first and fix every error it lists (warnings",
      "  explain likely surprises), then save_flow. For big jobs, run it once on a small sample (vars that cap",
      "  pages/items), check the results with get_collection, then start the full job with run_flow",
      "  {background: true}. Never accumulate arrays by hand with set; use collect.",
      "- When a run fails or pauses, read its failure {kind, step, item, status, reason} and preserved",
      "  results before changing anything: budget_* means it pauses and resumes by itself; rate_limited means",
      "  lower concurrency; http_status 401/403 on replays often means context \"page\"; template means a",
      "  definition mistake to fix with validate_flow.",
      "- After saving, run_flow once and report each step's result, including loop counts and the run log.",
      "  Only then say it is scheduled.",
      "- \"Every hour\" is every_minutes 60. Mention that schedules and triggers run while the browser is open.",
      "",
      "Answering:",
      "- Concise and technical; the reader is a developer.",
      "- Short sections and \"- \" bullets. No tables, no emojis. ``` fences for code, JSON and cURL.",
      "- When diagnosing: what you observed (with ids), the most likely cause, then the next concrete check."
    ].join("\n");
  }

  async function snapshotText() {
    try {
      const s = JSON.parse(await T().runTool("get_capture_summary", {}, null));
      const hosts = (s.hosts || [])
        .slice(0, 5)
        .map((h) => `${h.host} ${h.count}`)
        .join(" · ");
      const st = s.status_histogram || {};
      const statuses = Object.keys(st)
        .sort()
        .map((k) => `${k} ${st[k]}`)
        .join(" · ");
      return [
        "CURRENT CAPTURE",
        `page: ${s.inspected_page || "(unknown)"}`,
        `${s.total_entries} entries (http ${s.http}, ws frames ${s.ws_frames}, sockets ${s.sockets})`,
        hosts ? `hosts: ${hosts}` : "",
        statuses ? `statuses: ${statuses}` : ""
      ]
        .filter(Boolean)
        .join("\n");
    } catch (_) {
      return "";
    }
  }

  /* ------------------------------------------------------------- seeds */

  function fence(label, json) {
    return ["", label, "```json", json, "```"].join("\n");
  }

  function seedExplain(id) {
    const t = T();
    const e = t.entryById(id);
    if (!e || e.kind !== "http") return null;
    const head =
      `Explain the endpoint behind request #${e.id}: ${e.method} ${t.clipUrl(e.url, 300)} → ` +
      `${e.status || "no response"}${e.statusText ? " " + e.statusText : ""}, ${e.size || 0} B, ` +
      `${Math.round(e.durationMs || 0)} ms.`;
    const ask = [
      "",
      "Cover: what it appears to do; the request shape (path parameters, query parameters, body",
      "fields, notable headers); the response shape; how other captured calls to the same endpoint",
      "differ; the auth mechanism; and any caching or pagination signals."
    ].join("\n");

    let extra = "";
    const shape = t.describeJsonData({ id, side: "response" });
    if (shape && shape.is_json) {
      let js = JSON.stringify(shape.shape);
      if (js.length > 2000) js = JSON.stringify(shape.shape, null, 0).slice(0, 2000) + "…";
      extra = fence("Response body shape (precomputed):", js);
    }
    return { text: head + ask + extra, display: head };
  }

  function seedSummarize() {
    const t = T();
    let data = null;
    let js = "";
    for (const limit of [120, 60, 30]) {
      data = t.endpointsData({ include_static: false, limit });
      js = JSON.stringify(data);
      if (js.length <= 12000) break;
    }
    if (js.length > 12000) {
      data.endpoints = (data.endpoints || []).slice(0, 15);
      js = JSON.stringify(data);
    }
    const head = "Summarize the API surface captured on this page.";
    const ask = [
      head,
      "",
      "Group by host. For each endpoint: method and normalized path, what it appears to do, its",
      "parameters, and its response shape. Call out the auth style, the pagination style, error",
      "conventions, and anything unusual — polling, N+1 patterns, duplicated calls, oversized",
      "responses. Ignore static assets unless they matter."
    ].join("\n");
    const extra = fence(
      "Endpoint inventory (precomputed — use the tools to drill into specific requests where you need detail):",
      js
    );
    return { text: ask + extra, display: head };
  }

  async function seedDebug(id) {
    const t = T();
    const e = t.entryById(id);
    if (!e || e.kind !== "http") return null;
    const head =
      `Request #${e.id} failed: ${e.method} ${t.clipUrl(e.url, 300)} → ` +
      `${e.status || "no response"}${e.statusText ? " " + e.statusText : ""}.`;
    const ask = [
      "",
      "Diagnose it. Check the request body and headers, the response body for an error code,",
      "whether this endpoint ever succeeded in this capture (compare a success against it with",
      "compare_requests), whether auth looks valid or expired, and whether a preceding request set",
      "up state this one needed. End with the most likely cause and the next concrete check."
    ].join("\n");
    const detail = await t.runTool(
      "get_request",
      { id, include: ["req_headers", "res_headers", "res_body"], body_max: 3000 },
      null
    );
    return { text: head + ask + fence("The failing request (precomputed):", detail), display: head };
  }

  function seedChat(spec) {
    const t = T();
    let text = spec.text;
    if (spec.useSelection && spec.entryId) {
      const e = t.entryById(spec.entryId);
      if (e) {
        const label =
          e.kind === "http"
            ? `${e.method} ${t.clipUrl(e.url, 200)} → ${e.status || "no response"}`
            : `${e.kind} ${t.clipUrl(e.url, 200)}`;
        text += `\n\n(The developer is asking about #${e.id}: ${label}.)`;
      }
    }
    if (/^\s*curl\s/i.test(spec.text)) {
      text += "\n\n(The developer pasted a cURL command: run it with http_request and explain the response.)";
    }
    return { text, display: spec.text };
  }

  async function buildSeed(spec) {
    if (spec.kind === "explain") return seedExplain(spec.entryId);
    if (spec.kind === "summarize") return seedSummarize();
    if (spec.kind === "debug") return seedDebug(spec.entryId);
    return seedChat(spec);
  }

  /* ----------------------------------------------------------- history */

  function pruneHistory() {
    const toolTurns = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].tool_calls) toolTurns.push(i);
      if (toolTurns.length >= 2) break;
    }
    // Elide content only. Deleting a tool message would orphan its tool_call_id
    // and the next request would be rejected.
    const keepFrom = toolTurns.length >= 2 ? toolTurns[1] : 0;
    for (let i = 0; i < keepFrom; i++) {
      const m = messages[i];
      if (m.role === "tool" && m.content && m.content.length > 200 && m.content !== ELIDED) {
        m.content = ELIDED;
      }
    }

    let chars = contextChars();
    let guard = 0;
    while (chars > MAX_HISTORY_CHARS && messages.length > 4 && guard++ < 500) {
      do {
        const dropped = messages.splice(1, 1)[0];
        chars -= msgChars(dropped);
      } while (messages.length > 2 && messages[1].role !== "user" && guard++ < 500);
    }
  }

  /* -------------------------------------------------------------- loop */

  async function execCall(call, run, h) {
    const name = call.function.name;
    let args = {};
    let parseError = null;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch (err) {
      parseError = err;
    }

    if (parseError) {
      h.onToolCall(name, String(call.function.arguments || ""));
      const out = JSON.stringify({
        error: "arguments were not valid JSON: " + String(parseError.message || parseError).slice(0, 120),
        hint: "Send the arguments again as a single valid JSON object."
      });
      h.onToolResult(name, out, 0);
      return out;
    }

    const ask = await T().approvalFor(name, args, run.settings.approval);
    if (ask) {
      const approved = await h.onApproval(ask, run.controller.signal);
      if (run.cancelled) return JSON.stringify({ error: "run cancelled by the user" });
      if (!approved) {
        h.onToolCall(name, args);
        const out = JSON.stringify({ error: "The user declined this action. Do not retry it; explain or offer an alternative." });
        h.onToolResult(name, out, 0);
        return out;
      }
    }

    h.onToolCall(name, args);
    const t0 = Date.now();
    const out = await T().runTool(name, args, run);
    h.onToolResult(name, out, Date.now() - t0);
    return out;
  }

  async function run(spec, h) {
    cancel();

    const client = C();
    const settings = await client.loadSettings();
    if (!client.isReady(settings)) {
      h.onError(new Error("The AI assistant is not configured. Add an API key in AI settings."), null);
      h.onDone("error");
      return;
    }

    let seed;
    try {
      seed = await buildSeed(spec);
    } catch (err) {
      seed = null;
    }
    if (!seed || !seed.text) {
      h.onError(new Error("That entry is no longer in the capture."), null);
      h.onDone("error");
      return;
    }

    const state = { controller: new AbortController(), cancelled: false, spent: 0, started: Date.now(), settings };
    currentRun = state;

    if (!messages.length) messages.push({ role: "system", content: systemPrompt() });
    const snap = await snapshotText();
    messages.push({ role: "user", content: seed.text + (snap ? "\n\n" + snap : "") });
    h.onUserMessage(seed.display || seed.text);
    pruneHistory();

    const maxIterations = Math.max(spec.maxIterations || 0, settings.maxIterations || 12);
    let replyCap = client.replyCap(settings, settings.reasoningEffort);
    const onWait = (w) =>
      h.onStatus(`Waiting ${Math.max(1, Math.round(w.ms / 1000))} s to stay under your Kimi ${w.tier} limit (${REASON_TEXT[w.reason] || "rate limit"})…`);
    const onRetry = (err, n, max, ms) =>
      h.onStatus(`${err.message} Trying again in ${Math.max(1, Math.round(ms / 1000))} s (${n}/${max})…`);
    let finished = false;
    let reason = "complete";

    try {
      for (let i = 0; i < maxIterations; i++) {
        if (state.cancelled) {
          reason = "cancelled";
          finished = true;
          break;
        }
        h.onStatus(`thinking… (${i + 1}/${maxIterations})`);

        h.onAssistantStart();
        const turn = await client.chat({
          messages,
          tools: T().TOOLS,
          tool_choice: i === 0 && spec.forceTool ? "required" : "auto",
          reasoning_effort: settings.reasoningEffort,
          signal: state.controller.signal,
          onDelta: h.onDelta,
          onReasoning: h.onReasoning,
          onWait,
          onRetry,
          max_completion_tokens: replyCap
        });
        h.onAssistantEnd(turn.assistantMessage.content || "");
        if (turn.usage) h.onUsage(turn.usage);
        if (turn.finishReason === "length" && replyCap < 65536) {
          // Thinking used up the reply budget. Give the rest of this answer more.
          const was = replyCap;
          replyCap = Math.min(65536, replyCap * 2);
          if (h.onNotice) h.onNotice(`Kimi's reply hit the ${was.toLocaleString()}-token cap; using ${replyCap.toLocaleString()} for the rest of this answer. Set “Max reply length” in Settings to change the default.`);
        }

        messages.push(turn.assistantMessage);
        if (!turn.toolCalls.length) {
          finished = true;
          break;
        }

        // Every tool_call_id needs a reply, including after cancellation —
        // an unanswered call would make the next request 400.
        for (const call of turn.toolCalls) {
          const out = state.cancelled
            ? JSON.stringify({ error: "run cancelled by the user" })
            : await execCall(call, state, h);
          messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: out });
        }

        if (state.cancelled) {
          reason = "cancelled";
          finished = true;
          break;
        }
        if (state.spent > T().TOTAL_BUDGET || Date.now() - state.started > RUN_TIME_LIMIT) break;
      }

      if (!finished) {
        reason = "budget";
        h.onStatus("wrapping up…");
        messages.push({
          role: "user",
          content:
            "Tool budget reached. Answer now with what you have, and state explicitly what you could not verify."
        });
        h.onAssistantStart();
        const final = await client.chat({
          messages,
          reasoning_effort: settings.reasoningEffort,
          signal: state.controller.signal,
          onDelta: h.onDelta,
          onReasoning: h.onReasoning,
          onWait,
          onRetry,
          max_completion_tokens: replyCap
        });
        h.onAssistantEnd(final.assistantMessage.content || "");
        if (final.usage) h.onUsage(final.usage);
        messages.push(final.assistantMessage);
      }
    } catch (err) {
      currentRun = null;
      if (err && err.name === "AbortError") {
        h.onDone("cancelled");
        return;
      }
      h.onError(err, spec);
      h.onDone("error");
      return;
    }

    currentRun = null;
    h.onDone(reason);
  }

  return { run, cancel, isRunning, newConversation, contextChars, getMessages, setMessages };
})();
