# phi-spaces codemode chat

A chat where **agents and people contribute code to a shared phi-space** and a **codemode sandbox judges every
contribution**. It is the Space-Chat of the help system rebuilt for codemode, with the same stack and operations:
Next.js 16 + React 19 behind a custom Node server, a Docker module with `dev`/`test`/`production`/`nano` targets, a
big/nano two-host setup and run scripts. It does not import anything from `help-site/` (palette and layout are copied).

## What happens

- A **task** is a function to write (`firstPrimes(n)`, `fib(n)`, `sortNumbers(arr)`, `gcd(a, b)`), or a custom task:
  choose "Custom task …" in the dropdown, which opens the fields for the function name, a description and test cases
  (`[{"args":[2],"expect":4}]`, or plain text such as `5 -> 120` or `Result: 0 1 4 9 11`, which is converted
  to JSON for you; the cases are the oracle). **Start run** opens a new **task block** in the chat when the
  chosen task is not the active block yet, and then starts the run in it (with 0 agents it only creates the block, and
  you hand in the code yourself).
- Every task block is one collapsible section of the conversation. Its contributions are **square tiles** (agent,
  model, time or cases passed such as 3/5, role and whose attempt it builds on); a click on a tile unfolds the test
  results per case and the code. ▶ runs a contribution in the sandbox with a live console and Stop. The leaderboard, the standings per
  contender and the best code on the right belong to the block that is open or was clicked last.
- A **run** is teamwork, not a race: N agents work on the active block for up to G generations. Every model agent sees
  the task with its test cases (and check rule), the team's best attempts with their case results, and the team's
  notes; it **repairs** an attempt that got close, **explores** a new approach (every third turn) or **improves** a
  correct solution, and may leave a note for the next ones. The run ends once the task is solved and the improvement
  rounds (0 to 3) are over, at the latest after G generations, or on Stop. Code you hand in at any time is judged by the
  same sandbox and is part of the board the agents build on; it always goes to the active block. Scripted agents (no
  model) hand in hand-written variants, some slow, some wrong. A custom task has no scripted variants, so choosing it
  hides the scripted agents and selects a model. For tasks with more than one right answer, a case may list several
  results ("4 -> 2 oder -2"), or a **verifier agent** writes a check rule `(result, args) => boolean` from the
  description and the examples when the task is created; the rule must accept the examples and reject obvious wrong
  results before it counts, and runs in a fresh sandbox of its own.
- You can **hand in code yourself**; it goes through exactly the same path.
- A task block can be **deleted** with the bin icon in its header, after a yes/no dialog. This removes everything that
  belongs to it (task, contributions, verdicts on this host and on nano, best code, log lines). A block with a running
  run cannot be deleted; deleting the active block makes the newest remaining one active (or opens a fresh first task).
- Every contribution is a `CodeCandidate` entry. A judge takes it under a transaction, runs it in a QuickJS sandbox
  (`@earendil-works/pi-codemode`: no tools, 5 s timeout, 64 MiB heap, at most 2 sandboxes at a time per process) and
  writes a `CodeScore` entry with the verdict (every case: result, expected, error; cases passed), time, judging host
  and the code. `CodeBest` holds the fastest correct
  one of its block. The page shows the code of every contribution, wrong ones included.

A contribution that writes an expected result into its code as a literal counts as hard-coded, not as correct; a
person can reject any contribution ("not like this", with a reason). Both no longer count as correct, and the agents
are shown them as approaches not to repeat.

Entries (`ChatMessage`, `CodeTask` = a task block, `CodeCandidate`, `CodeScore`, `CodeBest`, `CodeNote`, `CodeVeto`, `HostInfo`) carry the `blockId` of their task block and live in a durable space
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
# nano (judge shard): publishes :3800 on 127.0.0.1 (SSH tunnel); CODEMODE_SHARD_BIND=<internal ip> for a private route.
# Never a public interface: the socket has no TLS and every connection acts as the hub.
npm --prefix codemode-chat run docker:nano:up        # down | logs | build
# on one machine
npm --prefix codemode-chat run docker:dev:up         # Next.js dev server in a container (ports from PORT/HOST_BIND)
npm --prefix codemode-chat run docker:test           # tests in a container
```

On big, `CODEMODE_REMOTE=tcp:<nano-internal-ip>:3800` (or `tcp:127.0.0.1:3800` through an SSH tunnel, because the hub
container uses the host network). Deployment examples (host names are placeholders): `deploy/Caddyfile`,
`deploy/nginx-codemode.conf`, `deploy/phi-spaces-codemode.service`. Ports 3700/3800 do not collide with the help
system (3500/3600).

## Help pages and themes

`/help` has the help pages in the style of the phi-spaces help system: navigation on the left, the article in the
middle, the table of contents on the right, a search box and addresses like
`/help?lang=en&article=help.topic.overview`. The texts (German and English) are in `client/help/articles.ts`; the tests
check that both languages exist and that every link and anchor resolves. The top bar of the chat and of the help has
the same controls as the help system: language (DE/EN), dark/light mode and the color palettes, remembered per browser.

Every field in the chat has a small `?`: a click opens a short description with a link to the matching help section
(texts in `client/lib/tips.ts`). Below 760 px the page switches to one column for phones (no sticky header, 16 px
fields so iOS does not zoom, help articles as chips); between 760 and 1100 px it uses two columns.

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
server limits source size (16 000 characters), submissions, runs, tasks and deletions per minute and room, the number
of sessions and WebSocket clients. Identities are unauthenticated display names: do not expose this publicly without
a reverse proxy in front.
