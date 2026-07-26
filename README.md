# NetScope — search Network responses & WebSockets from DevTools

Chrome's Network panel only filters by URL. NetScope is a native DevTools panel
that indexes everything the page transfers and lets you search inside it:

- **Response bodies** — find which request actually returned `"userId":48212` or an error string.
- **Request bodies & headers** — both directions, both header sets.
- **Live WebSocket frames** — every sent/received frame is captured and searchable, per direction.
- **Duplicates grouped by default** — requests with the same input (method + URL + request body)
  and identical WS frames collapse into one row with a ×N badge. Responses may differ across a
  group (polling, retries); mixed statuses get a warning-tinted badge and a per-status breakdown
  in the detail pane. Untick "Group duplicates" to see every occurrence.
- **Duplicate grouping (on by default)** — repeat polls, retries and identical
  heartbeat frames collapse into a single row with a `×N` count instead of
  flooding the list.
- **Copy as cURL** — replay any captured HTTP request 1:1 (headers and body included).
- **WS tooling** — one-click `websocat` / `wscat` commands and a cURL handshake probe per socket.
- **Export AsyncAPI 3.0** — turn the captured WebSocket traffic into an AsyncAPI skeleton
  (servers, channels, send/receive operations, real captured payloads as message examples).
- **AI assistant (opt-in)** — ask Kimi K3 what an endpoint does, why a request failed, or how
  the whole API surface fits together. Off until you add your own key; see below.

Search supports plain text or regex, case toggle, per-field scopes
(`url · req-h · req-b · res-h · res-b · ws`), a resource-type filter, and "Found in" chips
showing exactly where each hit lives. `Enter` jumps to the next match; matches are
highlighted in the detail pane. `Preserve log` keeps entries across navigations.

## Duplicate grouping

Two entries are considered the same only when **everything** that defines them
matches:

- HTTP — method, full URL, status, request body, and response body (binary
  bodies compare by size). Requests whose body is still downloading are never
  grouped, so a response that turns out to differ can't be hidden.
- WebSocket — socket URL, direction, and the exact frame payload.

The kept row is the **first** occurrence, badged `×N`; opening it shows the
count with first and last timestamps and an **Ungroup** button. Untick
**Group duplicates** in the toolbar to see every entry individually. Grouping is
applied after filtering, so the match count always equals the number of rows
you can actually step through with `Enter`.

## AI assistant

Search tells you *where* a string appears. It can't tell you why a `422` came back, or what
an unfamiliar endpoint is for. The **AI** button in the toolbar (`Alt`/`⌥` + `A`) opens a sidebar
that can, using [Kimi K3](https://platform.kimi.ai/docs) and your own Moonshot API key.

It is **agentic**, not a prompt stuffed with your traffic. The model gets tools to query the
capture and drills down the way you would:

| Tool | What it does |
| --- | --- |
| `get_capture_summary` | Counts, hosts, status histogram |
| `list_endpoints` | Requests grouped by method + host + normalized path (`/orders/:id`) |
| `list_requests` | Filtered, sorted, paginated list — one line each, no bodies |
| `search_traffic` | Text/regex across URLs, headers, bodies and WS frames; returns snippets |
| `get_request` | One entry in full, with paging through large bodies |
| `describe_json` | A body's *shape* — keys, types, array lengths — collapsing 1 MB to ~900 chars |
| `get_websocket_frames` | Frames for one socket, with heartbeats collapsed |
| `compare_requests` | Diffs a success against a failure to explain the difference |

Three one-click actions: **Summarize API structure** (whole capture), and **Explain** /
**Debug** on the selected request — Debug appears only on 4xx/5xx and network failures.
Answers cite entry ids like `#412`; click one to jump to that row. Every tool call is shown
collapsed in the transcript and expands to the exact payload that left your machine.

### Setup

1. Get a key from [platform.moonshot.ai](https://platform.moonshot.ai) — a spend-capped one is wise.
2. Click **AI** → paste the key → tick the consent box → **Save & enable**. **Test** verifies it.
3. Ask away, or hit a quick action.

The key is stored with `chrome.storage.local` on this machine only. It is never synced through
your Google account and never sent anywhere but `api.moonshot.ai`. **Forget key** removes it.

### What gets sent

Whatever the tools return: URLs, headers and body excerpts from the page you are inspecting.
**Redaction is off by default**, so that includes live session tokens, cookies and any personal
data the page transfers. Tick **Mask secrets before sending** to replace `Authorization` and
`Cookie` values with shape hints (`<redacted Bearer JWT, expired 3m ago>`) and scrub
token-shaped strings from bodies and URLs; a second checkbox also masks email, card and SSN
patterns. Masking is best-effort — it cannot catch a secret sitting in an arbitrary JSON field.
Nothing is sent until you have entered a key and consented, and nothing is sent on its own:
every request is one you triggered.

## Screenshots

![Search inside responses](docs/screenshot-1-search.png)
![Match highlighting in the response body](docs/screenshot-2-response.png)
![WebSocket frames captured live](docs/screenshot-3-websockets.png)

## Install (unpacked)

```
git clone https://github.com/taishi55/NetScope.git
```

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the cloned `NetScope` folder
4. Open DevTools on any page (`F12`) → pick the **NetScope** tab (it may hide behind `»`)
5. **Reload the page once** so the WebSocket hook is in place before the app connects

## How it works

```
page (MAIN world)        isolated world        service worker         DevTools
ws-hook.js  ──postMessage──▶ ws-bridge.js ──sendMessage──▶ background.js ──port──▶ devtools.js ──▶ panel
   │                                                                        ▲                       │
   └─ wraps window.WebSocket (send + message)                               │                       │
                                                                            │                  ai-*.js
chrome.devtools.network.onRequestFinished + getContent  (HTTP + bodies) ────┘                       │
                                                                                                    ▼
                                                          only when you ask ──▶ api.moonshot.ai (your key)
```

- `devtools.js` runs for the whole DevTools session, so HTTP capture starts the moment
  DevTools opens (plus a `getHAR` backfill of anything the Network panel already recorded).
- WebSocket frames are mirrored by a tiny `Proxy` around `window.WebSocket`; native behavior
  is untouched. The background worker routes frames to the DevTools instance inspecting that
  tab and keeps a small backlog so frames fired just before the panel connects aren't lost.
- No `chrome.debugger`, so the "extension is debugging this browser" bar never appears.
- The AI code (`ai-tools.js`, `ai-client.js`, `ai-agent.js`, `ai-panel.js`) runs in the panel
  document, where the capture already lives as a plain JS object — no serializing thousands of
  entries across a port, and no run dying when the MV3 service worker suspends. It ships in the
  package; no remote code is ever fetched or executed.

## Why a DevTools panel and not a Network-panel sidebar

Chrome's extension API only allows sidebars inside the **Elements** and **Sources** panels —
there is no API to extend the Network panel itself. A dedicated DevTools panel is the closest
native integration Chrome permits, and it follows the DevTools theme (dark/light) automatically.

## Caveats

- WebSocket capture hooks `window.WebSocket` at `document_start`: pages loaded **before**
  installing/reloading the extension, and sockets opened inside **Workers**, are not seen.
- HTTP is only captured **while DevTools is open** (a Chrome platform limit, same as the HAR).
- Bodies are truncated at 1 MB and WS frames at 256 KB (constants at the top of
  `devtools.js` / `ws-hook.js`); binary bodies are flagged and skipped by search.
- Ring buffer keeps the last 4 000 entries.
- Generated cURL includes captured cookies/authorization headers verbatim — treat it as a secret.
- `<all_urls>` content-script access is required to hook WebSockets everywhere; narrow the
  `matches` patterns in `manifest.json` if you only debug specific hosts.
- Using the AI assistant transmits excerpts of the captured traffic to a third party
  (Moonshot AI). It is off by default and each request is one you triggered, but the data does
  leave your machine — see [What gets sent](#what-gets-sent).
- Chat transcripts are not persisted; they are gone when the DevTools session ends.

## Permissions

- `clipboardWrite` — the various Copy buttons.
- `storage` — stores the AI assistant's API key and settings locally (`chrome.storage.local`,
  never `chrome.storage.sync`). Nothing else is persisted.
- `https://api.moonshot.ai/*` — the AI assistant's only outbound destination, and the only host
  this extension can reach at all. Unused until you enable the assistant.
- Content scripts on `<all_urls>` — the WebSocket hook + bridge (see note above).

## Privacy

Capture is entirely local: traffic lives in memory, on your machine, for the current DevTools
session. NetScope has no analytics, telemetry, or error reporting, and never contacts the
developer.

The optional AI assistant is the one exception, and only when you enable and use it: it sends
selected excerpts of the captured traffic, plus your question, to `api.moonshot.ai` using your
own API key. Moonshot's policy governs that data. Full policy: [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)
