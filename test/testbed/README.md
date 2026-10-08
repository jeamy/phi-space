# Remote test bed

Verifies the **built, production-like artifact** in docker containers on a server instead of on the developer machine. No
source code goes to the server. `testbed.sh` builds the artifacts locally (the `pi-spaces.mjs` bundle, compiled examples and
scenarios, byte-identical to what the mobile runtime gets), ships only those over ssh, builds an image from them there
(Node, `npm ci --omit=dev`, the artifacts; unprivileged user, `NODE_ENV=production`, read-only root filesystem, no
capabilities) and starts the containers that are not running.

```sh
cp test/testbed/testbed.env.example test/testbed/testbed.env   # server, directory, credentials (git-ignored)
npm run testbed -- check          # read-only: ssh, docker, compose, rsync, directory
npm run testbed -- test           # build + ship + image + start the runner; smoke, examples, scenario
npm run testbed -- scenario sieve-mobile create|run|evaluate|all
npm run testbed -- up federation  # also start host-a, host-b, member-1, member-2
npm run testbed -- status | logs <svc> | exec <svc> <cmd> | kill|stop|partition|heal <svc> | down
npm run testbed -- --dry-run up   # show every remote command without running it
```

Scenario: `scenario sieve-mobile` runs a prime sieve driven by a simulated phone (lost calls, retries with the same request id,
app in the background, dying workers, host restart) and evaluates the stored state against trial division. Exit code 0
means passed.

The source tests (`npm run typecheck`, `npm test`, `npm run test:examples`) read TypeScript and therefore stay local.

- `build-artifacts.mjs`: esbuild step; refuses to produce any `.ts` file.
- `docker/`: templates installed on the server (`docker-compose.yml`, `Dockerfile`, `.dockerignore`). Existing files on the
  server are kept; `init --force` overwrites them. The server `.env` is generated once and never overwritten.
- `testbed.env.example`: every setting. Environment variables win over `testbed.env`.
- No ports are published, containers have memory/cpu/pid limits, and the script never deletes the server directory.

Procedure, container roles, limits and troubleshooting: [docs/testumgebung-big.md](../../docs/testumgebung-big.md) (German).
