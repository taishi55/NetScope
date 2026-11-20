/* NetScope – page-inspect.js
 * The page inspector: one self-contained function that the background worker
 * runs in a tab's MAIN world with chrome.scripting.executeScript({ func }).
 * It must not reference anything outside its own body (it is serialized).
 *
 * Read-only by design: it never runs property getters (state is read from
 * plain data properties), never writes storage, and opens IndexedDB without a
 * version so it can never create or upgrade a database. Every result is
 * size-capped and JSON-safe.
 *
 *   overview    frameworks and versions, build info, meta, scripts, storage
 *               summary, service workers, performance, third parties, globals
 *   routes      router tables (React Router, Remix, Next, Nuxt, Vue, Gatsby…)
 *               plus the site's internal links grouped into path patterns
 *   components  React / Vue / Angular / Svelte / Astro / custom-element tree
 *   state       Redux, React Query, Apollo, Next data, Nuxt, Pinia, Vuex,
 *               Inertia, Remix loader data and app globals: shape + values
 *   storage     localStorage / sessionStorage
 *   idb         IndexedDB databases, stores, indexes, counts, records
 *   cache       Cache Storage
 *   dom         semantic outline: landmarks, headings, forms, tables, lists
 *   scripts     script tags, inline scripts, loaded chunks, import maps
 *   globals     window properties the app added (diffed against a blank frame)
 *   styles      one element: box, computed CSS, matched rules, variables
 *   design      design tokens (CSS variables), colors, fonts, type scale,
 *               radii, shadows, breakpoints, CSS framework / approach
 *   handlers    interactive elements and what handles them (React/Vue/
 *               Angular/jQuery/inline/htmx…)
 *   a11y        accessibility audit: names, landmarks, headings, alt, ids,
 *               tabindex, WCAG contrast
 *   performance Web Vitals (recorded from page start by net-hook.js), long
 *               tasks and animation frames, heap over time
 *   resources   Resource Timing for everything the page loaded
 *   frame       a one-frame summary (run in every frame for the frame list)
 *   flags       feature flags and experiments, i18n, workers, event streams
 */
"use strict";

globalThis.__netscopeInspector = async function netscopeInspect(op, args) {
  "use strict";
  args = args || {};
  const W = window;
  const D = document;
  const T0 = performance.now();

  /* ------------------------------------------------------------ helpers */

  const clip = (s, n) => {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  };
  const own = (o, k) => {
    try {
      const d = Object.getOwnPropertyDescriptor(o, k);
      return d && "value" in d ? d.value : undefined;
    } catch (_) {
      return undefined;
    }
  };
  // Reads o.a.b.c through data properties only; a getter on the way returns undefined.
  const dig = (o, path) => {
    let v = o;
    for (const k of path) {
      if (v == null || (typeof v !== "object" && typeof v !== "function")) return undefined;
      v = own(v, k);
    }
    return v;
  };
  const isObj = (v) => v !== null && typeof v === "object";
  const ctor = (v) => {
    try {
      const p = Object.getPrototypeOf(v);
      return (p && p.constructor && p.constructor.name) || "";
    } catch (_) {
      return "";
    }
  };
  const basename = (f) => String(f || "").split(/[\\/]/).pop();
  const abs = (u) => {
    try {
      return new URL(u, location.href).href;
    } catch (_) {
      return String(u || "");
    }
  };
  const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
  const pathPattern = (p) =>
    String(p || "/")
      .split("/")
      .map((s) => (/^\d+$/.test(s) ? ":id" : /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) ? ":uuid" : /^[0-9a-f]{20,}$/i.test(s) ? ":hash" : s.length > 40 ? ":slug" : s))
      .join("/");

  // JSON-safe copy with limits; getters are not run, cycles are cut.
  function toJson(v, maxDepth, seen, budget) {
    budget = budget || { n: 4000 };
    seen = seen || new WeakSet();
    const t = typeof v;
    if (--budget.n < 0) return "…";
    if (v === null || t === "boolean" || t === "number") return Number.isFinite(v) || t !== "number" ? v : String(v);
    if (t === "string") return v.length > 2000 ? v.slice(0, 2000) + "…" : v;
    if (t === "undefined") return "(undefined)";
    if (t === "bigint") return String(v) + "n";
    if (t === "symbol") return String(v);
    if (t === "function") return "ƒ " + (v.name || "anonymous");
    try {
      if (v instanceof Date) return isNaN(v) ? "Invalid Date" : v.toISOString();
      if (v instanceof RegExp) return String(v);
      if (v instanceof Error) return (v.name || "Error") + ": " + v.message;
      if (typeof Node !== "undefined" && v instanceof Node) return "<" + (v.nodeName || "node").toLowerCase() + ">";
      if (typeof Blob !== "undefined" && v instanceof Blob) return `Blob(${v.size} B, ${v.type || "?"})`;
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return `${ctor(v)}(${v.byteLength} B)`;
    } catch (_) {}
    if (seen.has(v)) return "[Circular]";
    if (maxDepth <= 0) return Array.isArray(v) ? `[Array(${v.length})]` : `{…${safeKeys(v).length} keys}`;
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const out = v.slice(0, 50).map((x) => toJson(x, maxDepth - 1, seen, budget));
        if (v.length > 50) out.push(`… ${v.length - 50} more`);
        return out;
      }
      if (v instanceof Map) return { "(Map)": Array.from(v).slice(0, 50).map(([k, x]) => [toJson(k, maxDepth - 1, seen, budget), toJson(x, maxDepth - 1, seen, budget)]) };
      if (v instanceof Set) return { "(Set)": Array.from(v).slice(0, 50).map((x) => toJson(x, maxDepth - 1, seen, budget)) };
      const out = {};
      const keys = safeKeys(v);
      for (const k of keys.slice(0, 80)) {
        const d = Object.getOwnPropertyDescriptor(v, k);
        out[k] = d && "value" in d ? toJson(d.value, maxDepth - 1, seen, budget) : "(getter)";
      }
      if (keys.length > 80) out["…"] = `${keys.length - 80} more keys`;
      return out;
    } catch (_) {
      return "{…}";
    } finally {
      seen.delete(v);
    }
  }
  function safeKeys(v) {
    try {
      return Object.keys(v);
    } catch (_) {
      return [];
    }
  }

  // TypeScript-like one-line shape with short samples, e.g.
  //   { user: { id: 42, name: "Ann" }, items: Array(20) of { id: number, … } }
  function shapeOf(v, depth, seen) {
    seen = seen || new WeakSet();
    const t = typeof v;
    if (v === null) return "null";
    if (t === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 40) + "…" : v);
    if (t === "number" || t === "boolean") return String(v);
    if (t === "undefined") return "undefined";
    if (t === "function") return "ƒ";
    if (t !== "object") return t;
    try {
      if (v instanceof Date) return "Date";
      if (typeof Node !== "undefined" && v instanceof Node) return "<" + v.nodeName.toLowerCase() + ">";
    } catch (_) {}
    if (seen.has(v)) return "[Circular]";
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      if (depth <= 0) return `Array(${v.length})`;
      seen.add(v);
      const s = `Array(${v.length}) of ${shapeOf(v[0], depth - 1, seen)}`;
      seen.delete(v);
      return s;
    }
    const keys = safeKeys(v);
    const name = ctor(v);
    const pre = name && name !== "Object" ? name + " " : "";
    if (v instanceof Map) return `Map(${v.size})`;
    if (v instanceof Set) return `Set(${v.size})`;
    if (depth <= 0) return pre + `{…${keys.length} keys}`;
    seen.add(v);
    const parts = keys.slice(0, 30).map((k) => {
      const d = Object.getOwnPropertyDescriptor(v, k);
      return k + ": " + (d && "value" in d ? shapeOf(d.value, depth - 1, seen) : "(getter)");
    });
    seen.delete(v);
    return pre + "{ " + parts.join(", ") + (keys.length > 30 ? `, …${keys.length - 30} more` : "") + " }";
  }

  /* ------------------------------------------------------------- React */

  const keyWith = (el, prefix) => {
    for (const k of safeKeys(el)) if (k.startsWith(prefix)) return k;
    return null;
  };

  function reactRootFibers() {
    const roots = [];
    const seenRoots = new Set();
    const cands = D.querySelectorAll("body, body > *, body > * > *, #root, #__next, #app, [data-reactroot]");
    for (const el of cands) {
      let fiber = null;
      const ck = keyWith(el, "__reactContainer$");
      if (ck) fiber = own(el, ck);
      else {
        const legacy = own(el, "_reactRootContainer");
        fiber = legacy && (dig(legacy, ["_internalRoot", "current"]) || dig(legacy, ["current"]));
      }
      if (fiber && !seenRoots.has(fiber)) {
        seenRoots.add(fiber);
        roots.push(fiber);
      }
    }
    if (!roots.length) {
      // No container found: climb from any rendered element to its HostRoot.
      const any = D.querySelector("body *");
      const walker = any ? D.createTreeWalker(D.body, NodeFilter.SHOW_ELEMENT) : null;
      for (let n = 0, el = walker && walker.nextNode(); el && n < 2000; n++, el = walker.nextNode()) {
        const fk = keyWith(el, "__reactFiber$") || keyWith(el, "__reactInternalInstance$");
        if (!fk) continue;
        let f = own(el, fk);
        for (let i = 0; f && i < 5000 && f.return; i++) f = f.return;
        if (f && f.tag === 3 && !seenRoots.has(f)) {
          seenRoots.add(f);
          roots.push(f);
        }
        break;
      }
    }
    return roots;
  }

  function fiberName(f) {
    const t = f && f.type;
    if (!t || typeof t === "string") return null;
    if (typeof t === "function") return t.displayName || t.name || "Anonymous";
    if (typeof t === "object") {
      if (t.displayName) return t.displayName;
      if (f.tag === 10 || f.tag === 9) {
        const c = t._context || t;
        return (c.displayName || "Context") + (f.tag === 10 ? ".Provider" : ".Consumer");
      }
      if (t.render) return t.render.displayName || t.render.name || "ForwardRef";
      if (t.type) return (t.type.displayName || t.type.name || "Memo") + "";
    }
    return null;
  }

  // Visits every fiber (depth-first) up to `max`, calling fn(fiber, depth).
  function walkFibers(root, fn, max) {
    let count = 0;
    const stack = [[root, 0]];
    while (stack.length && count < max) {
      const [f, d] = stack.pop();
      if (!f) continue;
      count++;
      if (fn(f, d) === false) continue;
      const kids = [];
      for (let c = f.child; c; c = c.sibling) kids.push(c);
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], d + 1]);
    }
    return count;
  }

  function hookCount(f) {
    let n = 0;
    for (let h = f.memoizedState; h && typeof h === "object" && "next" in h && n < 200; h = h.next) n++;
    return n;
  }

  function reactTree(maxDepth, maxNodes, filter) {
    const roots = reactRootFibers();
    const lines = [];
    let nodes = 0;
    let shortNames = 0;
    const want = filter ? String(filter).toLowerCase() : "";
    function visit(f, depth, indent) {
      // Collect this fiber's component children, hoisting through host elements.
      const out = [];
      const stack = [];
      for (let c = f.child; c; c = c.sibling) stack.push(c);
      stack.reverse();
      while (stack.length) {
        const c = stack.pop();
        const name = fiberName(c);
        if (name && (c.tag === 0 || c.tag === 1 || c.tag === 2 || c.tag === 11 || c.tag === 14 || c.tag === 15 || c.tag === 10)) out.push(c);
        else {
          const kids = [];
          for (let g = c.child; g; g = g.sibling) kids.push(g);
          for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        }
      }
      // Repeated siblings of one component collapse into "Name ×N".
      for (let i = 0; i < out.length && nodes < maxNodes; ) {
        const c = out[i];
        const name = fiberName(c);
        let j = i + 1;
        while (j < out.length && fiberName(out[j]) === name) j++;
        const times = j - i;
        nodes++;
        const props = isObj(c.memoizedProps) ? safeKeys(c.memoizedProps).filter((k) => k !== "children").slice(0, 8) : [];
        const src = c._debugSource ? ` (${basename(c._debugSource.fileName)}:${c._debugSource.lineNumber})` : "";
        const hooks = c.tag === 0 || c.tag === 11 || c.tag === 15 ? hookCount(c) : 0;
        const state = c.tag === 1 && isObj(c.memoizedState) ? safeKeys(c.memoizedState).slice(0, 6) : [];
        const bits = [];
        if (props.length) bits.push("props: " + props.join(", "));
        if (hooks) bits.push(hooks + " hooks");
        if (state.length) bits.push("state: " + state.join(", "));
        // Context providers are plumbing: walk through them without a line.
        const isProvider = c.tag === 10;
        const line = indent + name + (times > 1 ? " ×" + times : "") + (bits.length ? "  {" + bits.join("; ") + "}" : "") + src;
        if (!isProvider && (!want || name.toLowerCase().includes(want))) lines.push(line);
        else if (isProvider) nodes--;
        if (!isProvider && name.length <= 2) shortNames++;
        if (depth < maxDepth) visit(c, depth + 1, isProvider ? indent : indent + "  ");
        i = j;
      }
    }
    for (const r of roots) visit(r, 0, "");
    const out = { roots: roots.length, nodes, truncated: nodes >= maxNodes, tree: lines.join("\n") };
    if (nodes && shortNames / nodes > 0.4) out.note = "Most names are minified (production build). Props and hooks still show the structure; source maps (list_sources) or search_sources map names back to files.";
    return out;
  }

  // Stores and routers reachable through React props and context values.
  function reactFinds() {
    const found = { redux: null, reactQuery: null, apollo: null, routerRoutes: null, routes: [] };
    const roots = reactRootFibers();
    for (const r of roots) {
      walkFibers(
        r,
        (f, d) => {
          const p = f.memoizedProps;
          if (!isObj(p)) return true;
          const val = own(p, "value");
          const store = own(p, "store") || (isObj(val) && own(val, "store"));
          if (!found.redux && store && typeof store.getState === "function" && typeof store.dispatch === "function") found.redux = store;
          const client = own(p, "client") || val;
          if (!found.reactQuery && client && typeof client.getQueryCache === "function") found.reactQuery = client;
          if (!found.apollo && client && isObj(client) && client.cache && typeof client.cache.extract === "function" && typeof client.query === "function") found.apollo = client;
          const router = own(p, "router") || (isObj(val) && own(val, "router"));
          if (!found.routerRoutes && router && Array.isArray(own(router, "routes"))) found.routerRoutes = own(router, "routes");
          const name = fiberName(f);
          const path = own(p, "path");
          if (typeof path === "string" && (name === "Route" || name === "PrivateRoute" || name === "ProtectedRoute" || /Route$/.test(name || ""))) {
            let depthPath = path;
            // Prefix with enclosing <Route path> for nested routes.
            for (let a = f.return, n = 0; a && n < 200; a = a.return, n++) {
              const ap = isObj(a.memoizedProps) && own(a.memoizedProps, "path");
              if (typeof ap === "string" && /Route$/.test(fiberName(a) || "") && a !== f) {
                depthPath = (ap.replace(/\/\*?$/, "") + "/" + depthPath.replace(/^\//, "")).replace(/\/+/g, "/");
                break;
              }
            }
            found.routes.push(depthPath);
          }
          return true;
        },
        40000
      );
    }
    return found;
  }

  /* --------------------------------------------------------------- Vue */

  function vueApp() {
    const cands = D.querySelectorAll("body > *, #app, #__nuxt, [data-v-app], [data-server-rendered]");
    for (const el of cands) {
      const app3 = own(el, "__vue_app__");
      if (app3) return { v: 3, app: app3, el };
      const vm2 = own(el, "__vue__");
      if (vm2) return { v: 2, vm: own(vm2, "$root") || vm2, el };
    }
    return null;
  }
  // app.config is an accessor on Vue 3 apps; it only returns the app's config
  // object, so this one getter is read directly.
  const vueGlobals = (app) => {
    try {
      return app.config.globalProperties || null;
    } catch (_) {
      return null;
    }
  };
  // $router / $pinia / $store may be accessors too (Nuxt defines $router as one);
  // they only hand back the plugin instance, so these names are read directly.
  const vueGlobal = (app, name) => {
    const gp = vueGlobals(app);
    if (!gp) return undefined;
    try {
      return gp[name];
    } catch (_) {
      return undefined;
    }
  };
  const vueName = (type) => (type && (type.name || type.__name || (type.__file && basename(type.__file).replace(/\.vue$/, "")))) || "Anonymous";

  function vueTree(maxDepth, maxNodes, filter) {
    const va = vueApp();
    if (!va) return null;
    const lines = [];
    let nodes = 0;
    const want = filter ? String(filter).toLowerCase() : "";
    const emit = (indent, name, props, file) => {
      nodes++;
      const line = indent + name + (props.length ? "  {props: " + props.join(", ") + "}" : "") + (file ? " (" + basename(file) + ")" : "");
      if (!want || name.toLowerCase().includes(want)) lines.push(line);
    };
    if (va.v === 3) {
      const walkVNode = (vnode, depth, indent) => {
        if (!vnode || nodes >= maxNodes || depth > maxDepth) return;
        const comp = own(vnode, "component");
        if (comp) {
          const type = own(comp, "type");
          const props = isObj(own(comp, "props")) ? safeKeys(own(comp, "props")).slice(0, 8) : [];
          emit(indent, vueName(type), props, type && type.__file);
          walkVNode(own(comp, "subTree"), depth + 1, indent + "  ");
          return;
        }
        const kids = own(vnode, "children");
        if (Array.isArray(kids)) for (const k of kids) walkVNode(k, depth, indent);
        const sus = own(vnode, "suspense");
        if (sus) walkVNode(own(sus, "activeBranch"), depth, indent);
      };
      // app._instance exists only in dev builds; the mount element always has _vnode.
      const inst = own(va.app, "_instance") || own(own(va.el, "_vnode") || {}, "component");
      if (inst) {
        emit("", vueName(own(inst, "type")), [], own(inst, "type") && own(inst, "type").__file);
        walkVNode(own(inst, "subTree"), 1, "  ");
      } else if (own(va.el, "_vnode")) walkVNode(own(va.el, "_vnode"), 0, "");
    } else {
      const walkVm = (vm, depth, indent) => {
        if (!vm || nodes >= maxNodes || depth > maxDepth) return;
        const opts = own(vm, "$options") || {};
        const props = isObj(own(vm, "_props")) ? safeKeys(own(vm, "_props")).slice(0, 8) : [];
        emit(indent, opts.name || opts._componentTag || "Anonymous", props, opts.__file);
        for (const c of own(vm, "$children") || []) walkVm(c, depth + 1, indent + "  ");
      };
      walkVm(va.vm, 0, "");
    }
    return { nodes, truncated: nodes >= maxNodes, tree: lines.join("\n") };
  }

  function vueRouterRoutes() {
    const va = vueApp();
    if (!va) return null;
    try {
      if (va.v === 3) {
        const router = vueGlobal(va.app, "$router");
        if (router && typeof router.getRoutes === "function") {
          return router.getRoutes().map((r) => ({
            path: r.path,
            name: typeof r.name === "string" ? r.name : r.name ? String(r.name) : undefined,
            meta: r.meta && safeKeys(r.meta).length ? toJson(r.meta, 2) : undefined,
            components: r.components ? Object.values(r.components).map((c) => vueName(c)).join(", ") : undefined
          }));
        }
      } else {
        const routes = dig(va.vm, ["$router", "options", "routes"]);
        if (Array.isArray(routes)) {
          const out = [];
          const walk = (list, base) => {
            for (const r of list || []) {
              const full = r.path && r.path.startsWith("/") ? r.path : (base.replace(/\/$/, "") + "/" + (r.path || "")).replace(/\/+/g, "/");
              out.push({ path: full, name: r.name, meta: r.meta ? toJson(r.meta, 2) : undefined });
              walk(r.children, full);
            }
          };
          walk(routes, "");
          return out;
        }
      }
    } catch (_) {}
    return null;
  }

  /* -------------------------------------------------------- detection */

  function detectFrameworks() {
    const out = [];
    const add = (name, version, note) => out.push(Object.assign({ name }, version ? { version: String(version) } : {}, note ? { note } : {}));
    const g = (k) => own(W, k);
    // React family
    const hook = g("__REACT_DEVTOOLS_GLOBAL_HOOK__");
    const renderers = hook && hook.renderers instanceof Map ? Array.from(hook.renderers.values()) : [];
    const reactVersion = renderers.map((r) => r && r.version).filter(Boolean)[0];
    const hasReact = reactRootFibers().length > 0;
    if (hasReact || reactVersion) add("React", reactVersion, hasReact ? "rendered root found" : "devtools hook only");
    const nd = g("__NEXT_DATA__");
    const nextV = dig(W, ["next", "version"]);
    if (nd || nextV || g("__next_f")) add("Next.js", nextV, g("__next_f") ? "App Router (RSC)" : nd ? "Pages Router" : "");
    if (g("__remixContext") || g("__remixManifest")) add("Remix", null, "routes, loaders and actions in the manifest");
    if (g("__reactRouterContext") || g("__reactRouterManifest")) add("React Router (framework mode)", g("__reactRouterVersion"));
    else if (g("__reactRouterVersion")) add("React Router", g("__reactRouterVersion"));
    if (g("___gatsby") || g("___loader")) add("Gatsby");
    if (g("_$HY")) add("SolidJS", null, "hydration marker");
    if (D.querySelector("[q\\:container]")) add("Qwik");
    if (g("preact") || g("__PREACT_DEVTOOLS__")) add("Preact");
    // Vue family
    const va = vueApp();
    if (va) add("Vue", va.v === 3 ? own(va.app, "version") : dig(W, ["Vue", "version"]) || "2.x");
    if (g("__NUXT__") || D.getElementById("__nuxt") || g("$nuxt")) add("Nuxt", dig(W, ["__NUXT__", "config", "app", "buildId"]) ? null : null, g("__NUXT__") ? "payload in window.__NUXT__" : "");
    if (D.querySelector("[data-server-rendered]") && !va) add("Vue (SSR)");
    // Angular
    const ngv = D.querySelector("[ng-version]");
    if (ngv) add("Angular", ngv.getAttribute("ng-version"), g("ng") ? "dev mode (window.ng)" : "production build");
    else if (g("angular")) add("AngularJS", dig(W, ["angular", "version", "full"]));
    // Svelte family
    const kit = safeKeys(W).filter((k) => k.startsWith("__sveltekit"));
    if (kit.length || D.querySelector("[data-sveltekit-preload-data], [data-sveltekit-reload]")) add("SvelteKit", null, kit.length ? kit.join(", ") : "");
    else if (D.querySelector("[class*='svelte-']")) add("Svelte");
    if (D.querySelector("astro-island")) add("Astro", null, "islands");
    if (g("Ember")) add("Ember", dig(W, ["Ember", "VERSION"]));
    if (g("Alpine")) add("Alpine.js", dig(W, ["Alpine", "version"]));
    if (g("htmx")) add("htmx", dig(W, ["htmx", "version"]));
    if (g("Turbo")) add("Hotwire Turbo");
    if (g("Stimulus")) add("Stimulus");
    if (g("Livewire")) add("Laravel Livewire");
    const inertia = D.querySelector("#app[data-page]");
    if (inertia) add("Inertia.js", dig(safeParse(inertia.getAttribute("data-page")), ["version"]), "page component: " + (dig(safeParse(inertia.getAttribute("data-page")), ["component"]) || "?"));
    if (g("jQuery")) add("jQuery", dig(W, ["jQuery", "fn", "jquery"]));
    if (g("Backbone")) add("Backbone", dig(W, ["Backbone", "VERSION"]));
    if (g("litElementVersions") || g("litHtmlVersions")) add("Lit", (g("litElementVersions") || g("litHtmlVersions") || []).join(", "));
    // Platforms
    if (g("Shopify")) add("Shopify", null, dig(W, ["Shopify", "shop"]));
    if (g("wp") || D.querySelector("link[href*='/wp-content/'], script[src*='/wp-content/']")) add("WordPress");
    if (D.documentElement.getAttribute("data-wf-site")) add("Webflow");
    if (g("wixBiSession") || D.querySelector("meta[name='generator'][content*='Wix']")) add("Wix");
    if (g("Squarespace")) add("Squarespace");
    const gen = D.querySelector("meta[name='generator']");
    if (gen) add("generator meta", null, clip(gen.getAttribute("content"), 80));
    // Build tools
    const chunks = safeKeys(W).filter((k) => /^webpackChunk|^webpackJsonp/.test(k));
    if (chunks.length) add("webpack", null, chunks.map((k) => `${k} (${(own(W, k) || []).length} chunks)`).join(", "));
    if (D.querySelector("script[type='module'][src*='/@vite/client']")) add("Vite (dev server)");
    else if (D.querySelector("script[type='module'][src*='/assets/']")) add("Vite (likely)", null, "module scripts under /assets/");
    if (g("__turbopack_load__") || g("TURBOPACK")) add("Turbopack");
    if (g("parcelRequire")) add("Parcel");
    return out;
  }

  function safeParse(s) {
    try {
      return JSON.parse(s);
    } catch (_) {
      return null;
    }
  }

  // Third-party services the page talks to or embeds, and what they reveal.
  function detectServices() {
    const out = [];
    const g = (k) => own(W, k);
    const add = (name, detail) => out.push(detail ? { name, detail: clip(detail, 200) } : { name });
    const dl = g("dataLayer");
    if (Array.isArray(dl)) {
      const ids = new Set();
      for (const s of D.scripts) {
        const m = /[?&]id=((?:GTM|G|AW|UA|DC)-[A-Z0-9-]+)/.exec(s.src || "");
        if (m) ids.add(m[1]);
      }
      add("Google Tag Manager / gtag", Array.from(ids).join(", ") || `dataLayer (${dl.length} events)`);
    }
    if (g("ga")) add("Google Analytics (analytics.js)");
    if (g("analytics") && dig(W, ["analytics", "VERSION"])) add("Segment", "v" + dig(W, ["analytics", "VERSION"]));
    if (g("mixpanel")) add("Mixpanel");
    if (g("amplitude")) add("Amplitude");
    if (g("posthog")) add("PostHog", dig(W, ["posthog", "config", "api_host"]));
    if (g("hj")) add("Hotjar");
    if (g("clarity")) add("Microsoft Clarity");
    if (g("Intercom")) add("Intercom");
    if (g("drift")) add("Drift");
    if (g("zE")) add("Zendesk");
    if (g("$crisp")) add("Crisp");
    if (g("__SENTRY__") || g("Sentry")) add("Sentry", g("SENTRY_RELEASE") ? "release " + JSON.stringify(g("SENTRY_RELEASE")) : "");
    if (g("DD_RUM")) add("Datadog RUM");
    if (g("newrelic") || g("NREUM")) add("New Relic");
    if (g("LDClient") || g("ldclient")) add("LaunchDarkly");
    if (g("optimizely")) add("Optimizely");
    if (g("Stripe")) add("Stripe.js", dig(W, ["Stripe", "version"]));
    if (g("paypal")) add("PayPal SDK");
    if (g("firebase")) add("Firebase SDK (global)", dig(W, ["firebase", "SDK_VERSION"]));
    if (g("__FIREBASE_DEFAULTS__")) add("Firebase", "defaults injected");
    if (g("Clerk")) add("Clerk auth");
    if (g("auth0") || g("createAuth0Client")) add("Auth0");
    if (g("google") && dig(W, ["google", "accounts"])) add("Google Identity Services");
    if (g("grecaptcha")) add("reCAPTCHA");
    if (g("turnstile")) add("Cloudflare Turnstile");
    if (g("hcaptcha")) add("hCaptcha");
    if (g("algoliasearch") || g("instantsearch")) add("Algolia");
    if (g("mapboxgl")) add("Mapbox");
    if (g("__APOLLO_CLIENT__")) add("Apollo Client (GraphQL)", dig(W, ["__APOLLO_CLIENT__", "link", "options", "uri"]));
    if (g("__URQL_DATA__")) add("urql (GraphQL)");
    if (g("__RELAY_STORE__") || g("__RELAY_DEVTOOLS_HOOK__")) add("Relay (GraphQL)");
    if (g("__mobxGlobals") || g("__mobxInstanceCount")) add("MobX");
    if (g("__REDUX_DEVTOOLS_EXTENSION__")) add("Redux DevTools hook present");
    return out;
  }

  /* ---------------------------------------------------------- overview */

  async function storageSummary() {
    const area = (s) => {
      try {
        let bytes = 0;
        const keys = [];
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          const v = s.getItem(k) || "";
          bytes += k.length + v.length;
          keys.push(k);
        }
        return { count: keys.length, chars: bytes, keys: keys.slice(0, 40) };
      } catch (err) {
        return { error: String(err && err.message) };
      }
    };
    const out = { localStorage: area(W.localStorage), sessionStorage: area(W.sessionStorage) };
    try {
      out.cookies_visible_to_js = D.cookie ? D.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean) : [];
    } catch (_) {}
    try {
      out.indexedDB = indexedDB.databases ? (await withTimeout(indexedDB.databases(), 2000, [])).map((d) => `${d.name} v${d.version}`) : "unknown";
    } catch (_) {}
    try {
      out.cacheStorage = W.caches ? await withTimeout(caches.keys(), 2000, []) : [];
    } catch (_) {}
    try {
      const regs = navigator.serviceWorker ? await withTimeout(navigator.serviceWorker.getRegistrations(), 2000, []) : [];
      out.serviceWorkers = regs.map((r) => ({ scope: r.scope, script: (r.active || r.waiting || r.installing || {}).scriptURL, state: (r.active || r.waiting || r.installing || {}).state }));
      out.controlledByServiceWorker = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    } catch (_) {}
    try {
      const est = navigator.storage && (await withTimeout(navigator.storage.estimate(), 1500, null));
      if (est) out.quota = { usageMB: +(est.usage / 1e6).toFixed(2), quotaMB: Math.round(est.quota / 1e6) };
    } catch (_) {}
    return out;
  }

  function perfSummary() {
    const out = {};
    try {
      const n = performance.getEntriesByType("navigation")[0];
      if (n) {
        out.navigation = {
          type: n.type,
          protocol: n.nextHopProtocol,
          ttfb_ms: Math.round(n.responseStart),
          dom_content_loaded_ms: Math.round(n.domContentLoadedEventEnd),
          load_ms: Math.round(n.loadEventEnd),
          document_kb: Math.round((n.transferSize || 0) / 1024),
          server_timing: (n.serverTiming || []).map((s) => `${s.name}${s.duration ? "=" + Math.round(s.duration) + "ms" : ""}${s.description ? " (" + s.description + ")" : ""}`)
        };
      }
      const paint = performance.getEntriesByType("paint").map((p) => `${p.name} ${Math.round(p.startTime)}ms`);
      if (paint.length) out.paint = paint;
      const res = performance.getEntriesByType("resource");
      const byType = {};
      for (const r of res) {
        const k = r.initiatorType || "other";
        byType[k] = byType[k] || { count: 0, kb: 0 };
        byType[k].count++;
        byType[k].kb += Math.round((r.transferSize || 0) / 1024);
      }
      out.resources = byType;
      out.slowest = res
        .slice()
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 6)
        .map((r) => `${Math.round(r.duration)}ms ${r.initiatorType} ${clip(r.name, 140)}`);
      const mem = own(performance, "memory") || performance.memory;
      if (mem && mem.usedJSHeapSize) out.js_heap_mb = +(mem.usedJSHeapSize / 1e6).toFixed(1);
    } catch (_) {}
    return out;
  }

  function hostsSummary() {
    const first = location.hostname.split(".").slice(-2).join(".");
    const hosts = {};
    try {
      for (const r of performance.getEntriesByType("resource")) {
        let h = "";
        try {
          h = new URL(r.name).hostname;
        } catch (_) {
          continue;
        }
        hosts[h] = (hosts[h] || 0) + 1;
      }
    } catch (_) {}
    const rows = Object.entries(hosts).sort((a, b) => b[1] - a[1]);
    return {
      first_party: rows.filter(([h]) => h === location.hostname || h.endsWith("." + first) || h === first).map(([h, n]) => `${h} (${n})`),
      third_party: rows.filter(([h]) => !(h === location.hostname || h.endsWith("." + first) || h === first)).slice(0, 40).map(([h, n]) => `${h} (${n})`)
    };
  }

  function metaSummary() {
    const m = {};
    const get = (sel, attr) => {
      const el = D.querySelector(sel);
      return el ? clip(el.getAttribute(attr || "content"), 300) : undefined;
    };
    m.title = clip(D.title, 200);
    m.lang = D.documentElement.lang || undefined;
    m.description = get("meta[name='description']");
    m.canonical = get("link[rel='canonical']", "href");
    m.robots = get("meta[name='robots']");
    m.viewport = get("meta[name='viewport']");
    m.theme_color = get("meta[name='theme-color']");
    m.manifest = get("link[rel='manifest']", "href");
    m.base_href = get("base", "href");
    m.csp_meta = get("meta[http-equiv='Content-Security-Policy' i]");
    m.csrf_meta = Array.from(D.querySelectorAll("meta[name*='csrf' i], meta[name*='xsrf' i]")).map((x) => x.getAttribute("name"));
    const og = {};
    for (const el of D.querySelectorAll("meta[property^='og:']")) og[el.getAttribute("property")] = clip(el.getAttribute("content"), 160);
    if (Object.keys(og).length) m.open_graph = og;
    m.secure_context = W.isSecureContext;
    m.cross_origin_isolated = W.crossOriginIsolated;
    for (const k of Object.keys(m)) if (m[k] === undefined || (Array.isArray(m[k]) && !m[k].length)) delete m[k];
    return m;
  }

  function inlineData() {
    const out = [];
    for (const s of D.querySelectorAll("script[type='application/json'], script[type='application/ld+json'], script#__NEXT_DATA__, script#__NUXT_DATA__")) {
      const text = s.textContent || "";
      const data = safeParse(text);
      out.push({ id: s.id || undefined, type: s.type, chars: text.length, shape: data !== null ? clip(shapeOf(data, 2), 600) : "not JSON" });
      if (out.length >= 12) break;
    }
    const inertia = D.querySelector("#app[data-page]");
    if (inertia) {
      const data = safeParse(inertia.getAttribute("data-page"));
      out.push({ id: "inertia data-page", chars: (inertia.getAttribute("data-page") || "").length, shape: clip(shapeOf(data, 2), 600) });
    }
    return out;
  }

  function domStats() {
    const all = D.getElementsByTagName("*");
    const custom = {};
    let shadow = 0;
    const max = Math.min(all.length, 30000);
    for (let i = 0; i < max; i++) {
      const el = all[i];
      const tag = el.tagName.toLowerCase();
      if (tag.includes("-")) custom[tag] = (custom[tag] || 0) + 1;
      if (el.shadowRoot) shadow++;
    }
    const links = Array.from(D.links);
    return {
      elements: all.length,
      forms: D.forms.length,
      inputs: D.querySelectorAll("input, select, textarea").length,
      buttons: D.querySelectorAll("button, [role='button']").length,
      links_internal: links.filter((a) => a.origin === location.origin).length,
      links_external: links.filter((a) => a.origin !== location.origin).length,
      iframes: Array.from(D.querySelectorAll("iframe")).slice(0, 10).map((f) => clip(f.src || "(srcdoc/blank)", 140)),
      images: D.images.length,
      open_shadow_roots: shadow,
      custom_elements: Object.entries(custom).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([t, n]) => `${t} ×${n}`),
      test_ids: D.querySelectorAll("[data-testid], [data-test], [data-cy], [data-qa]").length
    };
  }

  function scriptsSummary(withInline) {
    const tags = [];
    const inline = [];
    for (const s of D.scripts) {
      if (s.src) tags.push({ src: abs(s.src), type: s.type || undefined, module: s.type === "module" || undefined, async: s.async || undefined, defer: s.defer || undefined, integrity: s.integrity ? true : undefined });
      else {
        const text = s.textContent || "";
        if (!text.trim() || /json/i.test(s.type)) continue;
        inline.push(Object.assign({ index: inline.length, type: s.type || undefined, chars: text.length, head: clip(text.trim().replace(/\s+/g, " "), 160) }, withInline ? { text: text.slice(0, 200000) } : {}));
      }
    }
    const tagged = new Set(tags.map((t) => t.src));
    let loaded = [];
    try {
      loaded = performance
        .getEntriesByType("resource")
        .filter((r) => (r.initiatorType === "script" || r.initiatorType === "link" || r.initiatorType === "other") && /\.m?js(\?|#|$)/.test(r.name) && !tagged.has(r.name))
        .map((r) => ({ src: r.name, kb: Math.round((r.encodedBodySize || r.transferSize || 0) / 1024), loaded_later: true }));
    } catch (_) {}
    const importMap = D.querySelector("script[type='importmap']");
    return { page: location.href, tags, loaded_chunks: loaded, inline, import_map: importMap ? clip(importMap.textContent, 2000) : undefined };
  }

  // Window properties the app added: compared with a blank same-origin frame.
  function appGlobals(filter) {
    let base = null;
    try {
      const f = D.createElement("iframe");
      f.style.display = "none";
      f.setAttribute("aria-hidden", "true");
      (D.body || D.documentElement).appendChild(f);
      base = new Set(Object.getOwnPropertyNames(f.contentWindow));
      f.remove();
    } catch (_) {}
    const names = Object.getOwnPropertyNames(W).filter((k) => !(base && base.has(k)) && !/^\d+$/.test(k) && !k.startsWith("__netscope") && !/^on[a-z]+$/.test(k) && !/^(webkit|chrome|\$0|__REACT_DEVTOOLS|__VUE_DEVTOOLS)/.test(k));
    const want = filter ? String(filter).toLowerCase() : "";
    const out = [];
    for (const k of names) {
      if (want && !k.toLowerCase().includes(want)) continue;
      const d = Object.getOwnPropertyDescriptor(W, k);
      if (!d) continue;
      if (!("value" in d)) {
        out.push({ name: k, type: "getter" });
        continue;
      }
      const v = d.value;
      const t = typeof v;
      try {
        if (v && typeof v === "object" && v.window === v) continue; // a frame's window
      } catch (_) {
        continue; // cross-origin frame
      }
      let preview;
      if (t === "function") preview = "ƒ " + (v.name || k);
      else if (t === "object" && v !== null) preview = clip(shapeOf(v, 1), 240);
      else preview = clip(JSON.stringify(v), 160);
      out.push({ name: k, type: v === null ? "null" : Array.isArray(v) ? "array" : t, preview });
      if (out.length >= 150) break;
    }
    return { count: names.length, globals: out };
  }

  async function overview() {
    const fw = detectFrameworks();
    const nd = own(W, "__NEXT_DATA__");
    const build = {};
    if (nd) {
      build.next = {
        page: nd.page,
        buildId: nd.buildId,
        query: toJson(nd.query, 2),
        locale: nd.locale,
        isFallback: nd.isFallback,
        data_fetching: ["gssp", "gsp", "gip", "appGip"].filter((k) => nd[k]),
        runtimeConfig: nd.runtimeConfig ? toJson(nd.runtimeConfig, 3) : undefined,
        props_shape: clip(shapeOf(nd.props, 3), 1500)
      };
    }
    const nuxt = own(W, "__NUXT__");
    if (nuxt) build.nuxt = { keys: safeKeys(nuxt), public_config: nuxt.config ? toJson(dig(nuxt, ["config", "public"]) || nuxt.config, 3) : undefined, routePath: nuxt.routePath };
    const kit = safeKeys(W).filter((k) => k.startsWith("__sveltekit"));
    if (kit.length) build.sveltekit = kit.map((k) => ({ global: k, value: toJson(own(W, k), 3) }));
    const remix = own(W, "__remixManifest") || own(W, "__reactRouterManifest");
    if (remix) build.remix = { version: remix.version, routes: safeKeys(remix.routes || {}).length, url: remix.url };
    const gatsby = own(W, "pagePath");
    if (gatsby) build.gatsby = { pagePath: gatsby };
    const out = {
      url: location.href,
      title: D.title,
      frameworks: fw,
      services: detectServices(),
      build: Object.keys(build).length ? build : undefined,
      meta: metaSummary(),
      inline_data: inlineData(),
      scripts: (() => {
        const s = scriptsSummary(false);
        return { script_tags: s.tags.length, loaded_chunks: s.loaded_chunks.length, inline_scripts: s.inline.length, import_map: !!s.import_map, sample: s.tags.slice(0, 12).map((t) => t.src) };
      })(),
      storage: await storageSummary(),
      dom: domStats(),
      performance: perfSummary(),
      hosts: hostsSummary(),
      app_globals: (() => {
        const g = appGlobals();
        return { count: g.count, sample: g.globals.slice(0, 40).map((x) => `${x.name}: ${x.preview || x.type}`) };
      })()
    };
    return out;
  }

  /* ------------------------------------------------------------ routes */

  async function routes() {
    const out = { current: location.pathname + location.search, sources: [] };
    const push = (source, list, note) => {
      if (list && list.length) out.sources.push(Object.assign({ source, count: list.length, routes: list.slice(0, 400) }, note ? { note } : {}));
    };
    // Remix / React Router framework manifest: path, parent, loader, action.
    const man = own(W, "__remixManifest") || own(W, "__reactRouterManifest");
    if (man && isObj(man.routes)) {
      const rs = man.routes;
      const full = (id) => {
        const parts = [];
        for (let r = rs[id], n = 0; r && n < 50; r = rs[r.parentId], n++) if (r.path) parts.unshift(r.path);
        return "/" + parts.join("/").replace(/^\/+/, "").replace(/\/+/g, "/");
      };
      push(
        own(W, "__remixManifest") ? "remix manifest" : "react-router manifest",
        Object.keys(rs).map((id) => {
          const r = rs[id];
          const flags = [r.index ? "index" : "", r.hasLoader ? "loader" : "", r.hasAction ? "action" : "", r.hasClientLoader ? "clientLoader" : ""].filter(Boolean).join(", ");
          return `${full(id)}${r.index ? " (index)" : ""}  [${id}]${flags ? " " + flags : ""}`;
        }),
        "loader/action routes run on the server: GET loads data, POST/PUT/DELETE to the same path runs the action"
      );
    }
    // Next.js pages router: every page in the build.
    const bm = own(W, "__BUILD_MANIFEST");
    if (bm && Array.isArray(bm.sortedPages)) push("next build manifest", bm.sortedPages.filter((p) => !/^\/_/.test(p)));
    const nd = own(W, "__NEXT_DATA__");
    if (nd && nd.page) out.next_current_page = nd.page;
    // Gatsby page list (when the loader exposes it).
    const gl = own(W, "___loader");
    const gpages = gl && isObj(gl.pageDb) ? Array.from(gl.pageDb.keys ? gl.pageDb.keys() : []) : [];
    push("gatsby page db", gpages);
    // Vue Router (Vue / Nuxt).
    const vr = vueRouterRoutes();
    if (vr) push("vue-router", vr.map((r) => `${r.path}${r.name ? " (" + r.name + ")" : ""}${r.components ? " → " + r.components : ""}${r.meta ? " meta " + JSON.stringify(r.meta) : ""}`));
    // React Router (data router object or <Route path> elements).
    if (reactRootFibers().length) {
      const f = reactFinds();
      if (f.routerRoutes) {
        const list = [];
        const walk = (rs, base) => {
          for (const r of rs || []) {
            const p = r.path ? (r.path.startsWith("/") ? r.path : (base.replace(/\/$/, "") + "/" + r.path).replace(/\/+/g, "/")) : base;
            list.push(`${p || "/"}${r.index ? " (index)" : ""}${r.loader ? " loader" : ""}${r.action ? " action" : ""}${r.lazy ? " lazy" : ""}${r.id ? " [" + r.id + "]" : ""}`);
            walk(r.children, p);
          }
        };
        walk(f.routerRoutes, "");
        push("react-router data router", list);
      }
      push("react-router <Route> elements", Array.from(new Set(f.routes)));
    }
    // Angular dev mode can expose router config through ng.
    // Links on this page, grouped into path patterns.
    const groups = {};
    for (const a of D.links) {
      if (a.origin !== location.origin) continue;
      const pat = pathPattern(a.pathname);
      const g = (groups[pat] = groups[pat] || { count: 0, sample: a.pathname + a.search });
      g.count++;
    }
    out.internal_links = Object.entries(groups)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 150)
      .map(([p, g]) => `${p}  ×${g.count}${g.sample !== p ? "  e.g. " + clip(g.sample, 100) : ""}`);
    // Forms post somewhere: those are server routes too.
    out.form_actions = Array.from(D.forms)
      .slice(0, 30)
      .map((f) => `${(f.getAttribute("method") || "GET").toUpperCase()} ${f.getAttribute("action") ? abs(f.getAttribute("action")) : "(same URL / handled by JS)"}`);
    return out;
  }

  /* -------------------------------------------------------- components */

  function components() {
    const maxDepth = Math.min(Number(args.max_depth) || 40, 200);
    const maxNodes = Math.min(Number(args.max_nodes) || 300, 2000);
    const out = {};
    if (reactRootFibers().length) out.react = reactTree(maxDepth, maxNodes, args.filter);
    const vt = vueTree(maxDepth, maxNodes, args.filter);
    if (vt) out.vue = vt;
    const ngv = D.querySelector("[ng-version]");
    if (ngv) {
      const tags = {};
      for (const el of D.querySelectorAll("*")) {
        if (!Array.from(el.attributes).some((a) => a.name.startsWith("_nghost-"))) continue;
        const name = W.ng && typeof W.ng.getComponent === "function" ? (() => {
          try {
            const c = W.ng.getComponent(el);
            return c ? ctor(c) : el.tagName.toLowerCase();
          } catch (_) {
            return el.tagName.toLowerCase();
          }
        })() : el.tagName.toLowerCase();
        tags[name] = (tags[name] || 0) + 1;
      }
      out.angular = { version: ngv.getAttribute("ng-version"), components: Object.entries(tags).map(([t, n]) => `${t} ×${n}`) };
    }
    const sv = [];
    for (const el of D.querySelectorAll("*")) {
      const meta = own(el, "__svelte_meta");
      if (meta && meta.loc) sv.push(`${basename(meta.loc.file)}:${meta.loc.line} <${el.tagName.toLowerCase()}>`);
      if (sv.length > 200) break;
    }
    if (sv.length) out.svelte_dev = Array.from(new Set(sv));
    const islands = Array.from(D.querySelectorAll("astro-island")).slice(0, 60).map((i) => `${basename(i.getAttribute("component-url"))} (${i.getAttribute("component-export") || "default"}) client:${(i.getAttribute("client") || "").replace(/^client:/, "")} props ${clip(i.getAttribute("props"), 120)}`);
    if (islands.length) out.astro_islands = islands;
    const custom = {};
    for (const el of D.querySelectorAll("*")) {
      const t = el.tagName.toLowerCase();
      if (t.includes("-") && customElements.get(t)) custom[t] = (custom[t] || 0) + 1;
    }
    if (Object.keys(custom).length) out.web_components = Object.entries(custom).map(([t, n]) => `${t} ×${n}${D.querySelector(t) && D.querySelector(t).shadowRoot ? " (shadow DOM)" : ""}`);
    if (!Object.keys(out).length) out.note = "No component framework found on this page (server-rendered HTML or an unsupported framework).";
    return out;
  }

  /* ------------------------------------------------------------- state */

  function stateSources() {
    const out = {};
    const add = (name, get, note) => {
      out[name] = { get, note };
    };
    const g = (k) => own(W, k);
    if (reactRootFibers().length) {
      const f = reactFinds();
      if (f.redux) add("redux", () => f.redux.getState(), "Redux store (getState)");
      if (f.reactQuery)
        add(
          "react_query",
          () =>
            f.reactQuery
              .getQueryCache()
              .getAll()
              .map((q) => ({ key: q.queryKey, status: q.state && q.state.status, updated: q.state && q.state.dataUpdatedAt ? new Date(q.state.dataUpdatedAt).toISOString() : undefined, observers: q.getObserversCount ? q.getObserversCount() : undefined, data: q.state && q.state.data })),
          "React Query cache: every query key the app fetched, with its data"
        );
      if (f.apollo) add("apollo", () => f.apollo.cache.extract(), "Apollo normalized cache (ROOT_QUERY lists the queries run)");
    }
    if (g("__APOLLO_CLIENT__") && !out.apollo) add("apollo", () => g("__APOLLO_CLIENT__").cache.extract(), "Apollo normalized cache");
    if (g("__NEXT_DATA__")) add("next_data", () => g("__NEXT_DATA__"), "Next.js page props and build data");
    if (g("__NUXT__")) add("nuxt", () => g("__NUXT__"), "Nuxt payload / state");
    const nuxtData = D.getElementById("__NUXT_DATA__");
    if (nuxtData) add("nuxt_data", () => safeParse(nuxtData.textContent), "Nuxt 3 serialized payload (devalue format)");
    const va = vueApp();
    if (va && va.v === 3) {
      const pinia = vueGlobal(va.app, "$pinia");
      if (pinia) add("pinia", () => (pinia.state && "value" in pinia.state ? pinia.state.value : null), "Pinia stores by id");
      const vuex = vueGlobal(va.app, "$store");
      if (vuex) add("vuex", () => vuex.state, "Vuex state");
    } else if (va) {
      const vuex = own(va.vm, "$store");
      if (vuex) add("vuex", () => vuex.state, "Vuex state");
    }
    if (g("__remixContext") || g("__reactRouterContext")) add("remix", () => dig(g("__remixContext") || g("__reactRouterContext"), ["state"]) || g("__remixContext") || g("__reactRouterContext"), "loader data by route id");
    const inertia = D.querySelector("#app[data-page]");
    if (inertia) add("inertia", () => safeParse(inertia.getAttribute("data-page")), "Inertia page: component, props, url, version");
    for (const k of safeKeys(W)) {
      if (/^(__)?(INITIAL|PRELOADED|APP|REDUX|SERVER|SSR)_?(STATE|DATA|PROPS|CONTEXT)(__)?$|^__(STATE|DATA|CONFIG|ENV|APP)__$|^(ENV|env|CONFIG|config|appConfig|APP_CONFIG|__env)$/i.test(k)) add("window." + k, () => own(W, k), "app global");
    }
    return out;
  }

  function state() {
    const sources = stateSources();
    const names = Object.keys(sources);
    let src = args.source ? String(args.source) : "";
    if (src && !sources[src] && src.startsWith("window.")) {
      const k = src.slice(7);
      sources[src] = { get: () => own(W, k), note: "window global" };
    }
    if (!src) return { available: names.map((n) => ({ source: n, note: sources[n].note, shape: (() => { try { return clip(shapeOf(sources[n].get(), 1), 400); } catch (e) { return "error: " + e.message; } })() })), hint: "Call again with source (and optionally path like 'user.profile' or 'items.0') for the shape and values." };
    if (!sources[src]) return { error: `no state source "${src}"`, available: names };
    let v;
    try {
      v = sources[src].get();
    } catch (err) {
      return { error: "reading " + src + " failed: " + (err && err.message) };
    }
    const path = args.path ? String(args.path).split(".").filter(Boolean) : [];
    for (const k of path) {
      if (v == null) break;
      v = Array.isArray(v) && /^\d+$/.test(k) ? v[Number(k)] : own(v, k);
    }
    const depth = Math.min(Number(args.max_depth) || 4, 8);
    const json = toJson(v, depth);
    const text = JSON.stringify(json);
    return { source: src, path: path.join(".") || undefined, shape: clip(shapeOf(v, 3), 4000), value: text.length > 30000 ? clip(text, 30000) : json, truncated: text.length > 30000 || undefined };
  }

  /* ----------------------------------------------------------- storage */

  function webStorage() {
    const s = args.area === "session" ? W.sessionStorage : W.localStorage;
    if (!s) return { error: "storage unavailable" };
    if (args.key != null) {
      const v = s.getItem(String(args.key));
      if (v === null) return { error: `no key "${args.key}"` };
      const parsed = safeParse(v);
      return { key: args.key, chars: v.length, value: clip(v, 20000), json_shape: parsed !== null && typeof parsed === "object" ? clip(shapeOf(parsed, 4), 3000) : undefined };
    }
    const rows = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      const v = s.getItem(k) || "";
      rows.push({ key: k, chars: v.length, preview: clip(v, 200) });
    }
    rows.sort((a, b) => a.key.localeCompare(b.key));
    const off = Math.max(0, Number(args.offset) || 0);
    const lim = Math.min(Number(args.limit) || 200, 500);
    return { area: args.area === "session" ? "sessionStorage" : "localStorage", count: rows.length, items: rows.slice(off, off + lim) };
  }

  function openDb(name) {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(name);
      } catch (err) {
        return reject(err);
      }
      // Opening an unknown name would create it: abort that instead.
      req.onupgradeneeded = () => {
        try {
          req.transaction.abort();
        } catch (_) {}
        reject(new Error("database does not exist"));
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("open failed"));
      req.onblocked = () => reject(new Error("blocked by another connection"));
    });
  }
  const idbReq = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

  async function idb() {
    if (!W.indexedDB) return { error: "IndexedDB unavailable" };
    const list = indexedDB.databases ? await withTimeout(indexedDB.databases(), 3000, []) : [];
    if (!args.db) {
      const dbs = [];
      for (const info of list.slice(0, 15)) {
        const entry = { name: info.name, version: info.version, stores: [] };
        try {
          const db = await withTimeout(openDb(info.name), 3000, null);
          if (!db) throw new Error("timed out");
          try {
            const names = Array.from(db.objectStoreNames);
            if (names.length) {
              const tx = db.transaction(names, "readonly");
              for (const sn of names.slice(0, 40)) {
                const st = tx.objectStore(sn);
                const count = await withTimeout(idbReq(st.count()), 2000, "?");
                entry.stores.push({
                  name: sn,
                  keyPath: st.keyPath,
                  autoIncrement: st.autoIncrement,
                  count,
                  indexes: Array.from(st.indexNames).map((iname) => {
                    const ix = st.index(iname);
                    return `${iname} (${JSON.stringify(ix.keyPath)}${ix.unique ? ", unique" : ""}${ix.multiEntry ? ", multiEntry" : ""})`;
                  })
                });
              }
            }
          } finally {
            db.close();
          }
        } catch (err) {
          entry.error = String(err && err.message);
        }
        dbs.push(entry);
      }
      return { databases: dbs, note: list.length > 15 ? `${list.length - 15} more databases not shown` : undefined };
    }
    const db = await withTimeout(openDb(String(args.db)), 3000, null);
    if (!db) return { error: "could not open database " + args.db };
    try {
      const names = Array.from(db.objectStoreNames);
      const sn = args.store ? String(args.store) : names[0];
      if (!names.includes(sn)) return { error: `no store "${sn}"`, stores: names };
      const st = db.transaction([sn], "readonly").objectStore(sn);
      const off = Math.max(0, Number(args.offset) || 0);
      const lim = Math.min(Number(args.limit) || 20, 100);
      const rows = [];
      await new Promise((resolve, reject) => {
        let skipped = false;
        const cur = st.openCursor();
        cur.onerror = () => reject(cur.error);
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c || rows.length >= lim) return resolve();
          if (off && !skipped) {
            skipped = true;
            c.advance(off);
            return;
          }
          rows.push({ key: toJson(c.key, 2), value: toJson(c.value, Math.min(Number(args.max_depth) || 4, 8)) });
          c.continue();
        };
      });
      const count = await withTimeout(idbReq(st.count()), 2000, "?");
      return { db: args.db, store: sn, count, offset: off, records: rows, stores: names };
    } finally {
      db.close();
    }
  }

  async function cacheStorage() {
    if (!W.caches) return { error: "Cache Storage unavailable (needs a secure context)" };
    const names = await withTimeout(caches.keys(), 3000, []);
    const out = [];
    for (const n of names.slice(0, 15)) {
      if (args.cache && n !== args.cache) continue;
      try {
        const c = await caches.open(n);
        const reqs = await withTimeout(c.keys(), 3000, []);
        const off = Math.max(0, Number(args.offset) || 0);
        const lim = Math.min(Number(args.limit) || (args.cache ? 100 : 25), 300);
        out.push({ cache: n, entries: reqs.length, requests: reqs.slice(off, off + lim).map((r) => `${r.method} ${clip(r.url, 200)}`) });
      } catch (err) {
        out.push({ cache: n, error: String(err && err.message) });
      }
    }
    return { caches: out };
  }

  /* --------------------------------------------------------------- DOM */

  function domOutline() {
    const root = args.selector ? D.querySelector(String(args.selector)) : D.body;
    if (!root) return { error: "no element matches " + args.selector };
    const maxDepth = Math.min(Number(args.max_depth) || 12, 40);
    const maxLines = Math.min(Number(args.max_lines) || 260, 800);
    const withText = args.include_text !== false;
    const SKIP = new Set(["script", "style", "noscript", "template", "link", "meta", "path", "defs", "symbol", "use", "br", "wbr"]);
    const SEM = new Set(["header", "nav", "main", "aside", "footer", "section", "article", "form", "table", "dialog", "details", "fieldset", "ul", "ol", "iframe", "video", "audio", "canvas", "h1", "h2", "h3", "h4", "button", "select", "textarea", "label", "summary", "figure", "img", "svg", "a", "input"]);
    const lines = [];
    const txt = (el, n) => clip((el.innerText || el.textContent || "").trim().replace(/\s+/g, " "), n);
    const label = (el) => {
      const tag = el.tagName.toLowerCase();
      let s = tag;
      if (el.id) s += "#" + el.id;
      const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter((c) => c && c.length < 30 && !/^(css|sc|jsx|svelte|emotion|tw)-[a-z0-9]+$/i.test(c)).slice(0, 2) : [];
      if (cls.length) s += "." + cls.join(".");
      const role = el.getAttribute("role");
      if (role) s += `[role=${role}]`;
      const tid = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-cy");
      if (tid) s += `[testid=${tid}]`;
      const aria = el.getAttribute("aria-label");
      if (aria) s += ` "${clip(aria, 50)}"`;
      return s;
    };
    const formLine = (f) => {
      const method = (f.getAttribute("method") || "GET").toUpperCase();
      const action = f.getAttribute("action");
      const fields = Array.from(f.elements)
        .filter((x) => x.name || x.id)
        .slice(0, 30)
        .map((x) => `${x.name || "#" + x.id}(${x.type || x.tagName.toLowerCase()}${x.required ? ",required" : ""}${x.autocomplete && x.autocomplete !== "on" ? "," + x.autocomplete : ""})`);
      const buttons = Array.from(f.querySelectorAll("button, input[type=submit]")).slice(0, 6).map((b) => `"${clip(b.innerText || b.value || b.getAttribute("aria-label") || "", 30)}"`);
      return `${label(f)} ${method} ${action ? abs(action) : "(JS-handled)"}  fields: ${fields.join(", ") || "none"}${buttons.length ? "  buttons: " + buttons.join(", ") : ""}`;
    };
    const walk = (el, depth, indent) => {
      if (lines.length >= maxLines) return;
      const tag = el.tagName ? el.tagName.toLowerCase() : "";
      if (!tag || SKIP.has(tag)) return;
      let style;
      try {
        style = el.getClientRects().length === 0 && tag !== "dialog" ? "hidden" : "";
      } catch (_) {
        style = "";
      }
      const custom = tag.includes("-");
      const interesting = SEM.has(tag) || el.id || el.getAttribute("role") || el.getAttribute("data-testid") || custom;
      let nextIndent = indent;
      if (interesting && depth <= maxDepth) {
        let line = indent + label(el) + (style ? " (hidden)" : "");
        if (tag === "form") {
          lines.push(indent + formLine(el));
          return;
        }
        if (/^h[1-4]$/.test(tag) || tag === "button" || tag === "summary" || tag === "label") line += withText ? ` "${txt(el, 80)}"` : "";
        else if (tag === "a") {
          line += ` → ${clip(el.getAttribute("href") || "", 100)}${withText ? ' "' + txt(el, 40) + '"' : ""}`;
          lines.push(line);
          return;
        } else if (tag === "img") {
          line += ` alt="${clip(el.alt, 60)}" ${clip(el.currentSrc || el.src, 100)}`;
          lines.push(line);
          return;
        } else if (tag === "input" || tag === "select" || tag === "textarea") {
          line += ` name=${el.name || "-"} type=${el.type || tag}${el.placeholder ? ' placeholder="' + clip(el.placeholder, 40) + '"' : ""}`;
          lines.push(line);
          return;
        } else if (tag === "table") {
          const heads = Array.from(el.querySelectorAll("th")).slice(0, 10).map((th) => txt(th, 24));
          lines.push(line + ` ${el.rows ? el.rows.length : "?"} rows${heads.length ? " columns: " + heads.join(" | ") : ""}`);
          return;
        } else if ((tag === "ul" || tag === "ol") && el.children.length > 6) {
          const first = el.children[0];
          lines.push(line + ` ×${el.children.length} items, first: "${txt(first, 60)}"`);
          return;
        } else if (tag === "iframe") {
          lines.push(line + " " + clip(el.src, 140));
          return;
        } else if (tag === "svg" || tag === "canvas" || tag === "video" || tag === "audio") {
          lines.push(line);
          return;
        }
        lines.push(line);
        nextIndent = indent + "  ";
      }
      if (depth > maxDepth + 6) return;
      for (const c of el.children) walk(c, depth + 1, nextIndent);
      if (el.shadowRoot) {
        lines.push(nextIndent + "#shadow-root");
        for (const c of el.shadowRoot.children) walk(c, depth + 1, nextIndent + "  ");
      }
    };
    walk(root, 0, "");
    return { root: args.selector || "body", lines: lines.length, truncated: lines.length >= maxLines, outline: lines.join("\n") };
  }

  /* ----------------------------------------------------------- styles */

  const describeEl = (el) => {
    if (!el || el.nodeType !== 1) return "";
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    if (cls.length) s += "." + cls.join(".");
    return s;
  };
  const elText = (el, n) => clip((el.innerText || el.textContent || "").trim().replace(/\s+/g, " "), n || 60);

  // Rules from every readable stylesheet, @media/@supports/@layer included.
  function eachRule(fn) {
    const notes = [];
    const walk = (rules, ctx) => {
      for (const r of rules) {
        if (r.cssRules && (r.media || r.conditionText !== undefined || r.name !== undefined) && !r.selectorText) walk(r.cssRules, (ctx ? ctx + " " : "") + (r.media ? "@media " + r.media.mediaText : r.conditionText ? "@supports " + r.conditionText : r.name ? "@layer " + r.name : ""));
        else fn(r, ctx);
      }
    };
    for (const sheet of D.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        notes.push("not readable (cross-origin): " + clip(sheet.href, 120));
        continue;
      }
      walk(rules, "");
    }
    return notes;
  }

  const STYLE_PROPS = ["display", "position", "top", "right", "bottom", "left", "z-index", "box-sizing", "width", "height", "min-width", "max-width", "min-height", "max-height", "margin", "padding", "border", "border-radius", "box-shadow", "color", "background-color", "background-image", "opacity", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "text-transform", "white-space", "overflow", "flex", "flex-direction", "flex-wrap", "justify-content", "align-items", "gap", "grid-template-columns", "grid-template-rows", "grid-area", "transform", "transition", "animation", "cursor", "pointer-events", "visibility", "content-visibility", "contain", "aspect-ratio", "object-fit", "filter", "backdrop-filter"];
  const DULL = /^(none|normal|auto|0px|0|visible|static|start|stretch|nowrap|baseline|content-box|row|initial|ltr|1|0s|all 0s ease 0s|none 0s ease 0s 1 normal none running)$/;

  function styles() {
    const all = D.querySelectorAll(String(args.selector || "body"));
    const el = all[Math.min(all.length - 1, Math.max(0, Number(args.index) || 0))];
    if (!el) return { error: "no element matches " + args.selector };
    const cs = getComputedStyle(el);
    const computed = {};
    for (const p of STYLE_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v && !DULL.test(v.trim())) computed[p] = clip(v, 200);
    }
    const r = el.getBoundingClientRect();
    const matched = [];
    const notes = eachRule((rule, ctx) => {
      if (!rule.selectorText || matched.length >= 40) return;
      let ok = false;
      try {
        ok = el.matches(rule.selectorText);
      } catch (_) {}
      if (ok && (!ctx.startsWith("@media") || W.matchMedia(ctx.replace(/^@media /, "").split(" @")[0]).matches)) {
        const sheet = rule.parentStyleSheet;
        matched.push({ selector: clip(rule.selectorText, 160), where: (sheet && sheet.href ? basename(sheet.href) : "inline <style>") + (ctx ? " " + ctx : ""), css: clip(rule.style.cssText, 400) });
      }
    });
    const vars = [];
    for (const n of Array.from(cs).filter((p) => p.startsWith("--")).slice(0, 40)) vars.push(`${n}: ${clip(cs.getPropertyValue(n).trim(), 80)}`);
    return {
      element: describeEl(el),
      matches: all.length,
      text: elText(el, 80) || undefined,
      box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" },
      computed,
      inline_style: el.getAttribute("style") ? clip(el.getAttribute("style"), 400) : undefined,
      matched_rules: matched.reverse(),
      custom_properties_in_scope: vars.length ? vars : undefined,
      unreadable_stylesheets: notes.length ? notes.slice(0, 10) : undefined
    };
  }

  const toHex = (c) => {
    const m = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\)/.exec(c || "");
    if (!m) return c;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    const hex = "#" + [m[1], m[2], m[3]].map((x) => Math.round(Number(x)).toString(16).padStart(2, "0")).join("");
    return m[4] !== undefined && Number(m[4]) < 1 ? hex + " @" + Number(m[4]).toFixed(2) : hex;
  };
  const top = (map, n) =>
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k} ×${v}`);

  function design() {
    const out = {};
    // CSS variables declared on :root / html — usually the design tokens.
    const rootVars = new Set();
    const media = {};
    let darkMode = false;
    const notes = eachRule((rule, ctx) => {
      if (ctx.startsWith("@media")) {
        for (const m of ctx.match(/\((?:min|max)-width:\s*[\d.]+(?:px|em|rem)\)/g) || []) media[m] = (media[m] || 0) + 1;
        if (/prefers-color-scheme:\s*dark/.test(ctx)) darkMode = true;
      }
      if (rule.selectorText && /(^|,)\s*(:root|html)(\[[^\]]*\]|\.[\w-]+)?\s*(,|$)/.test(rule.selectorText)) for (const p of Array.from(rule.style)) if (p.startsWith("--")) rootVars.add(p);
    });
    const rcs = getComputedStyle(D.documentElement);
    const tokens = {};
    for (const n of Array.from(rootVars).slice(0, 400)) {
      const group = (/^--([a-z]+)/i.exec(n) || [, "other"])[1];
      (tokens[group] = tokens[group] || []).push(`${n}: ${clip(rcs.getPropertyValue(n).trim(), 60)}`);
    }
    out.css_variables = { count: rootVars.size, by_prefix: tokens };
    // What the rendered page actually uses.
    const colors = {};
    const bgs = {};
    const fonts = {};
    const sizes = {};
    const radii = {};
    const shadows = {};
    const layouts = { flex: 0, grid: 0 };
    const els = D.body ? D.body.getElementsByTagName("*") : [];
    const n = Math.min(els.length, 2500);
    for (let i = 0; i < n; i++) {
      const el = els[i];
      const cs = getComputedStyle(el);
      if (cs.display === "none") continue;
      if (cs.display.includes("flex")) layouts.flex++;
      if (cs.display.includes("grid")) layouts.grid++;
      const hasText = Array.from(el.childNodes).some((c) => c.nodeType === 3 && c.nodeValue.trim());
      if (hasText) {
        const c = toHex(cs.color);
        if (c) colors[c] = (colors[c] || 0) + 1;
        const f = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
        fonts[f] = (fonts[f] || 0) + 1;
        sizes[cs.fontSize] = (sizes[cs.fontSize] || 0) + 1;
      }
      const b = toHex(cs.backgroundColor);
      if (b) bgs[b] = (bgs[b] || 0) + 1;
      if (cs.borderRadius && cs.borderRadius !== "0px") radii[cs.borderRadius] = (radii[cs.borderRadius] || 0) + 1;
      if (cs.boxShadow && cs.boxShadow !== "none") shadows[clip(cs.boxShadow, 80)] = (shadows[clip(cs.boxShadow, 80)] || 0) + 1;
    }
    out.text_colors = top(colors, 14);
    out.background_colors = top(bgs, 14);
    out.font_families = top(fonts, 8);
    out.font_sizes = top(sizes, 12);
    out.border_radii = top(radii, 8);
    out.shadows = top(shadows, 6);
    out.layout = { flex_containers: layouts.flex, grid_containers: layouts.grid, sampled_elements: n };
    out.breakpoints = top(media, 12);
    out.dark_mode = darkMode || /dark/.test(rcs.colorScheme || "") || undefined;
    try {
      out.loaded_fonts = Array.from(D.fonts || [])
        .filter((f) => f.status === "loaded")
        .slice(0, 30)
        .map((f) => `${f.family.replace(/["']/g, "")} ${f.weight}${f.style !== "normal" ? " " + f.style : ""}`);
    } catch (_) {}
    // CSS frameworks and styling approaches, by their fingerprints.
    const cls = Array.from(D.querySelectorAll("[class]")).slice(0, 3000).map((e) => (typeof e.className === "string" ? e.className : "")).join(" ");
    const fw = [];
    const tw = (cls.match(/(?:^|\s)(?:[a-z]+:)*(?:p|m|px|py|mt|mb|ml|mr|gap|w|h|text|bg|rounded|flex|grid|items|justify)-[\w./[\]-]+/g) || []).length;
    if (tw > 30 || rootVars.has("--tw-ring-color") || /--tw-/.test(D.documentElement.getAttribute("style") || "")) fw.push(`Tailwind CSS (≈${tw} utility classes)`);
    if (/\b(btn btn-|col-(sm|md|lg)-|navbar-expand)/.test(cls)) fw.push("Bootstrap");
    if (/\bMui[A-Z]/.test(cls)) fw.push("Material UI");
    if (/\bchakra-/.test(cls)) fw.push("Chakra UI");
    if (/\bant-[a-z]/.test(cls)) fw.push("Ant Design");
    if (/\bmantine-/.test(cls)) fw.push("Mantine");
    if (D.querySelector("[data-radix-popper-content-wrapper], [data-radix-collection-item], [data-radix-scroll-area-viewport], [id^='radix-'], [aria-controls^='radix-']")) fw.push("Radix UI (shadcn/ui likely if with Tailwind)");
    if (D.querySelector("style[data-styled], style[data-styled-version]")) fw.push("styled-components");
    if (D.querySelector("style[data-emotion]")) fw.push("Emotion");
    if (/\b[a-zA-Z]+_[a-zA-Z]+__[a-zA-Z0-9_-]{5}\b/.test(cls)) fw.push("CSS Modules (hashed class names)");
    if (/\bsvelte-[a-z0-9]{5,}\b/.test(cls)) fw.push("Svelte scoped styles");
    if (D.querySelector("[data-v-app], [class*='data-v-']") || Array.from(D.querySelectorAll("*")).slice(0, 500).some((e) => Array.from(e.attributes).some((a) => /^data-v-[a-f0-9]{8}$/.test(a.name)))) fw.push("Vue scoped styles");
    if (/\bis-(primary|link)\b.*\bcolumns\b|\bbulma\b/.test(cls)) fw.push("Bulma");
    if (D.querySelector("link[href*='fonts.googleapis.com']")) fw.push("Google Fonts");
    if (/\bfa-(solid|regular|brands|[a-z-]+)\b/.test(cls)) fw.push("Font Awesome icons");
    if (/\bmaterial-(icons|symbols)/.test(cls)) fw.push("Material icons");
    out.css_approach = fw;
    out.stylesheets = Array.from(D.styleSheets)
      .slice(0, 30)
      .map((s) => {
        let rules = "?";
        try {
          rules = s.cssRules.length;
        } catch (_) {}
        return `${s.href ? clip(s.href, 120) : "<style> " + clip((s.ownerNode && s.ownerNode.textContent) || "", 0).length} rules:${rules}${s.media && s.media.mediaText ? " media:" + s.media.mediaText : ""}`;
      });
    if (notes.length) out.unreadable_stylesheets = notes.slice(0, 10);
    return out;
  }

  /* --------------------------------------------------------- handlers */

  function handlersOf(el) {
    const out = [];
    const pk = keyWith(el, "__reactProps$");
    if (pk) {
      const props = own(el, pk) || {};
      for (const k of safeKeys(props)) {
        if (!/^on[A-Z]/.test(k)) continue;
        const fn = own(props, k);
        if (typeof fn === "function") out.push(`${k}: ${fn.name || "anonymous"}`);
      }
      // The component that rendered it: the nearest function component above.
      const fk = keyWith(el, "__reactFiber$");
      let f = fk ? own(el, fk) : null;
      for (let i = 0; f && i < 60; i++, f = f.return) {
        if (f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 15) {
          out.push("in " + fiberName(f));
          break;
        }
      }
    }
    // Vue 3 keeps listeners in el._vei (a Symbol("_vei") since 3.4).
    let vei = own(el, "_vei");
    if (!vei) {
      try {
        const sym = Object.getOwnPropertySymbols(el).find((s) => s.description === "_vei");
        if (sym) vei = el[sym];
      } catch (_) {}
    }
    if (vei && isObj(vei)) {
      for (const k of safeKeys(vei)) {
        const inv = own(vei, k);
        const fn = inv && own(inv, "value");
        out.push(`${k}: ${(fn && fn.name) || "handler"}`);
      }
      const comp = own(el, "__vueParentComponent");
      if (comp) out.push("in " + vueName(own(comp, "type")));
    }
    try {
      const jq = W.jQuery && W.jQuery._data && W.jQuery._data(el, "events");
      if (jq) for (const k of Object.keys(jq)) out.push(`jQuery ${k} ×${jq[k].length}`);
    } catch (_) {}
    try {
      if (W.ng && typeof W.ng.getListeners === "function") for (const l of W.ng.getListeners(el) || []) out.push(`(${l.name}): ${(l.callback && l.callback.name) || "handler"}`);
    } catch (_) {}
    for (const a of Array.from(el.attributes)) if (/^on[a-z]+$/.test(a.name)) out.push(`${a.name}="${clip(a.value, 80)}"`);
    for (const a of Array.from(el.attributes)) if (/^(hx-(get|post|put|patch|delete)|wire:click|x-on:|@click|data-action|phx-click)/.test(a.name)) out.push(`${a.name}="${clip(a.value, 80)}"`);
    return out;
  }

  function handlers() {
    const root = args.selector ? D.querySelector(String(args.selector)) : D.body;
    if (!root) return { error: "no element matches " + args.selector };
    const els = root.querySelectorAll("button, a[href], input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=switch], [role=checkbox], [onclick], [tabindex]:not([tabindex='-1']), form");
    const rows = [];
    let withHandlers = 0;
    for (const el of els) {
      if (rows.length >= Math.min(Number(args.limit) || 150, 400)) break;
      const hs = handlersOf(el);
      if (hs.some((h) => !h.startsWith("in "))) withHandlers++;
      const tag = el.tagName.toLowerCase();
      const label = el.getAttribute("aria-label") || (tag === "input" ? el.name || el.type : "") || elText(el, 50);
      const extra = tag === "a" ? " → " + clip(el.getAttribute("href"), 100) : tag === "form" ? ` ${(el.getAttribute("method") || "GET").toUpperCase()} ${el.getAttribute("action") || "(JS)"}` : "";
      if (!hs.length && !extra && args.only_handled) continue;
      rows.push(`${describeEl(el)}${label ? ' "' + label + '"' : ""}${extra}${hs.length ? "  ⇒ " + hs.join(", ") : ""}`);
    }
    return { interactive: els.length, with_handlers: withHandlers, elements: rows, note: "Handler names come from React/Vue props, Angular dev mode, jQuery and inline attributes; production builds may minify them — search_sources finds the code." };
  }

  /* ----------------------------------------------------- accessibility */

  function accName(el) {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => D.getElementById(id))
        .filter(Boolean)
        .map((x) => elText(x, 80))
        .join(" ");
      if (t) return t;
    }
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
    const tag = el.tagName.toLowerCase();
    if (tag === "img" || (tag === "input" && el.type === "image")) return el.getAttribute("alt") || "";
    if (/^(input|select|textarea)$/.test(tag)) {
      if (el.id) {
        const l = D.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && elText(l)) return elText(l);
      }
      const wrap = el.closest("label");
      if (wrap && elText(wrap)) return elText(wrap);
      if (el.type === "submit" || el.type === "button") return el.value || "";
      return el.getAttribute("title") || "";
    }
    const svgTitle = el.querySelector && el.querySelector("svg title");
    return elText(el, 80) || el.getAttribute("title") || (svgTitle ? svgTitle.textContent.trim() : "");
  }

  const lum = (hex) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || "");
    if (!m) return null;
    const c = [m[1], m[2], m[3]].map((x) => {
      const v = parseInt(x, 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  function bgOf(el) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null; // an image: can't judge
      const h = toHex(cs.backgroundColor);
      if (h && !h.includes("@")) return h;
    }
    return "#ffffff";
  }

  function a11y() {
    const issues = [];
    const add = (kind, el, detail) => issues.length < 120 && issues.push(`${kind}: ${describeEl(el)}${detail ? " — " + detail : ""}`);
    const lang = D.documentElement.getAttribute("lang");
    if (!lang) issues.push("page: <html> has no lang attribute");
    if (!D.title.trim()) issues.push("page: empty <title>");
    const landmarks = Array.from(D.querySelectorAll("header, nav, main, aside, footer, [role=banner], [role=navigation], [role=main], [role=complementary], [role=contentinfo], [role=search], form[aria-label], section[aria-label]")).map((el) => `${el.getAttribute("role") || el.tagName.toLowerCase()}${accName(el) && el.getAttribute("aria-label") ? ' "' + el.getAttribute("aria-label") + '"' : ""}`);
    if (!D.querySelector("main, [role=main]")) issues.push("page: no <main> landmark");
    const headings = Array.from(D.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]"));
    let prev = 0;
    const outline = [];
    for (const h of headings.slice(0, 80)) {
      const lvl = Number(h.getAttribute("aria-level")) || Number(h.tagName[1]) || 2;
      if (prev && lvl > prev + 1) add("heading level skipped", h, `h${prev} → h${lvl}`);
      prev = lvl;
      outline.push("  ".repeat(lvl - 1) + `h${lvl} ${elText(h, 70)}`);
    }
    if (headings.filter((h) => h.tagName === "H1").length !== 1) issues.push(`page: ${headings.filter((h) => h.tagName === "H1").length} <h1> elements (expected 1)`);
    for (const img of D.querySelectorAll("img")) if (!img.hasAttribute("alt") && img.getAttribute("role") !== "presentation" && img.getAttribute("aria-hidden") !== "true") add("image without alt", img, clip(img.currentSrc || img.src, 80));
    const controls = [];
    for (const el of D.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=switch], [role=tab], [role=menuitem], [role=combobox], [role=textbox]")) {
      const name = accName(el).trim();
      const role = el.getAttribute("role") || (el.tagName === "A" ? "link" : el.tagName === "INPUT" ? (el.type === "checkbox" || el.type === "radio" ? el.type : el.type === "submit" || el.type === "button" ? "button" : "textbox") : el.tagName.toLowerCase());
      if (!name) add(`${role} without accessible name`, el);
      if (controls.length < 150) controls.push(`${role} "${clip(name, 60)}"${el.disabled ? " (disabled)" : ""}`);
      if (el.closest("[aria-hidden=true]") && !el.closest("[inert]") && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden") add("focusable inside aria-hidden", el);
      if (Number(el.getAttribute("tabindex")) > 0) add("positive tabindex", el, "tabindex=" + el.getAttribute("tabindex"));
    }
    const ids = {};
    for (const el of D.querySelectorAll("[id]")) ids[el.id] = (ids[el.id] || 0) + 1;
    for (const [id, n] of Object.entries(ids)) if (n > 1 && issues.length < 120) issues.push(`duplicate id "${id}" ×${n}`);
    // Text contrast (WCAG AA), sampled.
    let checked = 0;
    let lowContrast = 0;
    const els = D.body ? D.body.getElementsByTagName("*") : [];
    for (let i = 0; i < els.length && checked < 600; i++) {
      const el = els[i];
      if (!Array.from(el.childNodes).some((c) => c.nodeType === 3 && c.nodeValue.trim().length > 1)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
      const fg = toHex(cs.color);
      const bg = bgOf(el);
      if (!fg || !bg || fg.includes("@")) continue;
      checked++;
      const l1 = lum(fg);
      const l2 = lum(bg);
      if (l1 == null || l2 == null) continue;
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) {
        lowContrast++;
        if (lowContrast <= 25) add("low contrast", el, `${ratio.toFixed(2)}:1 (${fg} on ${bg}, ${cs.fontSize}) "${elText(el, 40)}"`);
      }
    }
    return {
      lang,
      landmarks,
      heading_outline: outline,
      issues_count: issues.length,
      issues,
      contrast: { text_elements_checked: checked, below_aa: lowContrast },
      controls,
      note: "A static audit like axe's basics: names, landmarks, headings, alt text, ids, tabindex, contrast. Screen reader behaviour and keyboard traps need a manual check."
    };
  }

  /* ------------------------------------------------------- performance */

  function performanceReport() {
    const p = own(W, "__netscopePerf");
    const rate = (v, good, poor) => (v == null ? undefined : v <= good ? "good" : v <= poor ? "needs improvement" : "poor");
    const nav = performance.getEntriesByType("navigation")[0];
    const ttfb = nav ? Math.round(nav.responseStart) : null;
    const out = {
      recorded_from_page_start: !!p,
      web_vitals: {
        LCP: p && p.lcp ? Object.assign({ rating: rate(p.lcp.ms, 2500, 4000) }, p.lcp) : null,
        CLS: p ? { value: +p.cls.toFixed(3), rating: rate(p.cls, 0.1, 0.25) } : null,
        INP: p && p.inp ? Object.assign({ rating: rate(p.inp.ms, 200, 500), interactions: p.interactions }, p.inp) : p ? { note: `no interactions slower than 16 ms yet (${p.interactions} interactions)` } : null,
        FCP: p && p.fcp != null ? { ms: p.fcp, rating: rate(p.fcp, 1800, 3000) } : null,
        TTFB: ttfb != null ? { ms: ttfb, rating: rate(ttfb, 800, 1800) } : null
      },
      layout_shifts: p ? p.shifts : undefined,
      long_tasks: p ? p.longTasks : undefined,
      long_animation_frames: p && p.loafs.length ? p.loafs : undefined,
      js_heap_mb_over_time: p && p.heap.length ? p.heap : undefined,
      timings: perfSummary()
    };
    if (!p) out.note = "This page loaded before NetScope's hook was active (e.g. right after installing): reload it to record Web Vitals from the start.";
    return out;
  }

  // Resource Timing: every resource the page loaded so far, even before NetScope recorded requests.
  function resourceTiming() {
    const rows = performance.getEntriesByType("resource").map((r) => ({
      url: clip(r.name, 300),
      type: r.initiatorType,
      ms: Math.round(r.duration),
      start: Math.round(r.startTime),
      kb: Math.round((r.transferSize || 0) / 102.4) / 10,
      status: r.responseStatus || undefined,
      cache: r.transferSize === 0 && r.decodedBodySize > 0 ? "cache" : r.deliveryType || undefined,
      protocol: r.nextHopProtocol || undefined,
      render_blocking: r.renderBlockingStatus === "blocking" || undefined
    }));
    return { count: rows.length, resources: rows.slice(-Math.min(Number(args.limit) || 300, 600)) };
  }

  /* ------------------------------------------------------------ frames */

  function frameSummary() {
    let fws = [];
    try {
      fws = detectFrameworks().map((f) => f.name + (f.version ? " " + f.version : ""));
    } catch (_) {}
    return {
      url: location.href,
      top: W === W.top,
      title: clip(D.title, 120),
      frameworks: fws,
      size: `${W.innerWidth}×${W.innerHeight}`,
      forms: D.forms.length,
      inputs: D.querySelectorAll("input, select, textarea").length,
      scripts: D.scripts.length,
      text: elText(D.body || D.documentElement, 120)
    };
  }

  /* ------------------------------------------- flags, i18n and workers */

  function reactProps(test, max) {
    const out = [];
    for (const r of reactRootFibers()) {
      walkFibers(
        r,
        (f) => {
          if (out.length >= (max || 3)) return false;
          const p = f.memoizedProps;
          if (isObj(p) && test(p)) out.push(p);
          return true;
        },
        40000
      );
    }
    return out;
  }

  function flags() {
    const out = { feature_flags: [], experiments: [], i18n: {}, workers: [] };
    const add = (source, data) => out.feature_flags.push(Object.assign({ source }, data));
    const tryCall = (fn) => {
      try {
        return fn();
      } catch (_) {
        return undefined;
      }
    };
    // LaunchDarkly
    const ld = reactProps((p) => (own(p, "ldClient") && typeof own(p, "ldClient").allFlags === "function") || (isObj(own(p, "value")) && own(own(p, "value"), "ldClient")), 1)[0];
    const ldClient = ld && (own(ld, "ldClient") || own(own(ld, "value") || {}, "ldClient"));
    if (ldClient) add("LaunchDarkly", { flags: toJson(tryCall(() => ldClient.allFlags()), 3) });
    // GrowthBook
    const gb = own(W, "_growthbook") || own(W, "growthbook") || (reactProps((p) => own(p, "growthbook") && typeof own(p, "growthbook").getFeatures === "function", 1)[0] || {}).growthbook;
    if (gb && typeof gb.getFeatures === "function") {
      const feats = tryCall(() => gb.getFeatures()) || {};
      const values = {};
      for (const k of Object.keys(feats).slice(0, 80)) values[k] = toJson(tryCall(() => gb.getFeatureValue(k, null)), 2);
      add("GrowthBook", { features: values, attributes: toJson(tryCall(() => gb.getAttributes()), 2) });
    }
    // Optimizely Web
    const opt = own(W, "optimizely");
    if (opt && typeof opt.get === "function") {
      const state = tryCall(() => opt.get("state"));
      if (state) out.experiments.push({ source: "Optimizely", active: toJson(tryCall(() => state.getActiveExperimentIds()), 2), variations: toJson(tryCall(() => state.getVariationMap()), 3) });
    }
    // PostHog
    const ph = own(W, "posthog");
    if (ph && ph.featureFlags) add("PostHog", { flags: toJson(tryCall(() => ph.featureFlags.getFlagVariants()) || tryCall(() => ph.featureFlags.getFlags()), 3) });
    // Flagsmith
    const fs = own(W, "flagsmith");
    if (fs && typeof fs.getAllFlags === "function") add("Flagsmith", { flags: toJson(tryCall(() => fs.getAllFlags()), 3) });
    // Statsig / Split / Unleash / ConfigCat: detection only.
    if (own(W, "__STATSIG__") || own(W, "statsig")) add("Statsig", { note: "client present; values are evaluated per check" });
    if (own(W, "splitio")) add("Split", { note: "SDK present" });
    if (own(W, "unleash")) add("Unleash", { note: "client present" });
    if (own(W, "configcat")) add("ConfigCat", { note: "SDK present" });
    // Storage keys that look like flags or experiment buckets.
    const flagKeys = [];
    for (const s of [W.localStorage, W.sessionStorage]) {
      try {
        for (let i = 0; i < s.length; i++) if (/flag|feature|experiment|variant|ab[-_]|split|toggle|rollout/i.test(s.key(i))) flagKeys.push(`${s === W.localStorage ? "local" : "session"}:${s.key(i)} = ${clip(s.getItem(s.key(i)), 120)}`);
      } catch (_) {}
    }
    if (flagKeys.length) add("storage keys", { keys: flagKeys.slice(0, 40) });
    const cookieFlags = (D.cookie || "").split(";").map((c) => c.trim()).filter((c) => /flag|feature|experiment|variant|ab[-_]|bucket/i.test(c.split("=")[0]));
    if (cookieFlags.length) add("cookies", { cookies: cookieFlags.slice(0, 20).map((c) => clip(c, 120)) });

    // i18n
    const i = out.i18n;
    i.html_lang = D.documentElement.lang || undefined;
    i.dir = D.documentElement.dir || undefined;
    i.browser_languages = navigator.languages;
    try {
      const ro = Intl.DateTimeFormat().resolvedOptions();
      i.intl = { locale: ro.locale, time_zone: ro.timeZone };
    } catch (_) {}
    const alts = Array.from(D.querySelectorAll("link[rel=alternate][hreflang]")).map((l) => `${l.hreflang} → ${clip(l.href, 100)}`);
    if (alts.length) i.hreflang_alternates = alts.slice(0, 40);
    const nd = own(W, "__NEXT_DATA__");
    if (nd && (nd.locale || nd.locales)) i.next = { locale: nd.locale, locales: nd.locales, defaultLocale: nd.defaultLocale };
    const i18n = own(W, "i18next") || own(reactProps((p) => own(p, "i18n") && typeof own(p, "i18n").t === "function", 1)[0] || {}, "i18n");
    if (i18n && typeof i18n.t === "function") {
      const store = dig(i18n, ["store", "data"]) || {};
      const lng = i18n.language;
      const ns = store[lng] || {};
      const keyCount = Object.values(ns).reduce((n, v) => n + (isObj(v) ? safeKeys(v).length : 0), 0);
      i.i18next = { language: lng, languages: toJson(i18n.languages, 1), namespaces: safeKeys(ns), keys_loaded: keyCount, sample_keys: Object.entries(ns).flatMap(([n, v]) => safeKeys(v || {}).slice(0, 10).map((k) => n + ":" + k)).slice(0, 20) };
    }
    const intl = reactProps((p) => typeof own(p, "locale") === "string" && isObj(own(p, "messages")), 1)[0];
    if (intl) i.react_intl = { locale: own(intl, "locale"), messages: safeKeys(own(intl, "messages")).length, sample_keys: safeKeys(own(intl, "messages")).slice(0, 15) };
    const va = vueApp();
    const vi18n = va && va.v === 3 ? vueGlobal(va.app, "$i18n") : null;
    if (vi18n) i.vue_i18n = { locale: toJson(vi18n.locale, 1), available: toJson(vi18n.availableLocales, 1) };
    // Workers
    const p = own(W, "__netscopePerf");
    out.workers = p ? p.workers : "unknown (page loaded before NetScope's hook)";
    if (p && p.sse && p.sse.length) out.event_streams = p.sse;
    return out;
  }

  /* ------------------------------------------------------------- run */

  try {
    let result;
    switch (op) {
      case "overview":
        result = await overview();
        break;
      case "routes":
        result = await routes();
        break;
      case "components":
        result = components();
        break;
      case "state":
        result = state();
        break;
      case "storage":
        result = webStorage();
        break;
      case "idb":
        result = await idb();
        break;
      case "cache":
        result = await cacheStorage();
        break;
      case "dom":
        result = domOutline();
        break;
      case "scripts":
        result = scriptsSummary(!!args.with_inline);
        break;
      case "globals":
        result = appGlobals(args.filter);
        break;
      case "styles":
        result = styles();
        break;
      case "design":
        result = design();
        break;
      case "handlers":
        result = handlers();
        break;
      case "a11y":
        result = a11y();
        break;
      case "performance":
        result = performanceReport();
        break;
      case "resources":
        result = resourceTiming();
        break;
      case "frame":
        result = frameSummary();
        break;
      case "flags":
        result = flags();
        break;
      default:
        result = { error: "unknown inspector op " + op };
    }
    // Structured-clone safety: everything returned is plain JSON.
    return JSON.parse(JSON.stringify(Object.assign({ ms: Math.round(performance.now() - T0) }, result)));
  } catch (err) {
    return { error: "inspector failed: " + String((err && err.message) || err) };
  }
};
