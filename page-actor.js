/* NetScope – page-actor.js
 * Injected with chrome.scripting.executeScript into the ISOLATED world of a
 * tab, so page scripts can neither see nor tamper with it. Self-contained:
 * Chrome serializes the function, so it may not use anything from outside.
 *
 *   __netscopeActor("snapshot", {...})  numbered map of what is on screen
 *   __netscopeActor("click" | "type" | "key" | "select" | "check" | "hover" |
 *                   "scroll" | "drag" | "dispatch" | "wait" | "read" |
 *                   "state" | "describe", {...})
 *
 * Elements are addressed by refs from the last snapshot. A ref stays with
 * its element until the document changes (a WeakRef registry kept in this
 * isolated world). Events are synthetic (isTrusted false): enough for nearly
 * every site, but :hover styles, file pickers, native <select> popups and
 * popup windows do not open from them.
 *
 * Safety floor: never types into password, card, bank, SSN or one-time-code
 * fields, whatever the caller asks.
 */
"use strict";

globalThis.__netscopeActor = function (op, args) {
  args = args || {};
  const W = window;
  const D = document;

  /* -------------------------------------------------------------- refs */

  const R = W.__netscopeActorRefs || (W.__netscopeActorRefs = { next: 1, byEl: new WeakMap(), byId: new Map(), doc: null });
  if (R.doc !== D) {
    // A new document (navigation): old refs mean nothing here.
    R.doc = D;
    R.byId.clear();
  }
  const refOf = (el) => {
    let id = R.byEl.get(el);
    if (!id) {
      id = R.next++;
      R.byEl.set(el, id);
    }
    R.byId.set(id, new WeakRef(el));
    return id;
  };
  const byRef = (ref) => {
    const n = Number(String(ref == null ? "" : ref).replace(/[^\d]/g, ""));
    const w = n ? R.byId.get(n) : null;
    const el = w && w.deref();
    return el && el.isConnected ? el : null;
  };
  if (R.byId.size > 8000) for (const [k, w] of R.byId) if (!w.deref()) R.byId.delete(k);

  /* ----------------------------------------------------------- helpers */

  const clean = (s, n) => {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return n && t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const isOurs = (el) => !!el && /^NETSCOPE-/.test(el.tagName || "");
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
  };

  function roleOf(el) {
    const r = el.getAttribute && el.getAttribute("role");
    if (r) return r.split(/\s+/)[0];
    const t = el.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "button" || t === "summary") return "button";
    if (t === "select") return el.multiple ? "listbox" : "combobox";
    if (t === "textarea") return "textbox";
    if (t === "input") {
      const ty = (el.type || "text").toLowerCase();
      return (
        { checkbox: "checkbox", radio: "radio", submit: "button", button: "button", reset: "button", image: "button", range: "slider", number: "spinbutton", search: "searchbox", file: "file-input", color: "color-input", date: "date-input", "datetime-local": "date-input", time: "time-input", month: "date-input", week: "date-input" }[ty] || "textbox"
      );
    }
    if (el.isContentEditable) return "textbox";
    if (t === "img") return "image";
    if (/^h[1-6]$/.test(t)) return "heading";
    if (t === "iframe") return "iframe";
    return "clickable";
  }

  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return clean(aria, 90);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const own = el.getRootNode && el.getRootNode();
      const t = lb
        .split(/\s+/)
        .map((id) => (own && own.getElementById ? own.getElementById(id) : null) || D.getElementById(id))
        .filter(Boolean)
        .map((x) => x.innerText || x.textContent)
        .join(" ");
      if (t.trim()) return clean(t, 90);
    }
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels)
        .map((l) => l.innerText || l.textContent)
        .join(" ");
      if (t.trim()) return clean(t, 90);
    }
    const tag = el.tagName;
    if (tag === "IMG") return clean(el.alt || el.title, 90);
    if (tag === "INPUT" && /^(submit|button|reset)$/i.test(el.type)) return clean(el.value, 90);
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return clean(el.getAttribute("placeholder") || el.title || el.name || "", 90);
    const text = clean(el.innerText || el.textContent, 90);
    if (text) return text;
    const img = el.querySelector && el.querySelector("img[alt], svg[aria-label], [title]");
    return clean(el.title || (img && (img.getAttribute("alt") || img.getAttribute("aria-label") || img.getAttribute("title"))) || el.getAttribute("name") || "", 90);
  }

  // Fields NetScope never types into, whatever the caller asks.
  function sensitive(el) {
    if (!el || !el.tagName) return "";
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && !el.isContentEditable) return "";
    const type = String(el.type || "").toLowerCase();
    const ac = String(el.getAttribute("autocomplete") || "").toLowerCase();
    const hint = [el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.labels && el.labels[0] && el.labels[0].innerText]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (type === "password" || /password/.test(ac) || /passw(or)?d|passcode|\bpin\b/.test(hint)) return "password";
    if (/^cc-/.test(ac) || /card.?(num|no)|cc.?(num|no)|\bcvc|\bcvv|\bcsc|security.?code|expir|\biban\b|routing|account.?(num|no)|sort.?code|\bssn\b|social.?security|tax.?id|passport/.test(hint)) return "payment or identity";
    if (/one-time-code/.test(ac) || /\botp\b|2fa|mfa|verification.?code|one.?time/.test(hint)) return "one-time code";
    return "";
  }

  const RISKY = /\b(buy|purchase|pay|checkout|check out|place order|order now|complete order|subscribe|upgrade|donate|delete|remove|erase|destroy|discard|send|post|publish|tweet|reply|submit|transfer|withdraw|confirm|sign up|unsubscribe|cancel (subscription|plan|account|order)|deactivate|close account|book now|reserve|accept)\b/i;

  function describe(el) {
    if (!el) return null;
    const role = roleOf(el);
    const name = nameOf(el);
    const form = el.form || (el.closest && el.closest("form"));
    const submits = role === "button" && !!form && (el.type === "submit" || (el.tagName === "BUTTON" && !el.getAttribute("type")));
    const payFields = form ? Array.from(form.querySelectorAll("input")).some((i) => sensitive(i) === "payment or identity") : false;
    const text = (name + " " + (el.value || "") + " " + (el.title || "")).trim();
    return {
      desc: `${role} "${clean(name, 60)}"`,
      role,
      name,
      tag: el.tagName.toLowerCase(),
      href: el.href ? String(el.href).slice(0, 300) : undefined,
      form: form ? { action: String(form.action || "").slice(0, 200), method: String(form.method || "get").toUpperCase(), payment_fields: payFields || undefined } : undefined,
      submits: submits || undefined,
      sensitive: sensitive(el) || undefined,
      risky: RISKY.test(text) || payFields || (submits && form && String(form.method || "").toUpperCase() === "POST" && RISKY.test(form.innerText.slice(0, 400))) || undefined
    };
  }

  /* -------------------------------------------------------------- walk */

  const INTERACTIVE =
    "a[href],button,input:not([type=hidden]),select,textarea,summary,iframe,[contenteditable=''],[contenteditable=true],[onclick],[draggable=true],[tabindex]:not([tabindex='-1'])," +
    "[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option]," +
    "[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],[role=treeitem],[role=gridcell],[role=listbox]";
  const POINTER_TAGS = /^(DIV|SPAN|LI|IMG|SVG|TD|LABEL|I|P|ARTICLE|SECTION|FIGURE)$/;
  const LEAF = /^(link|button|checkbox|radio|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|textbox|searchbox|slider|spinbutton|image|file-input|color-input|date-input|time-input)$/;

  // Elements in document order, through open shadow roots and same-origin
  // iframes (with their offsets). Cross-origin frames are listed, not entered.
  function walk(visit) {
    const stack = [{ root: D.body || D.documentElement, dx: 0, dy: 0, depth: 0 }];
    let pointerChecks = 0;
    while (stack.length) {
      const { root, dx, dy, depth } = stack.pop();
      const items = [];
      const tw = D.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let el = tw.currentNode;
      while (el) {
        items.push(el);
        el = tw.nextNode();
      }
      const sub = [];
      for (const e of items) {
        if (isOurs(e)) continue;
        const ctx = { dx, dy, pointer: false };
        if (!e.matches(INTERACTIVE) && POINTER_TAGS.test(e.tagName.toUpperCase()) && pointerChecks < 3000) {
          pointerChecks++;
          const cs = getComputedStyle(e);
          if (cs.cursor === "pointer" && e.parentElement && getComputedStyle(e.parentElement).cursor !== "pointer") ctx.pointer = true;
        }
        visit(e, ctx);
        if (e.shadowRoot && depth < 6) sub.push({ root: e.shadowRoot, dx, dy, depth: depth + 1 });
        if (e.tagName === "IFRAME" && depth < 3) {
          try {
            const doc = e.contentDocument;
            if (doc && doc.body) {
              const r = e.getBoundingClientRect();
              sub.push({ root: doc.body, dx: dx + r.left, dy: dy + r.top, depth: depth + 1 });
            }
          } catch (_) {}
        }
      }
      for (let i = sub.length - 1; i >= 0; i--) stack.push(sub[i]);
    }
  }

  function stateFlags(el) {
    const f = [];
    if (el.disabled || el.getAttribute("aria-disabled") === "true") f.push("disabled");
    if (el.checked || el.getAttribute("aria-checked") === "true") f.push("checked");
    if (el.getAttribute("aria-selected") === "true" || (el.tagName === "OPTION" && el.selected)) f.push("selected");
    const ex = el.getAttribute("aria-expanded");
    if (ex) f.push(ex === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-pressed") === "true") f.push("pressed");
    if (el.required) f.push("required");
    if (el.getAttribute("aria-invalid") === "true") f.push("invalid");
    if (el === deepActive()) f.push("focused");
    return f;
  }

  function deepActive() {
    let a = D.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function valueOf(el) {
    if (sensitive(el)) return el.value ? "••••" : "";
    if (el.tagName === "SELECT") {
      const o = el.selectedOptions && el.selectedOptions[0];
      return o ? clean(o.label || o.text, 60) : "";
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return /^(checkbox|radio|submit|button|reset|image|file)$/i.test(el.type) ? "" : clean(el.value, 80);
    if (el.isContentEditable) return clean(el.innerText, 80);
    const v = el.getAttribute("aria-valuenow");
    return v != null ? v : "";
  }

  function snapshot() {
    const vw = W.innerWidth;
    const vh = W.innerHeight;
    const max = Math.min(Math.max(Number(args.max) || 160, 20), 500);
    const all = !!args.all;
    const lines = [];
    const marks = [];
    const below = [];
    let count = 0;
    const seen = new Set();
    const dialogs = [];
    walk((el, ctx) => {
      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) {
        if (!visible(el)) return;
        const t = clean(el.innerText, 100);
        if (t) (inView(el, ctx) ? lines : below).push("#".repeat(Number(tag[1])) + " " + t);
        return;
      }
      if ((el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true" || (tag === "DIALOG" && el.open)) && visible(el)) {
        dialogs.push(clean(nameOf(el) || (el.querySelector("h1,h2,h3") || {}).innerText || "dialog", 80));
      }
      if (!(ctx.pointer || el.matches(INTERACTIVE))) return;
      // Inside a link or button its parts are not separate controls; inside a
      // container (listbox, grid cell, focusable wrapper) they are.
      for (let p = el.parentElement; p; p = p.parentElement) if (seen.has(p) && LEAF.test(roleOf(p))) return;
      if (!visible(el) && !(el.type === "checkbox" || el.type === "radio")) return;
      seen.add(el);
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + ctx.dx);
      const y = Math.round(r.top + ctx.dy);
      const on = x + r.width > 0 && y + r.height > 0 && x < vw && y < vh;
      if (!on && !all && below.length > max) return;
      if (count >= max) return;
      count++;
      const id = refOf(el);
      const role = tag === "IFRAME" ? "iframe" : roleOf(el);
      const name = tag === "IFRAME" ? clean(el.title || el.name || el.src, 80) : nameOf(el);
      const val = valueOf(el);
      const flags = stateFlags(el);
      let line = `[${id}] ${role}${name ? ` "${name}"` : ""}`;
      if (val && val !== name) line += ` value="${val}"`;
      if (el.tagName === "A" && el.href && !/^javascript:/i.test(el.getAttribute("href") || "")) line += ` → ${String(el.getAttribute("href")).slice(0, 80)}`;
      if (flags.length) line += " " + flags.join(" ");
      if (sensitive(el)) line += ` (${sensitive(el)} field: the developer fills this)`;
      if (tag === "IFRAME") {
        let cross = false;
        try {
          cross = !el.contentDocument;
        } catch (_) {
          cross = true;
        }
        if (cross) line += " (cross-origin frame: use frame_id from list_frames)";
      }
      if (on) {
        const cx = Math.round(x + r.width / 2);
        const cy = Math.round(y + r.height / 2);
        line += ` @${cx},${cy}`;
        lines.push(line);
        marks.push({ ref: id, x, y, w: Math.round(r.width), h: Math.round(r.height) });
      } else below.push(line);
    });
    const se = D.scrollingElement || D.documentElement;
    const head = [
      `${clean(D.title, 120) || "(untitled)"} — ${location.href.slice(0, 300)}`,
      `viewport ${vw}×${vh}, scrolled ${Math.round(W.scrollY)} of ${Math.max(0, se.scrollHeight - vh)} px${dialogs.length ? `, open dialog: ${dialogs.join("; ")}` : ""}`
    ];
    const outLines = head.concat(lines);
    if (below.length) outLines.push("— outside the visible area (scroll or click by ref) —", ...below.slice(0, all ? max : 60));
    if (count >= max) outLines.push(`(stopped at ${max} elements: pass max for more)`);
    const res = {
      url: location.href,
      title: D.title,
      text: outLines.join("\n"),
      elements: count,
      viewport: { w: vw, h: vh, dpr: W.devicePixelRatio || 1, scroll_y: Math.round(W.scrollY), page_h: se.scrollHeight },
      marks
    };
    if (args.include_text) res.page_text = clean((D.querySelector("main, [role=main], article") || D.body).innerText, Math.min(Number(args.text_chars) || 4000, 20000));
    return res;
  }

  function inView(el, ctx) {
    const r = el.getBoundingClientRect();
    const y = r.top + (ctx ? ctx.dy : 0);
    return y + r.height > 0 && y < W.innerHeight;
  }

  /* ------------------------------------------------------------ target */

  function findByText(text) {
    const want = clean(text).toLowerCase();
    let best = null;
    walk((el, ctx) => {
      if (best && best.exact) return;
      if (!(ctx.pointer || el.matches(INTERACTIVE)) || !visible(el)) return;
      const n = nameOf(el).toLowerCase();
      if (!n) return;
      if (n === want) best = { el, exact: true };
      else if (!best && n.includes(want)) best = { el, exact: false };
    });
    return best && best.el;
  }

  function topAt(x, y) {
    const list = D.elementsFromPoint(x, y) || [];
    return list.find((e) => !isOurs(e)) || null;
  }

  function target() {
    if (args.ref != null && args.ref !== "") {
      const el = byRef(args.ref);
      if (!el) throw new Error(`ref ${args.ref} is gone (the page changed or navigated) — call page_snapshot again`);
      return el;
    }
    if (args.selector) {
      const el = D.querySelector(String(args.selector));
      if (!el) throw new Error(`nothing matches the selector ${args.selector}`);
      return el;
    }
    if (args.target_text) {
      const el = findByText(args.target_text);
      if (!el) throw new Error(`no visible control is named "${args.target_text}"`);
      return el;
    }
    if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
      const el = topAt(args.x, args.y);
      if (!el) throw new Error(`nothing at ${args.x},${args.y}`);
      return el;
    }
    return null;
  }

  function point(el) {
    if (Number.isFinite(args.x) && Number.isFinite(args.y) && args.ref == null && !args.selector && !args.target_text) return { x: args.x, y: args.y };
    const r0 = el.getBoundingClientRect();
    if (r0.top < 0 || r0.bottom > W.innerHeight || r0.left < 0 || r0.right > W.innerWidth) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  const MODS = (m) => {
    const s = String(m || "").toLowerCase();
    return { ctrlKey: /ctrl|control/.test(s), shiftKey: /shift/.test(s), altKey: /alt|option/.test(s), metaKey: /meta|cmd|command/.test(s) };
  };

  function fire(el, type, Ctor, init) {
    const base = { bubbles: true, cancelable: true, composed: true };
    if (Ctor !== Event && Ctor !== CustomEvent) base.view = W;
    const ev = new Ctor(type, Object.assign(base, init || {}));
    return el.dispatchEvent(ev);
  }

  function mouseInit(p, extra) {
    return Object.assign({ clientX: p.x, clientY: p.y, screenX: p.x + (W.screenX || 0), screenY: p.y + (W.screenY || 0), pointerId: 1, pointerType: "mouse", isPrimary: true }, extra || {});
  }

  function hoverAt(el, p, mods) {
    const init = mouseInit(p, mods);
    fire(el, "pointerover", PointerEvent, init);
    fire(el, "pointerenter", PointerEvent, Object.assign({}, init, { bubbles: false }));
    fire(el, "mouseover", MouseEvent, init);
    fire(el, "mouseenter", MouseEvent, Object.assign({}, init, { bubbles: false }));
    fire(el, "pointermove", PointerEvent, init);
    fire(el, "mousemove", MouseEvent, init);
  }

  function focusable(el) {
    for (let e = el; e && e !== D.body; e = e.parentElement || (e.getRootNode && e.getRootNode().host)) {
      if (e.tabIndex >= 0 || /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(e.tagName) || e.isContentEditable) return e;
    }
    return null;
  }

  /* ----------------------------------------------------------- actions */

  function click() {
    const el = target();
    if (!el) throw new Error("say what to click: ref, text, selector or x and y");
    const p = point(el);
    let hit = topAt(p.x, p.y);
    let recv = el;
    if (hit && (hit === el || el.contains(hit))) recv = hit;
    else if (hit && hit.tagName === "LABEL" && hit.control === el) recv = hit;
    else if (hit && !(el.contains(hit) || hit.contains(el))) {
      // Hidden native checkbox/radio styled by a sibling: click the element itself.
      const tiny = el.getBoundingClientRect().width < 2 || getComputedStyle(el).opacity === "0";
      if (!args.force && !tiny) {
        const d = describe(hit);
        return { error: `the click would land on ${d ? d.desc : hit.tagName.toLowerCase()} (ref ${refOf(hit)}) that covers the target — close it first, click that ref, or pass force: true`, covered_by: refOf(hit) };
      }
    }
    const button = args.button === "right" ? 2 : args.button === "middle" ? 1 : 0;
    const mods = MODS(args.modifiers);
    const count = Math.min(Math.max(Number(args.count) || 1, 1), 3);
    const info = describe(el);
    // A link that opens a new tab would be stopped by the popup blocker
    // (synthetic clicks carry no user gesture): the background opens it.
    const link = el.closest && el.closest("a[href]");
    const newTab = !!(link && button === 0 && (link.target === "_blank" || mods.metaKey || mods.ctrlKey) && /^https?:/i.test(link.href));
    hoverAt(recv, p, mods);
    for (let i = 1; i <= count; i++) {
      const init = mouseInit(p, Object.assign({ button, buttons: [1, 4, 2][button], detail: i }, mods));
      const downOk = fire(recv, "pointerdown", PointerEvent, init) && fire(recv, "mousedown", MouseEvent, init);
      if (downOk && i === 1) {
        const f = focusable(recv);
        if (f && f !== deepActive()) f.focus({ preventScroll: true });
      }
      const upInit = Object.assign({}, init, { buttons: 0 });
      fire(recv, "pointerup", PointerEvent, upInit);
      fire(recv, "mouseup", MouseEvent, upInit);
      if (button === 2) {
        fire(recv, "contextmenu", MouseEvent, upInit);
        break;
      }
      if (button === 1) {
        fire(recv, "auxclick", PointerEvent, upInit);
        break;
      }
      if (newTab) {
        // Fire click for listeners but keep the browser from navigating this tab.
        const stop = (e) => e.preventDefault();
        W.addEventListener("click", stop, { capture: true, once: true });
        fire(recv, "click", PointerEvent, upInit);
        W.removeEventListener("click", stop, { capture: true });
      } else fire(recv, "click", PointerEvent, upInit);
    }
    if (count === 2 && button === 0) fire(recv, "dblclick", MouseEvent, mouseInit(p, Object.assign({ detail: 2 }, mods)));
    return { ok: true, clicked: info && info.desc, point: p, open_url: newTab ? link.href : undefined };
  }

  function insertText(el, text) {
    if (!text) return true;
    let ok = false;
    try {
      ok = D.execCommand("insertText", false, text);
    } catch (_) {}
    if (ok) return true;
    // Fallback: the native setter, so frameworks' value trackers see a change.
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, "value").set;
      const start = el.selectionStart != null ? el.selectionStart : el.value.length;
      const end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
      set.call(el, el.value.slice(0, start) + text + el.value.slice(end));
      try {
        el.setSelectionRange(start + text.length, start + text.length);
      } catch (_) {}
      fire(el, "input", InputEvent, { inputType: "insertText", data: text });
      return true;
    }
    if (el.isContentEditable) {
      el.textContent += text;
      fire(el, "input", InputEvent, { inputType: "insertText", data: text });
      return true;
    }
    return false;
  }

  function keyInit(key, mods) {
    const named = {
      Enter: ["Enter", 13], Tab: ["Tab", 9], Escape: ["Escape", 27], Backspace: ["Backspace", 8], Delete: ["Delete", 46],
      ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
      Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34], " ": ["Space", 32]
    };
    let code;
    let keyCode;
    if (named[key]) [code, keyCode] = named[key];
    else if (/^F\d{1,2}$/.test(key)) (code = key), (keyCode = 111 + Number(key.slice(1)));
    else if (key.length === 1) {
      const up = key.toUpperCase();
      code = /[A-Z]/.test(up) ? "Key" + up : /\d/.test(key) ? "Digit" + key : "";
      keyCode = up.charCodeAt(0);
    } else (code = key), (keyCode = 0);
    return Object.assign({ key, code, keyCode, which: keyCode, charCode: key.length === 1 ? key.charCodeAt(0) : 0 }, mods);
  }

  function typeChar(el, ch) {
    const init = keyInit(ch, {});
    if (!fire(el, "keydown", KeyboardEvent, init)) return;
    fire(el, "keypress", KeyboardEvent, init);
    insertText(el, ch);
    fire(el, "keyup", KeyboardEvent, init);
  }

  function typeText() {
    let el = args.ref != null || args.selector || args.target_text || Number.isFinite(args.x) ? target() : deepActive();
    if (!el || el === D.body) throw new Error("say which field to type into (ref from page_snapshot)");
    // A label or wrapper: type into the field inside it.
    if (!/^(INPUT|TEXTAREA)$/.test(el.tagName) && !el.isContentEditable) {
      const inner = (el.control) || el.querySelector("input:not([type=hidden]),textarea,[contenteditable=''],[contenteditable=true]");
      if (inner) el = inner;
    }
    const why = sensitive(el);
    if (why) return { error: `this is a ${why} field. NetScope never types into these — ask the developer to fill it in themselves.`, sensitive: why };
    if (el.tagName === "SELECT") return { error: "this is a <select>: use select_option" };
    if (!/^(INPUT|TEXTAREA)$/.test(el.tagName) && !el.isContentEditable) return { error: `${describe(el).desc} is not a text field` };
    if (el.disabled || el.readOnly) return { error: `${describe(el).desc} is ${el.disabled ? "disabled" : "read-only"}` };
    const p = point(el);
    el.focus({ preventScroll: true });
    const text = String(args.text == null ? "" : args.text);
    if (args.clear !== false) {
      if (el.select && /^(INPUT|TEXTAREA)$/.test(el.tagName)) el.select();
      else {
        const range = D.createRange();
        range.selectNodeContents(el);
        const sel = W.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (!text) {
        try {
          D.execCommand("delete");
        } catch (_) {}
      }
    }
    if (text.length <= 80) for (const ch of text) typeChar(el, ch);
    else insertText(el, text);
    if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) fire(el, "change", Event, {});
    let submitted = false;
    if (args.submit) submitted = pressEnter(el);
    return { ok: true, typed_into: describe(el).desc, value: sensitive(el) ? "••••" : clean(el.isContentEditable ? el.innerText : el.value, 120), submitted: args.submit ? submitted : undefined, point: p };
  }

  function pressEnter(el) {
    const init = keyInit("Enter", {});
    const ok = fire(el, "keydown", KeyboardEvent, init);
    fire(el, "keypress", KeyboardEvent, init);
    let submitted = false;
    if (ok) {
      if (el.tagName === "INPUT" && el.form) {
        try {
          const btn = el.form.querySelector("button:not([type]),button[type=submit],input[type=submit]");
          el.form.requestSubmit(btn || undefined);
          submitted = true;
        } catch (_) {}
      } else if (el.tagName === "TEXTAREA" || el.isContentEditable) {
        try {
          D.execCommand("insertLineBreak");
        } catch (_) {}
      } else if (/^(BUTTON|A|SUMMARY)$/.test(el.tagName) || roleOf(el) === "button" || roleOf(el) === "link") {
        el.click();
        submitted = true;
      }
    }
    fire(el, "keyup", KeyboardEvent, init);
    return submitted;
  }

  function tabbables() {
    const list = [];
    walk((e) => {
      if (e.tabIndex >= 0 && !e.disabled && visible(e)) list.push(e);
    });
    return list;
  }

  function pressKey() {
    const raw = String(args.key || "");
    if (!raw) throw new Error("say which key, e.g. Enter, Tab, Escape, ArrowDown, a, Control+a");
    const parts = raw.split("+");
    const key = parts.length > 1 && parts[parts.length - 1] === "" ? "+" : parts.pop();
    const mods = MODS(parts.join("+") + " " + (args.modifiers || ""));
    let el = args.ref != null || args.selector ? target() : deepActive() || D.body;
    if (args.ref != null && el.focus) el.focus({ preventScroll: true });
    const times = Math.min(Math.max(Number(args.repeat) || 1, 1), 50);
    const editable = /^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable;
    if (editable && key.length === 1 && !mods.ctrlKey && !mods.metaKey && sensitive(el)) return { error: `this is a ${sensitive(el)} field. NetScope never types into these.` };
    const result = { ok: true, key: raw, target: (describe(el) || {}).desc };
    for (let i = 0; i < times; i++) {
      el = deepActive() || el;
      if (key === "Enter" && !Object.values(mods).some(Boolean)) {
        result.submitted = pressEnter(el) || undefined;
        continue;
      }
      const init = keyInit(key, mods);
      const ok = fire(el, "keydown", KeyboardEvent, init);
      if (ok) {
        if (key === "Tab") {
          const list = tabbables();
          const at = list.indexOf(el);
          const next = list[(at + (mods.shiftKey ? -1 : 1) + list.length) % list.length];
          if (next) next.focus();
        } else if ((key === "a" || key === "A") && (mods.ctrlKey || mods.metaKey) && editable) {
          if (el.select) el.select();
          else D.execCommand("selectAll");
        } else if (key === " " && !editable && (roleOf(el) === "button" || roleOf(el) === "checkbox" || roleOf(el) === "radio" || roleOf(el) === "switch")) {
          el.click();
        } else if (editable && key === "Backspace") D.execCommand("delete");
        else if (editable && key === "Delete") D.execCommand("forwardDelete");
        else if (editable && key.length === 1 && !mods.ctrlKey && !mods.metaKey) {
          fire(el, "keypress", KeyboardEvent, init);
          insertText(el, key);
        } else if (!editable && /^(ArrowDown|ArrowUp|PageDown|PageUp|Home|End| )$/.test(key) && (el === D.body || el === D.documentElement)) {
          const h = W.innerHeight;
          const dy = { ArrowDown: 40, ArrowUp: -40, PageDown: h * 0.9, " ": h * 0.9, PageUp: -h * 0.9 }[key];
          if (key === "Home") W.scrollTo(0, 0);
          else if (key === "End") W.scrollTo(0, (D.scrollingElement || D.documentElement).scrollHeight);
          else W.scrollBy(0, dy);
        }
      }
      fire(el, "keyup", KeyboardEvent, init);
    }
    return result;
  }

  function selectOption() {
    const el = target();
    if (!el) throw new Error("say which <select> (ref)");
    if (el.tagName !== "SELECT") return { error: `${describe(el).desc} is not a native <select>: click it to open the list, then click the option` };
    const opts = Array.from(el.options);
    const wants = [].concat(args.values || args.value || args.label || (args.index != null ? null : []));
    let picked = [];
    if (args.index != null) picked = [opts[Number(args.index)]].filter(Boolean);
    else {
      for (const w of wants) {
        const s = String(w).toLowerCase();
        const o = opts.find((x) => x.value === String(w)) || opts.find((x) => clean(x.label || x.text).toLowerCase() === s) || opts.find((x) => clean(x.label || x.text).toLowerCase().includes(s));
        if (o) picked.push(o);
      }
    }
    if (!picked.length) return { error: "no option matches", options: opts.slice(0, 40).map((o) => ({ value: o.value, label: clean(o.label || o.text, 60) })) };
    el.focus({ preventScroll: true });
    for (const o of opts) o.selected = el.multiple ? picked.includes(o) : o === picked[0];
    fire(el, "input", Event, {});
    fire(el, "change", Event, {});
    return { ok: true, selected: picked.map((o) => clean(o.label || o.text, 60)), point: point(el) };
  }

  function setChecked() {
    const el = target();
    if (!el) throw new Error("say which checkbox (ref)");
    const want = args.checked !== false;
    const now = el.checked != null && el.tagName === "INPUT" ? el.checked : el.getAttribute("aria-checked") === "true";
    if (now === want) return { ok: true, checked: now, note: "already in that state" };
    const r = click();
    const after = el.checked != null && el.tagName === "INPUT" ? el.checked : el.getAttribute("aria-checked") === "true";
    return Object.assign(r, { checked: after });
  }

  function hover() {
    const el = target();
    if (!el) throw new Error("say what to hover (ref or x and y)");
    const p = point(el);
    const hit = topAt(p.x, p.y);
    hoverAt(hit && el.contains(hit) ? hit : el, p, MODS(args.modifiers));
    return { ok: true, hovered: describe(el).desc, point: p, note: "Synthetic hover runs mouseover/mouseenter handlers; menus that open only with CSS :hover will not open." };
  }

  function scrollable(el) {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (e.scrollHeight > e.clientHeight + 4 || e.scrollWidth > e.clientWidth + 4)) return e;
    }
    return null;
  }

  function mainScroller() {
    const se = D.scrollingElement || D.documentElement;
    if (se.scrollHeight > W.innerHeight + 20) return null; // the window scrolls
    let best = null;
    let area = 0;
    for (const e of D.querySelectorAll("main, [role=main], div, section, article")) {
      if (e.scrollHeight <= e.clientHeight + 20) continue;
      const cs = getComputedStyle(e);
      if (!/(auto|scroll)/.test(cs.overflowY)) continue;
      const a = e.clientWidth * e.clientHeight;
      if (a > area) (area = a), (best = e);
    }
    return best;
  }

  function scroll() {
    const h = W.innerHeight;
    const dir = String(args.direction || "down");
    const amount = args.amount === "page" || args.amount == null ? Math.round(h * 0.85) : Number(args.amount) || Math.round(h * 0.85);
    let el = args.ref != null || args.selector ? target() : null;
    if (el && !args.direction && !args.to) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      return { ok: true, scrolled_to: describe(el).desc };
    }
    const box = el ? scrollable(el) || el : mainScroller();
    const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
    const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
    if (box) {
      if (args.to === "top") box.scrollTo(0, 0);
      else if (args.to === "bottom") box.scrollTo(0, box.scrollHeight);
      else box.scrollBy(dx, dy);
      fire(box, "wheel", WheelEvent, { deltaX: dx, deltaY: dy, clientX: W.innerWidth / 2, clientY: h / 2 });
      return { ok: true, container: describe(box).desc, scroll_top: Math.round(box.scrollTop), at_end: box.scrollTop + box.clientHeight >= box.scrollHeight - 4 };
    }
    if (args.to === "top") W.scrollTo(0, 0);
    else if (args.to === "bottom") W.scrollTo(0, (D.scrollingElement || D.documentElement).scrollHeight);
    else W.scrollBy(dx, dy);
    fire(D.elementFromPoint(W.innerWidth / 2, h / 2) || D.body, "wheel", WheelEvent, { deltaX: dx, deltaY: dy, clientX: W.innerWidth / 2, clientY: h / 2 });
    const se = D.scrollingElement || D.documentElement;
    return { ok: true, scroll_y: Math.round(W.scrollY), page_h: se.scrollHeight, at_end: W.scrollY + h >= se.scrollHeight - 4 };
  }

  async function drag() {
    const from = target();
    if (!from) throw new Error("say what to drag (ref)");
    let to = null;
    let end = null;
    if (args.to_ref != null) {
      const w = R.byId.get(Number(String(args.to_ref).replace(/[^\d]/g, "")));
      to = w && w.deref();
      if (!to || !to.isConnected) throw new Error(`to_ref ${args.to_ref} is gone — call page_snapshot again`);
    }
    const a = point(from);
    if (to) {
      const r = to.getBoundingClientRect();
      end = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    } else if (Number.isFinite(args.to_x) && Number.isFinite(args.to_y)) end = { x: args.to_x, y: args.to_y };
    else throw new Error("say where to drop: to_ref or to_x and to_y");
    const pause = () => new Promise((r) => setTimeout(r, 16));
    const down = mouseInit(a, { button: 0, buttons: 1 });
    fire(from, "pointerdown", PointerEvent, down);
    fire(from, "mousedown", MouseEvent, down);
    const dt = new DataTransfer();
    const draggable = from.closest && from.closest("[draggable=true]");
    if (draggable) fire(draggable, "dragstart", DragEvent, Object.assign(mouseInit(a), { dataTransfer: dt }));
    let over = from;
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const p = { x: Math.round(a.x + ((end.x - a.x) * i) / steps), y: Math.round(a.y + ((end.y - a.y) * i) / steps) };
      const at = topAt(p.x, p.y) || to || from;
      const move = mouseInit(p, { button: 0, buttons: 1 });
      fire(at, "pointermove", PointerEvent, move);
      fire(at, "mousemove", MouseEvent, move);
      if (draggable) {
        if (at !== over) fire(at, "dragenter", DragEvent, Object.assign(mouseInit(p), { dataTransfer: dt }));
        fire(at, "dragover", DragEvent, Object.assign(mouseInit(p), { dataTransfer: dt }));
      }
      over = at;
      await pause();
    }
    const drop = to || topAt(end.x, end.y) || D.body;
    if (draggable) {
      fire(drop, "drop", DragEvent, Object.assign(mouseInit(end), { dataTransfer: dt }));
      fire(draggable, "dragend", DragEvent, Object.assign(mouseInit(end), { dataTransfer: dt }));
    }
    const up = mouseInit(end, { button: 0, buttons: 0 });
    fire(drop, "pointerup", PointerEvent, up);
    fire(drop, "mouseup", MouseEvent, up);
    return { ok: true, dragged: describe(from).desc, onto: (describe(drop) || {}).desc, html5_drag: !!draggable, point: end };
  }

  function dispatchAny() {
    const el = target() || deepActive() || D.body;
    const type = String(args.type || "");
    if (!/^[a-zA-Z][\w:.-]{0,60}$/.test(type)) throw new Error("give the event type, e.g. input, change, focus, mouseenter, submit, my-custom-event");
    const cls = String(args.event_class || (/^(click|dblclick|mouse|contextmenu)/.test(type) ? "MouseEvent" : /^pointer/.test(type) ? "PointerEvent" : /^key/.test(type) ? "KeyboardEvent" : /^(input|beforeinput)$/.test(type) ? "InputEvent" : /^(focus|blur|focusin|focusout)$/.test(type) ? "FocusEvent" : /^wheel$/.test(type) ? "WheelEvent" : /^drag|^drop$/.test(type) ? "DragEvent" : /^touch/.test(type) ? "TouchEvent" : "Event"));
    if (!/^[A-Z]\w*Event$/.test(cls) || typeof W[cls] !== "function") throw new Error(`unknown event class ${cls}`);
    const init = Object.assign({}, args.init && typeof args.init === "object" ? args.init : {});
    if (/^(MouseEvent|PointerEvent|WheelEvent|DragEvent)$/.test(cls) && init.clientX == null) Object.assign(init, mouseInit(point(el)));
    if (cls === "DragEvent" && !init.dataTransfer) init.dataTransfer = new DataTransfer();
    if (cls === "CustomEvent" && args.detail !== undefined) init.detail = args.detail;
    if (cls === "TouchEvent") {
      const p = point(el);
      const t = new Touch({ identifier: 1, target: el, clientX: p.x, clientY: p.y });
      Object.assign(init, { touches: type === "touchend" ? [] : [t], targetTouches: type === "touchend" ? [] : [t], changedTouches: [t] });
    }
    if (type === "focus" && el.focus) el.focus();
    if (type === "blur" && el.blur) el.blur();
    if (type === "submit" && el.tagName === "FORM" && args.native !== false) {
      el.requestSubmit();
      return { ok: true, dispatched: "submit (requestSubmit)", target: describe(el).desc };
    }
    const ok = fire(el, type, W[cls], init);
    return { ok: true, dispatched: `${cls} ${type}`, target: describe(el).desc, default_prevented: !ok };
  }

  async function waitFor() {
    const until = Date.now() + Math.min(Math.max(Number(args.timeout_ms) || 8000, 100), 20000);
    const lc = (s) => String(s || "").toLowerCase();
    const check = () => {
      if (args.text && !lc(D.body && D.body.innerText).includes(lc(args.text))) return false;
      if (args.gone_text && lc(D.body && D.body.innerText).includes(lc(args.gone_text))) return false;
      if (args.selector) {
        const el = D.querySelector(String(args.selector));
        if (!el || !visible(el)) return false;
      }
      if (args.gone_selector && D.querySelector(String(args.gone_selector))) return false;
      if (args.url_contains && !location.href.includes(String(args.url_contains))) return false;
      return true;
    };
    while (Date.now() < until) {
      if (check()) return { ok: true, waited_ms: Math.round(Number(args.timeout_ms || 8000) - (until - Date.now())), url: location.href };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: false, timed_out: true, note: "condition not met in time", url: location.href };
  }

  function readText() {
    const el = args.ref != null || args.selector ? target() : D.querySelector("main, [role=main], article") || D.body;
    const max = Math.min(Number(args.max_chars) || 6000, 40000);
    const t = String(el.innerText || el.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    return { from: (describe(el) || {}).desc || el.tagName.toLowerCase(), chars: t.length, text: t.slice(0, max), truncated: t.length > max || undefined };
  }

  function pageState() {
    const alerts = [];
    for (const a of D.querySelectorAll("[role=alert],[role=status],[aria-live=assertive],[aria-live=polite],.error,.alert,.toast,[class*=error-message]")) {
      if (isOurs(a) || !visible(a)) continue;
      const t = clean(a.innerText, 160);
      if (t && !alerts.includes(t)) alerts.push(t);
      if (alerts.length >= 4) break;
    }
    const invalid = [];
    for (const f of D.querySelectorAll("input:invalid, textarea:invalid, select:invalid, [aria-invalid=true]")) {
      if (!visible(f)) continue;
      invalid.push(`${describe(f).desc}${f.validationMessage ? ": " + clean(f.validationMessage, 80) : ""}`);
      if (invalid.length >= 4) break;
    }
    const dialogs = [];
    for (const d of D.querySelectorAll("dialog[open],[role=dialog],[aria-modal=true]")) if (visible(d)) dialogs.push(clean(nameOf(d) || (d.querySelector("h1,h2,h3") || {}).innerText || "dialog", 80));
    const act = deepActive();
    return {
      url: location.href,
      title: D.title,
      focused: act && act !== D.body ? (describe(act) || {}).desc : undefined,
      dialogs: dialogs.length ? dialogs : undefined,
      messages: alerts.length ? alerts : undefined,
      invalid_fields: invalid.length ? invalid : undefined
    };
  }

  try {
    switch (op) {
      case "snapshot":
        return snapshot();
      case "click":
        return click();
      case "type":
        return typeText();
      case "key":
        return pressKey();
      case "select":
        return selectOption();
      case "check":
        return setChecked();
      case "hover":
        return hover();
      case "scroll":
        return scroll();
      case "drag":
        return drag().catch((e) => ({ error: String((e && e.message) || e) }));
      case "dispatch":
        return dispatchAny();
      case "wait":
        return waitFor();
      case "read":
        return readText();
      case "state":
        return pageState();
      case "describe": {
        const el = target();
        return el ? Object.assign(describe(el), { ref: refOf(el), page_url: location.href, page_title: D.title }) : { error: "no target" };
      }
      default:
        return { error: "unknown action " + op };
    }
  } catch (err) {
    return { error: String((err && err.message) || err).slice(0, 400) };
  }
};
