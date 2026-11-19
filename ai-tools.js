/* NetScope – ai-tools.js
 * The tools Kimi uses: read the capture, send requests (Postman-style, from a
 * cURL, a captured request, or a URL), and build/run/schedule flows — plus
 * the redaction layer every one of them routes through, and the approval
 * rules for actions that change things.
 *
 * Two invariants hold here and nowhere else:
 *   1. Redaction runs inside the executors, so no tool can bypass it. It ships
 *      OFF by default (settings.redact) — the assistant sees what the browser
 *      actually sent, including live tokens. Turning it on degrades gracefully:
 *      header names survive, only values become shape hints.
 *   2. Every result is size-capped, because the store holds up to 4000 entries
 *      with bodies up to 1 MB and a naive dump would blow any context window.
 */
"use strict";

window.__netscopeAiTools = (() => {
  // Cumulative capture-tool output per answer. Sized for ~100 tool calls; old
  // results are elided from the history as it grows, so context stays lean.
  const TOTAL_BUDGET = 1000000;
  const SCAN_LIMIT = 64 * 1024 * 1024; // max chars search_traffic will read
  const SCAN_CHUNK = 200; // entries between yields, so the panel stays responsive
  const BODY_BUDGET = 18000; // serialized chars a body may occupy inside get_request's 24k cap

  let api = null;
  // Initialised on, then overwritten by settings (which default to off) before
  // any run. The safe initial value only matters if settings failed to load —
  // in which case there is no API key either and nothing can be sent.
  let redactOn = true;
  let redactPii = false;

  function attach(a) {
    api = a;
  }
  function setRedaction(on, pii) {
    redactOn = !!on;
    redactPii = !!pii;
  }
  function entries() {
    return api ? api.getEntries() : [];
  }
  function startedAt() {
    return api ? api.getStartedAt() : 0;
  }
  function relT(e) {
    return Math.max(0, (e.startedAt || 0) - startedAt());
  }
  function entryById(id) {
    return entries().find((e) => e.id === id) || null;
  }

  /* ---------------------------------------------------------- redaction */

  const SECRET_HEADERS = new Set([
    "authorization",
    "proxy-authorization",
    "authentication",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "apikey",
    "x-auth-token",
    "x-access-token",
    "x-session-token",
    "x-csrf-token",
    "x-xsrf-token",
    "x-amz-security-token",
    "x-goog-api-key"
  ]);

  const SECRET_PARAMS = new Set([
    "token",
    "access_token",
    "id_token",
    "refresh_token",
    "api_key",
    "apikey",
    "key",
    "sig",
    "signature",
    "password",
    "secret",
    "auth",
    "session"
  ]);

  const SCRUB = [
    [/\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 <redacted>"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<jwt redacted>"],
    // Substring match on the key, so secret_token / authToken / refreshToken /
    // x-api-key are all covered rather than only the exact names.
    [
      /"([A-Za-z0-9_-]*(?:passwd|password|secret|token|api[_-]?key|apikey|credential|private[_-]?key|session[_-]?id|csrf)[A-Za-z0-9_-]*)"(\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
      '"$1"$2"<redacted>"'
    ],
    [/\bsk-[A-Za-z0-9_-]{16,}/g, "<redacted>"],
    [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, "<redacted>"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "<redacted>"],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, "<redacted>"],
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "<redacted>"]
  ];

  const PII = [
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<email redacted>"],
    [/\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6011)[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/g, "<card redacted>"],
    [/\b\d{3}-\d{2}-\d{4}\b/g, "<ssn redacted>"]
  ];

  function scrubText(s) {
    if (typeof s !== "string" || !s) return s || "";
    if (!redactOn) return s;
    let out = s;
    for (const [re, rep] of SCRUB) out = out.replace(re, rep);
    if (redactPii) for (const [re, rep] of PII) out = out.replace(re, rep);
    return out;
  }

  // Only the `exp` claim is read. Expiry is the single most useful signal for
  // diagnosing a 401 and leaks nothing; sub/email stay in the opaque payload.
  function jwtHint(value) {
    const m = /eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\./.exec(value || "");
    if (!m) return null;
    try {
      let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      const claims = JSON.parse(atob(b64));
      if (typeof claims.exp !== "number") return "JWT, no exp claim";
      const delta = claims.exp * 1000 - Date.now();
      const mins = Math.round(Math.abs(delta) / 60000);
      return delta >= 0 ? `JWT, expires in ${mins}m` : `JWT, expired ${mins}m ago`;
    } catch (_) {
      return "JWT, unreadable payload";
    }
  }

  function cookieHint(value) {
    const names = String(value || "")
      .split(";")
      .map((s) => s.split("=")[0].trim())
      .filter(Boolean);
    const shown = names.slice(0, 12);
    return `${names.length} cookie${names.length === 1 ? "" : "s"}: ${shown.join(", ")}${
      names.length > shown.length ? ", …" : ""
    }`;
  }

  function redactHeaderValue(name, value) {
    if (name === "cookie" || name === "set-cookie") return `<redacted: ${cookieHint(value)}>`;
    const scheme = /^([A-Za-z]+)\s/.exec(value || "");
    const jwt = jwtHint(value);
    if (jwt) return `<redacted ${scheme ? scheme[1] + " " : ""}${jwt}>`;
    return `<redacted${scheme ? " " + scheme[1] : ""}, ${(value || "").length} chars>`;
  }

  // Returns a plain {lowercased-name: value} map. Secret header NAMES are kept —
  // the agent has to know an Authorization header was present to reason about auth.
  function redactHeaders(list) {
    const out = {};
    for (const h of list || []) {
      const name = String(h.name || "").toLowerCase();
      if (!name) continue;
      const raw = String(h.value == null ? "" : h.value);
      const value = redactOn && SECRET_HEADERS.has(name) ? redactHeaderValue(name, raw) : scrubText(raw);
      out[name] = name in out ? out[name] + ", " + value : value;
    }
    return out;
  }

  function clipUrl(u, maxLen) {
    const max = maxLen || 200;
    if (!u) return "";
    let out = String(u);
    try {
      const x = new URL(out);
      let changed = false;
      for (const k of Array.from(x.searchParams.keys())) {
        if (redactOn && SECRET_PARAMS.has(k.toLowerCase())) {
          x.searchParams.set(k, "REDACTED");
          changed = true;
        }
      }
      if (changed) out = x.toString();
      if (out.length > max) {
        const n = Array.from(x.searchParams.keys()).length;
        out = x.origin + x.pathname + (n ? `?…(${n} params)` : "");
      }
    } catch (_) {
      if (out.length > max) out = out.slice(0, max) + "…";
    }
    return scrubText(out);
  }

  /* --------------------------------------------------------- size caps */

  // Always returns valid JSON. Oversized results shrink their largest array
  // until they fit, then say so, rather than being cut mid-token.
  function capResult(obj, maxChars) {
    let s;
    try {
      s = JSON.stringify(obj);
    } catch (_) {
      return '{"error":"result was not serializable"}';
    }
    if (s.length <= maxChars) return s;

    const arrays = [];
    (function walk(node) {
      if (Array.isArray(node)) {
        arrays.push(node);
        node.forEach(walk);
      } else if (node && typeof node === "object") {
        Object.keys(node).forEach((k) => walk(node[k]));
      }
    })(obj);

    let dropped = 0;
    for (let guard = 0; guard < 400 && s.length > maxChars; guard++) {
      let biggest = null;
      for (const a of arrays) if (!biggest || a.length > biggest.length) biggest = a;
      if (!biggest || biggest.length <= 1) break;
      const keep = Math.max(1, Math.floor(biggest.length * 0.7));
      dropped += biggest.length - keep;
      biggest.length = keep;
      try {
        s = JSON.stringify(obj);
      } catch (_) {
        break;
      }
    }

    // Arrays alone are not always enough: one long string (a body slice, a
    // snippet) can exceed the cap on its own, and JSON escaping can nearly
    // double it. Trim the longest remaining string until it fits.
    if (s.length > maxChars) {
      const slots = [];
      (function walk(node) {
        if (Array.isArray(node)) {
          node.forEach((v, i) => (typeof v === "string" ? slots.push({ o: node, k: i }) : walk(v)));
        } else if (node && typeof node === "object") {
          for (const k of Object.keys(node)) {
            if (typeof node[k] === "string") slots.push({ o: node, k });
            else walk(node[k]);
          }
        }
      })(obj);

      for (let guard = 0; guard < 400 && s.length > maxChars; guard++) {
        let biggest = null;
        for (const slot of slots) {
          if (!biggest || slot.o[slot.k].length > biggest.o[biggest.k].length) biggest = slot;
        }
        if (!biggest || biggest.o[biggest.k].length <= 60) break;
        const cur = biggest.o[biggest.k];
        biggest.o[biggest.k] = cur.slice(0, Math.max(60, Math.floor(cur.length * 0.7))) + "…";
        try {
          s = JSON.stringify(obj);
        } catch (_) {
          break;
        }
      }
    }

    obj.truncated = true;
    obj.dropped = dropped;
    obj.hint = "Result exceeded the size cap. Narrow the filter or lower `limit`.";
    try {
      s = JSON.stringify(obj);
    } catch (_) {}
    if (s.length > maxChars) {
      return JSON.stringify({
        error: "result exceeded the size cap even after truncation",
        hint: "Request fewer items, or a smaller body_max."
      });
    }
    return s;
  }

  /* ----------------------------------------------------------- shaping */

  function hostOf(u) {
    try {
      return new URL(u).host;
    } catch (_) {
      return "";
    }
  }

  function normalizePath(pathname) {
    return (pathname || "/")
      .split("/")
      .map((seg) => {
        if (!seg) return seg;
        if (/^\d+$/.test(seg)) return ":id";
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":uuid";
        if (/^[0-9a-f]{24,}$/i.test(seg)) return ":hash";
        if (seg.length >= 16 && /\d/.test(seg) && /[A-Za-z]/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg)) {
          return ":token";
        }
        // Bundler-hashed filenames: app.9f3a2b1c8d4e5f6a.js
        if (/[0-9a-f]{16,}/i.test(seg)) return seg.replace(/[0-9a-f]{16,}/gi, ":hash");
        return seg;
      })
      .join("/");
  }

  // The in-page hook only sees fetch/XHR/WebSocket, so there are no static
  // assets to skip; kept so include_static stays a harmless no-op.
  function isStatic() {
    return false;
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Math.round(sorted[i]);
  }

  function parseJson(text) {
    const t = (text || "").trim();
    if (!t || !(t.startsWith("{") || t.startsWith("["))) return undefined;
    try {
      return JSON.parse(t);
    } catch (_) {
      return undefined;
    }
  }

  // `returned` counts SOURCE characters consumed, not output characters, so
  // `body_offset + returned` always pages correctly even though scrubbing and
  // trimming change the text length.
  function bodySlice(text, offset, max, budget) {
    const src = text || "";
    const from = Math.max(0, Math.min(offset || 0, src.length));
    let take = Math.max(0, Math.min(max, src.length - from));
    let chunk = scrubText(src.slice(from, from + take));

    // JSON escaping can nearly double a body's length, which would otherwise
    // push the whole result past its cap and return an error instead of text.
    if (budget) {
      let guard = 0;
      while (take > 200 && JSON.stringify(chunk).length > budget && guard++ < 40) {
        take = Math.floor(take * 0.75);
        chunk = scrubText(src.slice(from, from + take));
      }
    }

    return { text: chunk, offset: from, returned: take, total: src.length, more: from + take < src.length };
  }

  function inspectedPage() {
    const all = entries();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].kind === "nav") return clipUrl(all[i].url);
    }
    for (const e of all) {
      if (e.kind === "http" && e.resourceType === "document") return clipUrl(e.url);
    }
    return "";
  }

  /* ------------------------------------------------------------- tools */

  function toolCaptureSummary() {
    const all = entries();
    const http = [];
    const frames = [];
    const sockets = new Set();
    let navCount = 0;
    for (const e of all) {
      if (e.kind === "http") http.push(e);
      else if (e.kind === "ws-frame") {
        frames.push(e);
        sockets.add(e.wsId);
      } else if (e.kind === "ws-open" || e.kind === "ws-close") sockets.add(e.wsId);
      else if (e.kind === "nav") navCount++;
    }

    const hosts = new Map();
    const statuses = {};
    const errors = { "4xx": 0, "5xx": 0, net_fail: 0 };
    let pending = 0;
    let truncatedBodies = 0;
    let binary = 0;

    for (const e of http) {
      const h = hostOf(e.url) || "(unparsed)";
      hosts.set(h, (hosts.get(h) || 0) + 1);
      const s = e.status || 0;
      const bucket = s === 0 ? "pending_or_failed" : Math.floor(s / 100) + "xx";
      statuses[bucket] = (statuses[bucket] || 0) + 1;
      if (s >= 400 && s < 500) errors["4xx"]++;
      else if (s >= 500) errors["5xx"]++;
      else if (s === 0) errors.net_fail++;
      if (e.resBodyPending) pending++;
      if (e.resBodyTruncated) truncatedBodies++;
      if (e.resBodyBinary) binary++;
    }

    const topHosts = Array.from(hosts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([host, count]) => ({ host, count }));

    return capResult(
      {
        inspected_page: inspectedPage(),
        capture_started_at: new Date(startedAt()).toISOString(),
        total_entries: all.length,
        http: http.length,
        ws_frames: frames.length,
        sockets: sockets.size,
        navigations: navCount,
        first_t: all.length ? relT(all[0]) : 0,
        last_t: all.length ? relT(all[all.length - 1]) : 0,
        hosts: topHosts,
        status_histogram: statuses,
        errors,
        pending_bodies: pending,
        truncated_bodies: truncatedBodies,
        binary_bodies: binary
      },
      2000
    );
  }

  function endpointsData(args) {
    const a = args || {};
    const includeStatic = a.include_static === true;
    const includeWs = a.include_ws !== false;
    const limit = Math.min(Math.max(1, a.limit || 120), 300);
    const groups = new Map();
    let skippedStatic = 0;

    for (const e of entries()) {
      if (e.kind !== "http") continue;
      if (!includeStatic && isStatic(e)) {
        skippedStatic++;
        continue;
      }
      const host = hostOf(e.url) || "(unparsed)";
      if (a.host && host !== a.host) continue;

      let path = e.url;
      let queryKeys = [];
      try {
        const x = new URL(e.url);
        path = normalizePath(x.pathname);
        queryKeys = Array.from(x.searchParams.keys());
      } catch (_) {}

      const key = e.method + " " + host + " " + path;
      let g = groups.get(key);
      if (!g) {
        g = {
          method: e.method,
          host,
          path,
          count: 0,
          statuses: {},
          _q: new Set(),
          _ms: [],
          total_bytes: 0,
          mime: "",
          req_body: false,
          sample_ids: []
        };
        groups.set(key, g);
      }
      g.count++;
      const st = String(e.status || 0);
      g.statuses[st] = (g.statuses[st] || 0) + 1;
      for (const k of queryKeys) g._q.add(k);
      if (e.durationMs) g._ms.push(e.durationMs);
      g.total_bytes += e.size || 0;
      if (!g.mime && e.mime) g.mime = e.mime.split(";")[0];
      if (e.reqBody) g.req_body = true;
      if (g.sample_ids.length < 3) g.sample_ids.push(e.id);
    }

    let list = Array.from(groups.values()).map((g) => {
      const ms = g._ms.sort((x, y) => x - y);
      const sum = ms.reduce((t, v) => t + v, 0);
      return {
        method: g.method,
        host: g.host,
        path: g.path,
        count: g.count,
        statuses: g.statuses,
        query_keys: Array.from(g._q).slice(0, 20),
        avg_ms: ms.length ? Math.round(sum / ms.length) : 0,
        p95_ms: percentile(ms, 95),
        total_bytes: g.total_bytes,
        mime: g.mime,
        req_body: g.req_body,
        sample_ids: g.sample_ids
      };
    });

    const errCount = (g) =>
      Object.keys(g.statuses).reduce((t, s) => t + (Number(s) >= 400 || Number(s) === 0 ? g.statuses[s] : 0), 0);
    const sort = a.sort || "count";
    if (sort === "slowest") list.sort((x, y) => y.p95_ms - x.p95_ms);
    else if (sort === "largest") list.sort((x, y) => y.total_bytes - x.total_bytes);
    else if (sort === "errors") list.sort((x, y) => errCount(y) - errCount(x));
    else list.sort((x, y) => y.count - x.count);

    const totalEndpoints = list.length;
    list = list.slice(0, limit);

    const sockets = [];
    if (includeWs) {
      const byId = new Map();
      for (const e of entries()) {
        if (!e.wsId) continue;
        let s = byId.get(e.wsId);
        if (!s) {
          s = {
            ws_id: e.wsId,
            url: clipUrl(e.url),
            opened_at: relT(e),
            closed: null,
            sent: 0,
            received: 0,
            _shapes: new Set(),
            sample_ids: []
          };
          byId.set(e.wsId, s);
        }
        if (e.kind === "ws-frame") {
          if (e.dir === "sent") s.sent++;
          else s.received++;
          const j = parseJson(e.payload);
          if (j && typeof j === "object") s._shapes.add(Object.keys(j).sort().join(","));
          if (s.sample_ids.length < 3) s.sample_ids.push(e.id);
        } else if (e.kind === "ws-close") {
          s.closed = { code: e.code, reason: scrubText(e.reason || "") };
        }
      }
      for (const s of byId.values()) {
        sockets.push({
          ws_id: s.ws_id,
          url: s.url,
          opened_at: s.opened_at,
          closed: s.closed,
          sent: s.sent,
          received: s.received,
          distinct_payload_shapes: s._shapes.size,
          sample_ids: s.sample_ids
        });
      }
    }

    return {
      endpoints: list,
      sockets,
      total_endpoints: totalEndpoints,
      skipped_static: skippedStatic
    };
  }

  function toolListEndpoints(args) {
    return capResult(endpointsData(args), 16000);
  }

  function statusMatches(status, spec) {
    if (!spec) return true;
    const s = Number(status) || 0;
    const q = String(spec).trim();
    if (/^\d{3}$/.test(q)) return s === Number(q);
    if (/^[1-5]xx$/i.test(q)) return Math.floor(s / 100) === Number(q[0]);
    const m = /^(>=|<=|>|<)\s*(\d+)$/.exec(q);
    if (m) {
      const n = Number(m[2]);
      if (m[1] === ">=") return s >= n;
      if (m[1] === "<=") return s <= n;
      if (m[1] === ">") return s > n;
      return s < n;
    }
    if (q === "0") return s === 0;
    return true;
  }

  function filterEntries(a) {
    const methods = a.method
      ? String(a.method)
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
      : null;
    return entries().filter((e) => {
      if (a.kind && e.kind !== a.kind) return false;
      if (!a.kind && e.kind === "nav") return false;
      if (methods && (e.kind !== "http" || !methods.includes(e.method))) return false;
      if (a.status && (e.kind !== "http" || !statusMatches(e.status, a.status))) return false;
      if (a.url_contains && !(e.url || "").toLowerCase().includes(String(a.url_contains).toLowerCase())) return false;
      if (a.host && hostOf(e.url) !== a.host) return false;
      if (a.mime_contains && !(e.mime || "").toLowerCase().includes(String(a.mime_contains).toLowerCase())) {
        return false;
      }
      if (a.resource_type && (typeof typeBucket !== "function" || typeBucket(e) !== a.resource_type)) return false;
      const t = relT(e);
      if (typeof a.since_t === "number" && t < a.since_t) return false;
      if (typeof a.until_t === "number" && t > a.until_t) return false;
      if (typeof a.min_ms === "number" && (e.durationMs || 0) < a.min_ms) return false;
      if (typeof a.min_bytes === "number" && (e.size || 0) < a.min_bytes) return false;
      return true;
    });
  }

  function briefItem(e) {
    const flags = [];
    if (e.resBodyTruncated || e.payloadTruncated) flags.push("truncated");
    if (e.resBodyBinary) flags.push("binary");
    if (e.resBodyPending) flags.push("pending");
    const item = { id: e.id, t: relT(e), kind: e.kind, url: clipUrl(e.url, 160) };
    if (e.kind === "http") {
      item.method = e.method;
      item.status = e.status;
      item.mime = (e.mime || "").split(";")[0];
      item.ms = Math.round(e.durationMs || 0);
      item.bytes = e.size || 0;
    } else if (e.kind === "ws-frame") {
      item.dir = e.dir;
      item.bytes = e.size || 0;
      item.payload_kind = e.payloadKind;
    } else if (e.kind === "ws-close") {
      item.code = e.code;
    }
    if (flags.length) item.flags = flags;
    return item;
  }

  function toolListRequests(args) {
    const a = args || {};
    const limit = Math.min(Math.max(1, a.limit || 50), 200);
    const offset = Math.max(0, a.offset || 0);
    let list = filterEntries(a);

    const sort = a.sort || "time";
    if (sort === "duration") list.sort((x, y) => (y.durationMs || 0) - (x.durationMs || 0));
    else if (sort === "size") list.sort((x, y) => (y.size || 0) - (x.size || 0));
    else list.sort((x, y) => x.id - y.id);
    if (a.order === "desc" && sort === "time") list.reverse();
    if (a.order === "asc" && sort !== "time") list.reverse();

    const total = list.length;
    const page = list.slice(offset, offset + limit);
    return capResult(
      { total, returned: page.length, offset, items: page.map(briefItem) },
      20000
    );
  }

  function buildRegex(query, isRegex, caseSensitive) {
    const source = isRegex ? query : String(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(source, caseSensitive ? "g" : "gi");
  }

  function countAndSnippet(re, text, ctx) {
    if (!text) return null;
    re.lastIndex = 0;
    const first = re.exec(text);
    if (!first) return null;
    let count = 1;
    while (count < 500 && re.exec(text)) count++;
    const start = Math.max(0, first.index - ctx);
    const end = Math.min(text.length, first.index + first[0].length + ctx);
    const snippet =
      (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
    return { count, snippet: scrubText(snippet) };
  }

  async function toolSearchTraffic(args) {
    const a = args || {};
    if (!a.query) return JSON.stringify({ error: "query is required" });
    const limit = Math.min(Math.max(1, a.limit || 30), 100);
    const ctx = Math.min(Math.max(20, a.context_chars || 120), 400);
    const scopes = new Set(a.scopes && a.scopes.length ? a.scopes : ["url", "req_headers", "req_body", "res_headers", "res_body", "ws"]);

    let re;
    try {
      re = buildRegex(a.query, a.regex === true, a.case_sensitive === true);
    } catch (err) {
      return JSON.stringify({ error: "invalid regular expression: " + (err && err.message) });
    }

    const fields = [
      ["url", "url", (e) => e.url],
      ["req_headers", "req-h", (e) => e.reqHeaderText],
      ["req_body", "req-b", (e) => e.reqBody],
      ["res_headers", "res-h", (e) => e.resHeaderText],
      ["res_body", "res-b", (e) => e.resBody],
      ["ws", "frame", (e) => (e.kind === "ws-frame" ? e.payload : "")]
    ];

    const all = entries();
    const items = [];
    let matchingEntries = 0;
    let scanned = 0;
    let scanTruncated = false;

    for (let i = 0; i < all.length; i++) {
      if (i % SCAN_CHUNK === 0 && i) await new Promise((r) => setTimeout(r, 0));
      const e = all[i];
      if (e.kind === "nav") continue;

      const matchedIn = [];
      let best = null;
      let total = 0;

      for (const [scope, label, get] of fields) {
        if (!scopes.has(scope)) continue;
        const text = get(e);
        if (!text) continue;
        scanned += text.length;
        if (scanned > SCAN_LIMIT) {
          scanTruncated = true;
          break;
        }
        const hit = countAndSnippet(re, text, ctx);
        if (hit) {
          matchedIn.push(label);
          total += hit.count;
          if (!best) best = hit.snippet;
        }
      }
      if (scanTruncated) break;
      if (!matchedIn.length) continue;

      matchingEntries++;
      if (items.length < limit) {
        const item = briefItem(e);
        item.matched_in = matchedIn;
        item.match_count = total;
        item.snippet = best;
        items.push(item);
      }
    }

    return capResult(
      {
        query: a.query,
        total_matching_entries: matchingEntries,
        returned: items.length,
        items,
        scan_truncated: scanTruncated
      },
      16000
    );
  }

  function toolGetRequest(args) {
    const a = args || {};
    const e = entryById(a.id);
    if (!e) return JSON.stringify({ error: `no entry with id ${a.id}` });

    const include = a.include && a.include.length ? a.include : ["req_headers", "res_headers"];
    const bodyMax = Math.min(Math.max(200, a.body_max || 4000), 20000);
    const offset = Math.max(0, a.body_offset || 0);

    if (e.kind === "ws-frame") {
      return capResult(
        {
          id: e.id,
          kind: e.kind,
          ws_id: e.wsId,
          url: clipUrl(e.url),
          t: relT(e),
          dir: e.dir,
          payload_kind: e.payloadKind,
          bytes: e.size || 0,
          payload: bodySlice(e.payload, offset, bodyMax, BODY_BUDGET),
          flags: { payload_capture_truncated: !!e.payloadTruncated }
        },
        24000
      );
    }

    if (e.kind !== "http") {
      return capResult(
        {
          id: e.id,
          kind: e.kind,
          ws_id: e.wsId || null,
          url: clipUrl(e.url),
          t: relT(e),
          code: e.code,
          reason: scrubText(e.reason || "")
        },
        4000
      );
    }

    const out = {
      id: e.id,
      kind: "http",
      method: e.method,
      url: clipUrl(e.url, 400),
      status: e.status,
      status_text: e.statusText,
      mime: e.mime,
      resource_type: typeof typeBucket === "function" ? typeBucket(e) : "other",
      bytes: e.size || 0,
      ms: Math.round(e.durationMs || 0),
      t: relT(e),
      flags: {
        res_body_pending: !!e.resBodyPending,
        res_body_binary: !!e.resBodyBinary,
        res_body_capture_truncated: !!e.resBodyTruncated,
        req_body_capture_truncated: !!e.reqBodyTruncated
      }
    };
    if (include.includes("req_headers")) out.req_headers = redactHeaders(e.reqHeaders);
    if (include.includes("res_headers")) out.res_headers = redactHeaders(e.resHeaders);
    if (include.includes("req_body")) {
      out.req_body = e.reqBody ? bodySlice(e.reqBody, offset, bodyMax, BODY_BUDGET) : null;
    }
    if (include.includes("res_body")) {
      if (e.resBodyBinary) out.res_body = { error: "response body is binary and was not captured as text" };
      else if (e.resBodyPending) out.res_body = { error: "response body was still downloading when captured" };
      else out.res_body = e.resBody ? bodySlice(e.resBody, offset, bodyMax, BODY_BUDGET) : null;
    }
    if (include.includes("timing")) {
      out.timing = e.timings || null;
      out.server_ip = e.serverIP || "";
      out.from_cache = !!e.fromCache;
      out.http_version = e.httpVersion || "";
      if (!out.timing) out.timing_note = "per-phase timings unavailable; total is `ms`";
    }
    return capResult(out, 24000);
  }

  function shapeOf(v, depth, maxDepth, maxKeys, counters) {
    if (v === null) return "null";
    if (Array.isArray(v)) {
      if (!v.length) return { type: "array", length: 0 };
      if (depth >= maxDepth) return { type: "array", length: v.length, items: "…" };
      return { type: "array", length: v.length, items: shapeOf(v[0], depth + 1, maxDepth, maxKeys, counters) };
    }
    if (typeof v === "object") {
      if (depth >= maxDepth) return { type: "object", keys: "…" };
      const keys = Object.keys(v);
      const out = {};
      let n = 0;
      for (const k of keys) {
        if (n >= maxKeys) {
          counters.truncated += keys.length - n;
          break;
        }
        out[k] = shapeOf(v[k], depth + 1, maxDepth, maxKeys, counters);
        n++;
      }
      return { type: "object", keys: out };
    }
    return typeof v;
  }

  function clipSample(v, depth) {
    if (typeof v === "string") return scrubText(v.length > 40 ? v.slice(0, 40) + "…" : v);
    if (Array.isArray(v)) {
      if (depth > 2) return "[…]";
      return v.slice(0, 3).map((x) => clipSample(x, depth + 1));
    }
    if (v && typeof v === "object") {
      if (depth > 2) return "{…}";
      const out = {};
      let n = 0;
      for (const k of Object.keys(v)) {
        if (n++ >= 12) {
          out["…"] = "…";
          break;
        }
        out[k] = clipSample(v[k], depth + 1);
      }
      return out;
    }
    return v;
  }

  function descend(v, path) {
    if (!path) return v;
    const parts = String(path).match(/[^.[\]]+/g) || [];
    let cur = v;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[/^\d+$/.test(p) ? Number(p) : p];
    }
    return cur;
  }

  function bodyTextFor(e, side) {
    if (e.kind === "ws-frame") return e.payload || "";
    return side === "request" ? e.reqBody || "" : e.resBody || "";
  }

  function describeJsonData(args) {
    const a = args || {};
    const e = entryById(a.id);
    if (!e) return { error: `no entry with id ${a.id}` };
    const side = a.side === "request" ? "request" : "response";
    const text = bodyTextFor(e, side);
    if (!text) {
      if (e.resBodyBinary) return { id: e.id, error: "body is binary" };
      if (e.resBodyPending) return { id: e.id, error: "body was still downloading" };
      return { id: e.id, side, bytes: 0, is_json: false, error: "body is empty" };
    }
    const parsed = parseJson(text);
    if (parsed === undefined) {
      return {
        id: e.id,
        side,
        bytes: text.length,
        is_json: false,
        head: scrubText(text.slice(0, 300))
      };
    }
    const root = a.path ? descend(parsed, a.path) : parsed;
    if (root === undefined) return { id: e.id, side, error: `path "${a.path}" not found` };

    const counters = { truncated: 0 };
    const maxDepth = Math.min(Math.max(1, a.max_depth || 4), 8);
    const maxKeys = Math.min(Math.max(5, a.max_keys || 60), 200);
    const shape = shapeOf(root, 0, maxDepth, maxKeys, counters);

    let sample = null;
    if (Array.isArray(root) && root.length) sample = { path: (a.path || "") + "[0]", value: clipSample(root[0], 0) };
    else if (root && typeof root === "object") sample = { path: a.path || "(root)", value: clipSample(root, 0) };

    return {
      id: e.id,
      side,
      bytes: text.length,
      is_json: true,
      path: a.path || null,
      shape,
      sample,
      truncated_keys: counters.truncated,
      capture_truncated: side === "response" ? !!e.resBodyTruncated : !!e.reqBodyTruncated
    };
  }

  function toolDescribeJson(args) {
    return capResult(describeJsonData(args), 8000);
  }

  function toolWebsocketFrames(args) {
    const a = args || {};
    const payloadMax = Math.min(Math.max(40, a.payload_max || 400), 4000);
    const limit = Math.min(Math.max(1, a.limit || 40), 100);
    const offset = Math.max(0, a.offset || 0);
    const dir = a.dir || "both";

    let wsId = a.ws_id || null;
    if (!wsId && a.url_contains) {
      const needle = String(a.url_contains).toLowerCase();
      const hit = entries().find((e) => e.wsId && (e.url || "").toLowerCase().includes(needle));
      if (hit) wsId = hit.wsId;
    }
    if (!wsId) {
      const first = entries().find((e) => e.kind === "ws-frame");
      if (!first) return JSON.stringify({ error: "no WebSocket frames were captured" });
      wsId = first.wsId;
    }

    const socket = { ws_id: wsId, url: "", opened_at: null, state: "open", close: null };
    const raw = [];
    for (const e of entries()) {
      if (e.wsId !== wsId) continue;
      if (!socket.url) socket.url = clipUrl(e.url);
      if (e.kind === "ws-open") socket.opened_at = relT(e);
      else if (e.kind === "ws-close") {
        socket.state = "closed";
        socket.close = { code: e.code, reason: scrubText(e.reason || "") };
      } else if (e.kind === "ws-frame") {
        if (dir !== "both" && e.dir !== dir) continue;
        if (a.contains && !(e.payload || "").toLowerCase().includes(String(a.contains).toLowerCase())) continue;
        raw.push(e);
      }
    }

    const frames = [];
    for (const e of raw) {
      const prev = frames[frames.length - 1];
      if (a.dedupe !== false && prev && prev._payload === e.payload && prev.dir === e.dir) {
        prev.repeat_count++;
        continue;
      }
      const clipped = (e.payload || "").slice(0, payloadMax);
      frames.push({
        id: e.id,
        t: relT(e),
        dir: e.dir,
        kind: e.payloadKind,
        bytes: e.size || 0,
        payload: scrubText(clipped),
        truncated: (e.payload || "").length > payloadMax || !!e.payloadTruncated,
        repeat_count: 1,
        _payload: e.payload
      });
    }
    for (const f of frames) delete f._payload;

    const total = frames.length;
    return capResult(
      { socket, total, returned: Math.min(limit, Math.max(0, total - offset)), offset, frames: frames.slice(offset, offset + limit) },
      16000
    );
  }

  function leafMap(v, prefix, map, depth) {
    if (depth > 6) return map;
    if (Array.isArray(v)) {
      map.set(prefix + ".length", v.length);
      if (v.length) leafMap(v[0], prefix + "[0]", map, depth + 1);
    } else if (v && typeof v === "object") {
      for (const k of Object.keys(v)) leafMap(v[k], prefix ? prefix + "." + k : k, map, depth + 1);
    } else {
      map.set(prefix || "(root)", v);
    }
    return map;
  }

  function clipValue(v) {
    if (typeof v === "string") return scrubText(v.length > 60 ? v.slice(0, 60) + "…" : v);
    return v;
  }

  function toolCompareRequests(args) {
    const a = args || {};
    const A = entryById(a.id_a);
    const B = entryById(a.id_b);
    if (!A) return JSON.stringify({ error: `no entry with id ${a.id_a}` });
    if (!B) return JSON.stringify({ error: `no entry with id ${a.id_b}` });
    const include = a.include && a.include.length ? a.include : ["headers", "query", "body"];

    const brief = (e) => ({
      id: e.id,
      method: e.method,
      url: clipUrl(e.url, 200),
      status: e.status,
      ms: Math.round(e.durationMs || 0),
      t: relT(e)
    });
    const out = { a: brief(A), b: brief(B) };

    if (include.includes("headers")) {
      const ha = redactHeaders(A.reqHeaders);
      const hb = redactHeaders(B.reqHeaders);
      const differing = {};
      let identical = 0;
      for (const k of Object.keys(ha)) {
        if (!(k in hb)) continue;
        if (ha[k] === hb[k]) identical++;
        else differing[k] = { a: ha[k], b: hb[k] };
      }
      out.headers = {
        only_in_a: Object.keys(ha).filter((k) => !(k in hb)),
        only_in_b: Object.keys(hb).filter((k) => !(k in ha)),
        differing,
        identical_count: identical
      };
    }

    if (include.includes("query")) {
      const qa = new Map();
      const qb = new Map();
      const fill = (e, m) => {
        try {
          for (const [k, v] of new URL(e.url).searchParams) m.set(k, SECRET_PARAMS.has(k.toLowerCase()) && redactOn ? "REDACTED" : v);
        } catch (_) {}
      };
      fill(A, qa);
      fill(B, qb);
      const differing = {};
      for (const [k, v] of qa) if (qb.has(k) && qb.get(k) !== v) differing[k] = { a: clipValue(v), b: clipValue(qb.get(k)) };
      out.query = {
        only_in_a: Array.from(qa.keys()).filter((k) => !qb.has(k)),
        only_in_b: Array.from(qb.keys()).filter((k) => !qa.has(k)),
        differing
      };
    }

    if (include.includes("body")) {
      const ja = parseJson(A.reqBody);
      const jb = parseJson(B.reqBody);
      if (ja === undefined || jb === undefined) {
        out.body = {
          comparable: false,
          note: "one or both request bodies are not JSON",
          a_bytes: (A.reqBody || "").length,
          b_bytes: (B.reqBody || "").length
        };
      } else {
        const ma = leafMap(ja, "", new Map(), 0);
        const mb = leafMap(jb, "", new Map(), 0);
        const differing = {};
        for (const [k, v] of ma) {
          if (!mb.has(k)) continue;
          if (JSON.stringify(v) !== JSON.stringify(mb.get(k))) differing[k] = { a: clipValue(v), b: clipValue(mb.get(k)) };
        }
        out.body = {
          comparable: true,
          same: ma.size === mb.size && !Object.keys(differing).length,
          a_keys_only: Array.from(ma.keys()).filter((k) => !mb.has(k)).slice(0, 40),
          b_keys_only: Array.from(mb.keys()).filter((k) => !ma.has(k)).slice(0, 40),
          differing,
          a_bytes: (A.reqBody || "").length,
          b_bytes: (B.reqBody || "").length
        };
      }
    }

    return capResult(out, 8000);
  }

  /* --------------------------------------------------- outgoing requests */

  const CURL = () => globalThis.__netscopeCurl;
  const MASKED = /<redacted[^>]*>|<jwt redacted>|<email redacted>|<card redacted>|<ssn redacted>|=REDACTED\b/;
  const isWriteMethod = (m) => !/^(GET|HEAD|OPTIONS)$/i.test(m || "GET");

  function headerListFrom(obj) {
    if (!obj) return [];
    if (Array.isArray(obj)) return obj.filter((h) => h && h.name).map((h) => ({ name: String(h.name), value: String(h.value == null ? "" : h.value) }));
    return Object.keys(obj).map((name) => ({ name, value: obj[name] }));
  }

  // Builds the concrete request from from_id / curl / url plus overrides.
  // Synchronous, so the approval card can show exactly what will be sent.
  function buildRequest(a) {
    let base;
    if (a.from_id != null) {
      const e = entryById(Number(a.from_id));
      if (!e || e.kind !== "http") throw new Error(`no captured HTTP request with id ${a.from_id}`);
      base = {
        method: e.method,
        url: e.url,
        headers: (e.reqHeaders || []).map((h) => ({ name: h.name, value: h.value })),
        body: e.reqBody || null
      };
    } else if (a.curl) {
      const parsed = CURL().parse(a.curl);
      base = { method: parsed.method, url: parsed.url, headers: parsed.headers, body: parsed.body, warnings: parsed.warnings };
    } else if (a.url) {
      base = { method: "GET", url: String(a.url), headers: [], body: null };
    } else {
      throw new Error("give one of: curl, from_id, or url");
    }
    if (a.method) base.method = String(a.method).toUpperCase();
    if (a.url && (a.from_id != null || a.curl)) base.url = String(a.url);
    if (a.query && typeof a.query === "object") {
      const u = new URL(base.url);
      for (const k of Object.keys(a.query)) {
        if (a.query[k] === null) u.searchParams.delete(k);
        else u.searchParams.set(k, typeof a.query[k] === "object" ? JSON.stringify(a.query[k]) : String(a.query[k]));
      }
      base.url = u.toString();
    }
    if (a.headers && typeof a.headers === "object") {
      for (const h of headerListFrom(a.headers)) {
        const i = base.headers.findIndex((x) => x.name.toLowerCase() === h.name.toLowerCase());
        if (h.value === null || h.value === undefined) {
          if (i >= 0) base.headers.splice(i, 1);
        } else if (i >= 0) base.headers[i] = { name: h.name, value: String(h.value) };
        else base.headers.push({ name: h.name, value: String(h.value) });
      }
    }
    if (a.body !== undefined) {
      if (a.body === null) base.body = null;
      else if (typeof a.body === "string") base.body = a.body;
      else {
        base.body = JSON.stringify(a.body);
        if (!base.headers.some((h) => /^content-type$/i.test(h.name))) base.headers.push({ name: "Content-Type", value: "application/json" });
      }
    }
    base.method = String(base.method || "GET").toUpperCase();
    if (!/^https?:\/\//i.test(base.url)) throw new Error("url must start with http:// or https://");
    // A masked value can only have come from a tool result; sending it would
    // just fail auth. Steer toward from_id, which copies the real value locally.
    const sent = JSON.stringify([base.url, base.headers, base.body]);
    const m = MASKED.exec(sent);
    if (m) {
      throw new Error(
        `the request contains a masked placeholder (${m[0]}). Masked values never reach you, so they cannot be sent. ` +
          "Use from_id to replay a captured request — NetScope copies its real headers locally — and override only what must change."
      );
    }
    return base;
  }

  function jsonOrNull(text) {
    const t = (text || "").trim();
    if (!t || !(t.startsWith("{") || t.startsWith("["))) return undefined;
    try {
      return JSON.parse(t);
    } catch (_) {
      return undefined;
    }
  }

  async function toolHttpRequest(args) {
    const a = args || {};
    let req;
    try {
      req = buildRequest(a);
    } catch (err) {
      return JSON.stringify({ error: String(err.message || err) });
    }
    if (!api || !api.rpc) return JSON.stringify({ error: "request runner unavailable" });
    let res;
    try {
      res = await api.rpc("http", {
        request: { method: req.method, url: req.url, headers: req.headers, body: req.body },
        source: "ai",
        timeoutMs: a.timeout_ms,
        context: a.context === "page" ? "page" : "extension"
      });
    } catch (err) {
      return JSON.stringify({ error: String(err.message || err) });
    }

    const bodyMax = Math.min(Math.max(200, a.body_max || 6000), 20000);
    const out = {
      request: { method: req.method, url: clipUrl(req.url, 400), headers: redactHeaders(req.headers) },
      status: res.status,
      status_text: res.statusText || "",
      ok: !!res.ok,
      ms: res.ms,
      mime: res.mime || "",
      bytes: res.size || 0
    };
    if (res.url && res.url !== req.url) out.final_url = clipUrl(res.url, 400);
    if (res.sentFrom) out.sent_from_page = clipUrl(res.sentFrom.url, 200);
    if (res.entryId) out.captured_as = "#" + res.entryId;
    if (res.error) out.error = res.error;
    if (res.droppedHeaders && res.droppedHeaders.length) {
      out.dropped_headers = res.droppedHeaders;
      out.dropped_note = "Browsers forbid scripts from setting these. The browser's own cookies for the host were sent instead.";
    }
    if (req.warnings && req.warnings.length) out.curl_warnings = req.warnings;
    out.headers = redactHeaders(res.headers || []);
    if (res.binary) out.body = { note: "binary body, not shown" };
    else {
      const parsed = jsonOrNull(res.body);
      if (parsed !== undefined && (res.body || "").length > bodyMax) {
        const counters = { truncated: 0 };
        out.body_shape = shapeOf(parsed, 0, 4, 60, counters);
      }
      out.body = bodySlice(res.body || "", 0, bodyMax, BODY_BUDGET);
      if (res.bodyTruncated) out.body_capture_truncated = true;
    }
    return capResult(out, 24000);
  }

  function toolGetCurl(args) {
    const e = entryById((args || {}).id);
    if (!e || e.kind !== "http") return JSON.stringify({ error: `no captured HTTP request with id ${(args || {}).id}` });
    const headers = redactHeaders(e.reqHeaders);
    const curl = CURL().build({ method: e.method, url: clipUrl(e.url, 4000), headers, body: scrubText(e.reqBody || "") });
    return capResult(
      {
        id: e.id,
        curl,
        note: redactOn
          ? "Secret values are masked here. To resend with the real values, call http_request with from_id."
          : "Headers are as the page set them; the browser adds cookies itself."
      },
      12000
    );
  }

  /* --------------------------------------------------------------- flows */

  const CHILD_KEYS = ["steps", "then", "else"]; // for_each / repeat bodies, if branches
  const CURL_WRITE = /(-X|--request)\s+['"]?(POST|PUT|PATCH|DELETE)|--data|-d\s|--json/i;

  function eachStep(steps, fn) {
    for (const s of steps || []) {
      if (!s || typeof s !== "object") continue;
      fn(s);
      for (const k of CHILD_KEYS) if (Array.isArray(s[k])) eachStep(s[k], fn);
    }
  }

  const isHttpStep = (s) => s.type === "http" || (!s.type && (s.url || s.curl || s.from_id != null));

  // Could running these steps change data somewhere? A sub-flow might, so it counts.
  function flowHasWrites(steps) {
    let writes = false;
    eachStep(steps, (s) => {
      if (isHttpStep(s) && (isWriteMethod(s.method) || (s.curl && CURL_WRITE.test(s.curl)))) writes = true;
      if (s.type === "run_flow" || (!s.type && s.flow)) writes = true;
    });
    return writes;
  }

  function redactStep(st) {
    const s = JSON.parse(JSON.stringify(st));
    if (s.headers) s.headers = redactHeaders(headerListFrom(s.headers));
    if (typeof s.curl === "string") s.curl = scrubText(s.curl);
    if (typeof s.url === "string") s.url = clipUrl(s.url, 1000);
    if (typeof s.body === "string") s.body = scrubText(s.body);
    for (const k of CHILD_KEYS) if (Array.isArray(s[k])) s[k] = s[k].map(redactStep);
    return s;
  }

  function flowBrief(f) {
    let total = 0;
    eachStep(f.steps, () => total++);
    const t = f.on_request;
    return {
      id: f.id,
      name: f.name,
      description: f.description || "",
      steps: total,
      schedule: f.schedule && f.schedule.enabled ? `every ${f.schedule.every_minutes} min` : "manual only",
      limits: f.limits ? `${f.limits.max_steps} step runs / ${f.limits.max_minutes} min per run${f.limits.auto_resume ? ", auto-resumes" : ""}` : undefined,
      on_request:
        t && t.enabled
          ? `when ${t.host ? "a page on " + t.host : "a page on any site"} sends ${t.method || "any method"} ${t.url_contains ? "to URLs containing " + t.url_contains : "requests"}${t.status ? " answered " + t.status : ""} (cooldown ${t.cooldown_seconds} s)`
          : undefined,
      last_run: f.lastRun
        ? { at: new Date(f.lastRun.at).toISOString(), ok: f.lastRun.ok, ms: f.lastRun.ms, error: f.lastRun.error || undefined, trigger: f.lastRun.trigger }
        : null
    };
  }

  // Steps given as { from_id } are expanded here, in the extension, so the
  // flow stores the real captured headers without the model ever seeing them.
  function materializeSteps(steps) {
    return (steps || []).map((st, i) => {
      const s = Object.assign({}, st);
      for (const k of CHILD_KEYS) if (Array.isArray(s[k])) s[k] = materializeSteps(s[k]);
      if (isHttpStep(s) && s.from_id != null) {
        s.type = "http";
        const e = entryById(Number(s.from_id));
        if (!e || e.kind !== "http") throw new Error(`step ${s.id || i + 1}: no captured HTTP request with id ${s.from_id}`);
        const headers = {};
        for (const h of e.reqHeaders || []) headers[h.name] = h.value;
        if (s.headers && typeof s.headers === "object") Object.assign(headers, s.headers);
        s.method = (s.method || e.method || "GET").toUpperCase();
        s.url = s.url || e.url;
        s.headers = headers;
        if (s.body === undefined && e.reqBody) s.body = jsonOrNull(e.reqBody) !== undefined ? jsonOrNull(e.reqBody) : e.reqBody;
        s.source_entry = e.id;
        delete s.from_id;
      }
      if (isHttpStep(s)) {
        const m = MASKED.exec(JSON.stringify([s.url, s.headers, s.body, s.curl, s.query]));
        if (m) throw new Error(`step ${s.id || i + 1} contains a masked placeholder (${m[0]}); use from_id so NetScope copies the real captured values`);
      }
      return s;
    });
  }

  // The flow save_flow would store: args merged over the existing flow when
  // updating, so omitted fields (steps, schedule …) keep their current value.
  // Used by both the tool and the approval gate, so what is approved is what
  // gets saved.
  async function resolveFlowArgs(a) {
    let existing = null;
    if (a.id) {
      existing = await api.rpc("flows.get", { id: a.id });
      if (!existing && !a.steps) throw new Error(`no flow with id ${a.id}`);
    }
    const prev = (existing && existing.schedule) || { enabled: false, every_minutes: 60 };
    let schedule;
    if (a.every_minutes != null) schedule = { enabled: a.schedule_enabled !== false && Number(a.every_minutes) > 0, every_minutes: Number(a.every_minutes) || 60 };
    else if (a.schedule_enabled != null) schedule = { enabled: !!a.schedule_enabled, every_minutes: prev.every_minutes || 60 };
    else schedule = prev;
    const flow = {
      name: a.name || (existing && existing.name),
      description: a.description != null ? a.description : (existing && existing.description) || "",
      steps: a.steps ? materializeSteps(a.steps) : (existing && existing.steps) || [],
      vars: a.vars || (existing && existing.vars) || {},
      schedule,
      limits: a.limits || (existing && existing.limits) || undefined
    };
    // on_request: object sets the trigger, null removes it, omitted keeps it.
    const trig = a.on_request !== undefined ? a.on_request : existing && existing.on_request;
    if (trig) {
      flow.on_request = Object.assign({ enabled: true }, trig);
      // Scope a new trigger to the site it was built on, so a bot for one app
      // never fires (and forwards data) while browsing another.
      if (!flow.on_request.host && a.on_request) {
        try {
          flow.on_request.host = new URL(api.page().url).host;
        } catch (_) {}
      }
    }
    if (a.id) flow.id = a.id;
    return flow;
  }

  async function toolSaveFlow(args) {
    const a = args || {};
    let flow;
    try {
      flow = await resolveFlowArgs(a);
      const saved = await api.rpc("flows.save", { flow });
      return capResult(
        {
          saved: true,
          flow: flowBrief(saved),
          step_ids: saved.steps.map((s) => s.id),
          warnings: saved.warnings && saved.warnings.length ? saved.warnings : undefined,
          hint: "Run it with run_flow (a small sample first for big jobs) before relying on the schedule."
        },
        6000
      );
    } catch (err) {
      return JSON.stringify({ error: String(err.message || err) });
    }
  }

  // Same arguments as save_flow; checks everything, stores nothing.
  async function toolValidateFlow(args) {
    try {
      const flow = await resolveFlowArgs(args || {});
      const r = await api.rpc("flows.validate", { flow });
      return capResult(
        {
          valid: r.valid,
          errors: r.errors,
          warnings: r.warnings,
          hint: r.valid ? "Valid. Save it with the same arguments." : "Fix every error, then validate again before saving."
        },
        12000
      );
    } catch (err) {
      return JSON.stringify({ valid: false, errors: [String(err.message || err)] });
    }
  }

  async function toolListFlows() {
    try {
      const flows = await api.rpc("flows.list");
      return capResult({ total: flows.length, flows: flows.map(flowBrief) }, 8000);
    } catch (err) {
      return JSON.stringify({ error: String(err.message || err) });
    }
  }

  function runBrief(run) {
    return {
      ok: run.ok,
      error: run.error || undefined,
      trigger: run.trigger,
      at: new Date(run.startedAt).toISOString(),
      ms: run.ms,
      note: run.note || undefined,
      failure: run.failure || undefined,
      preserved: run.preserved || undefined,
      rate_adapted: run.rate && Object.keys(run.rate).length ? run.rate : undefined,
      paused: run.paused || undefined,
      resumable: run.resumable || undefined,
      progress: run.progress || undefined,
      resumed: run.resumed || undefined,
      collections: run.collections && Object.keys(run.collections).length ? run.collections : undefined,
      step_runs: run.executed,
      steps: (run.steps || []).map((s) => ({
        id: s.id,
        type: s.type,
        ok: s.ok,
        runs: s.runs > 1 ? s.runs : undefined,
        retries: s.retries || undefined,
        failed_items: s.failedItems && s.failedItems.length ? s.failedItems.slice(0, 10) : undefined,
        failed_runs: s.runs > 1 && s.failCount ? s.failCount : undefined,
        skipped: s.skipped || undefined,
        status: s.status,
        method: s.method,
        url: s.url ? clipUrl(s.url, 200) : undefined,
        ms: s.ms,
        captured_as: s.entryId ? "#" + s.entryId : undefined,
        error: s.error || undefined,
        note: s.note || undefined,
        extracted: s.extracted ? JSON.parse(scrubText(JSON.stringify(s.extracted))) : undefined,
        output: s.output ? scrubText(String(s.output).slice(0, 1500)) : undefined
      })),
      vars: run.vars ? JSON.parse(scrubText(JSON.stringify(run.vars))) : undefined,
      memory: run.state && Object.keys(run.state).length ? JSON.parse(scrubText(JSON.stringify(run.state))) : undefined,
      log: run.logs && run.logs.length ? run.logs.slice(-30).map((l) => scrubText(l.message)) : undefined
    };
  }

  async function toolGetFlow(args) {
    try {
      const f = await api.rpc("flows.get", { id: (args || {}).id });
      if (!f) return JSON.stringify({ error: `no flow with id ${(args || {}).id}` });
      const runs = await api.rpc("flows.runs", { id: f.id });
      const memory = await api.rpc("flows.state", { id: f.id }).catch(() => ({}));
      const collections = await api.rpc("flows.collections", { id: f.id }).catch(() => ({}));
      const checkpoint = await api.rpc("flows.checkpoint", { id: f.id }).catch(() => null);
      return capResult(
        Object.assign(flowBrief(f), {
          vars: f.vars || {},
          memory: JSON.parse(scrubText(JSON.stringify(memory || {}))),
          collections: Object.keys(collections || {}).length
            ? JSON.parse(scrubText(JSON.stringify(Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, { count: v.count, fields: v.fields }])))))
            : undefined,
          paused_job: checkpoint || undefined,
          steps: (f.steps || []).map(redactStep),
          recent_runs: runs.slice(0, 3).map(runBrief)
        }),
        16000
      );
    } catch (err) {
      return JSON.stringify({ error: String(err.message || err) });
    }
  }

  async function toolRunFlow(args) {
    const a = args || {};
    try {
      if (a.background) {
        const r = await api.rpc("flows.start", { id: a.id, vars: a.vars, resume: !!a.resume, trigger: "ai" });
        return JSON.stringify(
          Object.assign(r, { hint: "Running in the background. Check progress with get_flow (paused_job, recent_runs) or get_collection; the developer sees it on the Flows tab." })
        );
      }
      const run = a.resume ? await api.rpc("flows.resume", { id: a.id }) : await api.rpc("flows.run", { id: a.id, vars: a.vars, trigger: "ai" });
      return capResult(runBrief(run), 16000);
    } catch (err) {
      return JSON.stringify({ error: String(err.message || err) });
    }
  }

  async function toolGetCollection(args) {
    const a = args || {};
    try {
      const page = await api.rpc("flows.collection", {
        id: a.flow_id,
        name: a.name,
        offset: a.offset || 0,
        limit: Math.min(Math.max(1, a.limit || 50), 200)
      });
      let items = page.items;
      if (Array.isArray(a.fields) && a.fields.length) {
        items = items.map((x) => {
          const o = {};
          for (const f of a.fields) o[f] = x && typeof x === "object" ? descend(x, f) : undefined;
          return o;
        });
      }
      return capResult(
        JSON.parse(scrubText(JSON.stringify({ name: a.name, total: page.total, offset: page.offset, returned: items.length, items }))),
        20000
      );
    } catch (err) {
      return JSON.stringify({ error: String(err.message || err) });
    }
  }

  /* ---------------------------------------------------------------- docs */

  // Markdown documents Kimi keeps for the developer (Docs tab): findings,
  // API maps, how a flow works. Stored locally; never sent anywhere else.
  const siteOfPage = () => {
    try {
      return new URL(api.page().url).host;
    } catch (_) {
      return "";
    }
  };

  async function findDoc(a) {
    if (a.id) return api.rpc("docs.get", { id: a.id });
    if (a.title) return api.rpc("docs.get", { title: a.title });
    return null;
  }

  async function toolListDocs(args) {
    try {
      const a = args || {};
      let list = await api.rpc("docs.list");
      if (a.site) list = list.filter((d) => d.site === a.site);
      return capResult(
        {
          total: list.length,
          docs: list.slice(0, 100).map((d) => ({ id: d.id, title: d.title, site: d.site || undefined, chars: d.size, updated: new Date(d.updatedAt).toISOString(), by: d.updatedBy }))
        },
        8000
      );
    } catch (err) {
      return JSON.stringify({ error: String(err.message || err) });
    }
  }

  async function toolReadDoc(args) {
    const a = args || {};
    try {
      const d = await findDoc(a);
      if (!d) return JSON.stringify({ error: "no such doc — list_docs shows what exists" });
      const offset = Math.max(0, a.offset || 0);
      const max = Math.min(Math.max(500, a.max_chars || 12000), 20000);
      return capResult({ id: d.id, title: d.title, site: d.site || undefined, total_chars: d.content.length, offset, content: d.content.slice(offset, offset + max), more: offset + max < d.content.length }, 24000);
    } catch (err) {
      return JSON.stringify({ error: String(err.message || err) });
    }
  }

  async function toolWriteDoc(args) {
    const a = args || {};
    try {
      const existing = a.id || (a.title && a.mode !== "create") ? await findDoc(a) : null;
      if (a.id && !existing) return JSON.stringify({ error: `no doc with id ${a.id}` });
      const mode = a.mode || "replace";
      let content = String(a.content || "");
      if (existing && mode === "append") content = existing.content.replace(/\s*$/, "") + "\n\n" + content;
      const doc = await api.rpc("docs.save", {
        by: "kimi",
        doc: { id: existing ? existing.id : undefined, title: a.title || (existing && existing.title) || "Findings", content, site: existing ? existing.site : siteOfPage() }
      });
      return JSON.stringify({ saved: true, id: doc.id, title: doc.title, chars: doc.content.length, created: !existing });
    } catch (err) {
      return JSON.stringify({ error: String(err.message || err) });
    }
  }

  async function toolEditDoc(args) {
    const a = args || {};
    try {
      const d = await findDoc(a);
      if (!d) return JSON.stringify({ error: "no such doc — list_docs shows what exists" });
      const edits = Array.isArray(a.edits) ? a.edits : a.find != null ? [{ find: a.find, replace: a.replace, all: a.all }] : [];
      if (!edits.length) return JSON.stringify({ error: "give edits: [{find, replace}]" });
      let content = d.content;
      const report = [];
      for (const e of edits) {
        const find = String(e.find || "");
        if (!find) return JSON.stringify({ error: "every edit needs non-empty find text" });
        const n = content.split(find).length - 1;
        if (!n) return JSON.stringify({ error: `text not found: "${find.slice(0, 80)}" — read_doc to see the current text`, applied: report });
        if (n > 1 && !e.all) return JSON.stringify({ error: `"${find.slice(0, 80)}" appears ${n} times — add more context, or set all: true`, applied: report });
        content = e.all ? content.split(find).join(String(e.replace || "")) : content.replace(find, () => String(e.replace || ""));
        report.push({ find: find.slice(0, 60), replaced: e.all ? n : 1 });
      }
      const doc = await api.rpc("docs.save", { by: "kimi", doc: { id: d.id, content, title: a.title || d.title } });
      return JSON.stringify({ saved: true, id: doc.id, title: doc.title, chars: doc.content.length, edits: report });
    } catch (err) {
      return JSON.stringify({ error: String(err.message || err) });
    }
  }

  async function toolDeleteDoc(args) {
    try {
      const d = await findDoc(args || {});
      if (!d) return JSON.stringify({ error: "no such doc" });
      await api.rpc("docs.delete", { id: d.id });
      return JSON.stringify({ deleted: true, title: d.title });
    } catch (err) {
      return JSON.stringify({ error: String(err.message || err) });
    }
  }

  async function toolDeleteFlow(args) {
    try {
      const ok = await api.rpc("flows.delete", { id: (args || {}).id });
      return JSON.stringify(ok ? { deleted: true } : { error: "no such flow" });
    } catch (err) {
      return JSON.stringify({ error: String(err.message || err) });
    }
  }

  /* ----------------------------------------------------------- approvals */

  // Hosts the page itself requested (not ones NetScope or Kimi sent to).
  function knownHosts() {
    const set = new Set();
    for (const e of entries()) {
      if (e.kind === "nav" || ((e.kind === "http" || e.wsId) && (!e.source || e.source === "page"))) {
        const h = hostOf(e.url);
        if (h) set.add(h);
      }
    }
    return set;
  }

  // Returns null when the action may run straight away, otherwise a
  // description for the approval card. policy: "writes" | "all" | "never".
  async function approvalFor(name, args, policy) {
    if (policy === "never") return null;
    const a = args || {};
    if (name === "http_request") {
      let req;
      try {
        req = buildRequest(a);
      } catch (_) {
        return null; // the tool will return the error itself
      }
      // A read to a host the page itself talks to is routine. A read to any
      // other host could carry captured secrets out in its URL (prompt
      // injection via a response body), so it needs a click too.
      let host = "";
      try {
        host = new URL(req.url).host;
      } catch (_) {}
      const known = knownHosts().has(host);
      if (policy === "writes" && !isWriteMethod(req.method) && known) return null;
      return {
        kind: "http",
        fromPage: a.context === "page",
        title: isWriteMethod(req.method)
          ? "Kimi wants to send a request that can change data"
          : known
            ? "Kimi wants to send a request"
            : `Kimi wants to call ${host || "a new host"}, which this page has not used`,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        fromId: a.from_id
      };
    }
    if (name === "save_flow") {
      let flow;
      try {
        flow = await resolveFlowArgs(a);
      } catch (_) {
        return null; // the tool will return the error itself
      }
      // Anything that will run without a click — a schedule, a page-request
      // trigger — or that can change data needs approval to be saved.
      const auto = flow.schedule.enabled || !!(flow.on_request && flow.on_request.enabled !== false);
      if (policy === "writes" && !auto && !flowHasWrites(flow.steps)) return null;
      const t = flow.on_request && flow.on_request.enabled !== false ? flow.on_request : null;
      return {
        kind: "flow",
        title: t
          ? `Kimi wants to save a flow that runs by itself when the page calls ${t.url_contains || t.method || "matching URLs"}`
          : flow.schedule.enabled
            ? `Kimi wants to save a flow that runs every ${flow.schedule.every_minutes} min`
            : "Kimi wants to save a flow",
        flow
      };
    }
    if (name === "run_flow") {
      let f = null;
      try {
        f = await api.rpc("flows.get", { id: a.id });
      } catch (_) {}
      if (!f) return null;
      if (policy === "writes" && !flowHasWrites(f.steps)) return null;
      return { kind: "flow-run", title: `Kimi wants to run the flow “${f.name}”`, flow: f };
    }
    if (name === "delete_doc") {
      let d = null;
      try {
        d = await findDoc(a);
      } catch (_) {}
      return { kind: "doc-delete", title: `Kimi wants to delete the doc “${d ? d.title : a.id || a.title}”` };
    }
    if (name === "delete_flow") {
      let f = null;
      try {
        f = await api.rpc("flows.get", { id: a.id });
      } catch (_) {}
      return { kind: "flow-delete", title: `Kimi wants to delete the flow “${f ? f.name : a.id}”`, flow: f };
    }
    return null;
  }

  /* ----------------------------------------------------------- schemas */

  const TOOLS = [
    {
      type: "function",
      function: {
        name: "get_capture_summary",
        description:
          "Live counts and shape of the whole capture: entry totals, hosts, status histogram, error counts. Cheap. Call it to orient yourself, or again later to see traffic that arrived during this conversation.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "list_endpoints",
        description:
          "Deduplicated overview of the API surface: HTTP requests grouped by method + host + normalized path (numeric, uuid and hash segments become :id/:uuid/:hash), plus one row per WebSocket connection. The right first call for any 'what does this app talk to' question, and far cheaper than listing every request.",
        parameters: {
          type: "object",
          properties: {
            host: { type: "string", description: "Only endpoints on this host." },
            include_static: {
              type: "boolean",
              description: "Include JS, CSS, images, fonts and media. Default false."
            },
            include_ws: { type: "boolean", description: "Include WebSocket connections. Default true." },
            sort: { type: "string", enum: ["count", "slowest", "largest", "errors"], description: "Default count." },
            limit: { type: "integer", description: "Max endpoints to return. Default 120, max 300." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_requests",
        description:
          "Filtered, sorted, paginated list of captured entries, one compact line each. Use it after list_endpoints to find specific requests. Returns no headers or bodies — drill down with get_request.",
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", description: "e.g. 'GET' or 'POST,PUT'." },
            status: { type: "string", description: "'2xx', '4xx', '404', '>=400', or '0' for network failure/pending." },
            url_contains: { type: "string" },
            host: { type: "string" },
            mime_contains: { type: "string" },
            resource_type: {
              type: "string",
              enum: ["api", "netscope", "ws"],
              description: "api = the page's fetch/XHR; netscope = requests sent from NetScope (by you, the user or a flow); ws = WebSocket."
            },
            kind: { type: "string", enum: ["http", "ws-frame", "ws-open", "ws-close", "nav"] },
            since_t: { type: "integer", description: "Milliseconds since capture start." },
            until_t: { type: "integer" },
            min_ms: { type: "integer" },
            min_bytes: { type: "integer" },
            sort: { type: "string", enum: ["time", "duration", "size"] },
            order: { type: "string", enum: ["asc", "desc"] },
            limit: { type: "integer", description: "Default 50, max 200." },
            offset: { type: "integer" }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_traffic",
        description:
          "Full-text or regex search across URLs, headers, request and response bodies, and WebSocket frames. Returns matching entry ids with a short snippet around the first hit — never a whole body. The fastest way to find where a value, id or error string came from.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            regex: { type: "boolean", description: "Treat query as a JavaScript regular expression. Default false." },
            case_sensitive: { type: "boolean" },
            scopes: {
              type: "array",
              items: { type: "string", enum: ["url", "req_headers", "req_body", "res_headers", "res_body", "ws"] },
              description: "Default: all scopes."
            },
            limit: { type: "integer", description: "Default 30, max 100." },
            context_chars: { type: "integer", description: "Snippet context each side. Default 120, max 400." }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_request",
        description:
          "Full detail for one entry by id. Headers are cheap; bodies are expensive and truncated, so prefer describe_json for large JSON. Use body_offset to page through a body you must read verbatim.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "integer" },
            include: {
              type: "array",
              items: { type: "string", enum: ["req_headers", "res_headers", "req_body", "res_body", "timing"] },
              description: "Default ['req_headers','res_headers']."
            },
            body_max: { type: "integer", description: "Body chars to return. Default 4000, max 20000." },
            body_offset: { type: "integer" }
          },
          required: ["id"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "describe_json",
        description:
          "Structural summary of a JSON body: key names, types, array lengths and one clipped sample element, without dumping the body. Use this instead of get_request res_body whenever the body is more than a few kB or you only need its shape.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "integer" },
            side: { type: "string", enum: ["request", "response"], description: "Default response. Ignored for WebSocket frames." },
            path: { type: "string", description: "Descend first, e.g. 'data.items[0]'." },
            max_depth: { type: "integer", description: "Default 4, max 8." },
            max_keys: { type: "integer", description: "Default 60, max 200." }
          },
          required: ["id"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_websocket_frames",
        description:
          "Frames for one WebSocket connection, in order, with clipped payloads. Identical consecutive payloads (heartbeats) collapse into a repeat count by default.",
        parameters: {
          type: "object",
          properties: {
            ws_id: { type: "string" },
            url_contains: { type: "string", description: "Use when you do not have a ws_id." },
            dir: { type: "string", enum: ["sent", "received", "both"] },
            contains: { type: "string", description: "Only frames whose payload contains this." },
            dedupe: { type: "boolean", description: "Collapse repeated identical frames. Default true." },
            payload_max: { type: "integer", description: "Default 400, max 4000." },
            limit: { type: "integer", description: "Default 40, max 100." },
            offset: { type: "integer" }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "compare_requests",
        description:
          "Diff two captured requests — headers, query parameters and JSON body — to explain why one succeeded and the other failed. Secret values stay redacted, but presence and length differences are reported.",
        parameters: {
          type: "object",
          properties: {
            id_a: { type: "integer" },
            id_b: { type: "integer" },
            include: { type: "array", items: { type: "string", enum: ["headers", "query", "body"] } }
          },
          required: ["id_a", "id_b"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "http_request",
        description:
          "Send an HTTP request, like Postman, and get the response. Give exactly one base: `curl` (a cURL command, e.g. one the user pasted), `from_id` (replay a captured request with the real headers the page set; the browser adds its own cookies), or `url`. Then optionally override method, url, query, headers (null removes one) or body. Runs from the extension, so CORS does not apply. The request is logged in the Traffic list. Requests that can change data may need the user's approval first.",
        parameters: {
          type: "object",
          properties: {
            curl: { type: "string", description: "A full cURL command." },
            from_id: { type: "integer", description: "Captured entry id to replay." },
            url: { type: "string" },
            method: { type: "string", description: "GET, POST, PUT, PATCH, DELETE …" },
            query: { type: "object", description: "Query parameters to set (null removes one)." },
            headers: { type: "object", description: "Headers to set or replace (null removes one)." },
            body: { description: "String, or a JSON value (sent as application/json)." },
            body_max: { type: "integer", description: "Response chars to return. Default 6000, max 20000." },
            timeout_ms: { type: "integer", description: "Default 30000, max 120000." },
            context: {
              type: "string",
              enum: ["extension", "page"],
              description:
                "extension (default): sent by NetScope, no CORS, with the browser's cookies for the site. page: sent from inside an open tab on that site, with the page's origin, first-party cookies and its own fetch wrappers — use it when the API (often a POST) rejects extension replays (WAF / anti-bot / CSRF / origin checks)."
            }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_curl",
        description: "A captured HTTP request as a cURL command (secrets masked if masking is on). Useful to show the user or as a base for a flow step.",
        parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "save_flow",
        description:
          "Create or update a flow: an automation from a simple chain of requests up to a bot with filters, loops, branches and memory. Runs on demand, on a schedule (every_minutes, in the background even with the page closed), and/or when the page makes a matching request (on_request). Pass `id` to update; omitted fields keep their current value. " +
          "STEPS (each has a unique id across the whole flow; any step may add when '<condition>' to skip itself and continue_on_error: true): " +
          "http {method, url, headers, body, query} | {curl} | {from_id} (copies a captured request's real headers locally), plus extract {var: 'body.data.token'} (paths into that step's response: status, headers.<lowercase>, body.<path>, text), expect_status '2xx' or '200,201', retry {times, delay_ms} (on network errors, 429, 5xx), timeout_ms; " +
          "ai {prompt, json: true for JSON output}; delay {ms}; set {vars: {name: value}, state: {name: value}} (state = memory kept between runs, e.g. the last id already handled); " +
          "filter {items, where, as='item', limit, save_as} keeps items where the condition holds, into vars.<save_as or id>; map {items, value, as, save_as} builds a new list; " +
          "for_each {items, as='item', steps: [...], max=100 (cap 1000), delay_ms, on_item_error 'stop'|'continue', collect {save_as, value}} runs steps per item; " +
          "repeat {steps: [...], until '<cond>' (checked after each pass) or while '<cond>' (before), max=10 (cap 500), delay_ms} for pagination and polling; " +
          "if {condition, then: [...], else: [...]}; stop {outcome 'ok'|'fail', message} ends the run; log {message} writes to the run log; run_flow {flow: '<flow id>', vars} runs another flow and exposes its vars as steps.<id>.body. " +
          "TEMPLATES in any string: {{vars.x}}, {{state.x}}, {{steps.<id>.status|body.<path>|headers.<name>|text}} (latest run of that step), {{item.x}} or the loop's `as` name, {{loop.index|number|count|first|last}}, {{trigger.body.<path>|url|method|status|headers.<name>|request_body}} (on_request runs), {{now}}, {{now_iso}}, {{today}}, {{uuid}}. " +
          "FILTERS: json, json_parse, urlencode, first, last, length/count, trim, upper, lower, default:x, number, string, not, round:n, abs, add:n, sub:n, mul:n, div:n, keys, values, get:path, pluck:field, where:field=value (also != > < >= <= ~), sort:field (sort:-field = descending), reverse, unique[:field], sum[:field], min[:field], max[:field], slice:a:b, join:\", \", split:x, replace:a:b, contains:x, date, timestamp. Quote an argument to keep spaces. A JSON value that is exactly one template keeps its type. " +
          "CONDITIONS: A == B, !=, >, <, >=, <=, contains, !contains, matches <regex>, exists, missing; combine with and / or; prefix not. " +
          "COLLECTIONS (results kept between runs): collect {collection: 'name', items, key: 'user_id', mode: 'append' (default; with key = only new keys) | 'upsert' (merge by key) | 'replace' | 'remove' | 'clear', flatten} — read back as {{collections.<name>}} (e.g. {{collections.profiles | count}}); get_collection reads them. " +
          "AT SCALE: repeat/for_each take collect {save_as, value, flatten: true, unique_by: 'user_id'} to merge page arrays without manual accumulation; for_each concurrency 1–10 runs items in parallel (each iteration has its own {{item}}/{{steps.*}}); http steps retry 429/503 three times by default honoring Retry-After, pausing every worker on that host; context: 'page' sends from an open tab on the site (for WAF / anti-bot / CSRF-protected endpoints). " +
          "LIMITS per run default 5000 step runs and 10 minutes; raise with limits {max_steps up to 100000, max_minutes up to 60, auto_resume: true}. Out of budget, a run PAUSES at a checkpoint (top-level repeat/for_each resume at the exact item) and, with auto_resume, continues by itself every ~30 s until done; run_flow {resume: true} continues manually. " +
          "Filters also include flatten[:n|deep], compact, chunk:n, group_by:f, index_by:f, count_by:f, merge, uniq. Prefer filter + for_each over many hand-written steps; use state or keyed collections to avoid acting on the same item twice.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Existing flow id to update." },
            name: { type: "string" },
            description: { type: "string" },
            steps: { type: "array", items: { type: "object" } },
            vars: { type: "object", description: "Initial variables, available as {{vars.name}}." },
            every_minutes: { type: "integer", description: "Run on a schedule every N minutes (60 = hourly). Omit for manual only." },
            schedule_enabled: { type: "boolean", description: "Set false to pause a schedule." },
            limits: {
              type: "object",
              description: "{max_steps (default 5000, max 100000), max_minutes (default 10, max 60), auto_resume (continue a paused run by itself)}."
            },
            on_request: {
              type: ["object", "null"],
              description:
                "Run automatically when the page itself makes a matching request: {url_contains, method, status ('2xx'), host (defaults to the current page's site; matches subdomains too), cooldown_seconds (default 30, min 5), enabled}. The response is available as {{trigger.body…}}. null removes the trigger."
            }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "validate_flow",
        description:
          "Check a flow without saving it: structure, every {{template}} (unknown filters, steps that don't exist or haven't run yet, loop names used outside their loop), URLs and cURL. Takes the same arguments as save_flow. Call it before save_flow and fix every error it lists.",
        parameters: { type: "object", properties: {}, additionalProperties: true }
      }
    },
    {
      type: "function",
      function: {
        name: "run_flow",
        description: "Run a saved flow now and get each step's status, extracted variables and output. Use it right after save_flow to verify.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            vars: { type: "object", description: "Override variables for this run." },
            resume: { type: "boolean", description: "Continue the flow's paused run from its checkpoint instead of starting over." },
            background: {
              type: "boolean",
              description:
                "Start it and return at once instead of waiting — for full-size jobs that take minutes. Verify on a small sample first (e.g. vars that cap pages or items)."
            }
          },
          required: ["id"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_flows",
        description: "All saved flows with schedule and last-run status.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "get_flow",
        description: "One flow's full definition (secrets masked if masking is on) and its three most recent runs.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "list_docs",
        description: "The developer's saved docs (Docs tab): markdown notes such as API maps, findings and how flows work. Check here before writing, and update the existing doc for a site instead of creating duplicates.",
        parameters: { type: "object", properties: { site: { type: "string", description: "Only docs for this host." } }, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "read_doc",
        description: "Read a doc by id or exact title, paginated.",
        parameters: {
          type: "object",
          properties: { id: { type: "string" }, title: { type: "string" }, offset: { type: "integer" }, max_chars: { type: "integer", description: "Default 12000, max 20000." } },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_doc",
        description:
          "Create or rewrite a markdown doc to keep findings for the developer (endpoints, auth, quirks, failures and their causes, flows built and how to run them). Pass id (or the exact title of an existing doc) to update it; mode replace (default) rewrites, append adds to the end. Use # headings, - bullets and ``` code fences.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
            mode: { type: "string", enum: ["replace", "append", "create"], description: "create always makes a new doc even if the title exists." }
          },
          required: ["content"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "edit_doc",
        description: "Change part of a doc without rewriting it: each edit replaces an exact piece of text (it must appear once unless all: true). read_doc first to copy the exact text.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            edits: {
              type: "array",
              items: {
                type: "object",
                properties: { find: { type: "string" }, replace: { type: "string" }, all: { type: "boolean" } },
                required: ["find", "replace"],
                additionalProperties: false
              }
            }
          },
          required: ["edits"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "delete_doc",
        description: "Delete a doc by id or exact title.",
        parameters: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } }, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "get_collection",
        description: "Read items from a flow's persistent collection (built by collect steps), paginated. Use fields to return only some keys.",
        parameters: {
          type: "object",
          properties: {
            flow_id: { type: "string" },
            name: { type: "string" },
            offset: { type: "integer" },
            limit: { type: "integer", description: "Default 50, max 200." },
            fields: { type: "array", items: { type: "string" }, description: "Key paths to keep, e.g. ['user_id','profile.followers']." }
          },
          required: ["flow_id", "name"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "delete_flow",
        description: "Delete a flow and its schedule. Always needs the user's approval.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }
      }
    }
  ];

  // validate_flow takes exactly save_flow's arguments.
  (() => {
    const save = TOOLS.find((t) => t.function.name === "save_flow");
    const val = TOOLS.find((t) => t.function.name === "validate_flow");
    if (save && val) val.function.parameters = JSON.parse(JSON.stringify(save.function.parameters));
  })();

  const EXEC = {
    get_capture_summary: toolCaptureSummary,
    list_endpoints: toolListEndpoints,
    list_requests: toolListRequests,
    search_traffic: toolSearchTraffic,
    get_request: toolGetRequest,
    describe_json: toolDescribeJson,
    get_websocket_frames: toolWebsocketFrames,
    compare_requests: toolCompareRequests,
    http_request: toolHttpRequest,
    get_curl: toolGetCurl,
    save_flow: toolSaveFlow,
    run_flow: toolRunFlow,
    list_flows: toolListFlows,
    get_flow: toolGetFlow,
    get_collection: toolGetCollection,
    validate_flow: toolValidateFlow,
    list_docs: toolListDocs,
    read_doc: toolReadDoc,
    write_doc: toolWriteDoc,
    edit_doc: toolEditDoc,
    delete_doc: toolDeleteDoc,
    delete_flow: toolDeleteFlow
  };

  // Tools whose results come from the network, not the capture: their output
  // does not count against the per-run capture budget.
  const UNBUDGETED = new Set([
    "http_request",
    "save_flow",
    "validate_flow",
    "run_flow",
    "list_flows",
    "get_flow",
    "get_collection",
    "delete_flow",
    "list_docs",
    "read_doc",
    "write_doc",
    "edit_doc",
    "delete_doc"
  ]);

  // Never throws. Every failure becomes a tool result the model can react to,
  // because an exception here would abort the whole run.
  async function runTool(name, args, run) {
    if (run && run.spent > TOTAL_BUDGET && !UNBUDGETED.has(name)) {
      return JSON.stringify({ error: "tool budget exhausted for this run — answer with what you have" });
    }
    const fn = EXEC[name];
    if (!fn) {
      return JSON.stringify({
        error: `unknown tool "${name}"`,
        available: Object.keys(EXEC)
      });
    }
    let out;
    try {
      out = await fn(args || {});
    } catch (err) {
      out = JSON.stringify({ error: String((err && err.message) || err).slice(0, 300) });
    }
    if (typeof out !== "string") out = JSON.stringify(out);
    if (run && !UNBUDGETED.has(name)) run.spent = (run.spent || 0) + out.length;
    return out;
  }

  return {
    TOOLS,
    runTool,
    approvalFor,
    buildRequest,
    isWriteMethod,
    attach,
    setRedaction,
    entryById,
    endpointsData,
    describeJsonData,
    redactHeaders,
    scrubText,
    clipUrl,
    relT,
    inspectedPage,
    TOTAL_BUDGET
  };
})();
