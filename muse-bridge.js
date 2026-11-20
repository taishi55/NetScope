/* NetScope – muse-bridge.js
 * Content script on muse.ai. Lets NetScope use Muse (Meta's agent) through
 * the user's own signed-in tab: it fills Muse's message box, presses Send,
 * and reads Muse's reply back as Markdown. No passwords or tokens are touched.
 *
 * Every operation is synchronous and returns at once. The background worker
 * does all the waiting and polling, because timers in a hidden or minimized
 * tab are throttled (down to once a minute) and would stall a reply.
 *
 * It only ever clicks Muse's Send and Stop buttons in the message box. It
 * never answers Muse's approval requests or touches anything else on the page.
 */
"use strict";

(() => {
  if (globalThis.__netscopeMuseBridge) return;
  globalThis.__netscopeMuseBridge = true;

  /* -------------------------------------------------------- the page */

  const composer = () => document.querySelector('textarea[aria-label="Message"]') || document.querySelector("textarea[data-hatch-composer-prehydration-input]");

  // Send and Stop sit next to the textarea, inside the composer surface.
  function composerBox(ta) {
    const t = ta || composer();
    if (!t) return null;
    return t.closest('[role="button"]') || (t.parentElement && t.parentElement.parentElement && t.parentElement.parentElement.parentElement) || document.body;
  }
  const buttonIn = (label) => {
    const box = composerBox();
    return box ? box.querySelector(`button[aria-label="${label}"]`) : null;
  };
  const sendButton = () => {
    const b = buttonIn("Send");
    return b && !b.disabled ? b : null;
  };
  const stopButton = () => buttonIn("Stop");

  const items = () => Array.from(document.querySelectorAll('[role="log"] [data-message-item="true"]'));
  const roleOf = (n) => (n.dataset && n.dataset.messageRole) || "";

  function threadOf(path) {
    const m = /^\/thread\/([0-9a-f-]{16,})/i.exec(path);
    if (m) return m[1];
    if (path === "/thread/new") return "new";
    return path === "/" ? "main" : null;
  }

  function state() {
    const ta = composer();
    return {
      ok: true,
      signedIn: !!ta,
      ready: !!ta && document.readyState !== "loading",
      path: location.pathname,
      thread: threadOf(location.pathname),
      busy: !!stopButton(),
      draft: !!(ta && ta.value.trim() && !/^\(ns-\w+\)/.test(ta.value)), // the user's own unsent text, not NetScope's
      hidden: document.hidden,
      url: location.href
    };
  }

  /* ----------------------------------------------- reply → Markdown */

  const SKIP = new Set(["BUTTON", "SVG", "svg", "STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE", "INPUT", "TEXTAREA", "SELECT"]);
  const skip = (n) => SKIP.has(n.tagName) || (n.dataset && (n.dataset.copyExclude === "true" || n.dataset.streamdown === "code-block-header" || n.dataset.streamdown === "code-block-actions")) || n.getAttribute("aria-hidden") === "true";

  function inline(n) {
    let out = "";
    for (const c of n.childNodes) {
      if (c.nodeType === 3) {
        out += c.nodeValue;
        continue;
      }
      if (c.nodeType !== 1 || skip(c)) continue;
      const tag = c.tagName;
      if (tag === "BR") out += "\n";
      else if (tag === "STRONG" || tag === "B" || (tag === "SPAN" && /\bfont-(semibold|bold)\b/.test(c.className))) {
        const t = inline(c);
        out += t.trim() ? `**${t.trim()}**` : t;
      } else if (tag === "EM" || tag === "I") {
        const t = inline(c);
        out += t.trim() ? `*${t.trim()}*` : t;
      } else if (tag === "DEL" || tag === "S") out += `~~${inline(c)}~~`;
      else if (tag === "CODE") out += "`" + c.textContent + "`";
      else if (tag === "A") {
        const href = c.getAttribute("href") || "";
        const t = inline(c).trim();
        out += /^(https?:|mailto:)/i.test(href) && t !== href ? `[${t}](${href})` : t || href;
      } else if (tag === "IMG") out += c.alt ? `[image: ${c.alt}]` : "";
      else out += inline(c);
    }
    return out;
  }

  function codeText(block) {
    const code = block.querySelector("pre code") || block.querySelector("pre") || block;
    // Streamdown puts each line in its own span.block, with no newline between.
    const lines = Array.from(code.children).filter((s) => s.tagName === "SPAN" && /\bblock\b/.test(s.className));
    return lines.length ? lines.map((s) => s.textContent).join("\n") : code.textContent;
  }

  function fence(lang, text) {
    const ticks = /```/.test(text) ? "````" : "```";
    return `${ticks}${lang || ""}\n${text.replace(/\n$/, "")}\n${ticks}`;
  }

  function tableMd(table) {
    const rows = Array.from(table.rows).map((r) => Array.from(r.cells).map((c) => inline(c).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim()));
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r) => "| " + Array.from({ length: width }, (_, k) => r[k] || "").join(" | ") + " |";
    return [line(rows[0]), "| " + Array(width).fill("---").join(" | ") + " |"].concat(rows.slice(1).map(line)).join("\n");
  }

  function listMd(list, depth) {
    const ordered = list.tagName === "OL";
    let n = Number(list.getAttribute("start")) || 1;
    const pad = "   ".repeat(depth);
    const out = [];
    for (const li of list.children) {
      if (li.tagName !== "LI") continue;
      const marker = ordered ? `${n++}. ` : "- ";
      const own = [];
      const nested = [];
      for (const c of li.childNodes) {
        if (c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL")) nested.push(listMd(c, depth + 1));
        else if (c.nodeType === 1 && c.tagName === "P") own.push(inline(c));
        else if (c.nodeType === 1 && !skip(c) && c.dataset && c.dataset.streamdown === "code-block") nested.push(fence(c.dataset.language, codeText(c)).replace(/^/gm, pad + "   "));
        else if (c.nodeType === 3) own.push(c.nodeValue);
        else if (c.nodeType === 1 && !skip(c)) own.push(inline(c));
      }
      out.push(pad + marker + own.join(" ").replace(/\s+/g, " ").trim());
      out.push(...nested);
    }
    return out.join("\n");
  }

  function blocks(n) {
    const out = [];
    for (const c of n.childNodes) {
      if (c.nodeType === 3) {
        if (c.nodeValue.trim()) out.push(c.nodeValue.trim());
        continue;
      }
      if (c.nodeType !== 1 || skip(c)) continue;
      const tag = c.tagName;
      const sd = c.dataset ? c.dataset.streamdown : "";
      if (sd === "code-block") out.push(fence(c.dataset.language, codeText(c)));
      else if (sd === "table-wrapper" || tag === "TABLE") {
        const t = tag === "TABLE" ? c : c.querySelector("table");
        if (t) out.push(tableMd(t));
      } else if (tag === "PRE") out.push(fence("", c.textContent));
      else if (/^H[1-6]$/.test(tag)) out.push("#".repeat(Number(tag[1])) + " " + inline(c).trim());
      else if (tag === "P") out.push(inline(c).trim());
      else if (tag === "UL" || tag === "OL") out.push(listMd(c, 0));
      else if (tag === "BLOCKQUOTE") out.push(blocks(c).replace(/^/gm, "> "));
      else if (tag === "HR") out.push("---");
      else if (c.querySelector("p, ul, ol, pre, table, h1, h2, h3, h4, blockquote, [data-streamdown]")) out.push(blocks(c));
      else {
        const t = inline(c).trim();
        if (t) out.push(t);
      }
    }
    return out.filter(Boolean).join("\n\n");
  }

  function messageMd(item) {
    const bodies = item.querySelectorAll("[data-hatch-markdown-streaming]");
    if (bodies.length) return Array.from(bodies, blocks).filter(Boolean).join("\n\n");
    // Cards (files, tasks) have no Markdown body: their visible text will do.
    const body = item.querySelector("[data-hatch-assistant-message-body]") || item;
    return (body.innerText || "").replace(/^\s*Assistant message:\s*/i, "").trim();
  }

  /* ----------------------------------------------------- operations */

  function fill(text) {
    const ta = composer();
    if (!ta) return { ok: false, error: "signed-out" };
    if (stopButton()) return { ok: false, error: "busy" };
    ta.focus();
    // React tracks the value through the native setter; the input event lets it see the change.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true, canSend: !!sendButton(), length: ta.value.length };
  }

  function submit() {
    const b = sendButton();
    if (b) {
      b.click();
      return { ok: true, via: "button" };
    }
    const ta = composer();
    if (!ta || !ta.value) return { ok: false, error: "empty" };
    const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    ta.dispatchEvent(new KeyboardEvent("keydown", init));
    ta.dispatchEvent(new KeyboardEvent("keyup", init));
    return { ok: true, via: "enter" };
  }

  // The reply to the message carrying `marker`: every Muse message after it,
  // up to the next message from the user.
  function read(marker) {
    const all = items();
    let at = -1;
    for (let k = all.length - 1; k >= 0; k--) {
      if (roleOf(all[k]) === "user" && all[k].textContent.includes(marker)) {
        at = k;
        break;
      }
    }
    const s = state();
    if (at < 0) return Object.assign(s, { found: false, count: 0, text: "" });
    const replies = [];
    for (let k = at + 1; k < all.length; k++) {
      const r = roleOf(all[k]);
      if (r === "user") break;
      if (r === "assistant") replies.push(all[k]);
    }
    return Object.assign(s, {
      found: true,
      count: replies.length,
      streaming: replies.some((r) => r.querySelector('[data-hatch-markdown-streaming="true"], [aria-busy="true"]')),
      text: replies.map(messageMd).filter(Boolean).join("\n\n")
    });
  }

  function stop() {
    const b = stopButton();
    if (b) b.click();
    return { ok: true, stopped: !!b };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only NetScope's own pages and worker can reach a content script with
    // chrome.tabs.sendMessage; the popup iframe inside a web page has a tab too.
    if (!msg || msg.__netscopeMuse !== 1 || sender.id !== chrome.runtime.id) return;
    let res;
    try {
      if (msg.op === "state") res = state();
      else if (msg.op === "fill") res = fill(String(msg.text || ""));
      else if (msg.op === "submit") res = submit();
      else if (msg.op === "read") res = read(String(msg.marker || ""));
      else if (msg.op === "stop") res = stop();
      else if (msg.op === "goto") {
        const url = new URL(String(msg.url || ""), location.origin);
        if (url.origin !== location.origin) res = { ok: false, error: "bad-url" };
        else {
          res = { ok: true };
          setTimeout(() => location.assign(url.href), 0);
        }
      } else res = { ok: false, error: "unknown-op" };
    } catch (err) {
      res = { ok: false, error: String((err && err.message) || err) };
    }
    sendResponse(res);
  });
})();
