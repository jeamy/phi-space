# Dashboard: read-only live view for Spaces

As of: 2026-10-28. **Phase 1, implemented.** Realization of the [UI plan](_attic/ui-mockups/UI-PLAN-SUMMARY.en.md) with the
decisions taken: without a framework and without new dependencies, read-only, as a standalone
start module `src/dashboard.ts`, and only with data that really exists (agent/mobile panels deliberately stay empty until
there is a data source). The design follows the [mockups](_attic/ui-mockups/ui-dashboard.en.md) (3-panel layout,
color scheme, live indicators).

## Start

In the foreground (own terminal, ends with Ctrl+C):

```bash
npm run dashboard -- --dir /pfad/zum/store              # directory with store.sqlite (is created)
npm run dashboard -- --sqlite /pfad/store.sqlite        # store file
```

In the background with the lifecycle script ([scripts/dashboard.sh](../scripts/dashboard.sh)):

```bash
npm run dashboard:start          # starts in the background and waits for readiness
npm run dashboard:status         # running? which Spaces?
npm run dashboard:stop           # clean stop by SIGTERM
bash scripts/dashboard.sh logs   # follow the log live
```

The dashboard opens the phi-spaces SQLite store and holds its owner lock, because it also serves the
Space socket. It does not read old JSONL or pi-durable stocks in the directory (decision D6).

The script is configured through environment variables or the `DASHBOARD_*` lines of the `.env` in the repository root
(set variables take precedence; `src/dashboard.ts` reads the same `.env` in the foreground too): `DASHBOARD_APPS`
(app sources, see below), `DASHBOARD_DIR` (directory with `store.sqlite`, default
`~/.local/share/phi-spaces/dashboard-store`), `DASHBOARD_SQLITE` (store file instead), `DASHBOARD_PORT`
(default 8787), `DASHBOARD_BIND` (default 127.0.0.1). Further flags after the command are passed through to
`src/dashboard.ts`, e.g. `bash scripts/dashboard.sh start --no-socket`. PID and log file
lie under `$XDG_RUNTIME_DIR/phi-spaces-dashboard-<uid>/` (fallback `/tmp`); a second `start` reports
the running process instead of opening a second one.

Options of the daemon (apply to both kinds of start): `--port` (default 8787), `--bind` (default 127.0.0.1 —
deliberately loopback only), `--socket <pfad>` (default `<store>/space.sock`, can be switched off with `--no-socket`),
`--app id=adresse` (repeatable, replaces the default apps), `--no-apps`, `--help`.

Open in the browser: **http://127.0.0.1:8787** (or the chosen port).

### Permanently as a service (survives restarts)

`dashboard.sh start` starts the process with `nohup`: it keeps running when the terminal goes away, but does not start again after a reboot
of the machine. Whoever wants to run the dashboard permanently (as on big behind `spaces-stats.eibrain.org`)
creates a systemd user unit, following the same pattern as the tunnels `codemode-nano-tunnel.service` and
`mmo-accounts-tunnel.service`. Prerequisite: linger for the user (`loginctl show-user $USER -p Linger` shows `yes`;
otherwise once `sudo loginctl enable-linger $USER`), so that user units start without a login.

```bash
cat > ~/.config/systemd/user/phi-spaces-dashboard.service <<'EOF'
[Unit]
Description=phi-spaces read-only dashboard (127.0.0.1:8787; settings: DASHBOARD_* in the checkout's .env)
After=network-online.target codemode-nano-tunnel.service mmo-accounts-tunnel.service swarm-nano-tunnel.service

[Service]
WorkingDirectory=/media/docker/spaces
ExecStart=/usr/local/bin/node --no-warnings --experimental-strip-types src/dashboard.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
bash scripts/dashboard.sh stop          # a process started by the script otherwise holds port and store
systemctl --user daemon-reload
systemctl --user enable --now phi-spaces-dashboard.service
```

`WorkingDirectory` is the checkout (on big `/media/docker/spaces`), `ExecStart` the path from `command -v node`. The
unit starts `src/dashboard.ts` directly in the foreground; it reads the settings itself from the `DASHBOARD_*` lines of the
`.env` in the checkout (store, port, app addresses). After that:

- Restart after `git pull` or a change of the `.env`: `systemctl --user restart phi-spaces-dashboard`
- State and log: `systemctl --user status phi-spaces-dashboard`, `journalctl --user -u phi-spaces-dashboard -f`
- Switch off: `systemctl --user disable --now phi-spaces-dashboard`

With the unit, do not additionally use `npm run dashboard:start`: two processes want the same port and the same
owner lock of the store, the second aborts.

## Apps: the Spaces of the projects

The projects on phi-spaces run their Spaces in separate processes, each holding the owner lock of its store.
The dashboard therefore does not open these stores, but connects as a client to their socket
(`connectSpace`) and uses only calls that leave nothing behind: `stats` (every 2 s per app) and `readAll` pages for the
entry list — no `read`/`take`, so no request claims and no locks. The entry list reads the first
`after + limit + 1` entries in one call and cuts in the dashboard (upper limit 2000), so that no
page snapshot stays behind in the Space of the app.

Each app has several default addresses, tried in this order (the last successful one first): the Unix socket
of a normal start (`npm start`, `dev`), the loopback port that `docker:local:up` publishes, and on big the
production address: the local end of the SSH tunnel to nano or the loopback port of a Space running on big.

| App | normal start | `docker:local:up` | big |
|---|---|---|---|
| Codemode Chat | `unix:/tmp/codemode-space.sock` | `tcp:127.0.0.1:3810` | `tcp:127.0.0.1:3800` (tunnel to nano) |
| spaces-mmo · Welt | `unix:/tmp/spaces-mmo-world.sock` | `tcp:127.0.0.1:3960` | `tcp:127.0.0.1:3950` (region West on big, no tunnel) |
| Help · Swarm-Shard | `unix:/tmp/swarm-b.sock` | `tcp:127.0.0.1:3600` | `tcp:127.0.0.1:3600` (tunnel to nano) |
| Help · Hub (`@*`) | `unix:/tmp/help-space.sock` | – | `tcp:127.0.0.1:3520` (the hub itself, no tunnel) |

**Public on big:** nginx forwards `https://spaces-stats.eibrain.org` (IPv6 `2a0a:4cc0:c0:62f2:8000::1002`, IPv4
shared) to `127.0.0.1:8787`, with a Let's Encrypt certificate (webroot `/var/www/acme`, like spaces-mmo), without
login (since 2026-10-28; the dashboard has only GET endpoints, the hub of the help site returns only figures, the
accounts store of spaces-mmo is missing). The entries of codemode chat, spaces-mmo world and swarm shard are thereby
publicly readable, also account names and messages to individual figures. `/api/live` without buffering. Site:
`/etc/nginx/sites-available/spaces-stats.eibrain.org`; the help site links the page with an introduction.

Deliberately not included: the accounts Space of spaces-mmo (credentials, sessions). The store of the help site lies in the
web process; with `HELP_SPACE_LISTEN` (in production `tcp:127.0.0.1:3520`, loopback, never behind nginx) it serves
only figures: its role may use `hello`, `stats` and `spaces`, no `readAll`. It holds the Space `control`
(`PeerKey`, `Enroll`) and the messages of the chat sessions, so the dashboard shows no entries there
("Einträge nicht freigegeben"), but it does show every Space with count per type and memory. If an app is not running, it appears
as "offline" with its address. Other addresses: `--app chat=tcp:nano:3800 --app welt=unix:/pfad.sock`, or in the `.env`
`DASHBOARD_APPS=spaces-mmo=tcp:127.0.0.1:3960|unix:/tmp/spaces-mmo-world.sock,codemode-chat=tcp:127.0.0.1:3810`
(entries separated by comma, alternatives by `|`; `--app` replaces `DASHBOARD_APPS`, both replace the default apps; a
default ID keeps its name and its Space).

**Named Spaces.** Without a statement the dashboard queries the default Space of the service. If the data lies in a
named Space, it is attached to the ID with `@`: `id@space=adresse`. The swarm shard of the help site keeps its posts in the Space
`social-swarm` (`SWARM_ALIAS`, created in `help-site/server/nano-host.ts`), its default Space stays empty;
the default app `help-swarm` therefore queries `social-swarm`, even if it stands in `DASHBOARD_APPS` without `@`.

**All Spaces of a service.** `id@*=adresse` queries the list of the service (method `spaces`, [API](api.en.md)) and
reads the figures of each Space (the 100 newest), summed for the app and individually in the table "Spaces".
It collapses aliases `präfix-<id>` from three equal prefixes on into one row (`chat-session-*` with their count).
Because this costs one call per Space, it reads such an app only every fifth round (at 2 s, every 10 s). The
default app `help-hub` is such an app. Which data lies in which store and Space: [data storage](datenhaltung.en.md).

The daemon opens the store **exclusively**: no second process may hold the same store
(single owner, see [conversion plan](umstellung-ohne-pi-durable.en.md) 5.2). Without `--no-socket` it
additionally serves the Space service on a Unix socket — this is the only way live traffic
arises in phase 1: examples or clients connect through `socketTransport({ path: ".../space.sock" })` and the
dashboard process counts and shows their operations. Whoever may open the socket file (same
operating user, file mode 0600) is a local admin there — identity comes from the trusted
local boundary, never from sent bytes; the same rule as in [socket.ts](../src/socket.ts). The dashboard
itself has **no writing endpoint**.

## Interface

**Live per app.** Every measurement (every 2 s, an app with `@*` every 10 s) becomes a point; the dashboard keeps the last 450
(15 minutes) and shows them in the detail view of the app as six curves: the answer time of the Space (duration of the
`stats` call), CPU and working memory of the Space process, memory in the Space (total, claims), entries and among them
messages (`Msg`), commits per minute. The Space service itself reports CPU and memory with every `stats` answer
(`process: { cpuMs, rssBytes, heapBytes, at }`, [API](api.en.md)); a Space process of an older phi-spaces version does not report
them, then the card says so. The curves come once with the app list (`/api/apps`, `hello`), after that with every
measurement only the new point (`point` in the SSE event `apps`).

**Enlarge a curve, 7-day history.** A click on one of the six curves (or Enter) opens it large in a dialog,
with the ranges 15 min · 1 h · 6 h · 24 h · 7 days; Esc, ✕ or a click beside it closes it. 15 min are the
live points and keep running. For the longer ranges the dashboard collapses the measurements of each app into a mean per
minute (`src/dashboard-history.ts`) and keeps 7 days of these; the dialog fetches them from
`/api/apps/{id}/history?range=<ms>` and refreshes every minute. The answer has at most 720 points: at 24 h and
7 days neighbouring minutes are averaged, the most recent 15 minutes are the individual measurements. A pause (the
dashboard was not running, the app was offline) interrupts the curve instead of bridging it. The default start writes
the minutes to `<store>/history.jsonl` (one JSON line per minute and app, on big in the `DASHBOARD_DIR`): a restart
loses at most the running minute; on opening and every 6 hours the file is rewritten without the expired lines
(about 10,000 lines per app, a few MB). `startDashboard` without `historyFile` (the tests) keeps them only in
memory.


On the left the apps (status dot online/busy/offline, entries, types, memory, history as a sparkline) and below them
the Spaces of the dashboard's store. In the middle the detail view of the selection: figures (entries, types, txn, waiting,
outbox, memory), the history of the entry count, bars "Entries nach Typ" (the largest 12, the rest collapsed; a
click filters the entry list), a stacked bar "Stand der Entries" (visible/locked/uncommitted/expired, with
legend) and bars "Speicher nach Teil" (`stats.bytes`). Below these the entries (for apps oldest first, paged; in the
dashboard's store newest first, plus transactions and waiters); long fields fold out. On the right "Apps im Vergleich"
(entries and memory per app), the process metrics with sparklines (writes/reads/takes from the `Meter`) and the
placeholder "Agents & Mobiles": the Space core knows no agent resources; as soon as devices write heartbeats into a Space
(future phase, cf. `CapabilityReport` in `capability-directory.ts`), real data can appear there.

**Theme.** The same 14 palettes and the same controls as help site, codemode chat and spaces-mmo: mode
(☾/☀) and palette top right, remembered in the browser (`dashboard.mode`, `dashboard.palette`; without a choice the mode follows
`prefers-color-scheme`). `src/dashboard/palettes.ts` is a copy of `client/lib/palettes.ts` of the projects
(`test/test-shared-copies.test.ts` keeps them equal; `tsconfig.json` leaves it out, it uses the DOM); the server
delivers it without types as `/palettes.js`. The surfaces are derived, as in the projects, by `color-mix` from the
palette colors.

## Interfaces

| Route | Content |
|---|---|
| `GET /` | static UI (`src/dashboard/`, ES modules, web components, no build step) |
| `GET /api/spaces` | all Spaces with gauges (`core.stats`: entries, byType, txns, waiters, outbox, …) |
| `GET /api/spaces/{id-oder-alias}` | Detail: gauges, active transactions, waiting operations |
| `GET /api/spaces/{id}/entries?after&limit` | Entries newest first, cursor `next` (default 100 per page, at most 500) |
| `GET /api/metrics` | `Meter.snapshot(10)`, uptime, socket connections |
| `GET /api/apps` | the app sources: addresses, address used, online, error, alias, `stats`, history of the entry count |
| `GET /api/apps/{id}/history?range` | History of an app for `range` ms (1 min to 7 days, default 15 min): `points` with the same fields as the live points, at most 720 |
| `GET /api/apps/{id}/entries?after&limit&type` | Entries of an app, oldest first; `after`/`next` are positions (max 200/page, up to 2000) |
| `GET /palettes.js` | the shared palettes without types |
| `GET /api/live` | Server-Sent Events |

**SSE contract.** After connecting the server at once sends `hello` (complete Space state), after that
on every commit `space` (gauges of the affected Space, bundled over `flushMs`=200 ms), on registry changes
`spaces`, every few seconds `metrics` and after each app query `apps` (all apps with state, history and activity;
`hello` contains them too). `EventSource` reconnects by itself after a break; after the
reconnect `hello` again delivers the full state — there is no event replay and therefore no lost
update. Watches (`watchDoc`) wake the server, correctness does not depend on a signal
(see conversion plan 4.2): a restart reconstructs everything from snapshots.

## Limits of phase 1

- Read-only; there is deliberately no write, control or agent endpoint.
- The `Meter` is **process-local** ([meter.ts](../src/meter.ts)): counted is the traffic of this process
  (socket clients and own runs), not that of other hosts or stores.
- Entries/pagination reads the full snapshot and cuts on the server side — with very large Spaces this is
  a known budget target of the store work packages (U2), no UI topic.
- Authentication is the local boundary (loopback binding + socket file rights). No TLS, no JWT —
  for a remote dashboard the existing gate/overlay paths apply instead of a new auth layer.
- Agent/mobile data does not exist in the core; the panels show this openly instead of inventing data.

## Tests

`test/test-dashboard.test.ts` (runs as part of `npm test`): HTTP projection (Spaces, detail, entries, metrics,
405/404, static UI) and the SSE contract (`hello`, `space` after a commit, `metrics` push) against an
in-memory host, plus an app over a real Unix socket (stats, types, pages, type filter, a later change)
and a missing app as "offline"; the history (mean per minute, file survives a restart, gone after 7 days,
thinning and gaps) and the endpoint `/history`. Single: `node --experimental-strip-types --test test/test-dashboard.test.ts`.

## Next phases (proposal)

1. Heartbeat entry type for agents/Termux (data source for the right panels).
2. Write actions through the existing role/policy infrastructure of `SpaceService` (if wanted).
3. Connection to the standalone service (`src/standalone.ts`, U3) instead of an own store opener;
   the dashboard boundary (`SpaceHost`, `Meter`) stays untouched by this.
