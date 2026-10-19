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

## Run it

```bash
npm --prefix codemode-chat run build                    # Next.js production build
npm run codemode-chat                                   # production server, http://localhost:3700 (in memory)
CODEMODE_SQLITE=/tmp/cm.sqlite npm run codemode-chat    # durable
npm run codemode-chat:dev                               # Next.js dev mode
npm run test:codemode-chat                              # tests (API, sandbox, big+nano, dead shard)

# local two-host test (hub + nano over a unix socket), http://127.0.0.1:3799
npm --prefix codemode-chat run shards:start             # DEV=0 for the production build; also stop|status|logs
```

Docker (build context: the repository root; all commands change containers on **this** machine, run them on a
shared server only after agreement):

```bash
npm --prefix codemode-chat run docker:test             # tests in a container
npm --prefix codemode-chat run docker:prod:up          # hub on 127.0.0.1:3700   (down | logs | build)
npm --prefix codemode-chat run docker:dev:up           # Next.js dev server in a container
npm --prefix codemode-chat run docker:nano:up          # shard on :3800 (profile nano; on the nano host)
```

Configuration is in `codemode-chat/.env.example` (copy to `.env`): `PORT`, `CODEMODE_SQLITE`, `CODEMODE_REMOTE` (hub),
`CODEMODE_LISTEN`/`CODEMODE_DB`/`CODEMODE_JUDGES` (nano), `CODEMODE_HOST_NAME`, `CODEMODE_CHAT_LLM`. Deployment
examples (host names are placeholders): `deploy/Caddyfile`, `deploy/nginx-codemode.conf`,
`deploy/phi-spaces-codemode.service`. Ports 3700/3800 do not collide with the help system (3500/3600).

## Model agents

Off by default. `CODEMODE_CHAT_LLM=1` plus credentials (environment keys or `~/.pi/agent/auth.json`) turns them on;
the picker offers `codestral-latest` and the newest haiku only. Guards: 2 calls in flight, 12 per minute, 700 output
tokens per call; when a guard or the model fails, the agent falls back to a scripted variant. Model calls cost tokens.

## Safety notes

Code from entries is data. It only ever runs inside the sandbox, which can reach no tool, file or network. The
server limits source size (16 000 characters), message size, submissions and runs per minute and session, the number
of sessions and WebSocket clients. Identities are unauthenticated display names: do not expose this publicly without
a reverse proxy in front.
