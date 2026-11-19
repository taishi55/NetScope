/* NetScope – docs-ui.js
 * The Docs view: markdown notes Kimi keeps for you (findings, API maps, how a
 * flow works) and you can read, edit, copy, download or delete. Stored in the
 * background worker's IndexedDB; Kimi manages them with the *_doc tools.
 * Rendering goes through the chat's markdown renderer, which builds DOM
 * nodes and never parses content as HTML.
 */
"use strict";

window.__netscopeDocsUi = (() => {
  let api = null;
  let docs = [];
  let current = null; // the open doc (full), or null for the list
  let editing = null; // { id?, title, content } while the editor is open

  const $ = (id) => document.getElementById(id);
  const say = (m) => typeof toast === "function" && toast(m);

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function btn(label, fn, cls, title) {
    const b = node("button", cls || "", label);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", fn);
    return b;
  }

  const when = (ts) => {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };

  async function load() {
    try {
      docs = await api.rpc("docs.list");
    } catch (_) {
      docs = [];
    }
    $("docsCount").textContent = docs.length ? String(docs.length) : "";
    if (current) {
      // Kimi may have just rewritten the open doc.
      const fresh = await api.rpc("docs.get", { id: current.id }).catch(() => null);
      if (!fresh) current = null;
      else if (!editing) current = fresh;
    }
    if (!editing) render();
  }

  function render() {
    const root = $("docsRoot");
    root.replaceChildren();
    if (editing) return root.appendChild(editor());
    if (current) return root.appendChild(viewer(current));
    root.appendChild(listView());
  }

  function listView() {
    const box = node("div", "docs-list");
    const head = node("div", "docs-head");
    head.appendChild(
      node(
        "p",
        "",
        "Notes Kimi keeps for you — what an API does, how its auth works, why a request failed, how a flow runs — plus any you write yourself. Kimi updates them as it learns more."
      )
    );
    const actions = node("div", "actions");
    actions.appendChild(btn("New doc", () => startEdit(null), "primary"));
    if (window.__netscopeAi) {
      actions.appendChild(
        btn("Ask Kimi to document this site", () => window.__netscopeAi.prefill("Document what this page's API does — endpoints, auth, parameters and quirks — in a doc for this site.", false), "ghost")
      );
    }
    head.appendChild(actions);
    box.appendChild(head);
    if (!docs.length) {
      const empty = node("div", "flows-empty");
      empty.appendChild(node("p", "", "No docs yet."));
      empty.appendChild(node("p", "hint", "Ask Kimi to write up what it found, or start one with New doc."));
      box.appendChild(empty);
      return box;
    }
    const ul = node("ul", "doc-items");
    for (const d of docs) {
      const li = node("li");
      const open = node("button", "doc-open");
      open.type = "button";
      open.appendChild(node("span", "doc-title", d.title));
      const meta = [when(d.updatedAt), d.updatedBy === "kimi" ? "by Kimi" : "by you"];
      if (d.site) meta.unshift(d.site);
      if (d.size) meta.push(d.size >= 1000 ? `${Math.round(d.size / 100) / 10}k chars` : `${d.size} chars`);
      open.appendChild(node("span", "doc-meta", meta.join(" · ")));
      open.addEventListener("click", () => openDoc(d.id));
      li.appendChild(open);
      ul.appendChild(li);
    }
    box.appendChild(ul);
    return box;
  }

  function viewer(d) {
    const box = node("div", "doc-view");
    const bar = node("div", "doc-bar");
    const back = btn("", () => {
      current = null;
      render();
    }, "icon", "Back to all docs");
    back.setAttribute("aria-label", "Back to all docs");
    const ns = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(ns, "svg");
    const use = document.createElementNS(ns, "use");
    use.setAttribute("href", "#i-back");
    icon.appendChild(use);
    back.appendChild(icon);
    bar.appendChild(back);
    bar.appendChild(node("h3", "doc-h", d.title));
    box.appendChild(bar);
    const meta = [d.site, "updated " + when(d.updatedAt), d.updatedBy === "kimi" ? "by Kimi" : "by you"].filter(Boolean);
    box.appendChild(node("p", "doc-meta", meta.join(" · ")));

    const actions = node("div", "actions doc-actions");
    actions.appendChild(btn("Edit", () => startEdit(d)));
    actions.appendChild(btn("Copy", () => typeof copyText === "function" && copyText(d.content, "Doc copied as Markdown"), "ghost"));
    actions.appendChild(
      btn("Download .md", () => typeof download === "function" && download((d.title || "doc").replace(/[^\w.-]+/g, "_").slice(0, 60) + ".md", d.content, "text/markdown"), "ghost")
    );
    if (window.__netscopeAi) {
      actions.appendChild(btn("Ask Kimi", () => window.__netscopeAi.prefill(`Read the doc “${d.title}” and update it with anything new you can find on this page. `, false), "ghost"));
    }
    const del = btn("Delete", async () => {
      if (!del.dataset.armed) {
        del.dataset.armed = "1";
        del.textContent = "Click again to delete";
        del.className = "danger";
        return;
      }
      await api.rpc("docs.delete", { id: d.id }).catch((e) => say(e.message));
      say(`Deleted “${d.title}”`);
      current = null;
      load();
    }, "ghost");
    actions.appendChild(del);
    box.appendChild(actions);

    const body = node("div", "doc-body msg-assistant");
    const inner = node("div", "msg-body");
    if (window.__netscopeAi && window.__netscopeAi.renderRich) window.__netscopeAi.renderRich(inner, d.content);
    else inner.appendChild(node("pre", "", d.content));
    body.appendChild(inner);
    box.appendChild(body);
    return box;
  }

  function editor() {
    const box = node("div", "doc-edit");
    box.appendChild(node("h3", "", editing.id ? "Edit doc" : "New doc"));
    const title = node("input");
    title.type = "text";
    title.value = editing.title || "";
    title.placeholder = "Title";
    title.setAttribute("aria-label", "Doc title");
    const ta = node("textarea");
    ta.value = editing.content || "";
    ta.spellcheck = true;
    ta.placeholder = "# Heading\n\n- Markdown: headings, - bullets, 1. steps, tables, `code`, ``` fences, [links](https://…)";
    ta.setAttribute("aria-label", "Doc content (Markdown)");
    const actions = node("div", "actions");
    actions.appendChild(
      btn("Save doc", async () => {
        const t = title.value.trim();
        if (!t) return say("Give the doc a title");
        try {
          const saved = await api.rpc("docs.save", { by: "you", doc: { id: editing.id, title: t, content: ta.value, site: editing.site } });
          editing = null;
          current = saved;
          say(`Saved “${saved.title}”`);
          load();
        } catch (e) {
          say(e.message);
        }
      }, "primary")
    );
    actions.appendChild(
      btn("Cancel", () => {
        editing = null;
        render();
      })
    );
    box.append(title, ta, actions);
    setTimeout(() => (editing.id ? ta : title).focus(), 0);
    return box;
  }

  function startEdit(d) {
    let site = "";
    try {
      site = new URL(api.page().url).host;
    } catch (_) {}
    editing = d ? { id: d.id, title: d.title, content: d.content, site: d.site } : { title: "", content: "", site };
    render();
  }

  async function openDoc(id) {
    const d = await api.rpc("docs.get", { id }).catch(() => null);
    if (!d) return say("That doc no longer exists");
    current = d;
    editing = null;
    if (typeof switchView === "function") switchView("docs");
    render();
  }

  function attach(a) {
    if (api) return;
    api = a;
    api.subscribe((type) => {
      if (type === "docs-changed") load();
    });
    api.whenReady().then(load);
  }

  return { attach, onShown: load, open: openDoc };
})();
