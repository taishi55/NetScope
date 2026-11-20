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
      default:
        result = { error: "unknown inspector op " + op };
    }
    // Structured-clone safety: everything returned is plain JSON.
    return JSON.parse(JSON.stringify(Object.assign({ ms: Math.round(performance.now() - T0) }, result)));
  } catch (err) {
    return { error: "inspector failed: " + String((err && err.message) || err) };
  }
};
