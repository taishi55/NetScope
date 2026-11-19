/* NetScope – markdown.js
 * Markdown → DOM for Kimi's answers and the Docs tab.
 *
 * Model output and captured data are untrusted, so this never parses text as
 * HTML: it builds elements with createElement/textContent only. Links are
 * kept only for http(s): and mailto:; anything else (javascript:, data: …)
 * stays plain text.
 *
 * Blocks: paragraphs (line breaks kept), # headings, ``` / ~~~ code with a
 * language label and Copy, tables with alignment (Copy table as TSV), - * +
 * and 1. lists — nested, with [ ] / [x] tasks — > quotes, --- rules.
 * Inline: `code`, **bold**, *italic*, ~~strike~~, [links](https://…),
 * <https://…>, bare https:// URLs, <br>, \-escapes and the common &entities;.
 * Plain text goes through opts.leaf, which the chat uses to turn "#412" into
 * a link to that request.
 */
"use strict";

globalThis.__netscopeMarkdown = (() => {
  const SAFE_URL = /^(https?:\/\/|mailto:)/i;
  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const textLeaf = (parent, t) => parent.appendChild(document.createTextNode(t));
  const decode = (t) => t.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, k) => ENTITIES[k]);

  function link(href) {
    const a = el("a", "md-link");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = href;
    return a;
  }

  /* ------------------------------------------------------------ inline */

  // Earliest match wins; ties go to the pattern listed first. Each pattern
  // scans the whole string from the current position (so lookbehinds see the
  // real previous character), and a match is reused until text before it is
  // consumed, which keeps long lines close to linear instead of quadratic.
  const INLINE = [
    ["esc", /\\([\\`*_{}[\]()#+\-.!|~<>])/g],
    ["code", /`([^`\n]+)`/g],
    // URL may hold one level of balanced parens: wiki/Foo_(bar), javascript:alert(1).
    ["link", /\[([^\]\n]+)\]\(\s*<?((?:[^()\s<>]|\([^()\s<>]*\))+)>?(?:\s+"[^"\n]*")?\s*\)/g],
    ["auto", /<((?:https?:\/\/|mailto:)[^>\s]+)>/g],
    // No __bold__: in a dev tool "__init__" is a name, and Kimi bolds with **.
    ["strong", /\*\*(?=\S)([^\n]*?\S)\*\*/g],
    ["del", /~~(?=\S)([^\n]*?\S)~~/g],
    ["em", /(?<![\w*\\])\*(?=[^\s*])([^*\n]*?[^\s*\\])\*(?![\w*])|(?<![\w_\\])_(?=[^\s_])([^_\n]*?[^\s_\\])_(?![\w_])/g],
    ["url", /\bhttps?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}*_~]/g],
    ["br", /<br\s*\/?>|\n/gi]
  ];
  const LINKISH = new Set(["link", "auto", "url"]);

  // inLink: inside a link's text, so no nested links.
  function inline(parent, text, leaf, inLink) {
    const s = String(text || "");
    const plain = (t) => t && leaf(parent, decode(t));
    const cache = new Array(INLINE.length).fill(undefined); // undefined = stale, null = no more matches
    let pos = 0;
    let guard = 0;
    while (pos < s.length && guard++ < 5000) {
      let best = -1;
      for (let k = 0; k < INLINE.length; k++) {
        if (inLink && LINKISH.has(INLINE[k][0])) continue;
        let m = cache[k];
        if (m === undefined || (m && m.index < pos)) {
          const re = INLINE[k][1];
          re.lastIndex = pos;
          m = cache[k] = re.exec(s);
        }
        if (m && (best < 0 || m.index < cache[best].index)) best = k;
      }
      if (best < 0) break;
      const kind = INLINE[best][0];
      const m = cache[best];
      plain(s.slice(pos, m.index));
      if (kind === "esc") plain(m[1]);
      else if (kind === "code") parent.appendChild(el("code", "", m[1]));
      else if (kind === "link") {
        if (SAFE_URL.test(m[2])) {
          const a = link(m[2]);
          inline(a, m[1], textLeaf, true); // no request links or nested links inside a link
          parent.appendChild(a);
        } else inline(parent, m[1], leaf, inLink);
      } else if (kind === "auto" || kind === "url") {
        const href = m[1] || m[0];
        const a = link(href);
        a.textContent = href;
        parent.appendChild(a);
      } else if (kind === "br") parent.appendChild(document.createElement("br"));
      else {
        const n = el(kind);
        inline(n, m[1] != null ? m[1] : m[2], leaf, inLink);
        parent.appendChild(n);
      }
      pos = m.index + m[0].length;
    }
    plain(s.slice(pos));
  }

  /* ------------------------------------------------------------ blocks */

  const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^\s{0,3}>/;
  const LIST = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
  const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const indentOf = (s) => s.match(/^\s*/)[0].replace(/\t/g, "    ").length;
  const closerFor = (mark) => new RegExp("^\\s*" + (mark[0] === "`" ? "`" : "~") + "{" + mark.length + ",}\\s*$");

  function isTableStart(lines, i) {
    const head = lines[i];
    const delim = lines[i + 1];
    return !!(head && delim && head.includes("|") && DELIM.test(delim) && (delim.includes("|") || head.trim().startsWith("|")));
  }

  function startsBlock(lines, i) {
    const l = lines[i];
    return FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || LIST.test(l) || isTableStart(lines, i);
  }

  // Inside a paragraph only a bullet, "1." or a number after a line ending in
  // ":" starts a list, so "2024. Then…" at the start of a wrapped line stays text.
  function interrupts(lines, i) {
    const m = LIST.exec(lines[i]);
    if (m && /\d/.test(m[2]) && parseInt(m[2], 10) !== 1 && !/:\s*$/.test(lines[i - 1])) return FENCE.test(lines[i]) || HEADING.test(lines[i]) || isTableStart(lines, i);
    return startsBlock(lines, i);
  }

  // Splits a table row on unescaped pipes outside `code`.
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    const cells = [];
    let cur = "";
    let inCode = false;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (ch === "\\" && s[k + 1] === "|") {
        cur += "|";
        k++;
        continue;
      }
      if (ch === "`") inCode = !inCode;
      if (ch === "|" && !inCode) {
        cells.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }

  function copyButton(label, getText, opts, message) {
    const b = el("button", "md-copy", label);
    b.type = "button";
    b.addEventListener("click", () => {
      const t = getText();
      if (opts.copy) opts.copy(t, message);
      else if (navigator.clipboard) navigator.clipboard.writeText(t).catch(() => {});
    });
    return b;
  }

  function table(parent, lines, i, leaf, opts) {
    const head = splitRow(lines[i]);
    const aligns = splitRow(lines[i + 1]).map((c) =>
      c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""
    );
    i += 2;
    const rows = [];
    while (i < lines.length && lines[i].trim() && lines[i].includes("|") && !FENCE.test(lines[i])) rows.push(splitRow(lines[i++]));

    const wrap = el("div", "md-table");
    const scroller = el("div", "md-table-scroll");
    const t = el("table");
    const thead = el("thead");
    const htr = el("tr");
    head.forEach((c, k) => {
      const th = el("th");
      th.scope = "col";
      if (aligns[k]) th.style.textAlign = aligns[k];
      inline(th, c, leaf);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    t.appendChild(thead);
    const tbody = el("tbody");
    for (const r of rows) {
      const tr = el("tr");
      for (let k = 0; k < head.length; k++) {
        const td = el("td");
        if (aligns[k]) td.style.textAlign = aligns[k];
        inline(td, r[k] || "", leaf);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    t.appendChild(tbody);
    scroller.appendChild(t);
    // Tab-separated values paste into a spreadsheet as columns.
    // Copies the text as shown (no Markdown syntax).
    const tsv = () => Array.from(t.rows, (tr) => Array.from(tr.cells, (c) => c.textContent.replace(/[\t\n]+/g, " ").trim()).join("\t")).join("\n");
    wrap.append(scroller, copyButton("Copy table", tsv, opts, "Table copied — paste it into a spreadsheet"));
    parent.appendChild(wrap);
    return i;
  }

  function codeBlock(code, lang, opts) {
    const wrap = el("div", "md-code");
    const bar = el("div", "md-code-bar");
    bar.appendChild(el("span", "md-lang", lang || "text"));
    const copy = copyButton("Copy", () => code, opts, /^(curl|bash|sh|shell|zsh|console)$/i.test(lang) ? "Command copied" : "Code copied");
    copy.setAttribute("aria-label", lang ? `Copy ${lang} code` : "Copy code");
    bar.appendChild(copy);
    const pre = el("pre");
    pre.appendChild(el("code", "", code));
    wrap.append(bar, pre);
    return wrap;
  }

  function list(parent, lines, i, leaf, opts) {
    const first = LIST.exec(lines[i]);
    const base = indentOf(first[1]);
    const ordered = /\d/.test(first[2]);
    const listEl = el(ordered ? "ol" : "ul");
    if (ordered && parseInt(first[2], 10) !== 1) listEl.start = parseInt(first[2], 10);
    const sameList = (l) => {
      const m = l != null && LIST.exec(l);
      return !!m && indentOf(m[1]) === base && /\d/.test(m[2]) === ordered;
    };
    let loose = false;

    while (i < lines.length) {
      if (!lines[i].trim()) {
        // A blank line between items keeps one list (and its numbering).
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (!sameList(lines[j])) break;
        loose = true;
        i = j;
      }
      if (!sameList(lines[i])) break;
      const m = LIST.exec(lines[i]);
      const contentIndent = base + m[2].length + 1;
      const dedent = (l) => {
        let k = 0;
        while (k < contentIndent && (l[k] === " " || l[k] === "\t")) k++;
        return l.slice(k);
      };
      const itemLines = [m[3]];
      let fence = null; // closing-fence pattern while inside a code block in this item
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (fence) {
          itemLines.push(dedent(l));
          if (fence.test(l)) fence = null;
          i++;
          continue;
        }
        if (!l.trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && indentOf(lines[j]) > base) {
            loose = true;
            itemLines.push("");
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) <= base && startsBlock(lines, i)) break;
        const f = FENCE.exec(l);
        if (f) fence = closerFor(f[2]);
        itemLines.push(dedent(l));
        i++;
      }

      const li = el("li");
      const task = /^\[([ xX])\]\s+/.exec(itemLines[0]);
      if (task) {
        li.classList.add("md-task");
        const cb = el("input");
        cb.type = "checkbox";
        cb.disabled = true;
        cb.checked = task[1] !== " ";
        cb.setAttribute("aria-label", cb.checked ? "Done" : "Not done");
        li.appendChild(cb);
        itemLines[0] = itemLines[0].slice(task[0].length);
      }
      if (itemLines.length === 1) inline(li, itemLines[0], leaf);
      else {
        const box = el("div");
        blocks(box, itemLines, leaf, opts);
        // Tight lists keep their text unwrapped, like most renderers.
        if (!loose) for (const p of Array.from(box.children)) if (p.tagName === "P") p.replaceWith(...p.childNodes);
        li.append(...box.childNodes);
      }
      listEl.appendChild(li);
    }
    parent.appendChild(listEl);
    return i;
  }

  function blocks(parent, lines, leaf, opts) {
    let i = 0;
    let guard = 0;
    while (i < lines.length && guard++ < 100000) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      let m = FENCE.exec(line);
      if (m) {
        const close = closerFor(m[2]);
        const buf = [];
        const strip = new RegExp("^ {0," + m[1].length + "}");
        i++;
        while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++].replace(strip, ""));
        i++; // the closing fence (or end of text while streaming)
        parent.appendChild(codeBlock(buf.join("\n"), m[3], opts));
        continue;
      }
      m = HEADING.exec(line);
      if (m) {
        const level = m[1].length;
        const h = el("h" + Math.min(6, level + 2), "md-h md-h" + level);
        inline(h, m[2], leaf);
        parent.appendChild(h);
        i++;
        continue;
      }
      if (RULE.test(line)) {
        parent.appendChild(el("hr"));
        i++;
        continue;
      }
      if (QUOTE.test(line)) {
        const buf = [];
        while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
        const q = el("blockquote");
        blocks(q, buf, leaf, opts);
        parent.appendChild(q);
        continue;
      }
      if (isTableStart(lines, i)) {
        i = table(parent, lines, i, leaf, opts);
        continue;
      }
      if (LIST.test(line)) {
        i = list(parent, lines, i, leaf, opts);
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim() && (buf.length === 0 || !interrupts(lines, i))) buf.push(lines[i++]);
      const p = el("p");
      inline(p, buf.join("\n").trim(), leaf);
      parent.appendChild(p);
    }
  }

  // opts: { leaf(parent, text) for plain text, copy(text, message) }
  function render(container, text, opts) {
    const o = Object.assign({ leaf: textLeaf }, opts || {});
    container.replaceChildren();
    blocks(container, String(text || "").replace(/\r\n?/g, "\n").split("\n"), o.leaf, o);
  }

  return { render, inline };
})();
