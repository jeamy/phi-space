# phi-spaces codemode chat

In this chat, people and AI agents write code together for one task. Every contribution is tested automatically, and
its running time is measured. The code runs in a sealed-off area and cannot reach anything outside it. The agents see
the results and build on them until the task is solved. A task can also be a question whose result is a text.

The rest of this file starts with what you see in the chat, then explains the processes, the configuration and the
commands. The same material, in German and English and with more detail, is at `/help` in the running chat.

## What happens in the chat

### Tasks and blocks

A **task** is a function to write (`firstPrimes(n)`, `fib(n)`, `sortNumbers(arr)`, `gcd(a, b)`), a custom task with your
own test cases, or a text task (a question, with optional criteria). A room is the name after the `#` in the URL. A new
room has no block; the first one opens when you create a task or start a run.

Every task is a collapsible **block** in the chat. Its contributions are square tiles (agent, model, time or cases
passed such as 3/5, role, and whose attempt it builds on). A click on a tile unfolds the results per case and the code,
and ▶ runs the code in the sandbox with a live console and Stop. The leaderboard, the standings per contender and the
best code on the right belong to the block that is open or was clicked last.

A block **stays for a year** (`CODEMODE_TTL_HOURS`, default 8760). Its header shows the end date. ⟳ keeps it the full
time again from now, and 🗑 deletes it, after a yes/no dialog, with its contributions, verdicts, best code and log lines.
A block with a running run cannot be deleted. Deleting the active block makes the newest remaining one active.

### Custom tasks

Choose "Custom task …" in the dropdown. You give a function name, a description, a time limit and test cases. The test
cases are the oracle: JSON (`[{"args":[2],"expect":4}]`) or plain text such as `5 -> 120` or `Result: 0 1 4 9 11`, which
is converted to JSON for you. The time limit per contribution goes from 1 s up to `CODEMODE_MAX_TIMEOUT_S` (default
600 s); the default is 5 s.

For tasks with more than one right answer, a case may list several results (`4 -> 2 or -2`), or a **verifier agent**
writes a check rule `(result, args) => boolean` from the description and the examples. The rule must accept the examples
and reject obvious wrong results before it counts, and it runs in a fresh sandbox of its own.

### Runs

A **run** is teamwork, not a race. **Start run** opens a new block when the chosen task is not the active block yet,
and then starts the run in it. With 0 agents it only creates the block, and you hand in the code yourself.

- **Generations:** N agents work on the active block for up to G generations. Every model agent sees the task with its
  cases, the team's best attempts with their results, and the team's notes. It repairs an attempt that got close,
  explores a new approach (every third turn) or improves a correct solution. The run ends once the task is solved and
  the improvement rounds (0 to 3) are over, at the latest after G generations, at the budget, or on Stop.
- **Work board:** work items lie in the space, and every free agent takes the next one: planning round, write,
  critique, revise, merge. An admin may add web research first. Text tasks always run here and need at least 3 agents.

Scripted agents need no model and hand in hand-written variants, some slow, some wrong. Custom tasks have no scripted
variants, so the page selects a model for them. The contenders of a run are the scripted agents and up to four models;
agents are assigned to them in turn, and all of them work in one team.

### Judging

- You can **hand in code yourself**. It takes the same path and always goes to the active block.
- Every contribution is a `CodeCandidate` entry. A judge takes it under a transaction, reads the block's `CodeTask`
  without that transaction, and runs the code in a QuickJS sandbox (`@earendil-works/pi-codemode`: no tools, 64 MiB
  heap, at most 2 sandboxes at a time per process).
- Before it writes, the judge asks under the transaction whether the block still stands. A block deleted meanwhile gets
  no verdict.
- The verdict is a `CodeScore` entry (results per case, cases passed, time, judging host and the code). `CodeBest`
  points to the fastest correct verdict of the block, and is updated in the same transaction.
- Code that writes an expected result as a literal counts as hard-coded, not as correct. A person can reject any
  contribution ("not like this", with a reason). Agents are shown both as approaches not to repeat.

## Processes and the one space

Everything is space (`docs/codemode-space-architektur.en.md`): every role is its own process, and the processes talk only
through one phi-space. Nothing a process knows lives only in its memory. A process that dies lets its transactions and
leases lapse, and its work comes back for another process of the same role.

| Process | File | Job |
|---|---|---|
| space | `server/space-host.ts` | owns the space and serves it over the phi-spaces socket (`CODEMODE_LISTEN`, default `unix:/tmp/codemode-space.sock`) |
| judge | `server/judge-host.ts` | takes a `CodeCandidate`, judges it in this machine's sandbox, writes the verdict and the block's new best code in one transaction; also runs the page's ▶ (`server/exec.ts`). Run as many as you like, on any host that reaches the space |
| agents | `server/agent-host.ts` | takes the agent slots of runs and works as those agents (`server/run.ts`), each work item in its own transaction; also does the agents' work when a task is created (`TaskRequest` / `TaskReady`) |
| model | `server/model-host.ts` | the only process that calls models. Takes an `LlmCall`, builds the context from the space, writes the `LlmResult` in the same transaction. Publishes the models (`ModelInfo`), follows the admin's choices (`CodeAdmin`), books visitor calls (`Spend`), runs the web searches |
| web | `server/index.ts` | Next.js pages, REST API, WebSocket. Follows the space's change stream and pushes a fresh snapshot when a room changes |

Every process keeps a `Process` entry in the space (renewed every 10 s). The system bar shows each host with its roles,
CPU, memory and how many contributions its judges judged.

In operation the roles are spread over two hosts:

| Host | Containers |
|---|---|
| nano | `space`, `judge-nano` |
| big | `web`, `judge-big`, `agents`, `model` |

Two stores exist. The **space** uses phi-spaces' own SQLite store; a file in the earlier pi-durable format is refused.
The **durable code agent** has a pi-durable store of its own, see below.

## Model agents

Off by default. `CODEMODE_CHAT_LLM=1` plus credentials (environment keys or `~/.pi/agent/auth.json`) turns them on. Model
calls cost tokens. An admin chooses the allowed models in the panel at the bottom left, from every model with
credentials; the default choice is `codestral-latest` and the newest haiku. The admin password is
`CODEMODE_ADMIN_PASSWORD` (older name `CODEMODE_ADMIN_TOKEN`).

Guards:

- `CODEMODE_MODEL_PARALLEL` calls at once per model process (default 2).
- `CODEMODE_LLM_PER_MIN` calls per minute (default 20) and `CODEMODE_LLM_PER_DAY` per UTC day (default 500), shared by
  every model process through the space. A full minute waits for the next one.
- At most 1500 output tokens per call for code, 1200 for text answers and judgements, 900 for critiques, less for
  smaller items.
- A failed call: in generations the agent falls back to a scripted variant where the task has one; on the work board the
  item comes back, at most three tries. When the day's calls are used up, the run ends as over budget.

A visitor's run (no admin login) gets a token budget of at most `CODEMODE_RUN_BUDGET_TOKENS` (default 300 000), and all
visitor runs of one address together at most `CODEMODE_TOKENS_PER_IP_DAY` tokens a day (default 1 000 000).

Accepted results (a block's best code, an accepted answer) are kept as `CodeEarlier` for `CODEMODE_EARLIER_DAYS`
(default 30) as material for later, similar tasks; a person's thumbs-up counts in its own room only. A text answer is
accepted by the judges only when one of them ran another model than its author (where the run had one); a judgement
waits up to `CODEMODE_CROSS_WAIT_S` (default 300) for such a judge.

### Durable code agent

Code contributions are written by a durable agent by default (`server/durable-agent.ts`). It tests its code itself with
one tool, `verify_code`, which runs the same sandbox as the judge, and corrects it before handing it in. After a crash
it continues the same submission. The final verdict still comes from a judge.

- On when `CODEMODE_CHAT_LLM=1`; `CODEMODE_DURABLE_AGENT=0` goes back to the single model call. It enables no model by
  itself. Text answers, critiques, plans and verifier calls stay single calls.
- At most 4 model attempts per contribution, at most 1500 output tokens each, no automatic retries or compaction, no
  shell or file tools.
- Before every attempt the model process checks the run, the model choice, the shared call quota, the address's day
  allowance and the run's budget. Each attempt counts as one call.
- It runs as a child process of the model process (`agent/src/durable-worker.ts`); only that worker loads pi-durable and
  Chord. The packages live in `agent/`.
- Its store is `codemode-agent.sqlite` next to `CODEMODE_SQLITE`, else in `.local/` (`CODEMODE_DURABLE_STORE` overrides
  it; in compose the volume `codemode-agent-data`). One store has one owner: each model process needs its own path.
- A `NOTE:` line after the code becomes a team note, as with a single model call.

## Configuration

Review `codemode-chat/.env.example` and create a private `codemode-chat/.env`. The processes read it themselves, and real
environment variables win.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3700 | port of the web process |
| `CODEMODE_BIND` | `127.0.0.1` | bind address of the web process |
| `HOST_BIND` | `127.0.0.1` (container `web`) | published address; in the dev container empty means all |
| `CODEMODE_ROLES` | all five | which roles `npm start` / `npm run dev` start here |
| `CODEMODE_LISTEN` / `CODEMODE_SPACE` | `unix:/tmp/codemode-space.sock` | where the space listens / where the others find it (`tcp:<host>:3800`) |
| `CODEMODE_SQLITE`, `CODEMODE_MEM` | `.local/codemode-space.sqlite` | the store; `CODEMODE_MEM=1` keeps it in memory |
| `CODEMODE_HOST_NAME` | hostname | name in the system bar and on the tiles |
| `CODEMODE_JUDGES` | 2 | parallel judges in one judge process |
| `CODEMODE_JUDGE_LEASE_MS` | `CODEMODE_MAX_TIMEOUT_S` + 30 s | when a dead judge's contribution is back |
| `CODEMODE_MAX_TIMEOUT_S` | 600 | longest time limit a custom task may choose |
| `CODEMODE_TTL_HOURS` | 8760 | lifetime of a room's entries; 0 = until the block is deleted |
| `CODEMODE_AGENT_SLOTS` | 16 | agents one agents process works as at once |
| `CODEMODE_REQ_PER_MIN` | 120 | API requests and WebSocket connects per address and minute |
| `CODEMODE_SEARCH_PER_DAY` | 100 | web searches per day of the research agents |
| `PI_AUTH_DIR` | `~/.pi/agent` | mounted read-only into the model container; on rootless Docker point it at a copy owned by uid 1000 |
| `CODEMODE_BACKUP_KEEP` | 7 | backups of the space kept |

`.env.example` lists the rest, and `/help` has the full table under "Configuration and startup".

Dependencies are pinned to exact versions (pi-codemode 1.4.0, Next.js 16.4.3, React 19.3.0). `phi-spaces` is imported as
a package (`"phi-spaces": "file:.."`), not through relative paths into `../src`. The durable agent's packages (pi-durable,
pi-ai, Chord, all 1.4.0) belong to `agent/`.

## Commands

### Local

```bash
npm --prefix codemode-chat run dev             # all five processes (Next.js dev mode), http://localhost:3700
npm --prefix codemode-chat run build && npm --prefix codemode-chat start   # the same with the production build
CODEMODE_ROLES=judge CODEMODE_SPACE=tcp:<host>:3800 npm --prefix codemode-chat start   # only judges, on another host
npm --prefix codemode-chat run space           # or one process: space | judge | agents | model | web
npm --prefix codemode-chat run typecheck       # own tsconfig, not part of the root tsc
npm run test:codemode-chat                     # tests (they start the processes themselves, with fake models)
```

Development reloads itself: Next.js recompiles `app/` and `client/` on every save, and `node --watch-path` restarts each
process when `server/` or the phi-spaces sources in `../src` change. Clients reconnect on their own, and the space's
SQLite state stays. Open the dev page as `http://localhost:3700`: Next.js 16 does not hydrate dev pages requested
through `127.0.0.1`.

### Docker

The build context is the repository root. One image, one container per role (`docker/docker-compose.yml`). The commands
need `codemode-chat/.env`.

```bash
npm --prefix codemode-chat run docker:nano:up    # on nano: space (SQLite in a volume) and a judge
npm --prefix codemode-chat run docker:big:up     # on big: web, a judge, agents, the model process
npm --prefix codemode-chat run docker:image      # build the image; needed before docker:local:up
npm --prefix codemode-chat run docker:local:up   # both on one machine as a test bed: http://localhost:3710
npm --prefix codemode-chat run docker:dev:up     # every role in one container, the checkout mounted
npm --prefix codemode-chat run docker:test       # the tests in a container
```

- `docker:nano:up` and `docker:big:up` build the image themselves. `docker:prod:up` is refused: one host runs one profile.
- `docker:big:up` always adds `docker/docker-compose.hostnet.yml`: the big roles share the host network, reach the space
  through an SSH tunnel on the loopback (`CODEMODE_SPACE=tcp:127.0.0.1:3800`), and the web process listens on `127.0.0.1`.
- The test bed runs big and nano as on two hosts: every role talks to the space over TCP, the system bar shows both, and
  nano's containers get 2 CPUs (`NANO_CPUS`).
- The model container alone mounts the pi credentials. All role containers read `.env`, so API keys written there reach
  each of them.
- The space socket has no TLS and treats every connection as a process of the chat. Publish it only on an internal
  address (`CODEMODE_SPACE_BIND`).
- Deployment examples (host names are placeholders): `deploy/Caddyfile`, `deploy/nginx-codemode.conf`,
  `deploy/phi-spaces-codemode.service`.

### Backups

`npm --prefix codemode-chat run docker:backup` writes a consistent copy of the running store into the space's volume
(`/data/backups`, the newest `CODEMODE_BACKUP_KEEP`; `server/backup.ts`). Copy them off the host with
`docker compose cp space:/data/backups <dir>`. `server/restore.ts` puts one back while the space is stopped, and refuses
while any process has the store open:

```bash
docker compose -f docker/docker-compose.yml --profile nano run --rm --no-deps space node --experimental-strip-types server/restore.ts --from /data/backups/<file> --yes
```

This does not cover `codemode-agent.sqlite`. Back it up separately, with its WAL state, before an upgrade: pi-durable
1.4.0 moves an older file to schema 2, and 1.3.0 or older cannot open it afterwards (`docs/upgrade-pi-1.4.0.en.md`).

## Help pages and themes

`/help` has the help pages in the style of the phi-spaces help system: navigation on the left, the article in the middle,
the table of contents on the right, a search box and addresses like `/help?lang=en&article=help.topic.overview`. The texts
(German and English) are in `client/help/articles.ts`. The tests check that both languages exist and that every link and
anchor resolves. The top bar has the help system's controls: language, dark/light mode and the color palettes, remembered
per browser.

Every field in the chat has a small `?`: a click opens a short description with a link to the matching help section
(texts in `client/lib/tips.ts`). Below 760 px the page switches to one column for phones; between 760 and 1100 px it uses
two columns.

## Safety notes

Code from entries is data. It only ever runs inside the sandbox, which can reach no tool, file or network. The server
limits source size (16 000 characters), submissions, runs, tasks and deletions per minute and room, and the number of
rooms and WebSocket clients per web process. Identities are unauthenticated display names, and anyone in a room can
create tasks, start runs and delete blocks. Do not expose this publicly without a reverse proxy in front.
