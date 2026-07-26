/* NetScope – ai-agent.js
 * The agent loop: prompt, quick-action seeds, and the tool-calling iteration.
 *
 * The model never sees the capture directly. It calls tools from ai-tools.js,
 * which is what makes this usable at all — the store can hold 4000 entries with
 * 1 MB bodies, so the only workable strategy is broad-then-narrow drilling.
 */
"use strict";

window.__netscopeAiAgent = (() => {
  const ELIDED = '{"note":"tool result elided to save context"}';
  const MAX_HISTORY_CHARS = 400000;
  const RUN_TIME_LIMIT = 180000;

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

  function contextChars() {
    return messages.reduce((t, m) => t + ((m.content && m.content.length) || 0), 0);
  }

  /* ------------------------------------------------------------ prompt */

  function systemPrompt() {
    return [
      "You are NetScope AI, embedded in a Chrome DevTools panel that has captured the network",
      "traffic of the page the developer is inspecting.",
      "",
      "You cannot see the traffic directly — use the tools. Ground every factual claim about a",
      "request, endpoint, header, status or field in a tool result. Never guess a URL, status",
      "code, header name or JSON field name.",
      "",
      "Method:",
      "- Go broad then narrow: get_capture_summary -> list_endpoints -> list_requests or",
      "  search_traffic -> get_request, describe_json, compare_requests.",
      "- Prefer describe_json or a search snippet over a full body. Bodies are large and cost context.",
      "- Entry ids are stable integers. Cite them as \"#412\" so the developer can click through to the row.",
      "- If a result says \"truncated\": true, narrow the filter — do not repeat the same call.",
      "",
      "What the data is and is not:",
      "- Only traffic captured while DevTools was open exists. Earlier requests are invisible; say",
      "  so rather than speculating.",
      "- Response bodies are capped at 1 MB at capture time and WebSocket frames at 256 KB.",
      "- flags.res_body_binary means the body was not captured as text, not that it was empty.",
      "- flags.res_body_pending means the body was still downloading when captured.",
      "- Header or body values shown as <redacted ...> were masked locally before reaching you.",
      "  Never ask the developer to paste a secret.",
      "- WebSocket frames exist only for sockets opened after the page loaded with the extension active.",
      "",
      "Answering:",
      "- Concise and technical. The reader is a developer with DevTools already open.",
      "- Short sections and bullet lists. No emojis. No tables. Plain text with simple \"- \" bullets",
      "  and ``` fences; the panel renders nothing richer.",
      "- When diagnosing: what you observed (with ids), then the most likely cause, then the next",
      "  concrete check.",
      "- If the capture is insufficient, name what the developer should do to capture it (for",
      "  example: enable Preserve log and reload)."
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
        text += `\n\n(The developer currently has #${e.id} selected: ${label}.)`;
      }
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
        chars -= (dropped.content && dropped.content.length) || 0;
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

    h.onToolCall(name, parseError ? String(call.function.arguments || "") : args);
    const t0 = Date.now();
    let out;
    if (parseError) {
      out = JSON.stringify({
        error: "arguments were not valid JSON: " + String(parseError.message || parseError).slice(0, 120),
        hint: "Send the arguments again as a single valid JSON object."
      });
    } else {
      out = await T().runTool(name, args, run);
    }
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

    const state = { controller: new AbortController(), cancelled: false, spent: 0, started: Date.now() };
    currentRun = state;

    if (!messages.length) messages.push({ role: "system", content: systemPrompt() });
    const snap = await snapshotText();
    messages.push({ role: "user", content: seed.text + (snap ? "\n\n" + snap : "") });
    h.onUserMessage(seed.display || seed.text);
    pruneHistory();

    const maxIterations = spec.maxIterations || settings.maxIterations || 8;
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
          reasoning_effort: i === 0 ? "low" : settings.reasoningEffort,
          signal: state.controller.signal,
          onDelta: h.onDelta,
          onRetry: (err, n) => h.onStatus(`${err.message} retrying (${n}/2)…`)
        });
        h.onAssistantEnd(turn.assistantMessage.content || "");
        if (turn.usage) h.onUsage(turn.usage);

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
          onDelta: h.onDelta
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

  return { run, cancel, isRunning, newConversation, contextChars };
})();
