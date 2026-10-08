# Remote test bed

Runs the pi-spaces tests, and later the federation hosts, in docker containers on a server instead of on the
developer machine. `testbed.sh` copies this checkout (uncommitted changes included) to the server over ssh, creates
the compose files there if they are missing, builds the image, starts the containers that are not running and runs
the tests in them.

```sh
cp test/testbed/testbed.env.example test/testbed/testbed.env   # server, directory, credentials (git-ignored)
npm run testbed -- check          # read-only: ssh, docker, compose, rsync, directory
npm run testbed -- test           # sync, build, start the runner, typecheck + npm test
npm run testbed -- test all       # ... plus npm run test:examples
npm run testbed -- up federation  # also start host-a, host-b, member-1, member-2
npm run testbed -- status | logs <svc> | exec <svc> <cmd> | kill|stop|partition|heal <svc> | down
npm run testbed -- --dry-run up   # show every remote command without running it
```

Scenario: `npm run testbed -- scenario sieve-mobile create|run|evaluate|all` runs a prime sieve driven by a simulated phone
(lost calls, retries with the same request id, app in the background, dying workers, host restart) and evaluates the stored
state against trial division. Exit code 0 means passed.

- `docker/`: templates installed on the server (`docker-compose.yml`, `Dockerfile`, `entrypoint.sh`,
  `.dockerignore`). Existing files on the server are kept; `init --force` overwrites them. The server `.env` is
  generated once and never overwritten.
- `testbed.env.example`: every setting. Environment variables win over `testbed.env`.
- No ports are published, containers have memory/cpu/pid limits, and the script never deletes the server directory.

Procedure, container roles, limits and troubleshooting: [docs/testumgebung-big.md](../../docs/testumgebung-big.md) (German).
