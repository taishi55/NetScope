/* NetScope – ai-inspect-tools.js
 * Tools that let the AI understand the whole front end, not just its traffic:
 * the console (logs, errors, route changes), the app's framework, routes,
 * component tree and state, every kind of browser storage, a semantic DOM
 * outline, and the JavaScript itself — bundles and, through source maps, the
 * original source files.
 *
 * All read-only. They register into ai-tools.js, so they share its budget,
 * size caps and redaction: with "Mask secrets" on, values of secret-looking
 * keys and cookies become shape hints and token patterns are scrubbed.
 */
"use strict";

(() => {
  const T = window.__netscopeAiTools;
  if (!T || !T.register) return;
  const CAP = 24000; // chars per result

  let api = null;
  const attach = (a) => {
    api = a;
  };

  const inspect = async (op, args) => {
    if (!api) throw new Error("NetScope is not connected yet");
    const r = await api.rpc("inspect", { op, args: args || {} });
    if (r && r.error && Object.keys(r).length <= 2) throw new Error(r.error);
    return r;
  };

  // Long results are cut, never dropped: the model learns what to narrow.
  function out(obj, hint) {
    let s = JSON.stringify(obj);
    s = T.scrubText(s);
    if (s.length <= CAP) return s;
    return JSON.stringify({ truncated: true, note: hint || "Result cut to fit; narrow the request.", partial: s.slice(0, CAP - 300) });
  }

  const SECRET_KEY = /(token|auth|session|sess|jwt|secret|passw|pwd|api[-_]?key|credential|bearer|^sid$|csrf|xsrf|refresh|cookie|signature|private)/i;
  // With masking on, a secret-looking key keeps its name and size but not its value.
  function maskValue(key, value) {
    if (!T.isRedacting() || typeof value !== "string" || !SECRET_KEY.test(String(key || ""))) return value;
    const jwt = T.jwtHint(value);
    return `<redacted ${value.length} chars${jwt ? ", " + jwt : ""}>`;
  }

  const relT = (ts) => Math.max(0, (ts || 0) - (api ? api.getStartedAt() : 0));

  /* ------------------------------------------------------------ console */

  function toolConsole(a) {
    const logs = api ? api.getLogs() : [];
    const level = String(a.level || "all");
    const want = a.contains ? String(a.contains).toLowerCase() : "";
    const since = Number(a.since_t) || 0;
    const counts = {};
    for (const l of logs) counts[l.level] = (counts[l.level] || 0) + 1;
    let rows = logs.filter((l) => {
      if (level === "errors_and_warnings" ? l.level !== "error" && l.level !== "warn" : level !== "all" && l.level !== level) return false;
      if (since && relT(l.ts) < since) return false;
      if (want && !(l.text + " " + (l.source || "")).toLowerCase().includes(want)) return false;
      return true;
    });
    // Identical consecutive messages collapse into one row with a count.
    const grouped = [];
    for (const l of rows) {
      const last = grouped[grouped.length - 1];
      if (a.group !== false && last && last.level === l.level && last.text === l.text && last.source === l.source) last.repeat = (last.repeat || 1) + 1;
      else grouped.push(Object.assign({}, l));
    }
    const limit = Math.min(Number(a.limit) || 60, 300);
    const newest = grouped.slice(-limit);
    const single = newest.length === 1;
    return out(
      {
        total: logs.length,
        by_level: counts,
        matched: rows.length,
        shown: newest.length,
        note: grouped.length > newest.length ? `showing the newest ${newest.length} of ${grouped.length}; use since_t, contains or level to narrow` : undefined,
        logs: newest.map((l) => {
          const row = { id: l.id, t: relT(l.ts), level: l.level, kind: l.kind !== "console" ? l.kind : undefined, text: single ? l.text : l.text.slice(0, 600), source: l.source || undefined };
          if (l.frame) row.frame = l.frame.slice(0, 160);
          if (l.repeat) row.repeat = l.repeat;
          if (l.stack && (a.include_stack || single)) row.stack = l.stack;
          return row;
        })
      },
      "Too many logs; filter with level, contains or since_t."
    );
  }

  /* ----------------------------------------------------------- overview */

  async function toolOverview(a) {
    const o = await inspect("overview", { frame_id: a && a.frame_id });
    const logs = api ? api.getLogs() : [];
    const errors = logs.filter((l) => l.level === "error");
    o.console = {
      messages: logs.length,
      errors: errors.length,
      warnings: logs.filter((l) => l.level === "warn").length,
      route_changes: logs.filter((l) => l.level === "route").length,
      latest_errors: errors.slice(-4).map((l) => `${l.kind !== "console" ? l.kind + ": " : ""}${l.text.slice(0, 200)}${l.source ? " @ " + l.source : ""}`)
    };
    o.network = { captured_entries: api ? api.getEntries().filter((e) => e.kind !== "nav").length : 0, hint: "list_endpoints maps the API" };
    return out(o, "Overview too large; use the focused tools (list_routes, get_component_tree, get_app_state, get_storage).");
  }

  /* ------------------------------------------------------------- routes */

  async function toolRoutes() {
    const r = await inspect("routes");
    // Routes the app actually navigated to while NetScope was watching.
    const seen = new Map();
    for (const l of api ? api.getLogs() : []) {
      if (l.level !== "route") continue;
      let p = l.text;
      try {
        const u = new URL(l.text);
        p = u.pathname;
      } catch (_) {}
      seen.set(p, (seen.get(p) || 0) + 1);
    }
    if (seen.size) r.visited_while_watching = Array.from(seen.entries()).map(([p, n]) => `${p}${n > 1 ? " ×" + n : ""}`);
    return out(r, "Too many routes; the first sources are the most authoritative.");
  }

  /* ------------------------------------------------------- components */

  const toolComponents = async (a) => out(await inspect("components", { max_depth: a.max_depth, max_nodes: a.max_nodes, filter: a.filter, frame_id: a.frame_id }), "Tree too large; lower max_nodes or set filter.");

  /* ------------------------------------------------------------- state */

  const toolState = async (a) => out(await inspect("state", { source: a.source, path: a.path, max_depth: a.max_depth, frame_id: a.frame_id }), "State too large; go deeper with path (e.g. 'user.profile' or 'items.0').");

  /* ----------------------------------------------------------- storage */

  async function toolStorage(a) {
    const area = String(a.area || "local");
    if (area === "local" || area === "session") {
      const r = await inspect("storage", { area, key: a.key, limit: a.limit, offset: a.offset, frame_id: a.frame_id });
      if (r.items) for (const it of r.items) it.preview = maskValue(it.key, it.preview);
      if (r.value != null) r.value = maskValue(r.key, r.value);
      return out(r, "Too many keys; page with offset/limit or read one key.");
    }
    if (area === "cookies") {
      const r = await inspect("cookies", { value_chars: a.key ? 4000 : 300 });
      if (r.cookies) {
        if (a.key) r.cookies = r.cookies.filter((c) => c.name === a.key);
        // Cookies are mostly session state: with masking on, every value is hidden.
        if (T.isRedacting()) for (const c of r.cookies) c.value = `<redacted ${c.chars} chars${T.jwtHint(c.value) ? ", " + T.jwtHint(c.value) : ""}>`;
      }
      return out(r);
    }
    if (area === "indexeddb") return out(await inspect("idb", { db: a.db, store: a.store, limit: a.limit, offset: a.offset, max_depth: a.max_depth, frame_id: a.frame_id }), "Too many records; lower limit or page with offset.");
    if (area === "cache") return out(await inspect("cache", { cache: a.cache, limit: a.limit, offset: a.offset }));
    throw new Error("area must be local, session, cookies, indexeddb or cache");
  }

  /* --------------------------------------------------------------- DOM */

  const toolDom = async (a) => out(await inspect("dom", { selector: a.selector, max_depth: a.max_depth, max_lines: a.max_lines, include_text: a.include_text, frame_id: a.frame_id }), "Outline too long; pass a selector for one region.");

  /* ----------------------------------------------- network and security */

  async function toolNetwork(a) {
    if (a.id != null) {
      const r = await api.rpc("res.get", { id: a.id });
      if (!r) throw new Error(`no recorded request with id ${a.id}`);
      return out(Object.assign({}, r, { reqHeaders: T.redactHeaders(r.reqHeaders), resHeaders: T.redactHeaders(r.resHeaders), reqHeaderText: undefined, resHeaderText: undefined }));
    }
    const r = await api.rpc("res.list", { type: a.type, failed: a.failed, status: a.status, host: a.host, contains: a.contains, limit: a.limit, offset: a.offset });
    if (!r.total) {
      // Not recorded yet (NetScope opened after the page loaded): fall back to Resource Timing.
      const rt = await inspect("resources", { limit: a.limit });
      return out({ recording: r.recording, note: "No requests recorded for this tab yet — recording starts when NetScope opens on a tab; reload the page for the full list with status and headers. Showing the browser's Resource Timing instead.", resource_timing: rt }, "Too many resources; filter with type or contains.");
    }
    return out(r, "Too many requests; filter with type, failed, host or contains, or page with offset.");
  }

  const toolSecurity = async () => out(await api.rpc("res.security", {}));

  /* ------------------------------------------------ elements and design */

  const toolStyles = async (a) => out(await inspect("styles", { selector: a.selector, index: a.index, frame_id: a.frame_id }), "Too many matched rules; pick a more specific element.");
  const toolDesign = async (a) => out(await inspect("design", { frame_id: a.frame_id }), "Design summary too large.");
  const toolHandlers = async (a) => out(await inspect("handlers", { selector: a.selector, only_handled: a.only_handled, limit: a.limit, frame_id: a.frame_id }), "Too many elements; pass a selector or only_handled.");
  const toolA11y = async (a) => out(await inspect("a11y", { frame_id: a.frame_id }), "Report too large.");
  const toolPerf = async () => out(await inspect("performance"));
  const toolFrames = async () => out(await inspect("frames"));
  const toolFlags = async (a) => out(await inspect("flags", { frame_id: a.frame_id }), "Too many flags; ask about one source.");

  /* ----------------------------------------------------------- sources */

  const toolListSources = async (a) => out(await api.rpc("sources.list", { refresh: !!a.refresh, file_limit: a.file_limit }), "Too many files; use search_sources to find what you need.");
  const toolSearchSources = async (a) =>
    out(await api.rpc("sources.search", { query: a.query, regex: a.regex, case_sensitive: a.case_sensitive, scope: a.scope, include_vendor: a.include_vendor, limit: a.limit, context_chars: a.context_chars }), "Too many hits; make the query more specific.");
  const toolReadSource = async (a) => out(await api.rpc("sources.read", { file: a.file, url: a.url, line: a.line, around: a.around, lines: a.lines, offset: a.offset, length: a.length }), "Slice too long; read fewer lines.");

  /* ------------------------------------------------------------ schema */

  const fn = (name, description, properties, required) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties: properties || {}, required: required || [], additionalProperties: false } }
  });

  const FRAME = { frame_id: { type: "integer", description: "Inspect this frame instead of the top page (ids from list_frames)." } };

  const DEFS = [
    fn(
      "get_app_overview",
      "Start here to understand the app as a whole: frameworks and versions (React, Next.js, Remix, Vue, Nuxt, Angular, SvelteKit, …), build info (Next buildId, data fetching mode, public runtime config), third-party services (analytics, auth, payments, error tracking, feature flags), meta tags, inline JSON data, scripts, a storage summary (local/session/cookies/IndexedDB/Cache/service workers), DOM stats, performance timings, first- vs third-party hosts, app-defined globals, and console error counts.",
      Object.assign({}, FRAME)
    ),
    fn(
      "get_console_logs",
      "The page's console: log/info/warn/error/debug messages with their source file:line, uncaught exceptions, unhandled promise rejections, failed resource loads, CSP violations, and SPA route changes (level 'route'). Use it for runtime errors and to see what the app logs about its own behavior.",
      {
        level: { type: "string", enum: ["all", "errors_and_warnings", "error", "warn", "info", "log", "debug", "trace", "route"], description: "Default all." },
        contains: { type: "string", description: "Case-insensitive text filter (message or source)." },
        since_t: { type: "integer", description: "Only messages after this many ms since capture start." },
        include_stack: { type: "boolean", description: "Include stack traces (always included when one message matches)." },
        group: { type: "boolean", description: "Collapse identical consecutive messages. Default true." },
        limit: { type: "integer", description: "Newest N. Default 60, max 300." }
      }
    ),
    fn(
      "list_routes",
      "The app's routes: router tables (React Router / Remix manifests with loader and action flags, Next.js build manifest pages, Vue Router / Nuxt routes, Gatsby pages, <Route path> elements), the routes visited while NetScope watched, internal links grouped into path patterns, and form actions. Loaders, actions and form actions are server endpoints.",
      {}
    ),
    fn(
      "get_component_tree",
      "The rendered component tree (React fibers, Vue instances, Angular components, Svelte dev metadata, Astro islands, web components) with prop names, hook counts and source file:line in dev builds. Repeated siblings collapse to 'Name ×N'. Production builds have minified names.",
      {
        filter: { type: "string", description: "Only components whose name contains this." },
        max_nodes: { type: "integer", description: "Default 300, max 2000." },
        max_depth: { type: "integer", description: "Default 40." },
        frame_id: FRAME.frame_id
      }
    ),
    fn(
      "get_app_state",
      "Client-side state. Without source: lists what is available (Redux store, React Query cache — every query key with its data, Apollo cache, Next.js __NEXT_DATA__, Nuxt payload, Pinia, Vuex, Remix loader data, Inertia page, and globals like window.__INITIAL_STATE__ or window.config). With source (and optional path): its shape and values. Any global works as source 'window.NAME'.",
      {
        source: { type: "string", description: "e.g. 'redux', 'react_query', 'apollo', 'next_data', 'pinia', 'window.__INITIAL_STATE__'." },
        path: { type: "string", description: "Dot path inside it, e.g. 'user.profile' or 'items.0'." },
        max_depth: { type: "integer", description: "Default 4, max 8." },
        frame_id: FRAME.frame_id
      }
    ),
    fn(
      "get_storage",
      "Browser storage for this site, like DevTools' Application tab. area local/session: keys with sizes and previews, or one key's full value with its JSON shape. cookies: every cookie the browser sends to this page, including HttpOnly ones, with flags (Secure, SameSite, expiry). indexeddb: databases → stores (keyPath, indexes, counts), or records of one store. cache: Cache Storage entries.",
      {
        area: { type: "string", enum: ["local", "session", "cookies", "indexeddb", "cache"] },
        key: { type: "string", description: "local/session: one key's full value. cookies: one cookie." },
        db: { type: "string", description: "indexeddb: database name (omit to list all)." },
        store: { type: "string", description: "indexeddb: object store (default: the first)." },
        cache: { type: "string", description: "cache: one cache's name." },
        limit: { type: "integer" },
        offset: { type: "integer" },
        max_depth: { type: "integer", description: "indexeddb: depth of record values. Default 4." },
        frame_id: FRAME.frame_id
      },
      ["area"]
    ),
    fn(
      "get_dom_outline",
      "A semantic outline of the page as rendered: landmarks, headings, navigation and links, forms with method, action and every field (name, type, required, autocomplete) and buttons, tables with their columns, lists, dialogs, iframes, custom elements and shadow roots, ids, roles and data-testids. Hidden elements are marked.",
      {
        selector: { type: "string", description: "CSS selector of one region (default: the whole body)." },
        max_lines: { type: "integer", description: "Default 260, max 800." },
        max_depth: { type: "integer", description: "Default 12." },
        include_text: { type: "boolean", description: "Include heading/button/link text. Default true." },
        frame_id: FRAME.frame_id
      }
    ),
    fn(
      "get_network_requests",
      "Every request the tab made, like DevTools' Network panel: the page document, scripts, stylesheets, images, fonts, media, iframes, beacons, EventSource, Web Worker and Service Worker requests — type, method, status, size, time, cache, redirects and errors (no bodies; fetch/XHR bodies are in list_requests / get_request). With id: one request's full request and response headers. Recording starts when NetScope opens on the tab.",
      {
        type: { type: "string", enum: ["all", "main_frame", "sub_frame", "script", "stylesheet", "image", "font", "xmlhttprequest", "media", "ping", "websocket", "other"] },
        failed: { type: "boolean", description: "Only errors and 4xx/5xx." },
        status: { type: "string", description: "Status class, e.g. '3' for redirects." },
        host: { type: "string" },
        contains: { type: "string", description: "URL substring." },
        id: { type: "integer", description: "One request with all headers." },
        limit: { type: "integer", description: "Default 80, max 400." },
        offset: { type: "integer" }
      }
    ),
    fn(
      "get_security_report",
      "The page document's security headers analysed (CSP directives and weaknesses, HSTS, framing, nosniff, referrer and permissions policies, COOP/COEP/CORP), cookies it sets with their flags, CORS policy per API host, and hosting/backend fingerprints (Server, X-Powered-By, CDN and platform headers, framework session cookies) for this site and third parties — evidence for how the backend is built.",
      {}
    ),
    fn(
      "get_styles",
      "One element as the Elements panel's Styles/Computed panes show it: its box (position, size, visibility), computed CSS that differs from defaults, the stylesheet rules that match it (with file and @media), inline style and CSS variables in scope.",
      Object.assign({ selector: { type: "string", description: "CSS selector." }, index: { type: "integer", description: "Which match (0-based). Default 0." } }, FRAME),
      ["selector"]
    ),
    fn(
      "get_design_system",
      "The design system as used: CSS variables / design tokens by prefix, text and background color palette, font families and loaded fonts, font-size scale, border radii, shadows, breakpoints, dark-mode support, flex vs grid usage, and the CSS approach (Tailwind, Bootstrap, MUI, Chakra, Radix/shadcn, styled-components, Emotion, CSS Modules, scoped styles, icon sets).",
      Object.assign({}, FRAME)
    ),
    fn(
      "get_event_handlers",
      "What each button, link, input and form does: the handlers attached through React/Vue props (with the component that rendered it), Angular (dev mode), jQuery, inline on* attributes and htmx/Alpine/Livewire/Stimulus attributes, plus link targets and form actions.",
      Object.assign({ selector: { type: "string", description: "Only inside this region." }, only_handled: { type: "boolean", description: "Skip elements with no handler or target." }, limit: { type: "integer", description: "Default 150, max 400." } }, FRAME)
    ),
    fn(
      "get_accessibility_report",
      "An accessibility audit: landmarks, heading outline (skipped levels, h1 count), every control's role and accessible name, missing names and alt text, duplicate ids, positive tabindex, focusable elements inside aria-hidden, and WCAG AA text contrast failures with the colors.",
      Object.assign({}, FRAME)
    ),
    fn(
      "get_performance_report",
      "Core Web Vitals recorded from page start — LCP with its element, CLS with the elements that shifted, INP with the slow interaction (input delay, processing), FCP, TTFB, each rated — plus long tasks, long animation frames with the scripts and functions that blocked, JS heap over time, navigation timing, Server-Timing and the slowest resources.",
      {}
    ),
    fn("list_frames", "Every frame in the tab (iframes, including cross-origin ones) with its URL, title, frameworks, forms, inputs and scripts. Pass a frame_id to the other inspection tools to read that frame.", {}),
    fn(
      "get_flags_and_i18n",
      "Feature flags and experiments (LaunchDarkly, GrowthBook, Optimizely, PostHog, Flagsmith, Statsig, Split, Unleash, ConfigCat, and flag-like storage keys and cookies) with their current values; internationalisation (html lang/dir, i18next / react-intl / vue-i18n / Next.js locales with sample keys, hreflang alternates, Intl locale and time zone); Web/Shared Workers the page started and its EventSource streams.",
      Object.assign({}, FRAME)
    ),
    fn(
      "list_sources",
      "The page's JavaScript like the Sources panel: every bundle and chunk it loaded (first- or third-party, size, source map), and — when the site ships source maps — the original source file tree (app files by folder, npm packages with file counts). Original files with embedded content can be searched and read.",
      {
        refresh: { type: "boolean", description: "Re-list scripts (after navigation or lazy loading)." },
        file_limit: { type: "integer", description: "Max app files in the tree. Default 400." }
      }
    ),
    fn(
      "search_sources",
      "Search the app's code: original source files (via source maps) first, then inline scripts and first-party bundles. Finds API endpoints and clients, auth and token handling, feature flags, permission checks, validation rules, env/config keys, error messages and route definitions — the frontend logic that reveals how the server behaves. Third-party scripts and node_modules are skipped unless include_vendor.",
      {
        query: { type: "string" },
        regex: { type: "boolean", description: "Treat query as a JavaScript regex." },
        case_sensitive: { type: "boolean" },
        scope: { type: "string", enum: ["all", "original", "bundles"], description: "Default all." },
        include_vendor: { type: "boolean", description: "Also search node_modules and third-party scripts." },
        limit: { type: "integer", description: "Default 40, max 150 hits." },
        context_chars: { type: "integer", description: "Snippet context each side. Default 100." }
      },
      ["query"]
    ),
    fn(
      "read_source",
      "Read code with line numbers: an original source file by path (from list_sources / search_sources, e.g. 'src/api/orders.ts') or a bundle by URL (minified bundles are paged by character offset).",
      {
        file: { type: "string", description: "Original file path (suffix match is fine)." },
        url: { type: "string", description: "Script URL, or 'inline script #N'." },
        line: { type: "integer", description: "First line (or the center with around)." },
        around: { type: "integer", description: "Lines of context around line." },
        lines: { type: "integer", description: "How many lines. Default 200, max 600." },
        offset: { type: "integer", description: "Minified bundles: character offset." },
        length: { type: "integer", description: "Minified bundles: characters. Default 12000." }
      }
    )
  ];

  T.register(DEFS, {
    get_app_overview: toolOverview,
    get_console_logs: toolConsole,
    list_routes: toolRoutes,
    get_component_tree: toolComponents,
    get_app_state: toolState,
    get_storage: toolStorage,
    get_dom_outline: toolDom,
    get_network_requests: toolNetwork,
    get_security_report: toolSecurity,
    get_styles: toolStyles,
    get_design_system: toolDesign,
    get_event_handlers: toolHandlers,
    get_accessibility_report: toolA11y,
    get_performance_report: toolPerf,
    list_frames: toolFrames,
    get_flags_and_i18n: toolFlags,
    list_sources: toolListSources,
    search_sources: toolSearchSources,
    read_source: toolReadSource
  });

  window.__netscopeInspectTools = { attach };
})();
