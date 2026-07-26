# NetScope — Privacy Policy

**Last updated: July 26, 2026**

## Summary

NetScope captures network traffic locally, in memory, on your own machine. It has no
analytics, no telemetry, no error reporting, and no accounts, and it never contacts the
developer.

There is exactly one way data leaves your machine: the **optional AI assistant**, which is
disabled until you supply your own API key and explicitly consent. When you use it, excerpts
of the captured traffic are sent to Moonshot AI. That is described in full below.

## What NetScope processes

While DevTools is open on a tab, the NetScope panel processes that tab's network traffic —
HTTP requests and responses (URLs, headers, bodies) and WebSocket frames — for one purpose:
displaying and searching it in the panel.

Capture works two ways, both scoped to the tab you have DevTools open on:

- **HTTP** — `chrome.devtools.network`, the same API the Network panel uses. Nothing is
  captured while DevTools is closed.
- **WebSocket** — a content script wraps `window.WebSocket` at page load and mirrors frames to
  the panel. Native behavior is unchanged.

This processing is local and in memory:

- Nothing is written to disk. Captured traffic is held in memory only while DevTools is open,
  and discarded on navigation unless you enable "Preserve log". A ring buffer keeps the last
  4,000 entries.
- No `chrome.debugger` is used, so Chrome's "extension is debugging this browser" bar never
  appears.
- Data leaves the extension only when you ask: a Copy button places text on your clipboard,
  the AsyncAPI export saves a file through your browser's normal download mechanism, and the
  AI assistant sends data to Moonshot (below). All three are explicit actions you take.

## The optional AI assistant

**Disabled by default.** It does nothing — and sends nothing — until you enter a Moonshot
(Kimi) API key, tick the consent checkbox, and click "Save & enable".

Once enabled, when you ask a question or use a quick action, NetScope sends the following to
`https://api.moonshot.ai/v1/chat/completions`:

- your question,
- excerpts of the captured traffic that the model requests through its tools — URLs, headers,
  request and response body fragments, and WebSocket frame payloads from the page you are
  inspecting,
- a short summary of the capture (entry counts, hosts, status codes).

This can include personal data, session tokens, cookies, and anything else the inspected page
transfers. **Only use the assistant on traffic you are permitted to share.**

Requests are made with your API key and are governed by
[Moonshot AI's privacy policy](https://platform.moonshot.ai). NetScope's developer receives
nothing and has no visibility into these requests.

Every tool call is shown in the transcript and can be expanded to reveal the exact data that
was sent, so you can audit it.

### Redaction

Redaction is **off by default**, meaning the assistant receives what the browser actually sent.
Two optional settings reduce what is transmitted:

- **Mask secrets before sending** — replaces the values of `Authorization`, `Cookie`, and
  common API-key headers with shape hints (for example `<redacted Bearer JWT, expired 3m ago>`
  or `<redacted: 6 cookies: sid, csrf, …>`), and scrubs token-shaped strings from bodies and
  URLs. Header and cookie *names* are preserved so the assistant can still reason about auth.
- **Also mask emails, card and SSN patterns** — additionally scrubs those from bodies.

Masking is best-effort pattern matching. It cannot catch a secret sitting in an arbitrary JSON
field, and it is not a substitute for judgement about what traffic you expose.

### Your API key

Stored with `chrome.storage.local`, on this machine only. It is deliberately **not** stored in
`chrome.storage.sync`, which would replicate it through your Google account. It is never sent
anywhere except as the `Authorization` header on requests to `api.moonshot.ai`, and it is never
included in exports, cURL commands, or copied text.

`chrome.storage.local` is not encrypted — it is plain JSON inside your Chrome profile
directory, readable by anything with access to that directory. Prefer a key with a spend cap,
and use **Forget key** to remove it.

Chat transcripts are not persisted and are gone when the DevTools session ends.

## Permissions

- **clipboardWrite** — used only when you click a Copy button (copy as cURL, copy a frame
  payload, copy the AsyncAPI document, copy a reply).
- **storage** — stores the AI assistant's API key and settings locally. Nothing else is stored.
- **host permission for `https://api.moonshot.ai/*`** — the AI assistant's only outbound
  destination. This is the only host NetScope can contact; it is unused unless you enable the
  assistant.
- **Content scripts on `<all_urls>`** — the WebSocket hook must be in place at page load, on
  whichever page you choose to debug, to see frames at all. It only mirrors WebSocket activity
  to the panel; it reads no page content and modifies no page behavior. You can narrow the
  `matches` patterns in `manifest.json` if you only debug specific hosts.

NetScope uses no `chrome.debugger`, no `tabs`, and no `sidePanel` permission.

## Data collection

NetScope collects no personal information, no browsing history, no usage statistics, and no
identifiers. There are no accounts, no cookies set by the extension, and no remote code — all
code ships in the package, and responses from the Moonshot API are rendered as text, never
executed.

## Limited Use

NetScope's handling of user data complies with the Chrome Web Store User Data Policy, including
its Limited Use requirements. Captured traffic is transferred to Moonshot AI only when you have
enabled the AI assistant and only to provide the assistant feature you invoked. It is not sold,
not shared with anyone else, and not used for advertising, creditworthiness, or any purpose
beyond answering your question.

## Changes

If this policy ever changes, the updated version will be published at this same URL with a new
"Last updated" date. Any change would still have to describe truthfully what the published
code does.

## Contact

Questions about this policy or the extension:

- Email: [YOUR EMAIL]
- Source code: https://github.com/taishi55/NetScope
