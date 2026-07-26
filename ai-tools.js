/* NetScope – ai-tools.js
 * The tools the AI assistant uses to query the capture, plus the redaction
 * layer every one of them routes through.
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
  const TOTAL_BUDGET = 120000; // cumulative tool-output chars per run
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

  function isStatic(e) {
    const b = typeof typeBucket === "function" ? typeBucket(e) : "other";
    return b === "js" || b === "media";
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
            resource_type: { type: "string", enum: ["xhr", "doc", "js", "media", "ws", "other"] },
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
    }
  ];

  const EXEC = {
    get_capture_summary: toolCaptureSummary,
    list_endpoints: toolListEndpoints,
    list_requests: toolListRequests,
    search_traffic: toolSearchTraffic,
    get_request: toolGetRequest,
    describe_json: toolDescribeJson,
    get_websocket_frames: toolWebsocketFrames,
    compare_requests: toolCompareRequests
  };

  // Never throws. Every failure becomes a tool result the model can react to,
  // because an exception here would abort the whole run.
  async function runTool(name, args, run) {
    if (run && run.spent > TOTAL_BUDGET) {
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
    if (run) run.spent = (run.spent || 0) + out.length;
    return out;
  }

  return {
    TOOLS,
    runTool,
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
