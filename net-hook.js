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
})();
