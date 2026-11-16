# phi-spaces

The phi-spaces library: a JavaSpaces-style data space with its own store (`src/`), its tests (`test/`), runnable
examples (`examples/`), the optional agent package that connects pi-durable agents (`agent/`, its own dependencies)
and the Rust core (`rust/`, a cargo workspace of its own). The applications built on it (spaces-mmo, codemode-chat,
the help site) sit beside this directory and depend on it as `"phi-spaces": "file:../spaces"`.

The repository's [README](../README.md) describes the project; [docs/api.en.md](../docs/api.en.md) the public API
and the package's exported subpaths; [AGENTS.md](../AGENTS.md) the commands. The scripts of this package.json run
here (`npm test`, `npm run typecheck`, …); the root package.json forwards to them and also runs the repository-wide
checks in `checks/`.
