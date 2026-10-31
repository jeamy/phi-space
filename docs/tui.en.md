# Terminal interface for Spaces and test operation

The TUI runs on the operator machine and uses the same server configuration as
`test/testbed/testbed.sh`. No new dependencies are installed.

```sh
npm run tui
npm run tui -- --dry-run
npm run tui -- --service member-1
npm run tui -- --local-dir /tmp/mein-sieve-mobile
```

Four views:

- **Spaces:** registered Spaces of a container, type bars, visible/reserved/uncommitted/expired
  entries, JSON fields and metadata. In addition transactions, notify subscriptions, waiters, outbox and request claims.
  `s` switches container, `←/→` the focus, `↑/↓` the selection, `/` filters and `i` the object kind.
  `PgUp/PgDn` scrolls details. Automatic refresh every three seconds; `r` refreshes at once.
- **Actions:** server check, initialization, artifact build/transfer, runner/federation containers,
  start/stop/crash/partition/rejoin, the existing artifact tests and the four sieve scenario phases.
  Local source tests, example tests, single test suites and typecheck are in a separate menu area.
- **Reports:** exit status and TAP counters of the TUI jobs as well as the individual domain checks from
  `sieve-mobile/report.json`. With older tests Node TAP counts file suites instead of single assertions.
  A report for another run ID or without a matching `phone.json` expressly counts as old/unconfirmed.
- **Log:** running output; `Enter` in the report menu opens the stored log. `PgUp/PgDn` scrolls.

`1`–`4` select views, `Tab` switches, `q` quits. The TUI restores terminal mode and cursor on exit.
It starts no containers on opening and transfers no artifacts. Without a running container or installed
inspection artifact it shows the concrete error. After the introduction of the TUI the Dockerfile template on the server
must be taken over with `npm run testbed -- init --force` if the existing Dockerfile does not yet contain `COPY build/tools`.
After that `up core` delivers the new inspection artifact. An existing `.env` stays in place.

## Read access to Spaces

`testbed inspect <dienst>` only runs `tools/inspect.mjs /data` in the existing container. The inspector looks for
phi-spaces stores (`*.sqlite` with the table `store_meta`) and scenario reports (`report.json`) down to four
directory levels below `/data`. Symlinks are not followed. For each store it creates a private temporary
directory and writes a backup there; a failure in this leads to at most three attempts.
The host is opened only on this copy. It therefore can never change the original, and the owner lock
stays with the running service. The copy is removed afterwards.

The display is an observation of committed data, not an atomic snapshot across several stores/hosts.
With ongoing changes reading can fail; the TUI then keeps the last successful view and
marks it as stale. At most 20,000 objects are transferred per Space; truncations are visible.
SQLite is taken into the private copy through a read-only database connection and a consistent SQLite backup;
WAL/journal state is not assembled by loose
file copying. The host then opens only the backup.
Stores in memory are not read here. Historical claims, invalid
generations and restore/authority states appear as separate objects.

## Actions, abort and evidence

The first real server intervention needs a release in the TUI. Stop, crash, `down` and scenarios that replace the
previous run have additional confirmations. The selection uses fixed commands and arguments,
no freely entered shell commands. At most one controlling job runs at a time in this TUI.
The existing test environment still has no lock between several operator machines; do not start shared tests in parallel.

`x` ends the local process group. With SSH work the server process can continue: the outcome stays
**unknown**, not "failed" or "passed". Afterwards check the container status and evaluate the scenario.
A container stop replaces no domain RunGate pause and can interrupt running work.

The TUI stores `.json` evaluation and the complete `.log` under `dist/tui-runs/` (git-ignored).
Status: `passed` only for successfully executed tests, `completed` for successful administrative actions,
`failed` on error, `preview` for a preview, `cancelled` on local abort, `unknown` on an aborted remote call
or an incompletely recorded earlier job. Previews do not connect to the server and build nothing.

```sh
npm run tui -- --list-actions
npm run tui -- --action test-all --dry-run
npm run tui -- --action test-all --allow-remote
npm run tui -- --once --json --local-dir /tmp/mein-sieve-mobile
```

The menu entries for membership/drain/removal, RunGate pause, productive run control, worker supervisor,
LLM agents, provisioning/pairing and promotion/restore stay locked: the library parts exist (`RunController`, `WorkerSupervisor`, `SpaceLifecycle`, recovery), the TUI has no control path to them.
Core mutations such as write/take/txn/lease also need an administrative remote control path; the inspector is
deliberately no second storage writer. The empty federation containers are labelled as placeholders.

Server artifact tests replace neither local source tests nor federation/fencing acceptance.

## Server evidence of 2026-10-08

On `big` the Dockerfile was updated with the inspector and `test-all` was run through the TUI control path:
smoke, five compiled examples and the sieve scenario passed. The runner uses
Node v22.23.3, `NODE_ENV=production`, UID 1000, a read-only root file system, no effective
capabilities and `no-new-privileges`. No TypeScript sources outside the dependencies.

The real TUI showed `default` and `sieve-a`, one run, eight results, nine decided claims
and all seven passed scenario checks (168 primes). Container stop/start through the TUI
passed; afterwards all Space objects were preserved unchanged. The runner stays
started for operation. Logs: `dist/tui-runs/`; summarized evidence:
`dist/testbed-proof/tui-big-2026-10-08.json`. This run checks one container, no federation.
