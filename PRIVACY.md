# NetScope — Privacy Policy

**Last updated: November 18, 2026**

## Summary

NetScope captures the API traffic of the pages you open it on and keeps it on your own
machine. It has no analytics, no telemetry, no error reporting and no accounts, and it never
contacts the developer.

Data leaves your machine in exactly two ways, both started by you:

1. **Kimi (optional)** — when you have entered your own Moonshot API key, consented, and ask a
   question, excerpts of the captured traffic are sent to Moonshot AI.
2. **Requests you send** — when you, Kimi at your request, or a flow you saved sends an HTTP
   request, it goes to the URL that request names, like any request your browser makes.

## What NetScope captures

On every page, a content script wraps the page's `fetch`, `XMLHttpRequest` and `WebSocket` at
load and mirrors their activity to the extension: request method, URL, the headers the page
set, request body, response status, headers and body (up to 256 KB each), and WebSocket
frames. Native behavior is unchanged. Requests the browser makes on its own (documents,
images, scripts) are not captured.

Where it is kept:

- **Capture log** — in the extension's IndexedDB on your machine, per tab. A new page load
  starts a fresh log unless you turn on **Keep logs on reload**. A tab's log is deleted when
  the tab closes, and the whole database is wiped each time the browser starts. Each tab keeps
  at most the last 3,000 entries.
- **Chat** — per tab in `chrome.storage.session`, which Chrome clears when the browser closes.
- **Flows and their run history** — in `chrome.storage.local` until you delete them. A flow
  built from a captured request stores that request's headers, which can include
  authorization tokens. Run history keeps step outputs (up to 4 KB each) for the last 15 runs.
- **Settings and API key** — in `chrome.storage.local` (below).

Nothing is written outside your Chrome profile. No `chrome.debugger` is used.

## Kimi (optional AI assistant)

**Off by default.** Nothing is sent until you enter a Moonshot API key, tick the consent box
and click "Save and enable". After that, when you ask a question or use a quick action,
NetScope sends to `https://api.moonshot.ai/v1/chat/completions`:

- your question and the conversation so far,
- the parts of the captured traffic the model asks for through its tools — URLs, headers,
  request and response body fragments, WebSocket payloads,
- the results of requests and flow runs it performs for you,
- a short summary of the capture (counts, hosts, status codes).

AI steps inside a flow send their prompt — including any values the prompt pulls in from
earlier steps — to the same endpoint, each time the flow runs, on schedule or not.

This can include personal data, session tokens, cookies and anything else the page transfers.
**Only use Kimi on traffic you are permitted to share.** Requests use your key and are
governed by Moonshot AI's privacy policy. NetScope's developer receives nothing.

Every tool call appears in the chat and expands to the exact data that was sent.

### Masking

Off by default. **Mask secrets before sending** replaces the values of `Authorization`,
`Cookie` and common API-key headers with shape hints (for example
`<redacted Bearer JWT, expired 3m ago>`) and scrubs token-shaped strings from bodies and URLs.
**Also mask emails, card and SSN patterns** scrubs those too. Masking is best-effort pattern
matching and cannot catch a secret in an arbitrary JSON field. Masked values are never sent
by Kimi's requests: to replay a request with real credentials it references the captured
entry, and NetScope copies the values locally without showing them to the model.

### Your API key

Stored with `chrome.storage.local` on this machine only — never `chrome.storage.sync`. It is
sent only as the `Authorization` header to `api.moonshot.ai` (including the free
`GET /v1/models` call behind "Test key"). It is never included in exports, cURL commands or
copied text. `chrome.storage.local` is not encrypted; prefer a key with a spend cap, and use
**Forget key** to remove it.

## Requests and flows

When you click **Send** in Edit & send, approve a request Kimi proposes, or run a flow, the
background worker sends that request to its URL with the browser's own cookies for that site,
and records it in the tab's capture log. Scheduled flows run with `chrome.alarms` while Chrome
is open, without further interaction, until you change their schedule to "Manual only" or
delete them. By default, Kimi must get your click before sending a request that can change
data (POST, PUT, PATCH, DELETE), saving a scheduled flow, or deleting a flow; you can make
this stricter or turn it off in Settings.

## Permissions

- **Content scripts and host permission on `<all_urls>`** — the capture hook must be in place
  on whichever page you choose to debug, and requests and flows must reach whichever API you
  point them at. Narrow the patterns in `manifest.json` to limit this.
- **storage** — settings, API key, flows and run history (local); chat per tab (session).
- **alarms** — flow schedules.
- **scripting** — injects the capture hook into tabs that were already open when you first
  click the icon.
- **clipboardWrite** — the Copy buttons.

## Data collection

NetScope collects no personal information, browsing history, usage statistics or identifiers
for its developer. There is no remote code: all code ships in the package, and responses from
Moonshot and from APIs you call are rendered as text, never executed.

## Limited Use

NetScope's handling of user data complies with the Chrome Web Store User Data Policy,
including its Limited Use requirements. Captured traffic is transferred to Moonshot AI only
when you have enabled Kimi, and only to provide the feature you invoked. It is not sold, not
shared with anyone else, and not used for advertising, creditworthiness or any other purpose.

## Changes

Updates to this policy are published at this URL with a new "Last updated" date, and must
describe truthfully what the published code does.

## Contact

- Email: [YOUR EMAIL]
- Source code: https://github.com/taishi55/NetScope
