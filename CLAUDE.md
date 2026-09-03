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

## SMS relay (`server/sms-relay.js`)

Optional, started from `server.js` only when the credential `smsRelay` object is present,
inside a try/catch so it can never disrupt the kiosk. It polls the site's TP-Link / Archer
4G router every 90s and forwards newly-received SMS to a configured number by having the
router send an SMS. See README.md for the `smsRelay` config shape.

`smsRelay.to` may be a list: a whitelist of numbers, any of which can text the SIM to redirect
future relays to itself (`+44` and a leading `0` compare equal - see `normalizeNumber()`). The
live destination is persisted in `sms-relay-seen.json` beside the seen keys and is **never**
written back to the config file. Messages arriving from the destination number itself are
relayed only `ECHO_LIMIT` (2) times per start-up or redirect, to break auto-responder loops;
that budget is in memory only, so a reboot re-arms it.

Self-contained and **dependency-free on purpose** (the project ships no `node_modules`): it
ports TP-Link's encrypted "GDPR" CGI protocol — RSA-512-signed, AES-128-CBC `cgi_gdpr`
command frames — using only Node built-ins, with native `BigInt` replacing `jsbn` and the
`http`/`https` modules replacing `axios`. Ported from
https://github.com/cmer81/tp-link-modem-sms-api. Faithful quirks to keep for router
compatibility: the RSA exponent is parsed as hex (`"010001"` → 65537) and the signature
carries a literal `h=undefined` (the reference never sets a password hash). POSTs must send
`Content-Length` or the firmware resets the connection.

First run baselines the existing inbox (not forwarded); relayed-message keys persist to
`sms-relay-seen.json` (repo root, gitignored) so restarts don't re-send. Test against real
hardware with `node server/sms-relay.js <url> <login> <password> [<forwardTo>]`.

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
