/* NetScope – ai-browser-tools.js
 * Tools that let the AI use the browser to get a task done: tabs, a
 * numbered map of each page's controls, clicks, typing, keys, options,
 * hover, scroll, drag, any DOM event, waits, and screenshots it can see
 * (Kimi K3.x reads images; Muse gets the page map instead).
 *
 * Approvals: on "Ask before acting: all", every action asks. Otherwise
 * clicks that look like buying, paying, deleting, sending, publishing or
 * submitting a payment form ask first — even on autopilot — unless the
 * developer turned "Ask before risky clicks" off. Typing into password,
 * card or one-time-code fields is refused in the page itself.
 */
"use strict";

(() => {
  const T = window.__netscopeAiTools;
  if (!T || !T.register) return;
  const C = () => window.__netscopeAiClient;
  const CAP = 24000;
  let api = null;

  const aiName = () => (window.__netscopeAi && window.__netscopeAi.aiName ? window.__netscopeAi.aiName() : "Kimi");
  const need = () => {
    if (!api) throw new Error("NetScope is not connected yet");
    return api;
  };
  const tabArg = (a) => {
    if (a.tab_id == null || a.tab_id === "") return undefined;
    const n = Number(a.tab_id);
    if (!Number.isInteger(n)) throw new Error(`tab_id must be a number from list_tabs, not ${JSON.stringify(a.tab_id)}`);
    return n;
  };
  const frameArg = (a) => (Number.isInteger(a.frame_id) ? a.frame_id : undefined);

  function out(obj) {
    let s = typeof obj === "string" ? obj : JSON.stringify(obj);
    s = T.scrubText(s);
    if (s.length <= CAP) return s;
    return JSON.stringify({ truncated: true, note: "Result cut to fit; pass max or a smaller region.", partial: s.slice(0, CAP - 300) });
  }

  // The element an action is aimed at, in the actor's terms.
  function target(a) {
    const t = {};
    if (a.ref != null && a.ref !== "") t.ref = a.ref;
    if (a.selector) t.selector = String(a.selector);
    if (a.target_text) t.target_text = String(a.target_text);
    if (Number.isFinite(a.x) && Number.isFinite(a.y)) {
      t.x = a.x;
      t.y = a.y;
    }
    return t;
  }

  const act = (op, a, args) => need().rpc("browser.act", { tab_id: tabArg(a), frame_id: frameArg(a), op, args });

  async function canSee() {
    const c = C();
    if (!c || !c.canSee) return false;
    const s = await c.loadSettings();
    return c.canSee(s.model);
  }

  /* ------------------------------------------------------------ images */

  // Draws each control's ref on the screenshot (the numbers match
  // page_snapshot) and shrinks it to at most 1280 px wide.
  function annotate(dataUrl, marks, vp) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1280 / img.width);
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0, c.width, c.height);
        if (marks && marks.length && vp && vp.w) {
          const k = c.width / vp.w;
          g.lineWidth = 2;
          g.font = "600 12px system-ui, -apple-system, sans-serif";
          g.textBaseline = "top";
          for (const m of marks) {
            const x = m.x * k;
            const y = m.y * k;
            g.strokeStyle = "rgba(245, 165, 36, 0.95)";
            g.strokeRect(x + 0.5, y + 0.5, Math.max(4, m.w * k), Math.max(4, m.h * k));
            const label = String(m.ref);
            const tw = g.measureText(label).width + 6;
            const ly = y >= 15 ? y - 15 : y;
            g.fillStyle = "rgba(245, 165, 36, 0.95)";
            g.fillRect(x, ly, tw, 15);
            g.fillStyle = "#111827";
            g.fillText(label, x + 3, ly + 1.5);
          }
        }
        const t = document.createElement("canvas");
        const ts = Math.min(1, 360 / c.width);
        t.width = Math.round(c.width * ts);
        t.height = Math.round(c.height * ts);
        t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);
        resolve({ full: c.toDataURL("image/jpeg", 0.72), thumb: t.toDataURL("image/jpeg", 0.6), w: c.width, h: c.height });
      };
      img.onerror = () => reject(new Error("could not read the screenshot"));
      img.src = dataUrl;
    });
  }

  /* -------------------------------------------------------------- tools */

  const EXEC = {
    async list_tabs() {
      return out(await need().rpc("browser.tabs", {}));
    },
    async open_tab(a) {
      return out(await need().rpc("browser.open", { url: a.url, active: !!a.active }));
    },
    async switch_tab(a) {
      return out(await need().rpc("browser.switch", { tab_id: tabArg(a) }));
    },
    async close_tab(a) {
      return out(await need().rpc("browser.close", { tab_id: tabArg(a) }));
    },
    async navigate(a) {
      return out(await need().rpc("browser.navigate", { tab_id: tabArg(a), url: a.url, action: a.action || (a.url ? "go" : "") }));
    },
    async page_snapshot(a) {
      const r = await act("snapshot", a, { max: a.max, all: !!a.all, include_text: !!a.include_text, text_chars: a.text_chars });
      if (r.error) return out(r);
      return out({ tab_id: r.tab_id, elements: r.elements, map: r.text, page_text: r.page_text });
    },
    async take_screenshot(a) {
      const tab = tabArg(a);
      // The map first, so the numbered boxes match what the picture shows.
      const snap = a.marks === false ? null : await act("snapshot", a, { max: 150 }).catch(() => null);
      const shot = await need().rpc("browser.screenshot", { tab_id: tab });
      const img = await annotate(shot.data_url, snap && !snap.error ? snap.marks : null, snap && snap.viewport);
      const sees = await canSee();
      T.addImage({
        data_url: img.full,
        thumb: img.thumb,
        caption: `Screenshot of tab ${shot.tab_id} (${shot.title || shot.url})${snap && !snap.error ? ", numbered boxes are refs from page_snapshot" : ""}.`
      });
      return out({
        tab_id: shot.tab_id,
        url: shot.url,
        title: shot.title,
        size: `${img.w}×${img.h}`,
        image: sees ? "attached in the next message" : `${aiName()} cannot see images here: use this map instead`,
        refs_marked: snap && !snap.error ? snap.marks.length : 0,
        map: sees ? undefined : snap && snap.text,
        note: shot.flashed ? "The tab was brought forward for a moment to take the picture." : undefined
      });
    },
    async click(a) {
      return out(await act("click", a, Object.assign(target(a), { button: a.button, count: a.count, modifiers: a.modifiers, force: !!a.force })));
    },
    async type_text(a) {
      const t = target(a);
      if (a.field) t.target_text = String(a.field);
      return out(await act("type", a, Object.assign(t, { text: a.text == null ? "" : String(a.text), clear: a.clear !== false, submit: !!a.submit })));
    },
    async press_key(a) {
      return out(await act("key", a, Object.assign(target(a), { key: a.key, modifiers: a.modifiers, repeat: a.repeat })));
    },
    async select_option(a) {
      return out(await act("select", a, Object.assign(target(a), { value: a.value, label: a.label, index: a.index, values: a.values })));
    },
    async set_checked(a) {
      return out(await act("check", a, Object.assign(target(a), { checked: a.checked !== false })));
    },
    async hover(a) {
      return out(await act("hover", a, target(a)));
    },
    async scroll(a) {
      return out(await act("scroll", a, Object.assign(target(a), { direction: a.direction, amount: a.amount, to: a.to })));
    },
    async drag(a) {
      return out(await act("drag", a, Object.assign(target(a), { to_ref: a.to_ref, to_x: a.to_x, to_y: a.to_y })));
    },
    async dispatch_event(a) {
      return out(await act("dispatch", a, Object.assign(target(a), { type: a.type, event_class: a.event_class, init: a.init, detail: a.detail })));
    },
    async wait_for(a) {
      return out(await act("wait", a, { text: a.text, gone_text: a.gone_text, selector: a.selector, gone_selector: a.gone_selector, url_contains: a.url_contains, timeout_ms: a.timeout_ms }));
    },
    async read_text(a) {
      return out(await act("read", a, Object.assign(target(a), { max_chars: a.max_chars })));
    }
  };

  /* ---------------------------------------------------------- approvals */

  const ACTIONS = { click: "click", type_text: "type into", press_key: "press a key on", select_option: "pick an option in", set_checked: "tick", drag: "drag", dispatch_event: "fire an event on", hover: "hover", scroll: "scroll" };

  async function approve(name, a, policy) {
    if (name === "open_tab" || name === "navigate") {
      // "For changes" keeps the same guard as http_request: going to another
      // site could carry captured data out in its URL (a planted instruction).
      let other = false;
      if (policy === "writes" && a.url) {
        try {
          const here = new URL(T.inspectedPage() || "about:blank").hostname;
          other = new URL(/^https?:/i.test(a.url) ? a.url : "https://" + a.url).hostname !== here;
        } catch (_) {
          other = true;
        }
      }
      if (policy !== "all" && !other) return null;
      return { kind: "browser", title: `${aiName()} wants to ${name === "open_tab" ? "open" : "go to"} ${a.url || a.action || "a page"}`, line: String(a.url || a.action || "") };
    }
    if (!(name in ACTIONS)) return undefined;
    if (name === "hover" || name === "scroll") {
      return policy === "all" ? { kind: "browser", title: `${aiName()} wants to ${name} on the page`, line: "" } : null;
    }
    const settings = await C().loadSettings();
    const confirmRisky = settings.confirmRisky !== false;
    const t = target(a);
    if (name === "type_text" && a.field) t.target_text = String(a.field);
    let d = null;
    if (Object.keys(t).length) {
      try {
        d = await act("describe", a, t);
        if (d && d.error) d = null;
      } catch (_) {
        d = null;
      }
    }
    let risky = !!(d && d.risky);
    if (name === "type_text" && a.submit && d && d.form) risky = risky || d.form.method === "POST" || !!d.form.payment_fields;
    if (name === "press_key" && /enter/i.test(String(a.key || "")) && d && d.form && d.form.method === "POST") risky = true;
    if (name === "dispatch_event" && /^submit$/i.test(String(a.type || ""))) risky = true;
    const ask = policy === "all" || (policy === "writes" && risky) || (policy === "never" && risky && confirmRisky);
    if (!ask) return null;
    const what = d ? d.desc : a.target_text ? `"${a.target_text}"` : a.ref != null ? `element ${a.ref}` : "the page";
    return {
      kind: "browser",
      risky,
      title: `${aiName()} wants to ${ACTIONS[name]} ${what}`,
      line: d && d.page_url ? `${d.page_title ? d.page_title + " — " : ""}${d.page_url}` : "",
      detail: [name === "type_text" ? `Text: ${String(a.text == null ? "" : a.text).slice(0, 400)}${a.submit ? "\nThen press Enter." : ""}` : "", d && d.form ? `Form: ${d.form.method} ${d.form.action}` : "", name === "dispatch_event" ? `Event: ${a.type}` : ""].filter(Boolean).join("\n"),
      why: risky ? "This looks like it buys, pays, deletes, sends, publishes or submits something." : ""
    };
  }

  /* ------------------------------------------------------------ schemas */

  const fn = (name, description, properties, required) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties: properties || {}, required: required || [], additionalProperties: false } }
  });
  const TAB = { type: "integer", description: "Tab to act on (list_tabs). Default: the page NetScope is open on." };
  const FRAME = { type: "integer", description: "A cross-origin iframe's frame_id from list_frames. Default: the top page." };
  const AIM = {
    tab_id: TAB,
    frame_id: FRAME,
    ref: { type: "integer", description: "The element's number from page_snapshot or the screenshot's boxes. Preferred." },
    target_text: { type: "string", description: "Or: the visible name of the control, e.g. \"Sign in\"." },
    selector: { type: "string", description: "Or: a CSS selector." },
    x: { type: "number", description: "Or: viewport x in CSS pixels (with y), from the map's @x,y or the screenshot." },
    y: { type: "number" }
  };

  const DEFS = [
    fn("list_tabs", "Every open tab: tab_id, title, url, which is active, which you opened, and which is the page NetScope is open on (this_tab)."),
    fn("open_tab", "Open a URL in a new tab and wait for it to load. Background by default; you can act on background tabs.", { url: { type: "string" }, active: { type: "boolean", description: "Bring it to the front. Default false." } }, ["url"]),
    fn("switch_tab", "Bring a tab to the front so the developer sees it.", { tab_id: TAB }, ["tab_id"]),
    fn("close_tab", "Close a tab you opened (only those).", { tab_id: TAB }, ["tab_id"]),
    fn("navigate", "Go to a URL in a tab, or back, forward or reload. Waits for the load.", { tab_id: TAB, url: { type: "string" }, action: { type: "string", enum: ["go", "back", "forward", "reload"] } }),
    fn(
      "page_snapshot",
      "See a tab as text: title, URL, scroll position, open dialogs, headings, and every visible control numbered, e.g. [12] button \"Pay now\" @77,222 (center x,y), with values and states (checked, expanded, disabled, focused). Call before acting and again after the page changes; refs go stale on navigation.",
      { tab_id: TAB, frame_id: FRAME, all: { type: "boolean", description: "Also list controls outside the visible area. Default: up to 60 of them." }, max: { type: "integer", description: "Max controls. Default 160, max 500." }, include_text: { type: "boolean", description: "Also return the main content's text." }, text_chars: { type: "integer" } }
    ),
    fn(
      "take_screenshot",
      "Look at a tab: a picture of its visible area with numbered boxes on the controls (the same refs as page_snapshot). Use it for layout, images, charts, colours, visual bugs, CAPTCHAs you must hand back, or when the map is not enough. A background tab is flipped to the front for a moment.",
      { tab_id: TAB, marks: { type: "boolean", description: "Draw the numbered boxes. Default true; false for a clean picture." } }
    ),
    fn(
      "click",
      "Click an element: pointer and mouse events, focus, then click, as a person would. Reports navigation, new tabs, dialogs, messages and invalid fields that followed. Links that open a new tab open as a background tab.",
      Object.assign({}, AIM, { button: { type: "string", enum: ["left", "right", "middle"] }, count: { type: "integer", description: "2 for a double-click." }, modifiers: { type: "string", description: "e.g. \"shift\", \"ctrl+shift\", \"meta\"." }, force: { type: "boolean", description: "Click even if another element covers it." } })
    ),
    fn(
      "type_text",
      "Type into a text field, textarea or rich editor (key events per character, framework-friendly). Replaces the current value unless clear is false. Never works on password, card or one-time-code fields — ask the developer to fill those.",
      Object.assign({}, AIM, { field: { type: "string", description: "Or: the field's label or placeholder." }, text: { type: "string" }, clear: { type: "boolean", description: "Default true." }, submit: { type: "boolean", description: "Press Enter afterwards (submits a search or form)." } }),
      ["text"]
    ),
    fn("press_key", "Press a key or shortcut on the focused element (or ref): Enter, Tab, Shift+Tab, Escape, Backspace, ArrowDown, PageDown, Control+a, a single character…", Object.assign({}, AIM, { key: { type: "string" }, modifiers: { type: "string" }, repeat: { type: "integer", description: "Press it N times (max 50)." } }), ["key"]),
    fn("select_option", "Choose an option in a native <select> by value, label or index (for custom dropdowns: click to open, then click the option).", Object.assign({}, AIM, { value: { type: "string" }, label: { type: "string" }, index: { type: "integer" }, values: { type: "array", items: { type: "string" }, description: "Several, for a multi-select." } })),
    fn("set_checked", "Tick or untick a checkbox, radio or switch (clicks only if it is not already in that state).", Object.assign({}, AIM, { checked: { type: "boolean" } })),
    fn("hover", "Move the pointer over an element (mouseover/mouseenter): opens JS-driven menus and tooltips. CSS-only :hover menus do not open.", AIM),
    fn("scroll", "Scroll the page or the scrollable area holding ref: a direction and amount, to top/bottom, or just bring ref into view (ref with no direction).", Object.assign({}, AIM, { direction: { type: "string", enum: ["down", "up", "left", "right"] }, amount: { type: "number", description: "Pixels. Default: most of a screen." }, to: { type: "string", enum: ["top", "bottom"] } })),
    fn("drag", "Drag an element onto another (to_ref) or to a point: pointer/mouse moves plus HTML5 drag and drop when the element is draggable. For sortable lists, kanban boards, sliders.", Object.assign({}, AIM, { to_ref: { type: "integer" }, to_x: { type: "number" }, to_y: { type: "number" } })),
    fn(
      "dispatch_event",
      "Fire any DOM event on an element when the other actions are not enough: input, change, focus, blur, submit, keydown with init {key}, mouseenter, wheel, touchstart, dragover, a custom event with detail… event_class is guessed from the type unless given.",
      Object.assign({}, AIM, { type: { type: "string" }, event_class: { type: "string", description: "e.g. Event, MouseEvent, KeyboardEvent, InputEvent, PointerEvent, FocusEvent, WheelEvent, TouchEvent, DragEvent, CustomEvent." }, init: { type: "object", description: "Event init fields, e.g. {\"key\":\"Enter\"} or {\"deltaY\":400}." }, detail: { description: "CustomEvent detail." } }),
      ["type"]
    ),
    fn("wait_for", "Wait until text appears or disappears, an element (CSS selector) shows or goes, or the URL contains something. Max 20 s.", { tab_id: TAB, frame_id: FRAME, text: { type: "string" }, gone_text: { type: "string" }, selector: { type: "string" }, gone_selector: { type: "string" }, url_contains: { type: "string" }, timeout_ms: { type: "integer" } }),
    fn("read_text", "Read the text of an element (ref or selector) or of the page's main content.", Object.assign({}, AIM, { max_chars: { type: "integer", description: "Default 6000." } }))
  ];

  T.register(DEFS, EXEC, { approve });

  window.__netscopeBrowserTools = {
    attach(a) {
      api = a;
    },
    annotate
  };
})();
