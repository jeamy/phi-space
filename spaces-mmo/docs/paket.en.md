# Preparatory work: phi-spaces as a package (phase P)

Decision: Before spaces-mmo starts, phi-spaces becomes a proper package. All projects built on phi-spaces
(codemode-chat, help-site, spaces-mmo, future ones) import `phi-spaces` instead of relative paths into `src/`.
The reference for subpaths and rules is in `docs/api.en.md`, section "Paket und Unterpfade".

Status 2026-10-24: implemented, not yet committed (see [Status](#status)).

## Starting point

- Consumers imported relatively: `../../src/index.ts`, `../../src/context.ts`, plus individual imports of `core.ts`,
  `remote.ts`, `store/host.ts`, `store/sqlite.ts`, `store/documents.ts`.
- The help-site example `examples/v5-federated-cluster` and `agent/` reach into federation internals (`router.ts`,
  `federated-space.ts`, `entry-replication.ts`, `federation-journals.ts`, `routing-semantics.ts`).
- Root `package.json`: no `exports`; `main`/`types` pointed to `dist/`, which is gitignored and can lie around
  stale locally.
- `@earendil-works/pi-codemode` was a runtime dependency of the root but is not imported by `src/`.

## Implementation

### `exports` directly onto the sources

```jsonc
"main": "./src/index.ts",
"exports": {
  ".":                 "./src/index.ts",
  "./context":         "./src/context.ts",
  "./core":            "./src/core.ts",
  "./store/host":      "./src/store/host.ts",
  "./store/sqlite":    "./src/store/sqlite.ts",
  "./store/documents": "./src/store/documents.ts",
  "./ws":              "./src/ws.ts",
  "./package.json":    "./package.json"
}
```

(`./ws` was added later, the WebSocket gateway of all projects.)

**Deviation from the first design:** A condition `source` → `src/*.ts` with `default` → `dist/*.js` was planned.
Rejected because:

- `dist/` is gitignored but exists locally in a stale state: every call without `--conditions=source` would have loaded
  **old code silently**.
- The condition would have had to go into every npm script, into the explicit arguments of `spawn` (`codemode-chat/server/launch.ts`),
  into every Dockerfile `CMD` and into every test that starts processes; one forgotten place is enough.

No `types` field pointing to `dist/*.d.ts`, for the same reason. If the package is to be published later, that gets
a step of its own (e.g. `prepack`, which rewrites `exports` to `dist/`, or an opt-in condition `dist`).

### Integration

- `"phi-spaces": "file:.."` in the `dependencies` of codemode-chat and help-site; npm creates
  `node_modules/phi-spaces -> ../..`. The lockfiles changed only by the link entry.
- **Verified:** Node 22 (locally v22.23.1) resolves through the symlink to the real path `…/phi-spaces/src/index.ts`
  and strips the types there (no `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Trial run with `import.meta.resolve`
  in the scratchpad.
- TypeScript: codemode-chat and help-site have `moduleResolution: "bundler"` and `allowImportingTsExtensions`; that
  resolves the `exports` without further settings.
- Next.js: Only server processes import the core, no page or client code; `transpilePackages` is not
  needed.
- Docker: The build context is already the root (`context: ../..`), the root `package.json` is in its place at the project's
  `npm ci`; `COPY node_modules` takes over the symlink.

### Dependencies

- `@earendil-works/pi-codemode` is now in the `devDependencies` of the root. codemode-chat runs it itself and loads
  it from its own `node_modules` (`loadCodemode` in `codemode-chat/server/judge.ts`); the root installation in
  the Dockerfiles runs without `--omit=dev`.
- `files` now contains `src` (the exports point there).

### Check script

`scripts/package-imports.mjs --check` (`npm run check:package`, hooked into `npm test`) checks every project with
its own `package.json` except `agent/`:

- no relative imports into `src/` (static, dynamic, re-export);
- only exported subpaths of `phi-spaces`;
- every export target exists;
- a linked `node_modules/phi-spaces` points to this checkout.

Exceptions, each justified: `help-site/examples/v5-federated-cluster/run.ts` (federation internals) and
`help-site/scripts/check-corpus-examples.ts` (writes import paths for a virtual file as text). spaces-mmo is checked
automatically as soon as it has a `package.json`.

### `agent/`

Stays with relative imports. Its deep imports are federation internals that are still changing; as an
`exports` subpath they would become a contract that every project sees. Only when `agent/` is to be published
on its own do the parts it needs get a subpath.

## Status

| Step | Status |
| --- | --- |
| `exports`, `pi-codemode` → `devDependencies`, `files` | done |
| Trial run of resolution + type stripping through the symlink | done, green |
| codemode-chat and help-site converted (40 files, import lines only) | done |
| `check:package` + hooking into `npm test` | done, counter-test triggers |
| `docs/api.en.md`, `AGENTS.md` | done |
| Typecheck root, codemode-chat, help-site | green |
| Test suites root (575/576, 1 skipped), codemode-chat (113/113), help-site (54/55, Next production test skipped as before) | green |
| `docker:test` codemode-chat (image build incl. typecheck and `next build`, 113/113) and help-site (55/55) | green |
| Production images (`docker:prod:*`) started | not checked |
