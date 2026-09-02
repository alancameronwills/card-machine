# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A donation kiosk for churches. A Raspberry Pi (Debian) runs Chromium in kiosk mode
displaying a fullscreen slideshow with tap-to-donate buttons. A local Node.js server
serves the client and relays REST calls to the Square card-terminal API. The physical
card reader is a Square terminal — there is **no** direct link between the Pi and the
reader; everything goes via `connect.squareup.com`, and the Pi polls Square for status.

No build step, no framework, no npm dependencies — plain Node.js `http` + browser JS +
jQuery (vendored at `client/js/jquery.min.js`).

## Running & developing

```
# Local dev (Windows): serves on :8080, filters creds to dir matching "1893", appends "-s" to location
go.cmd

# Direct
node server/server.js <port> [credFilter] [locationSuffix]
```

`server.js` positional args: `argv[2]`=port (default 80), `argv[3]`=substring to pick
which `cred-*` dir to load, `argv[4]`=string appended to the analytics `location`.

On the Pi, `run.sh` is the top-level entry (launched by X autostart). It archives logs,
copies/pulls latest code, then starts `server/server.sh` (a watchdog that pings
`/ping` every 20 min and calls `restart-server.sh` if dead) and launches Chromium at
`http://localhost:8080/?nocursor`. `fetch-code.sh` does `git reset --hard origin/master`
on a ~11h loop — **the Pi force-syncs to `master`, so anything on master auto-deploys.**

There are no automated tests.

## Server architecture (`server/server.js`)

A single-file HTTP server. Two request paths in `serve()`:
- **Static files** — any URL with a known extension is read from `client/`. Paths
  containing `..` are rejected.
- **Handlers** — any extensionless URL is matched by prefix against the `handlers` map
  (`req.path.indexOf("/" + key) == 0`). This is why the client can call
  `/card-operation.php` and still hit the `card-operation` handler — the `.php` suffix
  is legacy and ignored by the prefix match.

Key handlers: `card-operation` (Square checkout/ping/cancel/login), `config` (whitelisted
subset of credentials sent to client), `list-slides`, `calendar` (Google Calendar proxy),
`analytics` (Application Insights query proxy), `log-donation` / `get-donation-log`.

`cardOperation()` builds a Square request in `cardOperationRequest()` and retries up to 3×.
Actions: default=create checkout (`terminals/checkouts`), `ping` (`terminals/actions`
PING), `cancel`, `login` (`devices/codes` — used by `client/code.html` to enroll a reader).
Amounts are in pence, GBP hard-coded.

## Client architecture (`client/js/client.js`)

Loaded by `client/index.html`. All tunable timings live at the top of the file.
Bootstraps in the final `$(async () => …)` block, which fetches `/config` then constructs
global singletons on `window`: `cardTerminal`, `slides`, `buttons`, `services`, `calendar`,
`receipts`, `labels`, `languageSwitch`, `romanClock`.

- **`CardTerminal`** — donation flow is client-driven polling: `donate()` fires a checkout
  then polls `/card-operation.php` every second reading `Content.checkout.status` until
  `COMPLETED`/cancelled/timeout. Separately, `pingCheck()` polls the reader at intervals
  that vary by day/night and recent activity to drive the connected/disconnected state.
- **`state`** — a plain object that toggles CSS classes on `<article>`
  (`waiting`/`pending`/`success`/`disconnected`); the CSS drives all visible UI changes.
- **Slides** — images come from `/list-slides`, which returns one `slides!<systemID>` dir
  chosen by the credential `location`. Filenames encode set + language: `-i-` → info/services
  set, `cy` prefix → Welsh, else English. Bilingual (en/cy) throughout via `LanguageSwitch`
  (observer pattern) and `Labels` (from `js/strings.js` merged with per-site `config.strings`).
- Analytics go to Azure Application Insights (snippet inlined in `index.html`); the
  `analytics()` helper dedupes and rate-limits events.

`client/code.html` = one-off page to enroll/login a new Square reader.
`client/aix.html` = Application Insights query/dashboard page.

## Credentials & per-site config

Each Pi has a `cred-<name>-<id>/card-machine.config` file (**gitignored, never committed** —
the two `cred-*` dirs present locally are the live secrets). It is JSON, loaded by
`getCredentials()`, which picks the dir matching the optional filter arg. The `config`
handler only forwards a whitelist to the client. See README.md for the full field list
(`deviceId`, `auth`, `applicationId`, `googleCalendar`/`googleApiKey`, `appInsights*`,
`location`, `churchName`, `strings`, `offline`, etc.).

`location` is the per-site analytics key and also selects the slide directory. Because
slide dirs and QR images are named `slides!<systemID>` / `!<name>` with a `!`, the update
mechanism only pulls the items matching the local systemID.

## Logs (repo root, gitignored)

`log-server.log`, `log-update.log`, `log-donations.log` (tab-separated `ISO-date\tpence`).
`run.sh` rotates these into `logs/` daily and truncates the donation log monthly.
`get-donation-log?agg=<n>&lines=<m>` aggregates donations by date-prefix length for the
"takings" display.
