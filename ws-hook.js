/* NetScope – ws-hook.js
 * Runs in the page's MAIN world at document_start.
 * Wraps window.WebSocket so every frame (sent and received) is mirrored to the
 * isolated-world bridge via window.postMessage. The native socket behaviour is
 * untouched: send() is forwarded verbatim and message events still reach the page.
 */
(() => {
  "use strict";

  if (window.__netscopeHooked) return;
  try {
    Object.defineProperty(window, "__netscopeHooked", { value: true });
  } catch (_) {
    window.__netscopeHooked = true;
  }

  const Native = window.WebSocket;
  if (typeof Native !== "function") return;

  let seq = 0;
  const MAX_PAYLOAD = 262144; // keep at most 256 KB of text per frame

  const post = (msg) => {
    try {
      window.postMessage({ __netscope__: 1, ...msg }, "*");
    } catch (_) {
      /* payload not cloneable – ignore */
    }
  };

  const clip = (s) =>
    s.length > MAX_PAYLOAD
      ? { text: s.slice(0, MAX_PAYLOAD), truncated: true }
      : { text: s, truncated: false };

  const decodeBuf = (buf) => {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      return { kind: "text", ...clip(text) };
    } catch (_) {
      const view = new Uint8Array(buf, 0, Math.min(buf.byteLength, 96));
      const hex = Array.from(view, (b) => b.toString(16).padStart(2, "0")).join(" ");
      return {
        kind: "binary",
        text: `<binary ${buf.byteLength} B> ${hex}${buf.byteLength > 96 ? " …" : ""}`,
        truncated: buf.byteLength > 96
      };
    }
  };

  const describe = (data, cb) => {
    if (typeof data === "string") return cb({ kind: "text", ...clip(data) });
    if (data instanceof ArrayBuffer) return cb(decodeBuf(data));
    if (ArrayBuffer.isView(data)) {
      return cb(decodeBuf(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      data
        .arrayBuffer()
        .then((buf) => cb(decodeBuf(buf)))
        .catch(() => cb({ kind: "blob", text: `<blob ${data.size} B>`, truncated: false }));
      return;
    }
    cb({ kind: "unknown", text: String(data), truncated: false });
  };

  const instrument = (ws, url) => {
    const id = "ws" + Date.now().toString(36) + "-" + ++seq;
    post({ type: "ws-open", id, url, ts: Date.now() });

    const origSend = ws.send;
    ws.send = function (data) {
      try {
        describe(data, (p) => post({ type: "ws-frame", id, url, dir: "sent", ts: Date.now(), ...p }));
      } catch (_) {}
      return origSend.call(this, data);
    };

    ws.addEventListener("message", (ev) => {
      try {
        describe(ev.data, (p) =>
          post({ type: "ws-frame", id, url, dir: "received", ts: Date.now(), ...p })
        );
      } catch (_) {}
    });

    ws.addEventListener("close", (ev) => {
      post({ type: "ws-close", id, url, ts: Date.now(), code: ev.code, reason: ev.reason || "" });
    });

    ws.addEventListener("error", () => {
      post({ type: "ws-error", id, url, ts: Date.now() });
    });
  };

  window.WebSocket = new Proxy(Native, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget);
      try {
        instrument(ws, ws.url || String(args[0] ?? ""));
      } catch (_) {}
      return ws;
    }
  });
})();
