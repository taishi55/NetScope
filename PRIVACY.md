# NetScope — Privacy Policy

**Last updated: July 23, 2026**

## Summary

NetScope does not collect, store, transmit, or sell any data. Everything it
shows you stays in memory on your own machine, inside your own browser.

## What NetScope processes

When you press "Start capture" in the NetScope side panel, the extension
attaches Chrome's own debugging protocol to that one tab and processes its
network traffic — HTTP requests and responses (URLs, headers, bodies) and
WebSocket frames — for one purpose only: displaying and searching that traffic
in the panel, at your request. Chrome shows its standard debugging notice for
the whole time capture is active, and capture ends when you press Stop, close
the panel, or close the tab.

This processing happens entirely locally, in memory:

- Nothing is sent to the developer or to any third party. The extension makes
  no network requests of its own and contains no analytics, telemetry, error
  reporting, or tracking of any kind.
- Nothing is written to disk. Captured traffic is held in memory only while
  the panel is open and discarded when capture stops (and on page navigation,
  unless you enable "Preserve log" for that session).
- Data leaves the extension only when you explicitly ask it to: clicking a
  Copy button places text on your clipboard, and the AsyncAPI export saves a
  file through your browser's normal download mechanism. Both are entirely
  under your control.

## Permissions

- **sidePanel** — the user interface lives in Chrome's side panel.
- **debugger** — the capture mechanism (the Chrome DevTools Protocol, the same
  one DevTools uses). Attached to a single tab only after you press Start,
  visibly (Chrome shows its debugging notice), and detached on Stop or when
  the panel closes.
- **tabs** — reads the active tab's title and URL to label what is being
  captured.
- **clipboardWrite** — used only when you click a Copy button (copy as cURL,
  copy a frame payload, copy the AsyncAPI document).

NetScope requests no access to website data (no host permissions) and injects
no scripts into pages.

## Data collection

NetScope collects no personal information, no browsing history, no usage
statistics, and no identifiers. There are no accounts, no cookies set by the
extension, and no remote code.

## Limited Use

NetScope's handling of any information complies with the Chrome Web Store User
Data Policy, including its Limited Use requirements. Because no data is
collected or transferred, there is nothing to sell, share, or use for
advertising, creditworthiness, or any other purpose.

## Changes

If this policy ever changes, the updated version will be published at this
same URL with a new "Last updated" date. Any change would still have to
describe truthfully what the published code does.

## Contact

Questions about this policy or the extension:

- Email: [YOUR EMAIL]
- Source code: https://github.com/taishi55/NetScope
