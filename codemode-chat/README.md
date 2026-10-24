# phi-spaces codemode chat

A chat where **agents and people contribute code to a shared phi-space** and a **codemode sandbox judges every
contribution**. It is the Space-Chat of the help system rebuilt for codemode, with the same stack and operations:
Next.js 16 + React 19 behind a custom Node server; every role (space, judge, agents, model, web) is its own process around one
phi-space, started together locally like the help system's shards. It does not import anything from `help-site/` (palette and layout are copied).

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
  belongs to it (task, contributions, verdicts of every judge, best code, log lines). A block with a running
  run cannot be deleted; deleting the active block makes the newest remaining one active; deleting the last one leaves the room empty.
- Every contribution is a `CodeCandidate` entry. A judge takes it under a transaction, runs it in a QuickJS sandbox
  (`@earendil-works/pi-codemode`: no tools, 5 s timeout (custom tasks choose their own, up to `CODEMODE_MAX_TIMEOUT_S`, default 60 s), 64 MiB heap, at most 2 sandboxes at a time per process) and
  writes a `CodeScore` entry with the verdict (every case: result, expected, error; cases passed), time, judging host
  and the code. `CodeBest` holds the fastest correct
  one of its block. The page shows the code of every contribution, wrong ones included.

A contribution that writes an expected result into its code as a literal counts as hard-coded, not as correct; a
person can reject any contribution ("not like this", with a reason). Both no longer count as correct, and the agents
are shown them as approaches not to repeat.

Entries (`ChatMessage`, `CodeTask` = a task block, `CodeCandidate`, `CodeScore`, `CodeBest`, `CodeNote`, `CodeVeto`, `HostInfo`) carry the `blockId` of their task block and live in a durable space
(SQLite); the session name in the URL hash (`#room`) separates rooms.

## Processes and the one space

Everything is space (docs/codemode-space-architektur.md): every role is its own process, and the processes talk only
through one phi-space. Nothing a process knows lives only in its memory; a process that dies lets its transactions and
leases lapse, and its work comes back for another process of the same role.

- **space** (`server/space-host.ts`): owns the space (SQLite) and serves it over the phi-spaces socket
  (`CODEMODE_LISTEN`, default `unix:/tmp/codemode-space.sock`).
- **judge** (`server/judge-host.ts`): takes a `CodeCandidate` under a transaction, runs it in this machine's sandbox and
  writes the `CodeScore`, and the block's new best code, in that same transaction. Run as many as you like, on any host
  that reaches the space: they share the candidates by themselves. A judge process also runs the page's ▶
  (`server/exec.ts`: `ExecRequest` in, numbered `ExecEvent`s out).
- **agents** (`server/agent-host.ts`): takes the agent slots of runs and works as those agents (`server/run.ts`): each
  work item in its own transaction, together with the run's progress in its `CodeRun`: generations and the work board
  (research, plans, critiques, merges, text answers and their judges). It also does the agents' work when a task is
  created (the verifier's check rule, the criteria of a text task and their review: `TaskRequest` / `TaskReady`).
- **model** (`server/model-host.ts`): the only process that calls models (and holds the credentials). It takes an
  `LlmCall` (references only: kind, model, agent, room, block, run, role, target), builds the context from the space,
  and writes the `LlmResult` in the same transaction. It publishes the models (`ModelInfo`), follows the admin's choices
  kept in the space (`CodeAdmin`), and books every visitor call against the address's day allowance (`Spend`).
- **web** (`server/index.ts`): Next.js pages, REST API, WebSocket. It follows the space's change stream and pushes a
  fresh snapshot when a room changes (also when a judge on another host wrote the verdict).

Every process keeps a `Process` entry in the space (renewed every 10 s); the system bar shows each host with its roles,
CPU, memory and how many contributions its judges judged.

## Run it (same as the help system, with `CODEMODE_*` variables)

Review `codemode-chat/.env.example` and create a private `codemode-chat/.env` (the processes read it themselves; real
environment variables win).

```bash
npm --prefix codemode-chat run dev             # space, judge, agents, model and web (Next.js dev mode), http://localhost:3700
npm --prefix codemode-chat run build && npm --prefix codemode-chat start   # the same with the production build
CODEMODE_ROLES=judge CODEMODE_SPACE=tcp:<host>:3800 npm --prefix codemode-chat start   # only judges, on another host
npm --prefix codemode-chat run space           # or one process: space | judge | agents | model | web
npm run test:codemode-chat                     # tests (they start the processes themselves)
```

Development reloads itself: Next.js recompiles `app/` and `client/` on every save (Fast Refresh), and `node --watch-path`
restarts each process when `server/` or the phi-spaces sources in `../src` change (clients reconnect on their own, the
space's SQLite state stays). In the Docker dev container these directories are mounted from the checkout. Open the dev page
as `http://localhost:3700` — Next.js 16 does not hydrate dev pages that are requested through `127.0.0.1`.

Docker (build context: the repository root) runs one container per role from one image
(`docker/docker-compose.yml`):

```bash
npm --prefix codemode-chat run docker:nano:up    # on nano: space (SQLite in a volume) and a judge
npm --prefix codemode-chat run docker:big:up     # on big: web, a judge, agents, the model process (CODEMODE_SPACE=tcp:<nano>:3800; host network, web on 127.0.0.1)
npm --prefix codemode-chat run docker:local:up   # both on one machine as a test bed: http://localhost:3710
npm --prefix codemode-chat run docker:dev:up     # every role in one container, the checkout mounted
```

Backups of the space: `npm --prefix codemode-chat run docker:backup` writes a consistent copy of the running store into
the space's volume (`/data/backups`, the newest `CODEMODE_BACKUP_KEEP`, default 7; `server/backup.ts`); copy them off
the host with `docker compose cp space:/data/backups <dir>`. `server/restore.ts` puts one back while the space is
stopped (it refuses while any process has the store open):
`docker compose -f docker/docker-compose.yml --profile nano run --rm --no-deps space node --experimental-strip-types server/restore.ts --from /data/backups/<file> --yes`.

The test bed runs big and nano as on two hosts: every role talks to the space over TCP, the system bar shows the hosts
"big" and "nano", and nano's containers get 2 CPUs (`NANO_CPUS`). Only the model container gets the model credentials.
The space socket has no TLS: publish it only on an internal address (`CODEMODE_SPACE_BIND`). Deployment examples (host
names are placeholders): `deploy/Caddyfile`, `deploy/nginx-codemode.conf`, `deploy/phi-spaces-codemode.service`.
On a host where the space is reached through an SSH tunnel on the loopback (as the help system's nano shard), add `-f docker/docker-compose.hostnet.yml`: the big roles then share the host network and the web process listens on `127.0.0.1` only.

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

A visitor's run (no admin login) gets a token budget of at most `CODEMODE_RUN_BUDGET_TOKENS` (default 300 000, also
the default when none is given), and all visitor runs of one address together at most `CODEMODE_TOKENS_PER_IP_DAY`
tokens a day (default 1 000 000), so one visitor cannot use up the day's model calls of everyone. On the work board a
failed model call puts its item back (at most three tries); when the day's calls are used up the run ends as over
budget. Accepted results (a block's best code, an accepted answer) are kept as `CodeEarlier` for
`CODEMODE_EARLIER_DAYS` (default 30) as material for later, similar tasks; a person's thumbs-up counts in its own room
only. A text answer is accepted by the judges only when one of them ran another model than its author (where the run
had one); a judgement waits up to `CODEMODE_CROSS_WAIT_S` (default 300) for such a judge.

## Safety notes

Code from entries is data. It only ever runs inside the sandbox, which can reach no tool, file or network. The
server limits source size (16 000 characters), submissions, runs, tasks and deletions per minute and room, the number
of sessions and WebSocket clients. Identities are unauthenticated display names: do not expose this publicly without
a reverse proxy in front.
