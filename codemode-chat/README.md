# phi-spaces codemode chat

A chat where **agents and people contribute code to a shared phi-space** and a **codemode sandbox judges every
contribution**. It is the Space-Chat of the help system rebuilt for codemode: the same palette, the same layout
(task and run controls on the left, the conversation in the middle, leaderboard and best code on the right),
independent of `help-site/` and deployable as its own Docker module.

## What happens

- A **task** is a function to write (`firstPrimes(n)`, `fib(n)`, `sortNumbers(arr)`, `gcd(a, b)`), or a custom task
  you define with a function name and test cases (`[{"args":[2],"expect":4}]`). The cases are the oracle.
- A **run** lets N agents contribute for G generations. Scripted agents (no model) hand in hand-written variants,
  some slow, some wrong; model agents (optional) write JavaScript themselves and see the best code so far.
- You can **hand in code yourself**; it goes through exactly the same path.
- Every contribution is a `CodeCandidate` entry. A judge takes it under a transaction, runs it in a QuickJS sandbox
  (`@earendil-works/pi-codemode`, no tools, 5 s timeout, 64 MiB heap, at most 2 sandboxes at a time) and writes a
  `CodeScore` entry with the verdict, the time and the code. `CodeBest` holds the fastest correct one. The page shows
  the code of every contribution, wrong ones included.

Entries (`ChatMessage`, `CodeTask`, `CodeCandidate`, `CodeScore`, `CodeBest`) live in one durable space per
deployment (SQLite); the session name in the URL hash (`#room`) separates rooms.

## Run it

```bash
npm run codemode-chat                 # http://localhost:3700, in-memory
CODEMODE_SQLITE=/tmp/cm.sqlite npm run codemode-chat
npm run test:codemode-chat
npm run codemode-chat:docker:up       # builds and starts the container, port 127.0.0.1:3700
npm run codemode-chat:docker:down
```

Configuration (`codemode-chat/.env.example`): `PORT`, `CODEMODE_BIND`, `CODEMODE_SQLITE`, `CODEMODE_CHAT_LLM`,
`CODEMODE_CHAT_MODEL`. The Docker module is `docker/Dockerfile` (build context: the repository root) plus
`docker/docker-compose.yml` (project `phi-spaces-codemode`, volume `codemode-chat-data`, no capabilities, read-only
mount of `~/.pi/agent`).

## Model agents

Off by default. `CODEMODE_CHAT_LLM=1` plus credentials (environment keys or `~/.pi/agent/auth.json`) turns them on;
the picker offers `codestral-latest` and the newest haiku only. Guards: 2 calls in flight, 12 per minute; when a
guard or the model fails, the agent falls back to a scripted variant. Model calls cost tokens.

## Safety notes

Code from entries is data. It only ever runs inside the sandbox, which can reach no tool, file or network. The
server limits source size (16 000 characters), message size, submissions and runs per minute and session, the number
of sessions and WebSocket clients. Identities are unauthenticated display names: do not expose this publicly without
a reverse proxy in front.
