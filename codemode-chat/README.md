# phi-spaces codemode chat

A chat where **agents and people contribute code to a shared phi-space** and a **codemode sandbox judges every
contribution**. It is the Space-Chat of the help system rebuilt for codemode, with the same stack and operations:
Next.js 16 + React 19 behind a custom Node server, a Docker module with `dev`/`test`/`production`/`nano` targets, a
big/nano two-host setup and run scripts. It does not import anything from `help-site/` (palette and layout are copied).

## What happens

- A **task** is a function to write (`firstPrimes(n)`, `fib(n)`, `sortNumbers(arr)`, `gcd(a, b)`), or a custom task
  with a function name and test cases (`[{"args":[2],"expect":4}]`). The cases are the oracle.
- A **run** lets N agents contribute for G generations. Scripted agents (no model) hand in hand-written variants,
  some slow, some wrong; model agents (optional) write JavaScript themselves and see the best code so far.
- You can **hand in code yourself**; it goes through exactly the same path.
- Every contribution is a `CodeCandidate` entry. A judge takes it under a transaction, runs it in a QuickJS sandbox
  (`@earendil-works/pi-codemode`: no tools, 5 s timeout, 64 MiB heap, at most 2 sandboxes at a time per process) and
  writes a `CodeScore` entry with the verdict, time, judging host and the code. `CodeBest` holds the fastest correct
  one. The page shows the code of every contribution, wrong ones included.

Entries (`ChatMessage`, `CodeTask`, `CodeCandidate`, `CodeScore`, `CodeBest`, `HostInfo`) live in a durable space
(SQLite); the session name in the URL hash (`#room`) separates rooms.

## big and nano

- **big** (the hub, `server/index.ts`): Next.js pages, REST API, WebSocket, the chat and the task state, and local
  judge workers.
- **nano** (`server/nano-host.ts`, optional): a headless host with its own space and SQLite, served over the
  phi-spaces socket (`CODEMODE_LISTEN`). Its judge workers run in nano's sandbox, so judging costs nano's CPU.

With `CODEMODE_REMOTE` set on the hub, every second candidate is written into nano's space and comes back as a
`CodeScore` entry there; the hub merges both lists, and the system bar shows both hosts (CPU, memory, judged count).
If nano is unreachable (calls are bounded to 8 s, then it counts as down for 15 s) candidates are judged on big.
This is a demo wiring, not a replicated cluster; the socket has no TLS (bind it to an internal address or tunnel it).

## Run it (same as the help system, with `CODEMODE_*` variables)

Review `codemode-chat/.env.example` and create a private `codemode-chat/.env` (the servers read it themselves; real
environment variables win). Local development keeps the shard on a unix socket:

```bash
# .env: PORT=3700  CODEMODE_BIND=0.0.0.0  HOST_BIND=  CODEMODE_REMOTE=unix:/tmp/codemode-b.sock

npm --prefix codemode-chat run shards:start    # hub (Next.js dev mode) + nano over the socket; also stop|status|logs
DEV=0 npm --prefix codemode-chat run shards:start   # the production build instead (built when stale)

# or one server only (CODEMODE_REMOTE unset or the shard not running: judging stays on this host)
npm --prefix codemode-chat run dev             # Next.js dev mode, http://localhost:3700
npm --prefix codemode-chat run build && npm --prefix codemode-chat start   # production server
npm run test:codemode-chat                     # tests (API, sandbox, big+nano, dead shard)
```

Development reloads itself: Next.js recompiles `app/` and `client/` on every save (Fast Refresh), and `node --watch-path`
restarts the server when `server/` or the phi-spaces sources in `../src` change (clients reconnect on their own, the
SQLite state stays). In the Docker dev container these directories are mounted from the checkout. Open the dev page
as `http://localhost:3700` — Next.js 16 does not hydrate dev pages that are requested through `127.0.0.1`.

Docker (build context: the repository root). **Production and nano are two separate servers**, each started from its
own `codemode-chat/.env`; the commands change containers on the machine they run on, so use them on a shared server
only after agreement:

```bash
# big (hub): host networking, HOST_BIND=127.0.0.1 for the reverse proxy
npm --prefix codemode-chat run docker:prod:up        # down | logs | build
# nano (judge shard): publishes :3800, bind it with CODEMODE_SHARD_BIND=<internal ip> (no TLS)
npm --prefix codemode-chat run docker:nano:up        # down | logs | build
# on one machine
npm --prefix codemode-chat run docker:dev:up         # Next.js dev server in a container (ports from PORT/HOST_BIND)
npm --prefix codemode-chat run docker:test           # tests in a container
```

On big, `CODEMODE_REMOTE=tcp:<nano-internal-ip>:3800` (or `tcp:127.0.0.1:3800` through an SSH tunnel, because the hub
container uses the host network). Deployment examples (host names are placeholders): `deploy/Caddyfile`,
`deploy/nginx-codemode.conf`, `deploy/phi-spaces-codemode.service`. Ports 3700/3800 do not collide with the help
system (3500/3600).

## Contenders: several models against each other

The run panel lists the **contenders** as checkboxes: the scripted agents and every allowed model. Tick up to four;
the agents of a run are assigned to them in turn (agent 0 to the first, agent 1 to the second, ...), and the
"Standings per contender" panel shows correct contributions and the best time for each. So `mistral/codestral-latest`
can run against the newest Haiku and against the scripted baseline in one run. A custom task has no scripted
variants: as soon as one is active, the page switches the contenders to the available model automatically.

## Model agents

Off by default. `CODEMODE_CHAT_LLM=1` plus credentials (environment keys or `~/.pi/agent/auth.json`) turns them on;
only `codestral-latest` and the newest haiku can be chosen. Guards: 2 calls in flight (further agents wait for a slot),
`CODEMODE_LLM_PER_MIN` calls per minute (default 20), 700 output tokens per call; when a guard or the model fails, the agent falls back to a scripted variant. Model calls cost tokens.

## Safety notes

Code from entries is data. It only ever runs inside the sandbox, which can reach no tool, file or network. The
server limits source size (16 000 characters), message size, submissions and runs per minute and session, the number
of sessions and WebSocket clients. Identities are unauthenticated display names: do not expose this publicly without
a reverse proxy in front.
