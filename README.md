# NetScope — an AI API copilot that lives on the page

Click the NetScope icon (or press `Alt+Shift+N`) on any page and a popup opens **on the
Chat tab**. Ask Kimi about the requests the page is making, have it call endpoints for you
from a cURL, or turn a sequence of calls into a flow that runs every hour. No DevTools
needed.

![Kimi creating a request, saving a two-step flow and running it](docs/popup-chat.png)

- **Chat first** — the popup opens on a conversation with Kimi, grounded in the page's real
  traffic through tools (it cites requests as `#412`; click one to open it).
- **Kimi models in the dropdown** — `kimi-k3.1-pro` (default), `kimi-k3.1-pro-highspeed`,
  `kimi-k3`, plus the legacy `kimi-k2.7-code` and `kimi-k2.6`. A second dropdown sets
  thinking depth (Quick / Deep / Max → `reasoning_effort` low / high / max).
- **Call APIs like Postman** — paste a cURL into the chat, or ask Kimi to replay a captured
  request with changes. Requests run from the extension (no CORS), are logged in Traffic
  tagged *AI*, *You* or *Flow*, and anything that can change data waits for your click.
- **Flows and bots (Zapier-style, but programmable)** — chain requests, then filter, loop,
  branch, remember state between runs and call Kimi mid-flow. Run on demand, every N
  minutes, or whenever the page makes a matching request — in the background.
- **Keep logs on reload** — one switch in the popup header keeps the captured traffic (and
  the chat) across page reloads and navigations.
- **Traffic** — everything the old DevTools panel did, in the popup: full-text/regex search
  across URLs, headers, bodies and WebSocket frames, grouped repeats, request/response
  detail, **Edit & send** (Postman-style resend from an editable cURL), Copy cURL, and
  AsyncAPI 3.0 export for WebSocket traffic.
- **Expandable** — panel (460 px), large (near full screen, list + detail side by side), a
  pill with a live traffic trace, or hidden.

## Install (unpacked)

```
git clone https://github.com/taishi55/NetScope.git
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the cloned `NetScope` folder.
3. Pin the NetScope icon. On any page, click it (or press `Alt+Shift+N`).
4. Reload pages that were open before installing, so the capture hook is in place from the
   first request.

## Chat with Kimi

Open **Settings** (gear icon) → paste a key from [platform.moonshot.ai](https://platform.moonshot.ai)
→ tick the consent box → **Save and enable**. **Test key** checks the key and model access
with a free `GET /v1/models` call.

Things to try:

- “Map the API this page uses.”
- “Why did the last request fail?” — or select a request in Traffic and ask; the chip above
  the input tells Kimi which request you mean.
- Paste `curl 'https://api.example.com/v1/me' -H 'Authorization: Bearer …'` — Kimi runs it
  and explains the response.
- “Every hour, get the newest order and post its id to https://hooks.example.com/x.”
- “Whenever this page loads orders, post each new paid one to my webhook — never the same
  order twice.”

### Tools Kimi can use

| Tool | What it does |
| --- | --- |
| `get_capture_summary`, `list_endpoints`, `list_requests`, `search_traffic` | Orient in the capture, find requests |
| `get_request`, `describe_json`, `get_websocket_frames`, `compare_requests`, `get_curl` | Drill into one request or diff two |
| `http_request` | Send a request from a cURL, a captured request (`from_id`, real headers copied locally) or a URL, with overrides |
| `save_flow`, `run_flow`, `list_flows`, `get_flow`, `delete_flow` | Build, test, schedule and manage flows |

### Staying under Kimi's rate limits

Kimi limits each account (not each key) by concurrent requests, requests per minute, tokens
per minute, and on Tier 0 tokens per day. It counts a request as its **input tokens plus
`max_completion_tokens`**, whatever the reply actually uses — and K3's default for that is
131,072, which would spend a Tier 1 minute in a few calls. NetScope therefore:

- sets an explicit reply cap on every call (8k / 16k / 32k for Quick / Deep / Max thinking,
  or a fixed value under Settings → **Max reply length**), raising it for the rest of an
  answer only if a reply actually hits it;
- keeps the resent conversation lean (about 45k tokens);
- paces every Kimi call from every tab and every flow through one budget in the background
  worker, sized to 90 % of your tier (Settings → **Your Kimi account tier**) — a call that
  would cross a limit waits a few seconds, with the reason shown, instead of failing;
- if a 429 still arrives, pauses all callers, honors `Retry-After`, and retries up to five
  times with backoff. A daily cap or an empty balance is reported plainly, not retried.

### What waits for your approval

Settings → **Ask before Kimi acts**:

- **For changes** (default) — POST/PUT/PATCH/DELETE requests, saving a flow that has a
  schedule or write steps, running a flow with write steps, deleting a flow.
- **For every request** — also GETs.
- **Never** — autopilot.

The approval card shows the exact method, URL, headers (secrets abbreviated) and body.

## Flows and bots

A flow can be a two-call chain or a small bot: page through an API, filter the results,
loop over the matches, branch, remember what it already handled, and run by itself on a
schedule or **whenever the page makes a matching request**. Build one by asking Kimi, or
**Flows → New flow**, which opens an example bot in the JSON editor:

```json
{
  "name": "Paid order notifier",
  "on_request": { "url_contains": "/api/orders", "method": "GET", "status": "2xx", "cooldown_seconds": 30 },
  "steps": [
    { "id": "paid_new", "type": "filter", "items": "{{trigger.body.items}}",
      "where": "{{item.status}} == paid and {{item.id}} > {{state.last_id | default:0}}" },
    { "id": "check", "type": "if", "condition": "{{vars.paid_new | length}} > 0",
      "then": [
        { "id": "each", "type": "for_each", "items": "{{vars.paid_new}}", "as": "order", "delay_ms": 200,
          "steps": [
            { "id": "notify", "method": "POST", "url": "https://hooks.example.com/orders",
              "body": { "id": "{{order.id}}" }, "expect_status": "2xx", "retry": { "times": 2 } } ] },
        { "id": "remember", "type": "set", "state": { "last_id": "{{vars.paid_new | pluck:id | max}}" } },
        { "id": "report", "type": "log", "message": "notified {{vars.paid_new | pluck:id | join:\", \"}}" } ],
      "else": [ { "id": "quiet", "type": "stop", "message": "nothing new" } ] }
  ]
}
```

| Step | Does |
| --- | --- |
| `http` | `method/url/headers/body/query`, or `curl`, or Kimi's `from_id`; `extract`, `expect_status`, `retry`, `timeout_ms` |
| `filter` | keeps the `items` where `where` holds → `{{vars.<save_as or id>}}` |
| `map` | turns each item into `value` → a new list |
| `for_each` | runs nested `steps` per item (`as`, `max`, `delay_ms`, `on_item_error`, `collect`) |
| `repeat` | runs nested `steps` `until`/`while` a condition, up to `max` — pagination, polling |
| `if` | `condition` → `then` / `else` steps |
| `set` | assigns `vars`, or `state` — memory kept between runs |
| `ai` | a Kimi prompt over earlier results (`json: true` for structured output) |
| `stop`, `log`, `delay`, `run_flow` | end early (ok/fail), write to the run log, wait, call another flow |

- **Templates** — `{{vars.x}}`, `{{state.x}}`, `{{steps.<id>.body.<path>}}` / `.status` /
  `.headers.<name>`, `{{item.x}}` (or the loop's `as` name), `{{loop.index}}`,
  `{{trigger.body.<path>}}`, `{{now}}`, `{{uuid}}` and more. Filters transform values:
  `where:status=paid`, `pluck:id`, `sort:-total`, `unique`, `sum`, `max`, `slice:0:5`,
  `join:", "`, `add:1`, `default:x`, `json` … A JSON value that is exactly one template keeps
  its type.
- **Conditions** (`when` on any step, `where`, `condition`, `until`, `while`) — `==`, `!=`,
  `>`, `<`, `>=`, `<=`, `contains`, `matches`, `exists`, `missing`, joined with `and` / `or`,
  negated with `not`.
- **Triggers** — `schedule` (every N minutes, via `chrome.alarms`) and `on_request` (the page's
  own fetch/XHR matching URL, method and status; at most once per cooldown; requests NetScope
  sends never trigger). The response is `{{trigger.body}}`. Both keep working while Chrome is
  open, even with the page closed; pause either from the flow card.
- **Limits per run** — 2,000 step executions and 4 minutes; loops default to 100 items
  (`for_each`) or 10 passes (`repeat`). A run that fails by itself puts a red `!` on the
  toolbar icon and a notice in the Flows tab. The last 15 runs per flow are kept, each with
  per-step results (loop bodies show how many times they ran and failed) and the run log.
- **Copy as Markdown** on each flow copies the whole thing as a document: triggers, the step
  outline (2, 2.1, 2.1.1 …) with each request as cURL, the last run's result per step, the
  run log, the memory, and the JSON definition. Literal secrets (auth headers, cookies, token
  fields) are masked; `{{templates}}` stay as written. **Edit** still shows the raw definition.

![Flows tab with step results from the last run](docs/popup-flows.png)

## Traffic

![Large mode: the captured list beside a request's detail](docs/popup-traffic.png)

Search is plain text or regex with a case toggle and per-field scopes; `Enter` jumps to the
next match. Identical requests group into one row with `×N` (a warning tint if their
statuses differ). **Edit & send** turns any request into an editable cURL you can resend;
**New request** starts from a blank one.

## How it works

```
page (MAIN world)          isolated world          service worker                  popup (iframe)
net-hook.js ─postMessage─▶ content.js ─sendMessage─▶ background.js ──port──────────▶ app.html
  wraps fetch, XHR,          hosts the popup           per-tab log (IndexedDB)          Chat · Traffic · Flows
  WebSocket                  iframe                    request runner, flows, alarms ─▶ api.moonshot.ai (your key)
```

- **Capture** — `net-hook.js` wraps `fetch`, `XMLHttpRequest` and `WebSocket` with Proxies
  at `document_start`, so native behavior and `toString()` are unchanged. Response bodies are
  read from a clone (cancelled once the cap is reached), streamed bodies update live.
- **Popup** — `content.js` injects an extension-page iframe inside a closed shadow root. The
  UI runs in the iframe, cross-origin to the page, so the page cannot read it or keylog the
  API key field.
- **Log** — the background worker owns a per-tab log, mirrored to IndexedDB so it survives
  service-worker restarts and, with **Keep logs on reload**, page reloads. Without the switch
  each new document starts a fresh log. The database is wiped when the browser starts.
- **Requests and flows** run in the background worker with the extension's host permission
  (no CORS) and the browser's own cookies for the target site.

## Caveats

- Only traffic the page's own JavaScript makes is captured (fetch, XHR, WebSocket).
  Documents, images, scripts and requests from Service/Web Workers are not.
- Request headers are the ones the page set; the browser adds cookies, user-agent and
  similar itself. Scripts cannot set `Cookie`, `Origin`, `Referer` or `User-Agent`, so a
  cURL containing them is sent without them (reported as *Not sent*) and the browser's own
  cookies for that site are used.
- Bodies and frames are captured up to 256 KB; requests NetScope sends keep up to 1 MB. Each
  tab keeps the last 3,000 entries.
- Pages where extensions cannot run (`chrome://`, the Web Store) open NetScope as a
  standalone tab instead.
- Generated cURL commands include captured auth headers verbatim — treat them as secrets.

## Permissions

- `<all_urls>` content scripts and host permission — the capture hook must be in place on
  whichever page you debug, and the request runner and flows must reach whichever API you
  point them at.
- `storage` — settings, API key, flows and run history (`chrome.storage.local`), chat per tab
  (`chrome.storage.session`). The capture log lives in the extension's IndexedDB.
- `alarms` — flow schedules.
- `scripting` — injects the capture hook into tabs that were open before installing.
- `clipboardWrite` — the Copy buttons.

## Privacy

NetScope has no analytics, telemetry or error reporting, and never contacts its developer.
Data leaves your machine only when you, or a flow you saved, ask for it: questions and
traffic excerpts go to `api.moonshot.ai` with your key, and requests you or Kimi send go to
the URLs they name. Full policy: [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)
