/* NetScope – console-ui.js
 * The Console view: everything the page wrote to its console, plus uncaught
 * errors, unhandled rejections, failed resource loads, CSP violations and
 * single-page-app route changes. Filter by level or text, expand a message
 * for its full text and stack, and hand any error to the AI.
 * DOM is built with createElement/textContent only.
 */
"use strict";

window.__netscopeConsoleUi = (() => {
  const LEVELS = [
    ["all", "All"],
    ["error", "Errors"],
    ["warn", "Warnings"],
    ["info", "Info"],
    ["log", "Logs"],
    ["debug", "Debug"],
    ["route", "Routes"]
  ];
  const MAX_ROWS = 1500;
  // A small tag for kinds whose message doesn't already say what they are.
  const KIND = { csp: "CSP", table: "Table", netscope: "NetScope" };

  let api = null;
  let level = "all";
  let query = "";
  const open = new Set(); // expanded rows, by first log id
  let raf = 0;
  let stick = true;
  const $ = (id) => document.getElementById(id);

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const visible = () => $("view-console") && $("view-console").classList.contains("on");
  const ask = (text) => window.__netscopeAi && window.__netscopeAi.prefill(text, true);

  // "https://x.com/static/js/main.3f2a.js:120:15" → "main.3f2a.js:120";
  // an inline script on "https://x.com/" → "x.com/:15".
  function shortSource(src) {
    const m = /^(.*?):(\d+)(?::\d+)?$/.exec(src || "");
    const url = (m ? m[1] : src || "").split(/[?#]/)[0];
    let file = url.split("/").pop();
    if (!file && url) {
      try {
        const u = new URL(url);
        file = u.host + u.pathname;
      } catch (_) {
        file = url;
      }
    }
    return file ? file + (m ? ":" + m[2] : "") : "";
  }

  function when(ts) {
    const s = Math.max(0, (ts - api.getStartedAt()) / 1000);
    return s < 100 ? s.toFixed(1) + " s" : Math.round(s) + " s";
  }

  function counts(logs) {
    const c = { error: 0, warn: 0, info: 0, log: 0, debug: 0, route: 0, trace: 0 };
    for (const l of logs) c[l.level] = (c[l.level] || 0) + 1;
    return c;
  }

  function updateBadge(c, total) {
    const b = $("consoleCount");
    if (!b) return;
    b.textContent = c.error ? String(c.error) : total ? String(total) : "";
    b.classList.toggle("err", !!c.error);
    b.title = c.error ? `${c.error} error${c.error === 1 ? "" : "s"}` : "";
    if (typeof syncInspectTab === "function") syncInspectTab();
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  }

  function rows(logs) {
    const want = query.toLowerCase();
    const out = [];
    for (const l of logs) {
      if (level !== "all" && (level === "log" ? l.level !== "log" && l.level !== "trace" : l.level !== level)) continue;
      if (want && !(l.text + " " + (l.source || "")).toLowerCase().includes(want)) continue;
      const last = out[out.length - 1];
      if (last && last.l.level === l.level && last.l.text === l.text && last.l.source === l.source) last.n++;
      else out.push({ l, n: 1 });
    }
    return out.slice(-MAX_ROWS);
  }

  function detail(l) {
    const box = node("div", "con-detail");
    box.appendChild(node("pre", "con-full", l.text));
    const meta = [];
    if (l.source) meta.push(l.source);
    if (l.frame) meta.push("frame " + l.frame);
    if (meta.length) box.appendChild(node("div", "con-meta", meta.join("  ·  ")));
    if (l.stack) box.appendChild(node("pre", "con-stack", l.stack));
    const actions = node("div", "actions");
    if (l.level === "error" || l.level === "warn") {
      const b = node("button", "", "Ask why");
      b.type = "button";
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ask(`Explain this console ${l.level === "error" ? "error" : "warning"} and find its cause — check the code (search_sources / read_source), related requests and app state:\n\n${l.text}${l.source ? "\nat " + l.source : ""}${l.stack ? "\n\n" + l.stack.split("\n").slice(0, 8).join("\n") : ""}`);
      });
      actions.appendChild(b);
    }
    const copy = node("button", "ghost", "Copy");
    copy.type = "button";
    copy.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (typeof copyText === "function") copyText([l.text, l.source, l.stack].filter(Boolean).join("\n"), "Message copied");
    });
    actions.appendChild(copy);
    box.appendChild(actions);
    return box;
  }

  function render() {
    if (!api) return;
    const logs = api.getLogs();
    const c = counts(logs);
    updateBadge(c, logs.length);
    for (const b of $("conLevels").children) {
      const lv = b.dataset.level;
      const n = lv === "all" ? logs.length : lv === "log" ? c.log + c.trace : c[lv] || 0;
      b.querySelector(".n").textContent = n ? String(n) : "";
    }
    if (!visible()) return;
    const list = $("conList");
    const shown = rows(logs);
    $("conEmpty").hidden = logs.length > 0;
    list.hidden = !logs.length;
    $("conStats").textContent = logs.length ? `${shown.length === logs.length ? logs.length : shown.reduce((n, r) => n + r.n, 0) + " of " + logs.length} messages` : "";
    $("conAsk").disabled = !c.error && !c.warn;
    const atBottom = stick;
    const frag = document.createDocumentFragment();
    for (const { l, n } of shown) {
      const row = node("div", "con-row lvl-" + l.level);
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      const isOpen = open.has(l.id);
      row.setAttribute("aria-expanded", isOpen ? "true" : "false");
      const glyph = node("span", "con-lvl", l.level === "route" ? "→" : l.level === "error" ? "✕" : l.level === "warn" ? "!" : l.level === "info" ? "i" : l.level === "debug" ? "·" : "");
      glyph.setAttribute("aria-hidden", "true");
      row.appendChild(glyph);
      row.appendChild(node("span", "sr-only", (l.level === "warn" ? "warning" : l.level === "route" ? "route change" : l.level) + ": "));
      const msg = node("span", "con-msg");
      if (KIND[l.kind]) msg.appendChild(node("span", "con-kind", KIND[l.kind]));
      msg.appendChild(document.createTextNode(l.level === "route" ? routeText(l.text) : l.text.split("\n")[0].slice(0, 400)));
      row.appendChild(msg);
      if (n > 1) row.appendChild(node("span", "con-rep", "×" + n));
      const src = node("span", "con-src", l.level === "route" ? "" : shortSource(l.source));
      if (l.source) src.title = l.source;
      row.appendChild(src);
      row.appendChild(node("span", "con-t", when(l.ts)));
      const toggle = () => {
        if (open.has(l.id)) open.delete(l.id);
        else open.add(l.id);
        stick = false;
        render();
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          toggle();
        }
      });
      frag.appendChild(row);
      if (isOpen) frag.appendChild(detail(l));
    }
    const top = list.scrollTop;
    list.replaceChildren(frag);
    if (atBottom) list.scrollTop = list.scrollHeight;
    else list.scrollTop = top;
  }

  function routeText(url) {
    try {
      const u = new URL(url);
      return "Navigated to " + u.pathname + u.search + u.hash;
    } catch (_) {
      return "Navigated to " + url;
    }
  }

  function wire() {
    const lv = $("conLevels");
    for (const [key, label] of LEVELS) {
      const b = node("button", "tgl" + (key === level ? " on" : ""));
      b.type = "button";
      b.dataset.level = key;
      b.setAttribute("aria-pressed", key === level ? "true" : "false");
      b.appendChild(document.createTextNode(label + " "));
      b.appendChild(node("span", "n"));
      b.addEventListener("click", () => {
        level = key;
        for (const x of lv.children) {
          x.classList.toggle("on", x === b);
          x.setAttribute("aria-pressed", x === b ? "true" : "false");
        }
        stick = true;
        render();
      });
      lv.appendChild(b);
    }
    $("conSearch").addEventListener("input", (ev) => {
      query = ev.target.value;
      stick = true;
      render();
    });
    $("conClear").addEventListener("click", () => {
      open.clear();
      api.rpc("logs.clear").catch(() => {});
    });
    $("conAsk").addEventListener("click", () =>
      ask("Look at the console errors and warnings on this page (get_console_logs level errors_and_warnings). Group them by cause, explain each group, and point to the code and requests involved. Say which ones matter for users.")
    );
    const list = $("conList");
    list.addEventListener("scroll", () => {
      stick = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    });
  }

  function attach(a) {
    if (api) return;
    api = a;
    wire();
    api.subscribe((type) => {
      if (type === "logs" || type === "snapshot" || type === "clear") schedule();
    });
  }

  return { attach, onShown: () => ((stick = true), render()) };
})();
