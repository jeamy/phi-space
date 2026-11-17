# Directory split: the spaces core apart from the applications (plan)

Status (2026-11-16): done. Phase 1 (`phi-space-host`, `mmo-space`, `codemode-space`, `help-space`, no `--profile` in
`phi-space-server`), phase 2 (the dashboard's apps in `dashboard.apps.json`, the repository-wide checks in `checks/`
with `checks/layering.mjs`), phases 3 and 4 (the package in `spaces/`, one Cargo workspace per project, the references
after them) and phase 5 (pushed, rehearsed on copies of the stores, deployed on nano and big the same evening; records
below). Review incorporated
on 2026-11-15, gaps on 2026-11-16 (below). The open questions were decided on 2026-11-16.

## Goal

The core of phi-spaces, TypeScript and Rust, lives in one directory `spaces/`. Rust code that exists only for
spaces-mmo, codemode-chat or the help site lives under that project's own `rust/` directory. The core knows nothing of
the applications. It has no code path, binary, profile, default or test that names one of them. The dependency runs
one way only, from the applications to the core.

The application Rust directories are `spaces-mmo/rust/`, `help-site/rust/` and `codemode-chat/rust/`.

## Where things are tangled today

These are the places where the core names an application. They come from a word-bounded search over `src/`,
`rust/phi-*`, `test/` and `scripts/`. Comments that only cite an application as the reason for a default are not
counted.

| Place | What it holds | Belongs to |
|---|---|---|
| `rust/phi-space-server/src/profiles.rs` | `--profile mmo\|codemode\|help`: listen addresses, store files, limits, locks, peer names, Process entry, compaction, all from the projects' env variables (`SPACES_MMO_*`, `CODEMODE_*`, `SWARM_*`) | the generic part is core, the three profile functions belong to the apps |
| `rust/phi-space-server/src/help.rs` | the help site's swarm Space: alias, limits, completion profile, HostInfo, purge of old posts | help-site |
| `rust/phi-space-server/tests/process.rs` | generic server tests and process tests for `--profile mmo` / `codemode` | generic tests stay in core, profile tests follow their binaries |
| `rust/mmo-engine`, `rust/mmo-web` (bins `mmo-world`, `mmo-npc`, `mmo-web`) | the game engine and web process | spaces-mmo |
| `rust/Cargo.toml` | `[profile.dev.package.mmo-engine]`, `regex-*` opt-levels | spaces-mmo |
| `src/dashboard.ts` | the default app list (codemode-chat, spaces-mmo world, swarm shard, hub; sockets and ports) | configuration, not core code |
| `test/test-shared-copies.test.ts` (now `checks/shared-copies.test.mjs`) | reads `client/lib/palettes.ts`, `markdown.ts`, `server/env.ts` in the three apps | a repo-wide check, not a core test |
| `scripts/package-imports.mjs`, `scripts/durable-imports.mjs`, `scripts/check-branding.mjs` | discover or scan files across the applications and the core | repo-wide checks |

Everything else in `rust/` is core: `phi-json`, `phi-core`, `phi-store`, `phi-service`, `phi-wire`, `phi-host`,
`phi-spaces-client` (with `phi-client-driver`) and `phi-space-server` without the profiles. `mmo-web` depends
on `mmo-engine`. Both use `phi-json` and `phi-spaces-client` from the core.

## Target layout

```
spaces/                     the core: package "phi-spaces"
  package.json              exports unchanged (./src/index.ts, ./core, ./store/*, ./ws, ...)
  src/ test/ examples/ agent/ scripts/ dist/
  rust/                     Cargo workspace of the core
    phi-json phi-core phi-store phi-service phi-wire phi-host phi-spaces-client
    phi-space-host          new: library, a store on a socket with host tasks (from profiles.rs)
    phi-space-server        the generic binary, no --profile
spaces-mmo/rust/            Cargo workspace: mmo-engine, mmo-web, mmo-space (bin, was --profile mmo)
codemode-chat/rust/         Cargo workspace: codemode-space (bin, was --profile codemode)
help-site/rust/             Cargo workspace: help-space (bin, was --profile help, with help.rs)
checks/                     repo-wide checks: imports, shared copies, branding, layering, Cargo lockfiles
docs/ de-docs/ AGENTS.md README.md package.json (thin: forwards to spaces/ and the apps, no exports)
```

`spaces/rust` sits beside `spaces/test`, so the Rust tests' relative paths to `test/support/*-driver.ts` and
`test/vectors/` (`CARGO_MANIFEST_DIR/../..`) keep working unchanged.

## Decisions

**D1. One Cargo workspace per project (decided 2026-11-16).** Each app crate takes the core crates as path dependencies.
For example, from `spaces-mmo/rust/mmo-engine/Cargo.toml` the path to `phi-spaces-client` is
`../../../spaces/rust/phi-spaces-client`. Cargo permits dependencies across workspace boundaries. The repo-wide
layering check uses Cargo's resolved package graph to enforce the direction from apps to core, including normal,
build and dev dependencies. The cost is a `Cargo.lock` and a `target/` per workspace, so each app compiles its
dependencies on the core in its own build.
`[profile.release]` (thin LTO, one codegen unit) only takes effect at a workspace root, so it is copied into every
workspace. The mmo opt-levels go into the mmo workspace only. Lock drift between the workspaces (rusqlite, tokio,
rustls) is checked by comparing versions of shared crates across the lockfiles. A single virtual workspace at the
repo root is also an option, with one lockfile, one target directory and the same dependency check.

**D2. App profiles become app binaries.** The generic part of `profiles.rs` becomes the library
`phi-space-host`: `Instance`, `run_instance`, the Process lease, locks only when missing, compaction, host facts, the
ready line, `stopping`, and a `HostTask` hook for prepare and periodic work on the store's thread. The three profile
functions become `main.rs` of three small binaries in the apps. Each keeps its env variables and its ready line exactly
as now, so the TypeScript starters and tests see no difference except the binary's name. codemode's profile is pure
configuration. It still gets its own binary, so all three projects work the same way and the core keeps no codemode
defaults. `phi-space-server` keeps no `--profile` alias, because that alias would be app code in the core.

**D3. Move the TypeScript package into `spaces/` and keep a thin root manifest (decided 2026-11-16).** The apps'
`"phi-spaces": "file:.."` becomes `"file:../spaces"`. The same commit installs the root `package.json` with the
existing command names and argument forwarding. Put commands that launch an app, such as `example:space-chat`, in
the root or app scripts. The `phi-spaces` package name and exports belong to `spaces/package.json`.

**D4. Configure the dashboard app list through the repo root.** Both the CLI and `dashboard.sh` read the repo
root's `.env` after the move. Preserve the existing `DASHBOARD_APPS` and CLI override behavior. Move app addresses,
space selectors, labels and address fallback order into repo-level configuration before removing the built-in list.
The current `DASHBOARD_APPS` syntax accepts addresses and space selectors. Keep label metadata in the repo-level
configuration too. With no configured apps, the dashboard shows the stores and app addresses supplied through
`--dir` and `--app`.

**D5. Keep `docs/` at the repo root for the technical migration.** Update references to moved code as part of the
migration. The move of Codemode-only documents to `codemode-chat/docs/` can be reviewed separately with its links
and German counterparts.

## Phases

Every commit ends green. Phases 1 and 2 decouple the code in place. Phase 3 moves the TypeScript package and all
Cargo workspaces together with their path fixes. Use `git mv` and keep behavior changes in phases 1 and 2 so blame
can follow the moved files. When rolling back several phases, revert the dependent commits in reverse order.

### Phase 0: preconditions

- Coordinate with the owners of open work before moving files. Do the migration in a clean checkout and coordinate
  the cutover with other sessions working on affected paths.
- Inventory consumers outside this checkout, especially the Android build and remote demo in `pi-termux-mobile`,
  running soak jobs, backup scripts and absolute paths to binaries in local or server configuration.
- Baseline: `npm run typecheck`, `npm test`, `npm run test:agent`, `cd rust && cargo test && cargo clippy
  --all-targets`, the app tests, and the cross runs with `PHI_SPACES_SERVER_CMD` / `PHI_SPACES_CLIENT_CMD`. Results
  recorded so later failures can be told apart from existing ones.

### Phase 1: decouple Rust in place (still under `rust/`)

1. Extract `rust/phi-space-host` (library) from `profiles.rs` with the `HostTask` hook. Keep the current entry
   points while preparing the new binaries.
2. Add `rust/mmo-space`, `rust/codemode-space` and `rust/help-space` (with the swarm-specific `help.rs`) on
   `phi-space-host`. Move the MMO and Codemode profile tests alongside their binaries and keep the generic tests
   with `phi-space-server`. Exercise the Help binary through the swarm tests, including retention.
3. Switch each app's callers in the same commit as its command change:
   - `SPACES_MMO_SPACE_SERVER`, `CODEMODE_SPACE_SERVER`, `HELP_SPACE_SERVER` and the launchers that pass
     `--profile`
   - the three Dockerfiles (`cargo build -p ...`, `COPY --from=rust-builder ...`)
   - `docker-compose.rust*.yml` (`command:`), `spaces-mmo/tests/perf/space-cost.ts`, `handover-live.ts`, `soak.sh`
4. Once the callers have switched, remove `--profile` dispatch and its usage text from `phi-space-server/src/main.rs`.
5. Run Cargo tests and Clippy, run each app's tests with its new binary, and build and start each app's Rust images
   locally. Verify the ready line, first start and restart on an existing store, and graceful shutdown. Check MMO
   accounts and region stores, Codemode capacity validation, and the Help swarm alias and retention.

### Phase 2: decouple the TypeScript core in place

1. Move the dashboard app list to configuration (D4) and supply the test list in `test/test-dashboard.test.ts`.
2. `test/test-shared-copies.test.ts` → `checks/shared-copies.test.ts`, and `scripts/check-branding.mjs` →
   `checks/`. Put the package and durable import checks there as well. Use separate repo and package roots for
   app discovery, export targets, import allowlists and the expected `node_modules/phi-spaces` real path.
   Verify that every app is discovered and scanned. Keep the core-only test command usable from its package.
3. Add `checks/layering.mjs` to the root test command before the suites. Verify the following.
   - nothing under `src/`, `test/`, `scripts/`, `agent/` or `rust/phi-*` imports or path-references `spaces-mmo/`,
     `codemode-chat/` or `help-site/`
   - the resolved Cargo graph contains zero dependencies from core crates into app crates
   - comments that cite an app as a reason are allowed

   Start with today's paths and switch the check to the new layout in phase 3. Include package scripts and Cargo
   manifests in the check so entry points and build metadata are covered.
4. `examples/codemode-evolve.ts` is checked: if it only demonstrates pi-codemode on a space, it stays a core example.
   If it needs codemode-chat, it moves there.

Done on 2026-11-16:

- **Dashboard.** `dashboard.apps.json` at the repository root holds the list with labels, spaces and the order of
  the addresses; `loadApps` reads it, `DASHBOARD_APPS_FILE` names another file, none means no apps. `DASHBOARD_APPS`
  and `--app` replace it, an id of it keeps its label and space. `src/dashboard.ts` finds the file beside the `.env`
  it already reads (`join(import.meta.url, "../..")`): phase 3 points both at the repository root, two levels further up.
- **`checks/`.** `durable-imports.mjs`, `package-imports.mjs`, `branding.mjs` (was `scripts/check-branding.mjs`) and
  `shared-copies.test.mjs` (plain JavaScript like the others, outside `tsconfig.json`). `checks/roots.mjs` holds the
  two roots (`REPO`, `PACKAGE`, `PACKAGE_PREFIX`) and the list of applications; phase 3 changes `PACKAGE` there to
  `spaces/`. A check that does not find an application or a scanned directory fails instead of scanning less.
- **`checks/layering.mjs`** runs first in `npm test` (`npm run check:layering`). It scans `src`, `test`, `scripts`,
  `agent`, `examples`, `rust/phi-*` and the manifests (`package.json`, the tsconfigs, `rust/Cargo.toml`) without
  their comments, and reads Cargo's resolved graph (`cargo metadata --locked --offline`, so it needs cargo). Two files
  are allowed until phase 3: the root `package.json` (the scripts that start the applications, D3) and
  `rust/Cargo.toml` (the one workspace, D1). Probed: a path to `spaces-mmo/` in `src/` and a dev-dependency of
  `phi-wire` on `mmo-engine` are both refused.
- **`examples/codemode-evolve.ts`** stays a core example: it imports only `src/` and `@earendil-works/pi-codemode`.

### Phase 3: move the TypeScript package and all Cargo workspaces

Land the moves and path fixes in one phi-spaces commit. Moving the old Cargo manifest first would leave its member
paths invalid and the app crates without their inherited package fields and dependencies.

- **TypeScript package.** Move `src/`, `test/`, `examples/`, `agent/`, `scripts/`, the TypeScript configs and the
  package manifest and lockfile to `spaces/`. Add the root forwarders in the same commit. Update each app's
  `file:../spaces` dependency and all corresponding lockfile records. Move existing local `node_modules/` and
  `dist/` with the package and repoint each app's `node_modules/phi-spaces` symlink to `../../spaces`. Local
  installation requires prior approval. Verify the package contents listed in `files`, including the README and
  license, with `npm pack --dry-run --json` from `spaces/`.
- **Cargo workspaces.** Move the `phi-*` crates to `spaces/rust/`, the three MMO crates to `spaces-mmo/rust/`,
  `codemode-space` to `codemode-chat/rust/` and `help-space` to `help-site/rust/`. With the recommended D1 layout,
  add the workspace manifests with the inherited package fields, dependencies and profiles. Carry over
  `rustfmt.toml` so formatting commands keep the same settings. Start each lockfile
  from the original and review Cargo's changes to package versions. Validate the resulting lockfiles with
  `--locked` and run the resolved dependency and shared-version checks. Remove the old root `rust/` directory.
- **Cross-language tests and MMO oracle.** Update callers' binary paths, app references to core, agent and test
  sources, and the federation testbed's Docker context, build paths and mounts. `tests/common::repo()` in
  `mmo-engine` goes up three directories. Cargo unpacks the oracle under the MMO workspace's `target/tmp`. Link
  the archived checkout's root and agent `node_modules` to the live checkout's `spaces/node_modules` and
  `spaces/agent/node_modules`. Keep the archived app's `phi-spaces` link pointing to the archive's own root.
  Update the R8 scripts and paths for the oracle, coverage, command table and app binaries.
- **Mobile consumer.** Coordinate the matching change in `pi-termux-mobile` for this cutover. Update
  `scripts/bundle-mobile.mjs`, the default runtime path in `agent/test/pi-serverd.test.ts`, Android
  `scripts/prepare-runtime.py` and `scripts/remote-demo/run.sh`. Android currently looks for the bundle script,
  Cargo workspace and Android binary at the old paths. Verify a pre-build refresh that rebuilds both the bundle
  and native server from the new layout, and verify the remote-demo coordinator path.
- **Container builds.** Update where all stages copy npm manifests, source and runtime dependencies, including
  `agent/` and the local package symlink. Fix the MMO and Codemode dev bind mounts, Rust build and artifact paths,
  and `.gitignore` and `.dockerignore` entries for the moved outputs, Cargo targets and test evidence. Keep a
  build context that includes both the app and its core path dependencies.
- **Repo commands and configuration.** Update the repo-wide checks and their fixture paths. Verify dashboard
  start, stop and status and the CLI's use of the root `.env`. Preserve testbed env discovery, testbed and
  operations artifact paths or update their consumers in the same commit. Check argument forwarding and commands
  that accept paths relative to the invocation directory.

Repeat the phase 0 baseline through the root commands and from the individual packages. Test and lint each Cargo
workspace, run the Rust/TypeScript oracle and wire cross-checks, and run the app suites against their new binaries.
Build the dev, test and production Rust image targets from a clean local checkout. Run the Rust app stacks and
local federation testbed with the moved paths. Verify that every app is scanned by the import checks and that the
root commands still reach their intended packages.

### Phase 4: update instructions and references

- Update `AGENTS.md`, the app instructions and the root README for the new paths and commands. Land any updates
  needed to run phase 3's verification with phase 3.
- Fix Markdown links and commands in `docs/`, `de-docs/` and the apps, and check the links. Update the help site's
  corpus sources and Codemode's help articles where they describe the layout or the local package dependency.
  Keep any move of Codemode documents in a separate follow-up (D5).

### Phase 5: deploy (only with the user's approval)

Inventory the deployed revision, effective Compose project and service names, image IDs, and each store's mount
and path on big and nano. Include the separate MMO arena project if its image or commands are affected. Record
the existing dashboard app configuration where applicable.

Build the candidate images and rehearse the update and rollback locally on copies of the existing stores. Preserve
the current volume and bind-mount mappings. Verify startup and a read/write round trip on the expected stores,
with the appropriate account, region and swarm endpoints. Retain the previous images and their matching Compose
files and commands. To roll back, recreate the affected services with those images and commands, then verify
the mounts and endpoint health again.

After approval, pull the verified revision and use each app's Rust deployment entry point for the affected
services. Check the running containers' image IDs, commands, health and mounts after the update. Recreate any
affected service still running an old image before accepting the rollout.

Checkouts on the hosts (from phase 3): `git pull` moves the tracked files but leaves the ignored ones at the old
places. On each host that runs something from its checkout (the dashboard on big, through `scripts/dashboard.sh` or its systemd unit, any
`npm --prefix <app>` command) before starting it again:

- move the ignored `node_modules/` and `dist/` of the root into `spaces/` and `agent/node_modules/` to
  `spaces/agent/node_modules/` (or delete them and install anew, which needs approval); the old directories then
  hold nothing and go;
- delete the old `rust/target/` instead of moving it: a moved target keeps the core crates' test binaries with the old
  `CARGO_MANIFEST_DIR` baked in (`env!`), and Cargo does not rebuild them (seen on 2026-11-16: the phi-core drivers
  started in `rust/phi-core/../..`); after a move, `cargo clean -p <each core crate>` (both profiles) is needed;
- repoint each app's `node_modules/phi-spaces` to `../../spaces` (`ln -sfn ../../spaces <app>/node_modules/phi-spaces`)
  or run `npm --prefix <app> ci`;
- move a local `test/testbed/testbed.env` to `spaces/test/testbed/testbed.env` (the root `.gitignore` names the new
  place; at the old one it is no longer ignored);
- restart the dashboard with `npm run dashboard:start` from the root (it reads the root `.env` and
  `dashboard.apps.json` as before); where it runs as the systemd user unit of docs/dashboard.en.md
  (`phi-spaces-dashboard.service`, `WorkingDirectory` the checkout), its `ExecStart` names `src/dashboard.ts` and
  must name `spaces/src/dashboard.ts` before the restart (`systemctl --user daemon-reload`, then `restart`), or the
  unit fails after the `git pull`. Record the unit's current text in the inventory first.

The images are not affected by the leftovers: they install their dependencies themselves (`npm --prefix spaces ci`,
the app's `npm ci`) and copy the core crates and the app's workspace with the checkout's layout.

## Risks

- **Moves collide with open work.** Coordinate the shared paths and use the clean checkout from phase 0.
- **Compile time.** The separate workspaces build their core dependencies independently, including in Docker.
- **Paths outside the repo.** Apply the phase 0 inventory to the cutover. Mobile builds can use cached artifacts
  when the source probe fails, so confirm the refresh in the Android build output.
- **The frozen MMO oracle.** Its archive retains the original layout. Verify the links to dependencies from the
  live checkout as part of the oracle run.

## Gaps found on 2026-11-16 (folded into phase 1)

1. **A routine deploy ships phase 1.** big and nano are deployed from master with `docker:*:rust:up`. Once the
   compose `command:` names `mmo-space`, `codemode-space` or `help-space`, the next deploy for any other reason
   carries the new binaries, long before phase 5. Phase 1 is therefore verified to deploy grade: images built and
   started on this machine as throwaway projects (`docker:rust:up`, never `docker:local:rust:up`, which is the live
   local world) on copies of the stores, restarted on the existing files.
2. **A stale binary path fails without a reason.** An env value, a script or a habit that still points
   `SPACES_MMO_SPACE_SERVER`, `CODEMODE_SPACE_SERVER`, `HELP_SPACE_SERVER` or `HANDOVER_SERVER` at
   `phi-space-server` would start it without arguments, and it ends with its usage text. The app-side launchers
   (`server/space-server.ts` in spaces-mmo and codemode-chat, `help-site/tests/swarm-space.ts`,
   `spaces-mmo/tests/perf/handover-live.ts`) refuse that basename with a message naming the app's binary. The core
   keeps no word about it. Old run scripts in `~/phi-soak/runs/` name `phi-space-server` with `HELP_SPACE_SERVER`;
   they are records, not rerun.
3. **Generic process behavior beyond `profiles.rs`.** The abort-on-panic hook (in `main.rs`), `fail`,
   `stopping.rs`, the exit after the threads are joined and `host_facts` (used by the Process entry and by the
   swarm's HostInfo) belong to `phi-space-host` too. `phi-space-server` depends on it for its other modes.
4. **The help profile has no Rust process test.** `help-space` gets one: the ready line, the `social-swarm` alias,
   the HostInfo entry, and a purge with a small `SWARM_MAX_ENTRIES` and `SWARM_RETENTION_MS`. The MMO and Codemode
   process tests move unchanged except for the binary, so they hold the old behavior.
5. **Where the process-test helpers live.** `start`, the framed `call`, `stored_limits` and `items` are needed by
   four crates, across workspaces after phase 3. They are the `testing` feature of `phi-space-host`, enabled from
   the dev-dependencies.
6. **Instructions follow each phase.** `AGENTS.md`, the `.env.example` files and the source comments that name
   `--profile` or `profiles.rs` change in the commit that changes the command, not in phase 4: other sessions work
   from `AGENTS.md`.
7. **Images carry only what they run.** The MMO image copies `mmo-space` instead of `phi-space-server`, the Help and
   Codemode images likewise. Nothing in their containers starts the generic server.
8. **Name collision.** `phi-space-host` sits beside the `phi-host` crate, `phi_store::SpaceHost` and the apps'
   `server/space-host.ts`. The names are kept for phase 1; a rename before phase 3 is cheap (open question 3).

The mobile consumer is not affected by phase 1: `pi-termux-mobile` starts `phi-space-server` with `--store`,
`--listen` and `--agent-host` only.

## Decided on 2026-11-16

1. D1: one Cargo workspace per project.
2. D3: a thin forwarding `package.json` at the root.
3. Names: `spaces/`, `mmo-space`, `codemode-space`, `help-space` and `phi-space-host` stay.

## Phase 1 record (2026-11-16)

- Rust: `cargo test` of `phi-space-host`, `phi-space-server`, `mmo-space`, `codemode-space` and `help-space` green,
  `cargo clippy --all-targets` without warnings. The MMO and Codemode process tests moved unchanged except for the binary.
- `test/test-standalone.test.ts` with `PHI_SPACES_SERVER_CMD=rust/target/release/phi-space-server`: 4 of 4.
- `HELP_SPACE_SERVER=…/help-space npm --prefix help-site test`: 67 of 68, 0 failed, 1 skipped (the Next.js production
  server test, skipped before too).
- `SPACES_MMO_SPACE_SERVER=../rust/target/release/mmo-space npm --prefix spaces-mmo test`: 413 of 416. The two arena
  tests (`tests/arena.test.ts`) fail the same way with the old `phi-space-server --profile mmo`, built from the commit
  before, and pass on the TypeScript space: not from this change. The warehouse test of `tests/store.test.ts` failed
  once under the suite's load and passes alone on the new binary, the old one and TypeScript.

## Phase 3 record (2026-11-16)

- Layout: the package in `spaces/` (with a README and license of its own for `npm pack`; `npm pack --dry-run` lists
  both), its Cargo workspace `spaces/rust/` (the nine `phi-*` crates), `spaces-mmo/rust/`, `codemode-chat/rust/` and
  `help-site/rust/`, each with its own `Cargo.lock` (begun from the old one; Cargo only dropped what the workspace does
  not use) and `rustfmt.toml`. The MMO dev opt-levels moved to the MMO workspace. The apps depend on
  `file:../spaces`; npm rewrote their lockfiles offline (beside the path records, help-site and spaces-mmo now record
  pi-codemode 1.5.2, the version installed).
- The root `package.json` (`phi-spaces-repository`, private) runs the checks and forwards; the commands that take a
  path run the package's file from the root. `checks/root-scripts.mjs` (in `npm test`) holds every forward to an
  existing script and every direct script to the package's of the same name. `checks/layering.mjs` reads Cargo's graph
  of each workspace (`--locked --offline`): no core crate depends on anything outside the core but a registry crate,
  and each application workspace has the core's `[workspace.package]`, `[workspace.dependencies]` and
  `[profile.release]` and no registry crate in a version the core does not resolve. Planted faults (an application
  crate as a core dev-dependency, a different release profile, a missing application `Cargo.lock`) are refused.
- A Cargo target moved with its workspace keeps test binaries with the old `CARGO_MANIFEST_DIR` (`env!`): Cargo does
  not rebuild them. `cargo clean -p` of the core crates (or a new target) fixes it; phase 5 deletes the old target.
- The MMO oracle now unpacks into `spaces-mmo/rust/target/tmp`, inside a directory the import checks walk:
  `checks/durable-imports.mjs` and `checks/package-imports.mjs` skip `target` (as `checks/layering.mjs` did), else
  the old checkout's `agent/` fails `npm test` once the MMO tests have run.
- `npm test` from the root: 663 of 669, 0 failed, 6 skipped (as the baseline; the checks count 535, 148 and 497 files
  as before). `npm run test:agent`: 115 of 115 (with pi-serverd). Typechecks of the package, the agent package and the
  three applications clean.
- Rust: `cargo build --release --locked --bins`, `cargo test --locked --no-fail-fast` and `cargo clippy --locked
  --all-targets` in each of the four workspaces green, without warnings: 93 test binaries (77, 12, 2, 2) as in the
  single workspace before, among them the oracle tests of `mmo-engine` (`primitives`, `engine_walk`, `model_walk`)
  against the frozen commit, unpacked from the checkout's top. The Android `phi-space-server` builds from `spaces/rust`.
- `test/test-standalone.test.ts` against the Rust server: 4 of 4. `help-site` with `help-space`: 67 of 68, 1 skipped
  (as before). `codemode-chat` with `codemode-space`: 221 of 221, `test:durable` 221 of 221. `spaces-mmo` with
  `mmo-space`: 413 of 416 (the two arena tests as in phase 1, and the takeover test of `tests/phase5.test.ts` under the
  suite's load), `test:durable` 415 of 416 (`tests/planks.test.ts` under load); both pass alone.
- The help corpus builds unchanged (47 articles, 14 API signatures, 66 examples typechecked). The dashboard starts,
  reports and stops from the root with the root `.env`. The compose dev mounts resolve to `spaces/src`. `npm run
  bundle` from the root writes the mobile runtime; `pi-termux-mobile` finds the package in `spaces/` (and an old
  checkout at its top) in `scripts/prepare-runtime.py` and `scripts/remote-demo/run.sh`.
- Images, built from a clean worktree of the phase 3 commit under throwaway tags (deleted afterwards): the
  `production-rust` (with `production`) and `dev-test` targets of all three applications, the help site's `nano` and
  the local federation image (context `spaces/`). In each production image `phi-spaces` (331 exports) and the agent
  package's `live-models.ts` load from the application's directory through `node_modules/phi-spaces -> ../../spaces`,
  and every Rust binary finds its libraries. The test images, run as their compose services (user node, no
  capabilities, without the `.env`): codemode-chat 221 of 221, help-site 68 of 68, spaces-mmo 416 of 416 (the
  TypeScript space; the arena tests pass there as in phase 1). The applications' `docker:rust:up` stacks were not
  started: their scripts tag the images the running local world uses. `npm run testbed:federation -- both` from the
  root (the image built from `spaces/`): every pairing of TypeScript and Rust control host and Member answered alike,
  the admin commands too.

## Phase 4 record (2026-11-16)

- Markdown links: the 393 relative links the move broke point at the moved files again, each mapped from its
  target before the move to the target's new place (in `docs/`, `de-docs/`, the applications and `spaces/`). Of the
  161 links that were broken before the move none was touched, and none is new. The help site's two comparison
  documents linked with absolute `file:///` paths of this machine into the old places; they link relatively now.
- The local dependency reads `file:../spaces` in AGENTS.md, docs/api.en.md, the MMO docs, the help site's plan and
  corpus sources and Codemode's help articles (with `../spaces/src` and `spaces/agent/`). The record of the earlier
  package step (spaces-mmo/docs/paket.en.md) stays as it was.
- Commands run from the root name the files at their new places: the example commands in docs/examples*.en.md,
  the README's live examples, the dashboard's `scripts/dashboard.sh` and its systemd unit (docs/dashboard.en.md; on
  big, phase 5 changes the installed unit), the open index plan of spaces-mmo (`spaces/rust/phi-*`,
  `spaces-mmo/rust/mmo-*`). Package paths in prose (`src/core.ts`, `agent/`) stay paths from `spaces/`, as AGENTS.md
  says; the READMEs and the help corpus's examples article say so once. The records of runs before the move (the
  power-loss test, the R3 and R8 records, the U0 inventory) keep their paths.
- `npx tsc -p help-site` from the root found no TypeScript after the move: the help site has a `typecheck` script
  like the other applications, and AGENTS.md names it. The netbird overlay script linked a fixed path to the root's
  `node_modules`; it takes the package's, next to itself.
- After phase 4: `npm test` 663 of 669 (0 failed, 6 skipped), `help-site` with `help-space` 67 of 68 (1 skipped),
  `codemode-chat` with `codemode-space` 221 of 221, the help corpus rebuilt (the changed sources only), the branding
  check passed; `spaces/examples/golomb.ts` runs from the root.
- `npm run test:examples` (from the root, not part of `npm test`) failed once from the root: a child of
  `spaces/test/examples/recovery.test.ts` imported `./src/` against the working directory; it runs in the package's
  directory now (84 of 84 from the root and from `spaces/`). The other direct root scripts resolve their paths from
  their own file (`testbed check --dry-run`, `tui --dry-run --once`, `vectors`, the dashboard, the bundle checked).

## Phase 5 inventory (2026-11-16, read only)

Pushed first: `master` at `040492a` (GitHub and knot), the mobile checkout at `38e017f`. Nothing on the hosts changed.

**big** (`/media/docker/spaces`, at `8645e41`, 12 commits behind; untracked only `.env.bak-dashboard`):

- No ignored leftovers: no `node_modules/`, `dist/`, `agent/node_modules/`, `rust/target/` or `testbed.env` in
  the checkout, no `<app>/node_modules`. The images install their own; the pull needs no move or delete.
- The dashboard runs as the user unit `phi-spaces-dashboard.service` (active), text before the change:
  `WorkingDirectory=/media/docker/spaces`,
  `ExecStart=/usr/local/bin/node --no-warnings --experimental-strip-types src/dashboard.ts`, `Restart=always`,
  `RestartSec=5`, `After=` the three tunnel units. After the pull, `src/dashboard.ts` is gone and `Restart=always`
  loops: the `ExecStart` must name `spaces/src/dashboard.ts` in the same step. The root `.env` has only
  `DASHBOARD_*` keys.
- Compose projects of this checkout: `phi-spaces-mmo` (17 containers: space, world, npc on `phi-spaces-mmo:rust`
  `44c1e079e488`, model on `:prod` `a3d214a4eb3d`, web on `:rust`; files `docker-compose.yml`, `hostnet`, `rust`,
  `rust-game`; the space containers run `phi-space-server --profile mmo` on the volume `phi-spaces-mmo_mmo-space-data`),
  `phi-spaces-mmo-arena` (1, image `b8022792cb02`), `phi-spaces-help` (`swarm-space` on `phi-spaces-help:rust`
  `14664ae17e6d` with `phi-space-server --profile help`, `spaces-help-prod` on `dbba2b159543`, both on the volume
  `phi-spaces-help_spaces-help-data`), `phi-spaces-codemode` (agents, judge-big, model on `df33575b58dd`, web on
  `:prod` `c1f7a8d32714`; no space here; `hostnet`).
- Unrelated: the user units `phi-spaces-phase1b-host-a` and `phi-spaces-phase1b-member-1` restart in a loop
  (`activating auto-restart`); not from this change, the checkout there is untouched.

**nano** (`/home/mux/spaces`, at `b808534`, 16 commits behind; untracked only old `.bak` copies and
`docker-compose.rootless.yml` in `help-site/docker/`, none of them a path the pull writes):

- No ignored leftovers, no dashboard, no user units of the project.
- `phi-spaces-mmo` (`space-1` on `phi-spaces-mmo:rust` `bee7707d2039`, `phi-space-server --profile mmo`, volume
  `phi-spaces-mmo_mmo-space-data`), `phi-spaces-codemode` (`space-1` on `:rust` `3ba19ffa2049`,
  `phi-space-server --profile codemode`, volume `phi-spaces-codemode_codemode-space-data`; `judge-nano` on `:prod`
  `321291247433`), `phi-spaces-help` (`swarm-space-nano` on `:rust` `7b12525e5d02`, `phi-space-server --profile help`,
  volume `phi-spaces-help_swarm-nano-data`; `swarm-nano` on `:nano` `4ee60b6bbaf6`).

What follows for the deploy:

- Every running space container runs `phi-space-server --profile`, which the new binary refuses; the new compose
  files run `mmo-space`, `codemode-space` and `help-space`. The `:rust:up` scripts build the image first, so they
  bring both together. A `--no-build` recreate after the pull would start the new command in the old image and
  fail: never recreate a space service from the new files without the new image.
- Before the first build on a host, tag the running images (the IDs above) as `before-split-<rev>`, since the build
  moves `:rust`, `:prod` and `:nano`; the rollback recreates with those tags and the compose files of the deployed
  revision (`git worktree` of `8645e41` or `b808534`).
- The arena and big's codemode roles need no redeploy for this change.

## Phase 5 rehearsal (2026-11-16, local, on copies of the stores)

- Copies: the eight live stores (big: the four world regions and the swarm Space; nano: the accounts Space, the
  swarm shard and the codemode Space) were copied on each host from the volume's directory, the database and its WAL
  with no checkpoint in between (the database's mtime and the WAL header the same before and after; every one on
  the first attempt), then fetched with rsync, checksums equal, `PRAGMA integrity_check` ok. A first try by
  `docker cp` streamed over ssh gave torn copies (a live SQLite file read across checkpoints) and was dropped. The
  copies stay on the hosts and on this machine as the backup from before the deploy
  (`~/phi-backup/2026-11-16-split-rehearsal/`). No container on big or nano was started, stopped or changed.
- Images, built under throwaway tags and deleted after: `production-rust` of the three applications at `25972e1`
  (`mmo-space`, `codemode-space`, `help-space`; the new mmo image has no `phi-space-server`) and the mmo one at the
  deployed revision `8645e41` (`phi-space-server` with `--profile`).
- Per store, on one working copy, with the containers' environment of the hosts (only the listen addresses local):
  the old image with `phi-space-server --profile <app>` (today's state), the new image with the application's binary
  (the deploy), the old image again (the rollback). Each run: every space with its entries and revision, a marker
  entry written, read and taken in the default space, then a stop by SIGTERM. All 24 runs ready and exit 0, the
  entries the same in all three runs of each store (accounts 10; west 12372, nord 8734, ost 12472, sued 1860; swarm
  big 19598, nano 9518; codemode 346), the round trip complete, the revisions only rising, no error or warning in the
  logs, `integrity_check` ok after the rollback. The store format is unchanged (`phi-store` and `phi-service` are
  untouched since the deployed revisions), as expected.
- Not rehearsed: the web, world, npc and model processes (their code changed only in where the package lives; the
  phase 3 test images ran their suites) and the hosts' compose files themselves (the `:rust:up` scripts as above).

## Phase 5 deploy (2026-11-16, with the user's approval)

- Step 1, no container touched: `git pull --ff-only` to `76433c4` on big and nano; on big the dashboard unit's
  `ExecStart` names `spaces/src/dashboard.ts` (the old unit file in `~/phi-backup/2026-11-16-split-rehearsal/`),
  `daemon-reload`, restart of the dashboard alone; it answered at once and saw all five apps online.
- Before the builds, every running image was tagged `<repo>:before-split-<rev>-<service>` (`8645e41` on big,
  `b808534` on nano). Two containers on big ran an image no longer in the image store (`phi-spaces-help-prod`,
  `dbba2b159543`, and the arena, `b8022792cb02`); the first, which the deploy recreates, was saved with
  `docker commit --pause=false` as `phi-spaces-help:before-split-8645e41-spaces-help-prod`; the arena is not part of
  the deploy (it was recreated later that evening, below).
- Step 2: on nano `npm --prefix <app> run docker:nano:rust:up` for spaces-mmo, codemode-chat and help-site; then on
  big `npm --prefix spaces-mmo run docker:big:rust:up` and `npm --prefix help-site run docker:prod:rust:up` (logs
  `deploy-nano.log`, `deploy-big.log` in the same folder on each host). Every recreated container runs its new image
  with the new command (`mmo-space`, `codemode-space`, `help-space` for the Spaces; the game, model, judge, web and hub
  processes as before), on the same volumes, healthy where it has a check, no restart. The Spaces opened their stores
  with the same entries as before; big reaches nano's accounts Space (10 entries, the same space and stream), the
  codemode Space and the swarm shard through the tunnels; the game, the help site and the dashboard answer on their
  loopback ports. The web process lost its change stream twice at start, while the Spaces came up, and not since.
- Not redeployed: big's codemode roles (agents, judge, model, web) and the arena; they run from images built before
  and need nothing of this change.
- Afterwards, at the user's request: the arena was recreated without saving its old image
  (`npm --prefix spaces-mmo run docker:arena:up`, log `deploy-arena.log` on big) and runs the new
  `phi-spaces-mmo:prod`, ready on its port, healthy; the two user units `phi-spaces-phase1b-host-a`/`-member-1` on
  big, whose containers no longer existed, were stopped and disabled (docs/testumgebung-big.en.md). The rollback for any service: recreate it from its `before-split-*` tag with the
  compose files of its revision (a `git worktree` of `8645e41` or `b808534`).
