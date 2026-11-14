# Directory split: the spaces core apart from the applications (plan)

Status: plan, nothing moved yet (2026-11-14).

## Goal

The core of phi-spaces, TypeScript and Rust, lives in one directory `spaces/`. Rust code that exists only for
spaces-mmo, codemode-chat or the help site lives under that project's own `rust/` directory. The core knows nothing of
the applications. It has no code path, binary, profile, default or test that names one of them. The dependency runs
one way only, from the applications to the core.

The phrase "in die jeweiligen Verzeichnisse unter rust" is read here as `spaces-mmo/rust/`, `help-site/rust/` and
`codemode-chat/rust/`. It is not read as `rust/mmo/` and so on inside one shared Rust tree.

## Where things are tangled today

These are the places where the core names an application. They come from a word-bounded search over `src/`,
`rust/phi-*`, `test/` and `scripts/`. Comments that only cite an application as the reason for a default are not
counted.

| Place | What it holds | Belongs to |
|---|---|---|
| `rust/phi-space-server/src/profiles.rs` | `--profile mmo\|codemode\|help`: listen addresses, store files, limits, locks, peer names, Process entry, compaction, all from the projects' env variables (`SPACES_MMO_*`, `CODEMODE_*`, `SWARM_*`) | the generic part is core, the three profile functions belong to the apps |
| `rust/phi-space-server/src/help.rs` | the help site's swarm Space: alias, limits, completion profile, HostInfo, purge of old posts | help-site |
| `rust/phi-space-server/tests/process.rs` | starts `--profile mmo` / `codemode` / `help` | the apps, beside their binaries |
| `rust/mmo-engine`, `rust/mmo-web` (bins `mmo-world`, `mmo-npc`, `mmo-web`) | the game engine and web process | spaces-mmo |
| `rust/Cargo.toml` | `[profile.dev.package.mmo-engine]`, `regex-*` opt-levels | spaces-mmo |
| `src/dashboard.ts` | the default app list (codemode-chat, spaces-mmo world, swarm shard, hub; sockets and ports) | configuration, not core code |
| `test/test-shared-copies.test.ts` | reads `client/lib/palettes.ts`, `markdown.ts`, `server/env.ts` in the three apps | a repo-wide check, not a core test |

Everything else in `rust/` is core: `phi-json`, `phi-core`, `phi-store`, `phi-service`, `phi-wire`, `phi-host`,
`phi-spaces-client` (with `phi-client-driver`) and `phi-space-server` without the profiles. `mmo-web` and
`mmo-engine` already depend only on `phi-json` and `phi-spaces-client`.

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
checks/                     repo-wide checks: shared copies, branding, layering
docs/ de-docs/ AGENTS.md README.md package.json (thin: forwards to spaces/ and the apps, no exports)
```

`spaces/rust` sits beside `spaces/test`, so the Rust tests' relative paths to `test/support/*-driver.ts` and
`test/vectors/` (`CARGO_MANIFEST_DIR/../..`) keep working unchanged.

## Decisions

**D1, Cargo workspaces: one per project (recommended), not one for the whole repo.** Each app workspace takes the core
crates as path dependencies (`phi-spaces-client = { path = "../../spaces/rust/phi-spaces-client" }`). This makes the
separation structural: no core crate can depend on an app crate, because the core workspace does not contain them.
The cost is a `Cargo.lock` and a `target/` per workspace, so the core is compiled again for each app.
`[profile.release]` (thin LTO, one codegen unit) only takes effect at a workspace root, so it is copied into every
workspace. The mmo opt-levels go into the mmo workspace only. Lock drift between the workspaces (rusqlite, tokio,
rustls) is held off by `checks/rust-locks`, which compares the versions of shared crates across the lockfiles.
The alternative is one virtual workspace at the repo root with a layering check. It is simpler to operate (one lock,
one target) but separates only by folder.

**D2, app profiles become app binaries.** `profiles.rs` splits in two. The generic part becomes the library
`phi-space-host`: `Instance`, `run_instance`, the Process lease, locks only when missing, compaction, host facts, the
ready line, `stopping`, and a `HostTask` hook for prepare and periodic work on the store's thread. The three profile
functions become `main.rs` of three small binaries in the apps. Each keeps its env variables and its ready line exactly
as now, so the TypeScript starters and tests see no difference except the binary's name. codemode's profile is pure
configuration. It still gets its own binary, so all three projects work the same way and the core keeps no codemode
defaults. `phi-space-server` keeps no `--profile` alias, because that alias would be app code in the core.

**D3, the TypeScript core moves into `spaces/` as a whole package.** The apps' `"phi-spaces": "file:.."` becomes
`"file:../spaces"`. The root `package.json` keeps only forwarding scripts (`test`, `typecheck`, `test:agent`,
`codemode-chat`, ...). It has no `exports`, so nothing can import "the repo".

**D4, the dashboard takes its app list from configuration.** The defaults move out of `src/dashboard.ts` into the
root `.env` (`DASHBOARD_APPS`, which already exists) or into a `dashboard.apps.json` at the root. Without either, the
dashboard shows only `--dir`/`--app`.

**D5, `docs/` stays at the repo root.** It holds documents that span the core and the apps (rust-portierung, the
federation plan, betrieb). Only the documents that are purely codemode (`codemode-*.en.md`) move to
`codemode-chat/docs/`, as spaces-mmo already does. Moving the whole tree would break hundreds of links for little gain.

## Phases

Each phase is its own commit (or a few), ends green, and can be reverted on its own. Phases 1 and 2 change content in
place. Phases 3 and 4 are moves made with `git mv`, plus only the path fixes they force, so rename detection and
`git blame` follow the files.

### Phase 0: preconditions

- Clean working tree: the open changes in `codemode-chat/` and `spaces-mmo/` (planning bots, `server/subgoals.ts`)
  are committed or set aside first. Other sessions working in this checkout pause for phases 3 and 4.
- Baseline: `npm run typecheck`, `npm test`, `npm run test:agent`, `cd rust && cargo test && cargo clippy
  --all-targets`, the app tests, and the cross runs with `PHI_SPACES_SERVER_CMD` / `PHI_SPACES_CLIENT_CMD`. Results
  recorded so later failures can be told apart from existing ones.

### Phase 1: decouple Rust in place (still under `rust/`)

1. Extract `rust/phi-space-host` (library) from `profiles.rs` with the `HostTask` hook. `phi-space-server` uses it
   for nothing app-specific and loses `--profile`. Its `help.rs` (`--help` text) is checked for profile mentions.
2. `rust/mmo-space`, `rust/codemode-space`, `rust/help-space` (with today's `help.rs`) as binaries on
   `phi-space-host`. `tests/process.rs` is split into each.
3. Switch the callers to the new binaries, one app per commit:
   - `SPACES_MMO_SPACE_SERVER`, `CODEMODE_SPACE_SERVER`, `HELP_SPACE_SERVER` and the launchers that pass
     `--profile`
   - the three Dockerfiles (`cargo build -p ...`, `COPY --from=rust-builder ...`)
   - `docker-compose.rust*.yml` (`command:`), `spaces-mmo/tests/perf/space-cost.ts`, `handover-live.ts`, `soak.sh`
4. Verification: `cargo test`/`clippy`, every app's tests against the new binary, and the `docker:local:rust:up`
   images of each app built and started on this machine.

### Phase 2: decouple the TypeScript core in place

1. Dashboard defaults to configuration (D4). `test/test-dashboard.test.ts` gets its apps from the test.
2. `test/test-shared-copies.test.ts` → `checks/shared-copies.test.ts`, and `scripts/check-branding.mjs` →
   `checks/`. Both run from the root scripts.
3. New check `checks/layering.mjs`, run by `npm test` before the suites:
   - nothing under `src/`, `test/`, `scripts/`, `agent/` or `rust/phi-*` imports or path-references `spaces-mmo/`,
     `codemode-chat/` or `help-site/`
   - no core `Cargo.toml` has a path dependency on an app crate
   - comments that cite an app as a reason are allowed

   The check is written against today's paths and switched to `spaces/` in phase 3.
4. `examples/codemode-evolve.ts` is checked: if it only demonstrates pi-codemode on a space, it stays a core example.
   If it needs codemode-chat, it moves there.

### Phase 3: the core into `spaces/`

One commit, so the TypeScript and Rust paths to each other never break:

- `git mv src test examples agent scripts tsconfig*.json package.json package-lock.json spaces/`, plus the core part of
  `rust/` (`Cargo.toml`, `Cargo.lock`, `rustfmt.toml`, `phi-*`) to `spaces/rust/`. `node_modules/` and `dist/` are moved
  with `mv`, not reinstalled (nothing is installed locally). In each app, the `node_modules/phi-spaces` symlink is
  repointed by hand (`ln -sfn ../../spaces`). An `npm install` needs the user's approval first.
- Path fixes this forces:
  - **Each app's dependency:** `package.json` (`file:../spaces`) and its `package-lock.json` entry.
  - **Tooling inside `spaces/`:** the allowlists in `scripts/package-imports.mjs` and `scripts/durable-imports.mjs`.
  - **`scripts/bundle-mobile.mjs`:** the mobile sibling becomes `resolve(root, '../../pi-termux-mobile')`.
  - **Test support paths:** the `rust/target/release/...` defaults in `test/support/*-under-test.ts`, and
    `test/testbed/` (federation images, `phi-federation:local`, its Dockerfiles).
  - **App references into the old tree:** the paths from the apps to the core test tree (`spaces-mmo/tests/r8/*`,
    `help-site/server/social`), and the Dockerfiles' `COPY` of the core (`/opt/phi-spaces/spaces/...`).
  - **Git configuration:** `.gitignore` (`spaces/rust/target/`, `spaces/dist/`).
- Verification: everything from the phase 0 baseline, run from `spaces/` and through the root forwarders.

### Phase 4: the app crates into the apps

One commit per app. Each new workspace gets its own `Cargo.toml` with the release profile copied in (D1), its own
`Cargo.lock` started from the core one (`cargo generate-lockfile` is not run, the lock is copied and trimmed by
`cargo`), and its own `target/` in `.gitignore`.

- **spaces-mmo:** `git mv rust/mmo-engine rust/mmo-web rust/mmo-space spaces-mmo/rust/`.
  - `tests/common::repo()` becomes `../../..`.
  - The oracle is unpacked into `spaces-mmo/rust/target/tmp`. The frozen commit keeps its old layout inside the
    archive, so the oracle itself is unaffected.
  - The `MMO_ORACLE`, `commands.json` and `uncovered.ts` paths, and the `SPACES_MMO_*_CMD` defaults, follow.
  - The Dockerfile builds in `spaces-mmo/rust` and copies `spaces/rust` beside it for the path dependencies.
- **codemode-chat:** `git mv rust/codemode-space codemode-chat/rust/`.
- **help-site:** `git mv rust/help-space help-site/rust/`.
- After this, `rust/` at the root is empty and gone.
- Verification:
  - `cargo test`/`clippy` in all four workspaces
  - `tests/engine_walk.rs` and `primitives.rs` against the oracle
  - `web-cross.ts`, the app test suites against their binaries, and the local docker images

### Phase 5: the root and the documentation

- **Root and agent instructions:** the root `package.json` becomes the thin forwarder (D3). `AGENTS.md` is rewritten
  for the new paths (commands, layout, every `rust/...` and `test/...` mention), as is `README.md`.
- **Documentation links:** the codemode documents move (D5). Links in `docs/`, `de-docs/` and the apps' docs are
  rewritten by a script, then checked by a link check over every `*.md`.
- **Memory:** entries that name paths (soak, local mmo, deploy) are updated.

### Phase 6: deploy (only with the user's approval)

big and nano run only Rust (R-D12). The new binary names reach them only with a new image and the changed
`command:` in the compose files. The compose project names are set explicitly (`phi-spaces-mmo`,
`phi-spaces-codemode`, `phi-spaces-help`), so volumes and store files stay where they are. The servers' checkouts get
`git pull` and then the usual `docker:*:rust:up`. Before that, the same images run on this machine against copies of
the store files (`~/phi-backup/`). Nothing is started on a shared server without asking.

## Risks

- **Moves collide with open work.** A large move makes every uncommitted change elsewhere a conflict. Hence phase 0
  and the pause of other sessions.
- **Compile time.** Separate workspaces compile the core once per app (D1). This applies locally and in the docker
  builder. A shared `CARGO_TARGET_DIR` locally would soften it, but it is not part of this plan.
- **Paths outside the repo.** Some paths are not in git: the mobile runtime (`pi-termux-mobile`), `~/phi-soak`,
  `~/phi-backup`, the servers' checkouts, and scripts that use absolute `rust/target/release/...` paths. They are
  searched for before phase 3, and the hits are listed in that commit.
- **The frozen mmo oracle** is an old tree. It must not be "fixed" to the new layout, only its extraction target moves.

## Open for the user

1. D1: one workspace per project (recommended) or one virtual workspace with a layering check.
2. D3: is the thin forwarding `package.json` at the root wanted, or should the root have none?
3. Names: `spaces/` as the directory name, and `mmo-space` / `codemode-space` / `help-space` / `phi-space-host` for
   the new crates.
