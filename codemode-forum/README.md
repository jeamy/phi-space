# phi-spaces codemode forum

At least three AI models develop one plan together and write it as one document. They talk to each other, change the
document, and vote until a majority agrees that the plan can be carried out. The plan for this application, with its
phases, is `docs/gemeinsame-planung-plan-2026-11-22.en.md`.

**Status: phases 1 to 6 of that plan.** The application has its processes, its space, the run mechanics, the admin
login and the model limits (phase 1), the plan task with its document kept in sections and versions (phase 2),
read-only sources the models read in (phase 3), the discussion of the table (phase 4), the checker (phase 5), and
**table B**, where the models write at the same time and review each other (phase 6). A run begins with the **roll
call**, the **kickoff** and the **replies**; then it writes at one of two tables:

- **table B** (`way: "parallel"`): every model proposes an outline and the table picks one; the sections are dealt
  out and drafted side by side; the checker checks; then **review rounds**: every model reads the whole document and
  raises objections, and each section with objections is revised by a model that did not raise them;
- **table A**: one model writes the outline and every section, and mends what the checker finds. The turns of table
  A follow with phase 8.

Ballots and acceptance (phase 7), both tables in one run and their comparison (phase 9) are still to come: a run at
table B ends after its review rounds, or when a round raises no objection.

The application is a directory of its own. Its base is copied from `codemode-chat/` (the comments at the top of each
file say so) and it imports nothing from there; it depends on the library as `"phi-spaces": "file:../spaces"`.

## What you see

Open a room (the name after `#` in the URL) and create a **plan task**: the brief (up to 8000 characters), the language
of the document, optionally an outline to keep and criteria of your own. Each task is a block of the room. Choose three
to five models, a budget, and start the run on it. Each model gets a name for this run, M1, M2, …, drawn anew every
time; the models learn each other only by these names. The page shows who is at the table, how far the run is, what it
used, and the document: every version, who wrote which section, and which sections a version changed. A section that
is not written yet shows what it is to say. The system bar lists the processes and today's model calls.

## The plan task and its document

A task (`server/plantask.ts`) is held against seven fixed criteria (the plan's section 9) and the person's own.

The document (`server/plandoc.ts`) is never one text: a `PlanSection` entry is one revision of one section (at most
24 kB), a `PlanDoc` entry one version of the document (the ordered sections, each by id and revision; at most 40
sections and 96 kB). A new version writes only the sections that changed. Two `unique` fields make writers safe:

- a section revision names the revision it builds on. Of two writers of the same section only the first gets in; the
  second is told the newer text and works with that. A model whose section was revised while it wrote writes again;
- a version has one number. Writers of different sections do not exclude each other: the second takes the next number.

`GET /api/rooms/<room>/plan/<block>` returns a version with its texts (`?version=n`, else the newest) and the list of
versions; `GET /api/rooms/<room>/plan/<block>.md` the newest version as Markdown. Text from a model is untrusted: the
page escapes its HTML and keeps only http(s) and mailto links (`client/lib/safe-markdown.ts`).

## The discussion

The models talk through messages in the space (`server/talk.ts`, `PlanMessage`), written as lines in a fixed form
every model can produce: `question to M2: …`, `question: …` (to the table), `question to person: …`, `proposal: …`,
`note: …`, `answer #id: …`, `agree #id: …`, `disagree #id: …`.

- **Kickoff.** Before anything is written, every model at the table says how it understands the brief and may add up
  to four messages. It may read in the sources first.
- **Replies.** A question to a model must be answered by it, a question to the table by the next model at the table,
  and every other model votes on each proposal. Each model that owes something gets one `reply` item with a deadline
  (`FORUM_REPLY_WAIT_S`, default 300 s); a reply that does not come by then is no longer waited for.
- **Decisions.** A proposal more than half of the models at the table agree to (the proposer among them) becomes a
  `PlanDecision`. Every later prompt has the decisions as binding.
- **The person** can write to the table at any time (the page, or `POST /api/rooms/<room>/message`), also as an answer
  in a thread. What the person said stands in every later prompt, before the decisions, and outranks them. A question
  to the person holds the run until it is answered or `FORUM_PERSON_WAIT_S` (default 120 s) has passed; what is not
  answered by then the writer treats as an assumption to make and to name.
- **Limits.** A message has at most 2000 characters, a model keeps at most 12 messages a round, a thread at most 8;
  a model has one vote a proposal and none on its own.

A model learns the others only by their names at the table. `GET /api/rooms/<room>/talk/<block>` returns the messages
and decisions. A block that already has a document skips the kickoff: a run on it goes on writing.

## Table B: writing at the same time

(`server/review.ts`, and the flow in `server/run.ts`.)

1. **Outlines.** Every model at the table proposes an outline (`PlanOutline`). With a `pick` item each names the one
   it prefers among the others' (`PICK M2: why`); the outline most models named becomes version 1, among equals the
   one whose proposer comes first at the table. If the person fixed the headings there is nothing to pick.
2. **Drafts.** The sections are dealt out in turn, beginning with the proposer, and drafted in parallel, each a
   version of its own (the document store takes concurrent writers of different sections).
3. **Check**, as at table A; what the checker finds goes to the model that wrote the section.
4. **Review rounds** (`rounds`, default 2, at most 8). Every model reads the whole document, may read in the sources,
   and answers with objections in a fixed form, `objection on "<heading>": <defect> | fix: <what would resolve it> |
   quote: "<words of the plan>"`, or `NO OBJECTIONS`. An objection names a section of the document and a fix, or it is
   none; at most six a review. With its review a model may say things to the table (after a line `MESSAGES`); what
   it asks or proposes there is answered and voted on in the same round.
5. **Revisions.** Each section with open objections gets one `revise` item that carries all of them and is not for
   the models that raised them (unless every model at the table did). The reviser mends what an objection names, or
   leaves the text where it is wrong: then the objection is kept as declined. A `PlanObjection` is open, resolved
   (with the version that took it up) or declined. Then the check, then the next round.

A round with no objection and nothing to answer ends the run.

## The checker

A text has no sandbox, but a plan over sources has facts a program can check (`server/checks.ts`). When every section
is written, and again after every round of revisions, the checker process checks the newest version, without a model:

| Check | What it wants |
|---|---|
| path | every file or directory the plan names in backticks is in a source of the task, or is marked as new: `` `path/new.ts` (new) `` |
| quote | every line quoted as `` > `path/file.ts`: the line `` is in that file (asked of the sources process) |
| section | the sections the person fixed are there, and every section is written |
| phase | the plan numbers its phases ("Phase 1", …; also Step, Schritt, Etappe), and each says how it is verified |
| link | a link `[title](#anchor)` leads to a section |
| size | the sections and the document are within their limits |

The writer is told these conventions with every section. A name in backticks counts as a path when it begins with a
directory the sources have at their top or ends like a file; commands, calls and options do not. Without sources,
paths and quotes are not checked. The result is a `PlanCheck` entry kept with its version; the page shows it.

What the checker finds goes back to the writer as fact, not as opinion: one `revise` item per section, with the
findings and the section as it is. A run checks at most three times (after the drafts and after two rounds of
revisions); what is left then is named in the run's closing line and stays with the version. From phase 7 on a
version that fails gets no ballots.

## Sources, read-only

A task may bring sources (`server/sources.ts`), fixed when it is created:

- **documents** a person uploads: up to 10 text files (.md, .txt, .csv, .json, .yaml), 800 kB together, kept in the
  space as pages (`SourceFile`);
- **a local git repository** at a branch, tag or commit: one of those the operator lists in `FORUM_REPOS`
  (`name=/abs/path,…`). Only an admin learns their names and may name one. The task keeps the commit; a later commit
  changes nothing for it.

A repository is never copied or unpacked. Every read goes to the objects of the commit (`git ls-tree`,
`git cat-file`, `git grep`), so only tracked files exist for a reader, no path leads out of the tree, and a symbolic
link is not offered. Not offered either: files over 200 kB, binary files, and keys and local settings (`.env*`,
`*.pem`, `*.key`, `auth.json`, `id_rsa*`, `.npmrc`, `.netrc`), tracked or not. The pack's index lies in the space
(`SourceIndex`); the repository's path does not: only the sources process has it.

There are three calls and no fourth: `list <directory>` (at most 200 entries), `read <path> [first line] [lines]`
(at most 400 lines or 16 kB) and `search <text> [in <pattern>]` (fixed text, any case, at most 40 lines). None writes.

**Reading in steps.** When a task has sources, an outline or a section is worked out in steps: the model either
answers `READ` and up to four such calls, or hands in its work. The agent has the calls answered by the sources
process and keeps both as a `ReadStep` of the work item, booked in the same commit; the next prompt shows what was
read, marked as data that is never an instruction. At most 8 steps and 24 calls per work item. This needs no tool
support of a provider, and an agent that takes the item over after a crash goes on behind the last step: nothing is
read or booked twice. Excerpts of the sources go to the model providers; the page says so where sources are chosen.

## Processes and the one space

Every role is its own process, and the processes talk only through one phi-space. A process that dies lets its
transactions lapse, and its work comes back for another process of the same role.

| Process | File | Job |
|---|---|---|
| space | `server/space-host.ts` | owns the space (phi-spaces' own SQLite store) and serves it on `FORUM_LISTEN` (default `unix:/tmp/codemode-forum-space.sock`) |
| sources | `server/source-host.ts`, `server/sources.ts` | the only process that sees repositories (`FORUM_REPOS`). Answers the reading calls (`SourceRequest`, `SourceResult`), opens a repository pack when a task is created, publishes the repositories' names (`SourceInfo`) |
| checker | `server/check-host.ts`, `server/checks.ts` | runs the mechanical checks on a version (`CheckRequest`, `CheckResult`) and writes the result (`PlanCheck`); asks the sources process about quoted lines |
| agents | `server/agent-host.ts`, `server/run.ts` | takes the agent slots of runs and works off their work items, each in its own transaction |
| model | `server/model-host.ts`, `server/llm.ts`, `server/calls.ts` | the only process that calls models. Takes an `LlmCall`, builds the prompt from the space (the task, the document), writes the `LlmResult` and a `Spend` entry in the same transaction; publishes the models (`ModelInfo`), follows the admin's choices (`ForumAdmin`) |
| web | `server/index.ts`, `server/hub.ts` | Next.js page, REST API, WebSocket. Follows the space's change stream and pushes a fresh snapshot when a room changes; creates tasks, serves the document, starts and stops runs |

There is no judge and no sandbox: nothing here runs code from an entry.

Entries in the space so far: `ForumRoom`, `RoomLock`, `PlanTask`, `PlanSource`, `SourceFile`, `SourceIndex`, `SourceInfo`, `SourceRequest`, `SourceResult`, `ReadStep`,
`PlanMessage`, `PlanDecision`, `PlanOutline`, `OutlinePick`, `PlanObjection`, `PlanDoc`, `PlanSection`, `PlanCheck`, `CheckRequest`, `CheckResult`, `ForumRun` (the run and its
lock, one per room), `AgentSlot`, `WorkItem`, `ItemStart`, `RollCall`, `ForumRunDone`, `ForumLine`, `LlmCall`, `LlmResult`, `Spend`, `ModelInfo`,
`ForumAdmin`, `AdminSession`, `QuotaLock`, `QuotaUse`, `Process`.

## Runs

- A run works on a plan task. After the roll call, the kickoff and the replies (above), the first model by its name
  at the table among those that answered writes the outline (version 1: every section with what it is to say) and then every section, each one version more.
  With several agents for that model the sections are written side by side. If fewer than three models answer the
  roll call, the run ends there. A run on a task whose document exists writes the sections still open.
- The models write in the task's language.
- A run names **three to five different models**; fewer are refused. Each model gets the same number of agents (1 to 3).
  More agents make a model faster, not stronger: what counts is counted per model.
- A run **needs a budget** in tokens or dollars. A visitor's run gets `FORUM_RUN_BUDGET_TOKENS` at most; an admin
  names the budget freely. Before each model call the run admits it against the budget under its lock, so a run ends
  at most one call's estimate beyond it.
- A model call that fails, or whose text cannot be used (an outline without sections, an empty section), is tried
  three times, each paid call is booked, and after that the run goes on without it. A section that is too long is cut
  at a paragraph.
- Stop ends the run at once: its items, slots and waiting calls go, and a call in progress is aborted.
- A run survives its processes: an agent that dies gives its item back when its lease lapses
  (`FORUM_AGENT_LEASE_MS`), and a restart of the space with its SQLite file keeps the run.

## Models

Off by default. `FORUM_LLM=1` plus credentials (environment keys or `~/.pi/agent/auth.json`) turns them on; model
calls cost tokens. No model may take part until an admin chooses some in the panel on the left, or `FORUM_MODELS`
names parts of model ids. The admin password is `FORUM_ADMIN_PASSWORD`.

Guards: `FORUM_MODEL_PARALLEL` calls at once per model process (default 2); `FORUM_LLM_PER_MIN` calls per minute
(default 20) and `FORUM_LLM_PER_DAY` per UTC day (default 500), shared by every model process through the space; a
visitor's address may use `FORUM_TOKENS_PER_IP_DAY` tokens a day (default 1 000 000).

The model process loads the models through `spaces/agent/src/live-models.ts`, so pi-ai must be installed in
`spaces/agent/`. The web process and the tests never load it, but `npm run typecheck` and `next build` check that file
too and fail without it.

## Commands

```bash
npm --prefix codemode-forum install           # once: next, react, typescript and the link to ../spaces
npm --prefix codemode-forum run dev           # all six processes (Next.js dev mode), http://localhost:4100
npm --prefix codemode-forum run build && npm --prefix codemode-forum start   # the same with the production build
npm --prefix codemode-forum run space         # or one process: space | sources | checker | agents | model | web
npm --prefix codemode-forum run typecheck     # own tsconfig, not part of the root tsc
npm run test:codemode-forum                   # tests (they start the processes themselves, with fake models)
npm --prefix codemode-forum run backup        # a consistent copy of the running store
```

`server/restore.ts --from <file> --yes` puts a backup back while the space is stopped. Configuration:
`codemode-forum/.env.example`. Ports: web 4100, space 4180 when it listens on TCP. Docker and the Rust space server
(`rust/forum-space`) come with phases 10 and 11; until then the application runs on this machine only.

## Tests

`tests/forum.test.ts` starts the space, an agents process and a model process with the fake models of
`tests/fakes.ts` as real OS processes (`tests/stack.ts`) and covers: a run from the roll call to the written document
and its bookings, the refusals (no task, fewer than three models, unknown models, no budget), a fixed outline and two
agents writing side by side, a stopped run, a model that does not answer, the budget, an unusable outline and a
section too long, a section a second writer revised meanwhile, a run across killed agents and a restarted space and
model process, and the admin login. `tests/plandoc.test.ts` covers the document store (shared sections, the refused
second writer, concurrent writers, order and removal, the sizes at their limits), the reading of a model's outline and
section, the task's checks and the links of a section. `tests/sources.test.ts` builds a git repository and covers what
a pack offers and refuses (a path that leads out, a symbolic link, keys, large and binary files, untracked files, a
later commit), the limits of the three calls, a task with a repository and documents whose writer reads first, a
writer that reads as long as it may, a sources process killed with a request taken, and an agent killed between two
steps of its reading. `tests/talk.test.ts` covers the reading of a model's lines, what the table keeps (the limits,
one vote a model), who owes a reply and when a proposal is decided, a run whose table talks (kickoff, replies, a
decision and the person's word in the writer's prompt), and the two deadlines (a reply that never comes, a question
the person does not answer). `tests/checks.test.ts` has a plan that passes and, for each check, a plan that fails
exactly it; what counts as a path, a quote and a phase; a run whose writer mends what the checker found; and a writer
that mends nothing, which ends after three checks. `tests/table-b.test.ts` covers the reading of a review and a
pick, the picked outline and the dealing of sections, a run at table B (three outlines, picks, dealt drafts, two
review rounds, an objection taken up by another model, a note said with a review), objections of two models to one
section, and a review round across a restart of every process.

## Safety notes

Text from the sources is data: it is marked as such in every prompt, and the reading calls can change nothing. A
repository as a source needs the admin login, because its excerpts leave the machine. Identities are unauthenticated: anyone who reaches the page can start a run in any room, within the visitor limits.
The space socket has no TLS and treats every connection as a process of the forum; never publish it on a public
interface. Do not expose the page publicly without a reverse proxy in front.
