/* NetScope – curl.js
 * cURL ⇄ request conversion, shared by the app (AI tools, Traffic tab) and the
 * background worker (request runner, flows). No DOM, no chrome.* — pure data.
 *
 * parse() understands what people actually paste: Chrome/Firefox "Copy as
 * cURL (bash)", Postman exports, hand-written commands. Shell quoting ('…',
 * "…", $'…', backslash escapes and line continuations) is handled; flags that
 * only affect curl's own output (-s, -v, -k, --compressed, -L …) are accepted
 * and ignored because fetch() already behaves that way.
 */
"use strict";

globalThis.__netscopeCurl = (() => {
  function tokenize(src) {
    const s = String(src || "")
      .replace(/\\\r?\n/g, " ") // line continuations
      .replace(/\^\r?\n/g, " "); // cmd.exe continuations
    const out = [];
    let i = 0;
    const n = s.length;

    while (i < n) {
      while (i < n && /\s/.test(s[i])) i++;
      if (i >= n) break;
      let tok = "";
      let any = false;
      while (i < n && !/\s/.test(s[i])) {
        const c = s[i];
        any = true;
        if (c === "'") {
          const end = s.indexOf("'", i + 1);
          if (end === -1) throw new Error("unterminated ' quote");
          tok += s.slice(i + 1, end);
          i = end + 1;
        } else if (c === "$" && s[i + 1] === "'") {
          i += 2;
          while (i < n && s[i] !== "'") {
            if (s[i] === "\\" && i + 1 < n) {
              const e = s[i + 1];
              const map = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "0": "\0", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v" };
              if (e === "x") {
                const hex = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 2));
                if (hex) {
                  tok += String.fromCharCode(parseInt(hex[0], 16));
                  i += 2 + hex[0].length;
                  continue;
                }
              }
              if (e === "u") {
                const hex = /^[0-9a-fA-F]{4}/.exec(s.slice(i + 2));
                if (hex) {
                  tok += String.fromCharCode(parseInt(hex[0], 16));
                  i += 6;
                  continue;
                }
              }
              tok += e in map ? map[e] : e;
              i += 2;
            } else tok += s[i++];
          }
          if (i >= n) throw new Error("unterminated $' quote");
          i++;
        } else if (c === '"') {
          i++;
          while (i < n && s[i] !== '"') {
            if (s[i] === "\\" && i + 1 < n && /["\\$`\n]/.test(s[i + 1])) {
              tok += s[i + 1];
              i += 2;
            } else tok += s[i++];
          }
          if (i >= n) throw new Error('unterminated " quote');
          i++;
        } else if (c === "\\" && i + 1 < n) {
          tok += s[i + 1];
          i += 2;
        } else {
          tok += c;
          i++;
        }
      }
      if (any) out.push(tok);
    }
    return out;
  }

  const IGNORED = new Set([
    "-s", "--silent", "-S", "--show-error", "-v", "--verbose", "-k", "--insecure", "-L", "--location",
    "--compressed", "-i", "--include", "-g", "--globoff", "--http1.1", "--http2", "--http2-prior-knowledge",
    "--http3", "-N", "--no-buffer", "-f", "--fail", "--fail-with-body", "-#", "--progress-bar", "--raw",
    "--tr-encoding", "--path-as-is", "-Z", "--parallel", "--no-keepalive", "--tcp-nodelay", "-q"
  ]);
  const IGNORED_WITH_ARG = new Set([
    "-o", "--output", "-m", "--max-time", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time",
    "-w", "--write-out", "--proxy", "-x", "--cacert", "--cert", "--key", "-E", "--resolve", "--interface",
    "--limit-rate", "-c", "--cookie-jar", "-D", "--dump-header", "--max-redirs", "-T", "--upload-file",
    "--trace", "--trace-ascii", "--unix-socket", "--connect-to", "--ciphers", "--tls-max", "--proto"
  ]);

  function parse(command) {
    const toks = tokenize(command);
    if (!toks.length) throw new Error("empty command");
    let i = 0;
    if (/^curl(\.exe)?$/i.test(toks[0])) i = 1;

    let url = "";
    let method = "";
    const headers = [];
    const data = [];
    let dataIsBinaryish = false;
    let form = null;
    let getMode = false;
    let headOnly = false;
    let user = "";
    const warnings = [];

    const take = (flag) => {
      if (i + 1 >= toks.length) throw new Error(`${flag} needs a value`);
      i++;
      return toks[i];
    };

    for (; i < toks.length; i++) {
      let t = toks[i];
      let inline = null;
      // --flag=value form for long options
      if (/^--[a-z0-9-]+=/.test(t)) {
        inline = t.slice(t.indexOf("=") + 1);
        t = t.slice(0, t.indexOf("="));
      }
      const val = (flag) => (inline !== null ? inline : take(flag));

      if (t === "-X" || t === "--request") method = val(t).toUpperCase();
      else if (/^-X[A-Za-z]+$/.test(t)) method = t.slice(2).toUpperCase();
      else if (t === "-H" || t === "--header") {
        const h = val(t);
        const c = h.indexOf(":");
        if (c > 0) {
          const name = h.slice(0, c).trim();
          const value = h.slice(c + 1).trim();
          if (value || !/;$/.test(h)) headers.push({ name, value });
        } else if (/;$/.test(h)) headers.push({ name: h.slice(0, -1).trim(), value: "" });
      } else if (["-d", "--data", "--data-ascii", "--data-raw"].includes(t)) data.push(val(t));
      else if (t === "--data-binary") {
        const v = val(t);
        if (v.startsWith("@")) warnings.push("--data-binary @file is not supported; the literal value was sent");
        dataIsBinaryish = true;
        data.push(v);
      } else if (t === "--data-urlencode") {
        const v = val(t);
        const eq = v.indexOf("=");
        if (eq === -1) data.push(encodeURIComponent(v));
        else data.push(v.slice(0, eq + 1) + encodeURIComponent(v.slice(eq + 1)));
      } else if (t === "--json") {
        data.push(val(t));
        if (!headers.some((h) => /^content-type$/i.test(h.name))) headers.push({ name: "Content-Type", value: "application/json" });
        if (!headers.some((h) => /^accept$/i.test(h.name))) headers.push({ name: "Accept", value: "application/json" });
      } else if (t === "-F" || t === "--form" || t === "--form-string") {
        const v = val(t);
        const eq = v.indexOf("=");
        if (!form) form = [];
        form.push({ name: eq === -1 ? v : v.slice(0, eq), value: eq === -1 ? "" : v.slice(eq + 1) });
      } else if (t === "-u" || t === "--user") user = val(t);
      else if (t === "-b" || t === "--cookie") {
        const v = val(t);
        if (v.includes("=")) headers.push({ name: "Cookie", value: v });
      } else if (t === "-A" || t === "--user-agent") headers.push({ name: "User-Agent", value: val(t) });
      else if (t === "-e" || t === "--referer") headers.push({ name: "Referer", value: val(t) });
      else if (t === "-G" || t === "--get") getMode = true;
      else if (t === "-I" || t === "--head") headOnly = true;
      else if (t === "--url") url = val(t);
      else if (IGNORED.has(t)) continue;
      else if (IGNORED_WITH_ARG.has(t)) {
        if (inline === null) i++;
      } else if (t.startsWith("-") && t.length > 1) warnings.push(`ignored option ${t}`);
      else if (!url) url = t;
      else warnings.push(`ignored extra argument ${t.slice(0, 40)}`);
    }

    if (!url) throw new Error("no URL found in the cURL command");
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "http://" + url;

    let body = null;
    if (form) {
      body = { form };
    } else if (data.length) {
      if (getMode) {
        const sep = url.includes("?") ? "&" : "?";
        url += sep + data.join("&");
      } else {
        body = data.join("&");
        if (!headers.some((h) => /^content-type$/i.test(h.name)) && !dataIsBinaryish) {
          headers.push({ name: "Content-Type", value: "application/x-www-form-urlencoded" });
        }
      }
    }

    if (user) {
      try {
        headers.push({ name: "Authorization", value: "Basic " + btoa(user) });
      } catch (_) {
        warnings.push("could not encode -u credentials");
      }
    }

    if (!method) method = headOnly ? "HEAD" : body != null && !getMode ? "POST" : "GET";
    return { method, url, headers, body, warnings };
  }

  function shq(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  // req: { method, url, headers: [{name,value}] | {name: value}, body }
  function build(req) {
    const lines = ["curl " + shq(req.url)];
    const method = String(req.method || "GET").toUpperCase();
    const hasBody = req.body != null && req.body !== "";
    if (method !== "GET" && !(method === "POST" && hasBody)) lines.push("-X " + method);
    const list = (
      Array.isArray(req.headers) ? req.headers : Object.keys(req.headers || {}).map((name) => ({ name, value: req.headers[name] }))
    ).slice();
    // A JSON value body needs its type spelled out, or curl sends it as a form.
    if (hasBody && typeof req.body !== "string" && !list.some((h) => /^content-type$/i.test(h.name))) {
      list.push({ name: "Content-Type", value: "application/json" });
    }
    for (const h of list) {
      const n = String(h.name || "").toLowerCase();
      if (!n || n.startsWith(":") || n === "content-length" || n === "host") continue;
      lines.push("-H " + shq(h.name + ": " + h.value));
    }
    if (hasBody) {
      const b = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      lines.push("--data-raw " + shq(b));
    }
    return lines.join(" \\\n  ");
  }

  return { parse, build, tokenize, shq };
})();
