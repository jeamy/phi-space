# Codemode chat: tasks with tools (plan)

Status (2026-11-05): A step 1 is built: tools in the judge, the verdict with calls, cost and score, ranking by
points before time, the catalog task "Find frustrated issues" with scripted variants, ▶ on the sample, prompts, help
and `codemode-chat/tests/tools.test.ts`. A second built-in task, "Pi issues: Windows with a reply", runs on real data:
1000 issues of github.com/earendil-works/pi (`server/data/pi-issues.json`, fetched by `server/data/fetch-pi-issues.ts`,
shortened, logins replaced). Its answer is computed from the data, not labelled: the issues whose title or body
mentions Windows and that a person, not the tracker's auto-close bot, commented on. A third, "Pi issues: Windows bugs
by Jev", adds a `jev` tool: the answers of the classifier Jev (`typesafe/jev-1.13` via OpenRouter's decisions endpoint),
asked once per issue by `fetch-pi-issues.ts --jev` and replayed by the judge. This is the record-and-replay of D in small:
a real model's output, recorded, so the judge stays without network and deterministic. A step 2 (uploads as `CodeData`, the page's form) is open; B, C and D are built (their sections).

What step 1 does differently from the text below:

- **Dataset in code.** The built-in task's dataset is generated in code from a fixed seed (`server/tooltask.ts`), not
  stored as `CodeData` entries. Those entries come with uploads in step 2.
- **Two worlds, both scored.** The sample and the holdout are two worlds over the same tools, each one execution. A
  verdict is correct only when both score 100 %, and its cost, calls and time are the holdout's.
- **`execute()`, not `start()`.** The tools answer deterministically, so the points are the same on every host
  (tested). Seeding the VM itself (`start()` with `seed`/`startedAt`) comes with D.
- **No `label` tool and no per-task cost table yet.** The costs are fixed per tool (`TOOL_COST`).
- **Known limit: a narrow channel out of the holdout.** A script's own error message on the holdout is replaced by a
  fixed text, and the holdout shows no items and no answer. But its score in percent and its call counts remain
  visible, and a script could make them depend on the hidden data. That would take many contributions to learn a
  little; this is accepted for now.

## Why

Elsewhere, "codemode" means a model writes a script that **calls tools**: MCP servers, `gh`, classifiers such as Jev,
image models. The script composes the calls with loops, conditions and `Promise.all`, and only the result goes back
into the context (Cloudflare's codemode; Pi 1.0, Earendil's "You Said No MCP!"; Armin Ronacher, "What is Codemode").
The demos are of that kind: a week of commits summarised, 167 Linear issues classified by frustration, open GitHub
issues ranked by sentiment, a game played 30 steps through `tankctl`.

The codemode chat uses `@earendil-works/pi-codemode` as a judge sandbox **without tools** (`server/judge.ts`,
`tools: []`): the team writes pure functions. This plan adds the other half, with three new task kinds:

- **A, data tasks:** tools over a fixed dataset;
- **B, Leuchtfeuer bots:** tools over a spaces-mmo world;
- **C, eval harnesses:** a task whose result is a judging script.

Durable runs (D) come last.

## What stays

- **Only the model process calls models.** A judged script never reaches a model. Tools are answered by the judge from
  data the task brings.
- **The judge reaches nothing outside the space.** No network, no file system. `fetchJson` against an allowlist is
  deliberately not part of this plan.
- One verdict per contribution, in the candidate's transaction. `CodeBest` is still updated in the same transaction.

## A. Data tasks (tools over a dataset)

### The task

A `CodeTask` gets `kind: "tools"` and two more things:

- **A tool set.** The tools are taken from a fixed catalogue, each with a JSON schema and a cost in points:

| Tool | What it does | Cost |
|---|---|---|
| `list({ after, limit })` | pages over the items | 1 per call |
| `get({ id })` | one item | 1 |
| `search({ q, limit })` | substring/token match over the items' text | 2 |
| `label({ id })` | the item's reference label, i.e. what a classifier would answer; for "classify with a tool" tasks | 5 |
| `classify({ text, labels })` | a deterministic stand-in classifier (keyword table of the task); for tasks where the script is judged on using it well, not on the label quality | 3 |
| `store` / `load` | pi-codemode's own; free | free |

- **A dataset.** It is stored as `CodeData` entries per block: one entry per page of items, sized below one commit
  (`MAX_SOURCE_BYTES` shows how tight that is). The items are JSON objects with an `id`.
  - **Visible sample:** about 10 % of the items, shown to the agents with their expected answers. This is option 4,
    "probe first, then scale".
  - **Hidden holdout:** the rest, scored and never in an agent's context. Code that writes labels as literals only
    reaches the sample. The existing literal check does not catch this, so the holdout is the protection.

The function the team writes is `async function solve() { … }`. It returns the answer, and `tools.*` are its only
inputs.

Examples:

- "Which 10 issues are the most frustrated?" The answer is a list of ids; the score is overlap with the reference.
- "Summarise the week's commits per area". The answer is `{ area: count }`; the score is exact match per key.
- "Find every customer who …" over a small CRM table. The score is precision and recall.

### The judge

- `Codemode` in `judge.ts` gets `tools: CodemodeTool[]`. The metered tools must be `tools`, not `globals`: only tool
  calls are recorded in `result.calls`.
- The judge uses `start()` with `seed` and `startedAt` fixed per task (not `execute()`, which takes neither), so a
  contribution gives the same result on every judge host.
- Each `onCall` is answered from the block's `CodeData`, read without the candidate's transaction like `CodeTask` today.
  Answers are cached per judge process.
- The **verdict** gets:
  - `calls`: the number per tool;
  - `cost`: the sum of the points;
  - `score`: 0..1 on the holdout;
  - the time.
- **Ranking:**
  - first `score` (the threshold for "correct" is set by the task, default 1.0);
  - then `cost`;
  - then the time.

  The time now includes the answering of tools and is only the last tie-break.
- **Lease:** the judge holds a sandbox slot before its transaction (today's rule) and renews its lease while it judges.
  The deadline per contribution (`timeoutMs`) covers tool time. A tools task gets a call cap as well, default 2,000
  calls; a script over the cap fails with the cap's message.

### The agents

- The prompt shows the tool declarations (`renderDeclarations` from pi-codemode), the sample with its answers and the
  costs.
- The team's notes say which calls were expensive.
- The work board stays as it is. The critique item now also reads the call counts ("calls `get` 900 times, `list`
  with limit 100 would do in 9").

### The page

- A tile shows `score` and `cost` instead of only cases. It unfolds into the calls per tool and the holdout result
  (aggregate only, never the hidden items).
- ▶ runs against the sample only.
- Creating a task takes a JSON or CSV upload of the items with an answer column, and the catalogue tools are ticked
  per task.

### Tests

- The judge with a scripted tools contribution: counts, cost, determinism over two judge processes, a script over the
  call cap, and a script that throws in a tool callback.
- Holdout: a contribution with sample labels hard-coded scores sample only.
- A run with scripted agents (a cheap and an expensive variant) ends with the cheap one as best.

## B. Leuchtfeuer bots

Status (2026-11-06): step 3 is built: the arena (`spaces-mmo/server/arena.ts`, `tests/arena.test.ts`), the bot tools and the judge (`codemode-chat/server/bottask.ts`, `judge.ts`), lanes, the catalog task "Beacon bot" and `codemode-chat/tests/bots.test.ts` with `tests/fake-arena.ts`. On big the arena runs as a container of its own (`npm --prefix spaces-mmo run docker:arena:up`, loopback port 3990; since 2026-11-06), and the chat there reaches it with `CODEMODE_ARENA=tcp:127.0.0.1:3990`. What it settles, before the text below:

- **The arena is a spaces-mmo process** (`spaces-mmo/server/arena.ts`, `npm --prefix spaces-mmo run arena`). It listens
  on a socket and speaks JSON lines: `open` (a world of its own: a space process and a world worker in memory, no NPC
  and no model process, one guest), `look`, `act`, `wait`, `score`, `close`. It talks to the world's space directly, not
  through a web process: `act` writes the line as an `Intent` entry, as the gateway does, and is done when the world
  worker has taken it (its transaction committed); it returns the messages the figure got meanwhile. `move x y` walks
  the whole way in that one command. At most two worlds at a time; a world nobody asks for a while is closed.
- **The codemode judge reaches it by `CODEMODE_ARENA`** (`unix:…` or `tcp:host:port`), and only by that socket: no
  TypeScript import across the two projects. The codemode image has no spaces-mmo, so an arena in production is a
  container of the spaces-mmo image; that is a separate decision (not part of this step).
- **Lanes.** A `CodeCandidate` carries `lane: "code"` or `lane: "bot"`. Every judge takes `code`; only a judge with
  `CODEMODE_ARENA` also takes `bot`. A judge without an arena never sees a bot contribution, and the page offers bot
  tasks only when its own process has `CODEMODE_ARENA`. A candidate written before lanes existed is moved to `code` when
  a judge starts.
- **The clock stands still.** The arena pauses the world clock when it opens a world; only `wait({ minutes })` moves it
  on. So the world time a bot used is the sum of its waits, the same on every host. Walking and commands take no world
  time. The arena puts the guest on its room's spawn cell (a new figure is otherwise scattered at random), so without
  waiting every bot finds the same world. The world's jobs (tide, storm, wind) are dates in world time: none falls due
  while the clock stands still, and after a wait they come at random. The judge opens the world before the bot's time
  limit starts.
- **Arena trouble is no verdict.** Unreachable, busy, or gone in the middle: the judge gives the candidate back and tries
  again after a pause; only what the bot did becomes a verdict. Candidates without a lane (from a process of an older
  version) are moved to `code` every few seconds.
- **Ranking:** goal reached, then points (`look`, `act` and `wait` 1 each), then ms. Points are whole numbers, so the
  tiles and the ranking stay as for tools tasks. (World minutes do not rank: the first task needs no waiting.)
- **No sample/holdout and no literal check:** the world is the test, and a bot writes coordinates and lines on purpose.
- **▶ does not run a bot** (it would need an arena in the web process); the page says so.
- **First task:** light the beacon of the Graue Bucht from the spawn (driftwood lies fixed at 5,7 and 17,9; walk,
  `nimm treibholz`, walk beside the fire, `lege holz ins feuer`). The fire of Anleger, behind fog, comes next.


The team writes a bot: `async function bot()`, a loop over `look()` and `act(line)`, run for a fixed number of world
ticks. Examples:

- "light the fire of Anleger";
- "earn 20 coins and beam to …";
- "build a hut";
- "keep the fire of your island burning for three in-game days".

### The arena

- **A world of its own per judging pass:** spaces-mmo in memory, with a fixed epoch and fixed settings, as in
  `tests/stack.ts` `startServer({ worldEnv })`. Never big.
- **No TypeScript imports across the two projects.** Each has its own tsconfig. The codemode judge talks to the arena
  only over its game socket, as `tests/play/epochs.ts` and the page do.
- **An arena process** (spaces-mmo side, new: `tests/arena/` or `server/arena.ts`):
  - starts a world;
  - logs a guest in per bot;
  - answers `look` and `act`;
  - advances the world clock in fixed steps;
  - at the end hands back the score from `collectStats` (`server/stats.ts`). That already computes per figure
    reputation (pieces, beacons, parks), journeys and what it owns, plus the task's own condition ("fire of anleger
    lit").

### Tools in the sandbox

| Tool | What it does |
|---|---|
| `look()` | room, position, exits, things in reach, inventory, coins, clock |
| `act(line)` | sends one command line as a player would type it; returns the messages it got |
| `wait(ticks)` | lets the world run; only allowed tick by tick within the task's budget |

(Superseded above: every call costs 1 point; points rank before the time.)

### One world per contribution (decided 2026-11-05)

Every contribution gets a world of its own, so a bot is judged alone and no bot affects another. Starting a world
costs seconds, which the time limit of a bot task allows for. A shared world for several bots (a "tournament") is not
part of this plan.

### Live

A finished best bot could later play as a KI-Figur on the test bed (port 3910) under a name of its own, never on big
without asking.

## C. Eval harnesses as tasks

Status (2026-11-06): built: `codemode-chat/server/harnesstask.ts`, `judgeHarness` in `judge.ts`, the catalog task
"Eval harness: rate sort functions" with scripted variants, `codemode-chat/tests/harness.test.ts`. What it settles,
before the text below:

- **The harness never holds the candidate.** It is `async function rate()` with one tool, `tools.run({ args })`, which
  runs the implementation under test in a fresh sandbox of its own and returns `{ value, ms }` or `{ error }`. A
  candidate cannot patch the harness's globals, and the harness cannot recognise a variant by its source text.
- **Good and bad, shown and hidden.** The task brings good implementations (the reference first) and bad ones (sorts
  as text, knows the examples by heart, bubble sort); further good and bad ones are hidden like a tools task's holdout
  (`portableTask` strips them, `restoreTask` brings them back). Of a hidden one the verdict says only whether it was
  ordered right: no score, no runs, no error text, since a harness could encode what it saw in the number it returns. The hidden ones are
  rated only when the shown ones are ordered right. Correct: every good one scores strictly higher than every bad one.
- **Fixed before it grades.** The implementations are part of the task, written before any harness: the second rule
  below holds by construction. Using a winning harness as the judge of another task is not part of this step.
- **Speed without a clock of the judge's.** Times differ by machine, so a slow variant is told apart by comparison
  with something the harness times itself (the scripted harness times its own merge sort; the quadratic variants take
  8 to 20 times as long at 2000 numbers). A test judges it repeatedly, two at a time, and expects the same verdict.
- **Points.** Every run costs one point (at most 40 per implementation); points and time count the shown
  implementations only (the hidden ones would be a channel too). The fewest points win, then rate()'s own time. ▶ runs a harness against the reference only.

The result of the task is a judging script `(candidate, tools) => score` for a stated goal. It counts only if:

- it ranks a known good reference above several seeded bad variants that the task brings (wrong, slow, hard-coded);
- it is fixed before the solutions it grades are judged, so a team never grades its own work.

This generalises today's verifier agent: the verifier writes a predicate per case, a harness writes a whole score.

The judge runs the harness in a fresh sandbox of its own, as the check rule does today.

## D. Durable runs (last)

Status (2026-11-06): built: `codemode-chat/server/durable-run.ts`, `judgeDurableBot` in `judge.ts`, the log in the
space in `judge-host.ts`, `keep` and keyed calls in the arena (`spaces-mmo/server/arena.ts`), the catalog task "Tide
bot" and `codemode-chat/tests/durable-bots.test.ts` (with a judge process killed in the middle of a run). What it
settles, before the text below:

- **The use case is a day, not a week.** In the world as it is, driftwood burns 10 minutes, a fire holds at most 2 hours
  and the tide brings 8 to 15 pieces a world day to the Graue Bucht (measured in three arena worlds); other fuel comes
  only from traders, whose processes do not run in the arena. "Keep the fire burning for a week" cannot be reached.
  The task is "put 6 pieces of driftwood into the beacon within one world day": about 50 to 100 calls, 14 s against the
  real arena, long enough to kill a judge in the middle.
- **The world outlives the judge; it is not seeded.** The weather draws on the engine's own randomness, so a lost world
  cannot be rebuilt. A durable run opens its world with `keep: true` (it survives its connection, bounded by the idle
  TTL; the judge asks for its transaction lease plus a minute, at most an hour, since a dead judge's candidate is back
  only after that lease), and the head of the log names it. A world the arena lost starts the run afresh.
- **The log's own trouble is no verdict.** A log that cannot be read or written gives the candidate back, as an arena
  that is down does.
- **Keyed calls.** Every look/act/wait carries `<seed>:<call id>`; the arena answers a key it has seen from memory. The
  call that reached the world but not the log before the death is therefore not carried out twice.
- **The log.** `BotRun` (seed, start time, the VM's fingerprint, the world) and `BotCall` (seq, call id, name, args, the
  clock, the outcome) are written outside the judge's transaction, before the answer is delivered, and taken away once
  the verdict is stored. A run whose calls or fingerprint do not match its log starts afresh in a new world, once.
- **The clock.** The VM reads the `now` of each answer; live answers carry the wall clock minus the time the run was
  down, so the bot's time and its time limit count only the time it ran.
- **Deaths.** A candidate fails after two judge deaths only when they made no progress (its log did not grow).

Scripts that run over hours or many world days and survive a dead judge:

- every tool answer is logged in the space as a `CodeCall` entry `(candidateId, n, call, answer)`;
- after a crash, another judge starts the same script with the same `seed` and `startedAt` and replays the logged
  answers through `deliver()`;
- the `onStarted` fingerprint is checked against the logged one before it goes on.

### The use case

The use case must meet three criteria:

1. it runs long enough that a crash in the middle is real, and it can be forced in a test (a kill, as in
   `tests/perf/handover-live.ts`);
2. its tool answers can be logged and replayed with the same seed;
3. it runs in tests without a network or a model.

The candidate is a Leuchtfeuer bot over many in-game days, "keep your island's fire burning for a week", in an arena
world. It meets all three, and it combines B with D.

Pi's vacation planner demo is the outside reference: subagents that survive a process kill.

## Order

1. A: tools in the judge, dataset entries, the verdict with calls/cost/score, one data task as a built-in example,
   tests.
2. A: page (upload, tile with cost) and agent prompts.
3. B: arena process on the spaces-mmo side, `look`/`act`/`wait` tools, one built-in bot task.
4. C: harness tasks on top of the verifier.
5. D: the call log and replay, with the long-running bot task and a kill test.

Typecheck and tests after each step (`npm --prefix codemode-chat run typecheck`, `npm run test:codemode-chat`; for B
also `npm --prefix spaces-mmo run typecheck` and its tests).
