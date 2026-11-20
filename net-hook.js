/* NetScope – net-hook.js
 * Runs in the page's MAIN world at document_start, before any page script.
 *
 * Mirrors the page's own API traffic to the isolated-world bridge (content.js)
 * via window.postMessage:
 *   fetch()          request, response headers, streamed body (throttled)
 *   XMLHttpRequest   request, response headers, body
 *   WebSocket        every sent / received frame, open, close
 *
 * Native behaviour is untouched: wrappers are Proxies (so toString() still
 * reports native code), the page gets the original Response object, and body
 * capture reads a clone that is cancelled once the size cap is reached.
 * Requests the browser makes on its own (documents, images, scripts) are not
 * seen here — this is an API-traffic tool.
 *
 * It also mirrors the page's console (every level, with the calling source
 * line), uncaught errors and promise rejections, failed resource loads, CSP
 * violations and SPA route changes, in batches (type "console").
 */
(() => {
  "use strict";

  if (window.__netscopeHooked) return;
  try {
    Object.defineProperty(window, "__netscopeHooked", { value: true });
  } catch (_) {
    window.__netscopeHooked = true;
  }

  const MAX_BODY = 262144; // 256 KB of text per body / frame
  const STREAM_PUSH_MS = 350; // throttle for progressive body updates
  const TEXTY = /json|text|xml|javascript|ecmascript|html|urlencoded|csv|svg|yaml|graphql|event-stream|ndjson|x-www-form/i;

  const frameTag = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const nextId = (p) => p + frameTag + "-" + ++seq;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const post = (msg) => {
    try {
      window.postMessage({ __netscope__: 1, ...msg }, "*");
    } catch (_) {
      /* payload not cloneable – ignore */
    }
  };

  const clip = (s) =>
    s.length > MAX_BODY ? { text: s.slice(0, MAX_BODY), truncated: true } : { text: s, truncated: false };

  const absUrl = (u) => {
    try {
      return new URL(String(u), location.href).href;
    } catch (_) {
      return String(u);
    }
  };

  const headerList = (h) => {
    const out = [];
    if (!h) return out;
    try {
      if (typeof h.forEach === "function" && !Array.isArray(h)) {
        h.forEach((value, name) => out.push({ name, value: String(value) }));
      } else if (Array.isArray(h)) {
        for (const pair of h) if (pair && pair.length >= 2) out.push({ name: String(pair[0]), value: String(pair[1]) });
      } else if (typeof h === "object") {
        for (const k of Object.keys(h)) out.push({ name: k, value: String(h[k]) });
      }
    } catch (_) {}
    return out;
  };

  const decodeBytes = (buf) => {
    try {
      return { kind: "text", ...clip(new TextDecoder("utf-8", { fatal: true }).decode(buf)) };
    } catch (_) {
      const len = buf.byteLength;
      const view = new Uint8Array(buf, 0, Math.min(len, 96));
      const hex = Array.from(view, (b) => b.toString(16).padStart(2, "0")).join(" ");
      return { kind: "binary", text: `<binary ${len} B> ${hex}${len > 96 ? " …" : ""}`, truncated: len > 96 };
    }
  };

  // Request bodies. Returns synchronously when it can, otherwise a Promise.
  function describeBody(body) {
    if (body == null) return { text: "", truncated: false };
    if (typeof body === "string") return clip(body);
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return clip(body.toString());
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const lines = [];
      try {
        body.forEach((v, k) => {
          if (typeof v === "string") lines.push(`${k}=${v}`);
          else lines.push(`${k}=<file ${v.name || "blob"} ${v.size || 0} B>`);
        });
      } catch (_) {}
      return clip("<multipart/form-data>\n" + lines.join("\n"));
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      if (body.size <= MAX_BODY && (!body.type || TEXTY.test(body.type))) {
        return body.text().then(clip, () => ({ text: `<blob ${body.size} B>`, truncated: false }));
      }
      return { text: `<blob ${body.type || "binary"} ${body.size} B>`, truncated: false };
    }
    if (body instanceof ArrayBuffer) return decodeBytes(body);
    if (ArrayBuffer.isView(body)) {
      return decodeBytes(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    }
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
      return { text: "<stream body>", truncated: false };
    }
    return clip(String(body));
  }

  /* --------------------------------------------------------------- fetch */

  async function readBody(id, res, t0) {
    const mime = res.headers.get("content-type") || "";
    const len = Number(res.headers.get("content-length")) || 0;
    if (res.type === "opaque" || res.type === "opaqueredirect") {
      post({ type: "http-body", id, text: "", done: true, opaque: true, size: 0, durationMs: now() - t0 });
      return;
    }
    if (!res.body || (mime && !TEXTY.test(mime))) {
      try {
        if (res.body) res.body.cancel().catch(() => {});
      } catch (_) {}
      post({ type: "http-body", id, text: "", binary: !!res.body && !!mime, done: true, size: len, durationMs: now() - t0 });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let text = "";
    let bytes = 0;
    let truncated = false;
    let lastPush = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (!truncated) {
          text += decoder.decode(value, { stream: true });
          if (text.length > MAX_BODY) {
            text = text.slice(0, MAX_BODY);
            truncated = true;
            reader.cancel().catch(() => {}); // cancels only our tee branch
            break;
          }
        }
        const t = now();
        if (t - lastPush > STREAM_PUSH_MS) {
          lastPush = t;
          post({ type: "http-body", id, text, truncated, done: false, size: bytes });
        }
      }
      if (!truncated) text += decoder.decode();
    } catch (err) {
      post({
        type: "http-body",
        id,
        text,
        truncated,
        done: true,
        size: bytes,
        durationMs: now() - t0,
        error: String((err && err.message) || err).slice(0, 200)
      });
      return;
    }
    post({ type: "http-body", id, text, truncated, done: true, size: Math.max(bytes, len), durationMs: now() - t0 });
  }

  // Requests NetScope sends *from* the page ("send from the page" replays)
  // are tagged by their init object and are not page traffic: skip them, so
  // they are neither logged twice nor able to fire page-request triggers.
  // Page scripts that wrap fetch (anti-bot sensors, SDKs) often copy the
  // init object, so a replay is also matched once by method + URL within 3 s.
  const own = new WeakSet();
  const pending = [];
  const markOwn = (init, url, method) => {
    if (init && typeof init === "object") own.add(init);
    pending.push({ url: absUrl(url), method: String(method || "GET").toUpperCase(), until: Date.now() + 3000 });
  };
  const isOwn = (init, url, method) => {
    if (init && typeof init === "object" && own.has(init)) return true;
    const now = Date.now();
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (p.until < now) pending.splice(i, 1);
      else if (p.url === url && p.method === method) {
        pending.splice(i, 1);
        return true;
      }
    }
    return false;
  };
  try {
    Object.defineProperty(window, "__netscopeOwn", { value: markOwn });
  } catch (_) {}

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = new Proxy(nativeFetch, {
      apply(target, thisArg, args) {
        const [input, init] = args;
        try {
          const isReq0 = typeof Request !== "undefined" && input instanceof Request;
          const u0 = absUrl(isReq0 ? input.url : input);
          const m0 = String((init && init.method) || (isReq0 ? input.method : "GET")).toUpperCase();
          if (isOwn(init, u0, m0)) return Reflect.apply(target, thisArg, args);
        } catch (_) {}
        let id = null;
        let started = null;
        const t0 = now();
        try {
          const isReq = typeof Request !== "undefined" && input instanceof Request;
          const url = absUrl(isReq ? input.url : input);
          const method = String((init && init.method) || (isReq ? input.method : "GET")).toUpperCase();
          const headers = headerList((init && init.headers) || (isReq ? input.headers : null));
          id = nextId("f");

          let body = { text: "", truncated: false };
          if (init && init.body != null) body = describeBody(init.body);
          else if (isReq && method !== "GET" && method !== "HEAD" && !input.bodyUsed) {
            try {
              body = input.clone().text().then(clip, () => ({ text: "", truncated: false }));
            } catch (_) {}
          }

          const send = (b) =>
            post({
              type: "http-start",
              id,
              api: "fetch",
              method,
              url,
              reqHeaders: headers,
              reqBody: b.text,
              reqBodyTruncated: !!b.truncated,
              ts: Date.now()
            });
          started = body && typeof body.then === "function" ? body.then(send) : (send(body), Promise.resolve());
        } catch (_) {
          id = null;
        }

        const p = Reflect.apply(target, thisArg, args);
        if (!id) return p;

        p.then(
          (res) => {
            // Clone now, in the first reaction to settle: the page's own
            // .then(r => r.json()) runs right after this one, and once it
            // reads the body a clone is no longer possible.
            let copy = null;
            try {
              copy = res.clone();
            } catch (_) {}
            started.then(() => {
              try {
                post({
                  type: "http-res",
                  id,
                  status: res.status,
                  statusText: res.statusText || "",
                  resHeaders: headerList(res.headers),
                  mime: res.headers.get("content-type") || "",
                  url: res.url || "",
                  redirected: !!res.redirected,
                  ttfbMs: now() - t0
                });
                if (copy) readBody(id, copy, t0);
                else post({ type: "http-body", id, text: "", done: true, durationMs: now() - t0, error: "body was already read by the page" });
              } catch (_) {}
            });
          },
          (err) => {
            started.then(() =>
              post({
                type: "http-body",
                id,
                text: "",
                done: true,
                failed: true,
                error: String((err && err.message) || err).slice(0, 200),
                durationMs: now() - t0
              })
            );
          }
        );
        return p;
      }
    });
  }

  /* ----------------------------------------------------- XMLHttpRequest */

  const XHR = window.XMLHttpRequest;
  if (typeof XHR === "function" && XHR.prototype) {
    const meta = new WeakMap();
    const proto = XHR.prototype;

    proto.open = new Proxy(proto.open, {
      apply(target, xhr, args) {
        try {
          meta.set(xhr, { method: String(args[0] || "GET").toUpperCase(), url: absUrl(args[1]), headers: [] });
        } catch (_) {}
        return Reflect.apply(target, xhr, args);
      }
    });

    proto.setRequestHeader = new Proxy(proto.setRequestHeader, {
      apply(target, xhr, args) {
        try {
          const m = meta.get(xhr);
          if (m) m.headers.push({ name: String(args[0]), value: String(args[1]) });
        } catch (_) {}
        return Reflect.apply(target, xhr, args);
      }
    });

    proto.send = new Proxy(proto.send, {
      apply(target, xhr, args) {
        const m = meta.get(xhr);
        if (m && !m.id) {
          try {
            m.id = nextId("x");
            const t0 = now();
            const id = m.id;
            const fire = (b) =>
              post({
                type: "http-start",
                id,
                api: "xhr",
                method: m.method,
                url: m.url,
                reqHeaders: m.headers,
                reqBody: b.text,
                reqBodyTruncated: !!b.truncated,
                ts: Date.now()
              });
            const b = describeBody(args[0]);
            const started = b && typeof b.then === "function" ? b.then(fire) : (fire(b), Promise.resolve());

            xhr.addEventListener("loadend", () => {
              started.then(() => {
                try {
                  const raw = xhr.getAllResponseHeaders() || "";
                  const resHeaders = raw
                    .trim()
                    .split(/[\r\n]+/)
                    .filter(Boolean)
                    .map((line) => {
                      const i = line.indexOf(":");
                      return { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
                    });
                  const mime = xhr.getResponseHeader("content-type") || "";
                  post({
                    type: "http-res",
                    id,
                    status: xhr.status,
                    statusText: xhr.statusText || "",
                    resHeaders,
                    mime,
                    url: xhr.responseURL || "",
                    ttfbMs: now() - t0
                  });

                  let text = "";
                  let binary = false;
                  const rt = xhr.responseType;
                  if (rt === "" || rt === "text") text = xhr.responseText || "";
                  else if (rt === "json") {
                    try {
                      text = xhr.response == null ? "" : JSON.stringify(xhr.response);
                    } catch (_) {}
                  } else if (rt === "document") {
                    const d = xhr.responseXML;
                    text = d && d.documentElement ? d.documentElement.outerHTML : "";
                  } else binary = true;

                  const c = clip(text);
                  post({
                    type: "http-body",
                    id,
                    text: c.text,
                    truncated: c.truncated,
                    binary,
                    done: true,
                    failed: xhr.status === 0,
                    error: xhr.status === 0 ? "network error, CORS, abort or timeout" : undefined,
                    size: Number(xhr.getResponseHeader("content-length")) || text.length,
                    durationMs: now() - t0
                  });
                } catch (_) {}
              });
            });
          } catch (_) {}
        }
        return Reflect.apply(target, xhr, args);
      }
    });
  }

  /* ----------------------------------------------------------- WebSocket */

  const describeFrame = (data, cb) => {
    if (typeof data === "string") return cb({ kind: "text", ...clip(data) });
    if (data instanceof ArrayBuffer) return cb(decodeBytes(data));
    if (ArrayBuffer.isView(data)) {
      return cb(decodeBytes(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      data
        .arrayBuffer()
        .then((buf) => cb(decodeBytes(buf)))
        .catch(() => cb({ kind: "blob", text: `<blob ${data.size} B>`, truncated: false }));
      return;
    }
    cb({ kind: "unknown", text: String(data), truncated: false });
  };

  const instrument = (ws, url) => {
    const id = nextId("ws");
    post({ type: "ws-open", id, url, ts: Date.now() });

    const origSend = ws.send;
    ws.send = function (data) {
      try {
        describeFrame(data, (p) => post({ type: "ws-frame", id, url, dir: "sent", ts: Date.now(), ...p }));
      } catch (_) {}
      return origSend.call(this, data);
    };

    ws.addEventListener("message", (ev) => {
      try {
        describeFrame(ev.data, (p) => post({ type: "ws-frame", id, url, dir: "received", ts: Date.now(), ...p }));
      } catch (_) {}
    });
    ws.addEventListener("close", (ev) => {
      post({ type: "ws-close", id, url, ts: Date.now(), code: ev.code, reason: ev.reason || "" });
    });
    ws.addEventListener("error", () => post({ type: "ws-error", id, url, ts: Date.now() }));
  };

  const NativeWS = window.WebSocket;
  if (typeof NativeWS === "function") {
    window.WebSocket = new Proxy(NativeWS, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget);
        try {
          instrument(ws, ws.url || String(args[0] ?? ""));
        } catch (_) {}
        return ws;
      }
    });
  }
  /* ------------------------------------------------------------ console */

  // Console calls are passed through unchanged (Chrome DevTools ignore-lists
  // extension scripts, so it still shows the page's own call site). A copy is
  // serialized right away — objects change later — without running getters,
  // rate-limited per frame and sent in batches. Timers are the native ones
  // saved now, before frameworks like zone.js patch them.
  (() => {
    const RATE = 120; // messages per second per frame; beyond that only a count is kept
    const MAX_TEXT = 4000;
    const MAX_STACK = 3000;
    const nativeSetTimeout = window.setTimeout.bind(window);
    let buf = [];
    let timer = 0;
    let windowStart = 0;
    let inWindow = 0;
    let dropped = 0;
    let busy = false;

    const flush = () => {
      timer = 0;
      if (!buf.length) return;
      const items = buf;
      buf = [];
      post({ type: "console", frame: location.href, items });
    };
    // Counts one message against the per-second budget; false = over it (only counted).
    const admit = () => {
      const t = Date.now();
      if (t - windowStart > 1000) {
        if (dropped) buf.push({ level: "warn", kind: "netscope", text: `${dropped} more console messages within one second were not captured (rate limit)`, ts: t });
        windowStart = t;
        inWindow = 0;
        dropped = 0;
      }
      if (++inWindow > RATE) {
        dropped++;
        return false;
      }
      return true;
    };
    const push = (item, admitted) => {
      if (!admitted && !admit()) return;
      const t = Date.now();
      item.ts = t;
      if (item.text && item.text.length > MAX_TEXT) item.text = item.text.slice(0, MAX_TEXT) + " …";
      buf.push(item);
      if (buf.length >= 40) flush();
      else if (!timer) timer = nativeSetTimeout(flush, 250);
    };

    const ctorName = (v) => {
      try {
        const p = Object.getPrototypeOf(v);
        return p && p.constructor && p.constructor.name;
      } catch (_) {
        return "";
      }
    };
    const nodeText = (n) => {
      try {
        if (n.nodeType !== 1) return n.nodeName.toLowerCase();
        let s = "<" + n.tagName.toLowerCase();
        if (n.id) s += "#" + n.id;
        if (typeof n.className === "string" && n.className.trim()) s += "." + n.className.trim().split(/\s+/).slice(0, 3).join(".");
        return s + ">";
      } catch (_) {
        return "<node>";
      }
    };
    // DevTools-like one-line preview. Getters are never run (they could have side effects).
    const fmt = (v, d, seen) => {
      const t = typeof v;
      if (v === null) return "null";
      if (t === "undefined") return "undefined";
      if (t === "string") return d === 0 ? v : JSON.stringify(v.length > 300 ? v.slice(0, 300) + "…" : v);
      if (t === "number" || t === "boolean") return String(v);
      if (t === "bigint") return String(v) + "n";
      if (t === "symbol") return String(v);
      if (t === "function") return "ƒ " + (v.name || "anonymous") + "()";
      try {
        if (v instanceof Error) return (v.name || "Error") + ": " + v.message;
        if (typeof Node !== "undefined" && v instanceof Node) return nodeText(v);
        if (v instanceof Date) return isNaN(v) ? "Invalid Date" : v.toISOString();
        if (v instanceof RegExp) return String(v);
        if (typeof Window !== "undefined" && v instanceof Window) return "Window";
      } catch (_) {}
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      try {
        if (Array.isArray(v)) {
          if (d >= 3) return `Array(${v.length})`;
          const items = v.slice(0, 20).map((x) => fmt(x, d + 1, seen));
          return "[" + items.join(", ") + (v.length > 20 ? `, … ${v.length - 20} more` : "") + "]";
        }
        if (v instanceof Map) return `Map(${v.size})` + (d >= 3 ? "" : " {" + Array.from(v).slice(0, 10).map(([k, x]) => fmt(k, d + 1, seen) + " => " + fmt(x, d + 1, seen)).join(", ") + (v.size > 10 ? ", …" : "") + "}");
        if (v instanceof Set) return `Set(${v.size})` + (d >= 3 ? "" : " {" + Array.from(v).slice(0, 10).map((x) => fmt(x, d + 1, seen)).join(", ") + (v.size > 10 ? ", …" : "") + "}");
        if (ArrayBuffer.isView(v)) return `${ctorName(v) || "TypedArray"}(${v.length})`;
        const name = ctorName(v);
        const keys = Object.keys(v);
        if (d >= 3) return (name && name !== "Object" ? name + " " : "") + `{…${keys.length} keys}`;
        const parts = keys.slice(0, 25).map((k) => {
          const desc = Object.getOwnPropertyDescriptor(v, k);
          return k + ": " + (desc && "value" in desc ? fmt(desc.value, d + 1, seen) : "(getter)");
        });
        return (name && name !== "Object" ? name + " " : "") + "{" + parts.join(", ") + (keys.length > 25 ? `, … ${keys.length - 25} more` : "") + "}";
      } catch (_) {
        return "{…}";
      }
    };
    const preview = (v) => {
      const s = fmt(v, 0, new WeakSet());
      return s.length > 2000 ? s.slice(0, 2000) + "…" : s;
    };

    // console.log("%s has %d items", a, b) substitution; %c styles are dropped.
    const format = (args) => {
      const rest = Array.from(args);
      let head = "";
      if (typeof rest[0] === "string" && /%[sdifoOc]/.test(rest[0])) {
        const f = rest.shift();
        head = f.replace(/%([sdifoOc%])/g, (m, c) => {
          if (c === "%") return "%";
          if (!rest.length) return m;
          const a = rest.shift();
          if (c === "c") return "";
          if (c === "d" || c === "i") return String(parseInt(a, 10));
          if (c === "f") return String(parseFloat(a));
          if (c === "s") return typeof a === "string" ? a : preview(a);
          return preview(a);
        });
      }
      const tail = rest.map(preview).join(" ");
      return head && tail ? head + " " + tail : head || tail;
    };

    // Stack frames outside this extension: the first one is the call site.
    const frames = (stack) =>
      String(stack || "")
        .split("\n")
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("at ") && !l.includes("chrome-extension://"));
    const siteOf = (line) => {
      const m = /\(?((?:https?|file|blob|webpack|chrome):\/\/[^\s)]+?|[^\s()]+\.(?:js|mjs|ts|tsx|jsx|vue|svelte)[^\s)]*?):(\d+):(\d+)\)?$/.exec(line || "");
      return m ? `${m[1]}:${m[2]}:${m[3]}` : "";
    };
    const stackOf = (err) => {
      try {
        const st = err && err.stack ? String(err.stack) : "";
        return st.length > MAX_STACK ? st.slice(0, MAX_STACK) + "…" : st;
      } catch (_) {
        return "";
      }
    };

    const LEVEL = { log: "log", info: "info", warn: "warn", error: "error", debug: "debug", trace: "trace", dir: "log", table: "log", assert: "error" };
    const capture = (name, args) => {
      if (name === "assert") {
        if (args[0]) return;
        args = ["Assertion failed:"].concat(Array.from(args).slice(1));
      }
      // Over the budget: count it and skip the formatting and stack work.
      if (!admit()) return;
      const level = LEVEL[name];
      const fr = frames(new Error().stack);
      const item = { level, kind: name === "table" ? "table" : name === "assert" ? "assert" : "console", text: format(args), source: siteOf(fr[0]) };
      if (level === "error" || level === "warn" || level === "trace") {
        const err = Array.from(args).find((a) => a instanceof Error);
        item.stack = err ? stackOf(err) : fr.slice(0, 12).join("\n");
      }
      push(item, true);
    };

    const con = window.console;
    if (con) {
      for (const name of Object.keys(LEVEL)) {
        const orig = con[name];
        if (typeof orig !== "function") continue;
        try {
          con[name] = new Proxy(orig, {
            apply(target, self, args) {
              if (!busy) {
                busy = true;
                try {
                  capture(name, args);
                } catch (_) {}
                busy = false;
              }
              return Reflect.apply(target, self, args);
            }
          });
        } catch (_) {}
      }
    }

    // Uncaught errors, and (capture phase) resources that failed to load.
    window.addEventListener(
      "error",
      (ev) => {
        try {
          const el = ev.target;
          if (el && el !== window && el.tagName) {
            const url = el.currentSrc || el.src || el.href || "";
            push({ level: "error", kind: "resource", text: `Failed to load <${el.tagName.toLowerCase()}> ${url}`.trim(), source: url });
            return;
          }
          const where = ev.filename ? `${ev.filename}:${ev.lineno || 0}:${ev.colno || 0}` : "";
          push({ level: "error", kind: "exception", text: "Uncaught " + (ev.error ? fmt(ev.error, 0, new WeakSet()) : ev.message || "error"), source: where, stack: stackOf(ev.error) });
        } catch (_) {}
      },
      true
    );
    window.addEventListener("unhandledrejection", (ev) => {
      try {
        const r = ev.reason;
        push({ level: "error", kind: "rejection", text: "Unhandled promise rejection: " + (r instanceof Error ? (r.name || "Error") + ": " + r.message : preview(r)), stack: stackOf(r) });
      } catch (_) {}
    });
    try {
      document.addEventListener("securitypolicyviolation", (ev) => {
        push({
          level: "error",
          kind: "csp",
          text: `Content Security Policy blocked ${ev.blockedURI || "inline code"} (${ev.effectiveDirective || ev.violatedDirective})`,
          source: ev.sourceFile ? `${ev.sourceFile}:${ev.lineNumber || 0}:${ev.columnNumber || 0}` : ""
        });
      });
    } catch (_) {}

    // Single-page-app navigation: every distinct URL the app routes to.
    let lastUrl = location.href;
    const routed = (how) => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      push({ level: "route", kind: how, text: location.href });
    };
    for (const m of ["pushState", "replaceState"]) {
      try {
        history[m] = new Proxy(history[m], {
          apply(target, self, args) {
            const r = Reflect.apply(target, self, args);
            try {
              routed(m);
            } catch (_) {}
            return r;
          }
        });
      } catch (_) {}
    }
    window.addEventListener("popstate", () => routed("popstate"));
    window.addEventListener("hashchange", () => routed("hashchange"));
    window.addEventListener("pagehide", flush);
  })();

})();
