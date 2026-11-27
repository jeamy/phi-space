# phi-spaces codemode forum

At least three AI models develop one plan together and write it as one document. They talk to each other, change the
document, and vote until a majority agrees that the plan can be carried out. The plan for this application, with its
phases, is `docs/gemeinsame-planung-plan-2026-11-22.en.md`.

**Status: phases 1 to 11 of that plan.** The first runs with real models (phase 0, and phase 12 as far as it got) and what they changed are in
`docs/live-runs-2026-11-23.en.md`; `tests/live/run.ts` makes one such run against a running stack (it costs tokens),
`tests/live/collect.ts` and `tests/live/report.ts` make the results page of the runs from the space. The application has its processes, its space, the run mechanics, the admin
login and the model limits (phase 1), the plan task with its document kept in sections and versions (phase 2),
read-only sources the models read in (phase 3), the discussion of the table (phase 4), the checker (phase 5), table
B, where the models write at the same time (phase 6), **ballots**: the table changes the plan until a majority of
the models agrees that it can be carried out (phase 7), table A, where the models take turns (phase 8), and **both
tables in one run**: the two ways of working compete, and the better document is the base of the result (phase 9).
The page shows the difference between versions, both documents side by side, the comparison and the standings; the
result is exported with a generated appendix; there are help pages in German and English and a Docker test bed on
this machine (phase 10). The space process has a Rust implementation of its own, `rust/forum-space`, and a task may
read in a **remote repository** fetched over https from a host the operator allowed (phase 11). A run begins with the **roll call**, the **kickoff** and the
**replies**; then it writes at one of two tables:

- **table B** (`way: "parallel"`): every model proposes an outline and the table picks one; the sections are dealt
  out and drafted side by side; the checker checks; then rounds of **ballots**: every model votes on the version and
  raises its objections, each section with objections is revised by a model that did not raise them, until a majority
  approves, the rounds are used up, or the table is stuck and asks the person;
- **table A** (`way: "turns"`): one model writes the outline and every section; then the **turn** goes round the
  table: whoever has it reads the whole document, objects, and revises the sections concerned itself, with what the
  others objected to; after the turns of a round every model writes its ballot. Without a `way` a run writes the
  first draft only (no turns, no ballots).

A run with `way: "both"` (the page's default) sets up both tables at the same time; see "Both tables in one run".

The application is a directory of its own. Its base is copied from `codemode-chat/` (the comments at the top of each
file say so) and it imports nothing from there; it depends on the library as `"phi-spaces": "file:../spaces"`.

## The page

FORUM is the page a person uses (`client/forum/`, plan `../docs/forum-seite-plan-2026-11-26.en.md`, phase 2). Its
places:

- **Rooms** (`/`): the rooms of the signed-in person with their role, the number of tasks and a state: still empty,
  resting, working, **waiting for you** (a run is stuck or a question to the person is open, also after the run has
  ended) or plan accepted (`ForumHub.summary`, in `GET /api/rooms`); creating a room; the person's ID for invitations.
  The bar counts the rooms that wait, and so does the browser tab's title.
- **A room** (`/r/<room>`): three panes, **Files** (the task's material), **Table** (the brief, a new task, the run and
  its talk with the person's answers) and **Plan** (the comparison, the document, its versions, accepting and
  objecting). Above 1100 px side by side; from 760 px Table and Plan with Files as a drawer; below 760 px one pane at a
  time with a bar of the three at the bottom, the Table's tab counting the open questions. The pane stays in the
  address (`#files`, `#table`, `#plan`), so a link leads to it.
- **Settings** (`/settings`): the name at the table, the ID, signing out, language, light or dark, the colours, and
  for each room one owns the people in it (inviting by ID, removing).
- **Help** (`/help`) and, for administrators, the **expert view** (`/expert`): the earlier page with everything at
  once, also models, providers, repository sources and the system's processes (until the administration moves to the
  page in a later phase).

Every control of the page is a wrapper of `client/forum/controls.tsx` (field, text area, choice, tick, action) with
a visible or screen-reader label and a help tip beside it (`client/lib/tips.ts`); `tests/page.test.ts` holds the page
to that, to no width above 360 px in `client/styles/page.css`, and to its routes, manifest and icon. The panes the page
shares with the expert view are in `client/panes.tsx`, the room's state in `client/lib/use-room.ts`. Screenshots in
`docs/screenshots/`, taken by `tests/screenshots.ts` (fake models, the local Keycloak, headless Chromium).

## What you see

This section describes the expert view (`/expert`, `client/App.tsx`). Open a room (the name after `#` in the URL) and create a **plan task**: the brief (up to 8000 characters), the language
of the document, optionally an outline to keep and criteria of your own. Each task is a block of the room. Choose three
to five models, a budget, and start the run on it. Each model gets a name for this run, M1, M2, …, drawn anew every
time; the models learn each other only by these names. The page shows who is at the table, how far the run is, what it
used, and the document: every version, who wrote which section, and which sections a version changed. A section that
is not written yet shows what it is to say. The system bar lists the processes and today's model calls.

Beside the document (`client/App.tsx`, `client/lib/diff.ts`):

- **versions and their difference**: choose a version and one to compare it with; every section then shows the lines
  removed and added, and inside a changed line the words that differ; unchanged sections are marked as such. The
  difference is shown as text, never as HTML;
- **both documents side by side**, when both tables have one; the tabs above choose a table or both;
- **objections beside their sections**: what still stands (open, or declined and so standing for its raiser), and how
  many are settled;
- **ballots** per round and version, with every model's rating of each criterion;
- **the comparison** after a run with both tables: the result and why, each table's rounds, use and approvals, and
  every model's blind comparison with its reasons;
- **the standings** over all runs with both tables: how often each way of working was the base of the result;
- **help** (`/help`, `client/help/articles.ts`): fifteen articles in German and English.

## The result and its export

`GET /api/plan/<room>/<block>.md` (the same under `/api/rooms/<room>/plan/<block>.md`) returns the result as
Markdown (`server/export.ts`). Which version that is: the one a person accepted (their word is final); else the result
of the newest run with both tables; else the version a table accepted; else the newest draft, and the export says that
nobody accepted it. `?table=` and `?version=` name another version, `?plain=1` leaves the appendix out.

After the plan comes an **appendix a program generates** from the entries of the run, in the language of the task; no
model writes it: the brief and the criteria, the sources with their commit, the models under their names at the table,
which version this is and who accepted it, the way of working and, after a run with both tables, the base and why,
the final round and each table's numbers, the sections taken over from the other table, the table's decisions, the
questions to the person that stayed unanswered (the assumptions), every ballot, the objections still standing with
who holds them, the notes, and the cost. The appendix begins after a line with a fixed marker, so what is before it
is the plan and nothing else.

```bash
node --experimental-strip-types codemode-forum/server/export-plan.ts --room <room> --block <id> --out docs/plan.md
```

writes the same to a file (`--table`, `--version`, `--plain` as above; `--space` names another space). A person runs
it: no process of the forum writes into a repository.

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
4. **Rounds of ballots** (`rounds`, default 2, at most 8; see "When a plan counts as agreed"). Every model reads the
   whole document, may read in the sources, and with its ballot raises objections in a fixed form, `objection on "<heading>": <defect> | fix: <what would resolve it> |
   quote: "<words of the plan>"`, or `NO OBJECTIONS`. An objection names a section of the document and a fix, or it is
   none; at most six a review. With its review a model may say things to the table (after a line `MESSAGES`); what
   it asks or proposes there is answered and voted on in the same round.
5. **Revisions.** Each section with open objections gets one `revise` item that carries all of them and is not for
   the models that raised them (unless every model at the table did). The reviser mends what an objection names, or
   leaves the text where it is wrong: then the objection is kept as declined. A `PlanObjection` is open, resolved
   (with the version that took it up) or declined. Then the check, then the next round.

The rounds end when the table has agreed, when they are used up, or when the table is stuck.

## Table A: taking turns

(`way: "turns"`; the flow in `server/run.ts`.)

1. **First draft.** The first model at the table writes the outline and every section; the checker checks, and what
   it finds goes back to that model.
2. **The turn** (`turn`, a work item only the agents of one model take). In the first round it goes to the others in
   their order at the table (the first draft was the writer's turn), in later rounds to everybody. The model that has
   it reads the whole document, may read in the sources, and answers with objections in the form of table B or
   `NO OBJECTIONS`; it may add messages for the table. For every section with an open objection, its own new ones
   and those the others raised in their ballots, it gets a `revise` item of its own: it mends the section, or leaves
   it where an objection of another model is wrong (declined; an objection of its own it leaves unmended counts as
   withdrawn). Then the checker checks, what it finds goes to the model that revised the section, and the turn
   passes on.
3. **A turn nobody takes** passes on: a turn and each of its revisions has `FORUM_TURN_WAIT_S` (default 600 s). After
   that, or when its model fails three times, the run's note says so and the next model has the turn; objections
   left unrevised stay open for it.
4. **Ballots.** When every model had the turn, all of them vote on the version as at table B (next section). What a
   ballot objects to is not dealt out: it waits for the turns of the next round. From the second round on a model
   whose last ballot counts as an approval is passed over while no objection is open.

The rounds (`rounds`, default 2, at most 8) end as at table B: the table has agreed, the rounds are used up, the
version fails the checks, or the table is stuck and asks the person.

## Both tables in one run

(`way: "both"`; `server/compare.ts`, and the flow in `server/run.ts`.) The run itself waits; each table is a run of
its own (`TableRun`, run id `<run>-A` and `<run>-B`) with all models, its own roll call, kickoff, discussion,
document and agents, on **45 % of the budget** each. They work at the same time.

1. **Exchange.** A review (table B) and a turn (table A) show the other table's document as it stood after its last
   round, with that table's decisions and open objections, as reading material. A model may propose to its own table
   `proposal: take over "<heading there>" into "<heading here>": why`. It is decided like any proposal; once decided,
   the section is revised with the other section as material, no reviser can decline it, and the new revision names
   its origin (`origin`: table, version, section). Messages do not cross tables.
2. **Who is first.** When one table has agreed, the other finishes the round it is in and begins no other (its first
   round it has in any case).
3. **Blind comparison.** When both are through and there are two documents, every model compares them as "X" and
   "Y", without table or author (which table is X changes from model to model): `PREFER: X`, a reason per criterion,
   and what each does better than the other, `better Y: what | from: "<heading in Y>" | into: "<heading in X>"`
   (`PlanCompare`). The **base** is the only table that agreed; if both or neither did, the document more models
   prefer; among equals the table that spent less.
4. **Joint final round** (`<run>-F`). What the other document does better (at most six points, one per pair of
   sections) becomes proposals at the base's table; every model votes; the agreed ones are worked into the base, each
   revision naming its origin; the checker checks; then one round of ballots. If it agrees, that version is the
   **result** (`PlanResult`); if not, the base as it was stays the result, and the later versions stay in the
   document's history.
5. Every such run leaves a `PlanStrategyStat` (rounds, cost and approvals per table, the base and why, the final
   round, the result). The page shows the standings over all runs: how often each table was the base.

With one document only, that one is the result; without budget for the comparison, the table that agreed, else the
cheaper one. Stopping the run stops its tables.

## When a plan counts as agreed

(`server/ballots.ts`.) In every round each model at the table writes **one ballot** on the newest version; a model
has one vote however many agents it has. A ballot says `BALLOT: APPROVE` or `REJECT`, rates every criterion, says
what became of the model's earlier objections, and raises new ones.

**An approval counts** only when the ballot rates every criterion as met and gives for each words that are in the
plan (at least three, checked by the program), raises no objection, and none of the model's own objections still
stands. An approval without that evidence is kept, with the reason why it does not count.

**A version is accepted** (`PlanAccept`) when

- more than half of the models at the table approve it; a model that owes the table an answer does not count yet;
- approval is not the authors' alone: of the sections that changed since the last round of ballots, at least one
  approving model wrote none; in the first round, where every section is new, each section needs an approver who did
  not write it;
- the version passes the checks (one that fails gets no ballots), and nothing the person objected to is open.

**Objections** are a ledger: open; resolved by a revision; then confirmed, opened again or withdrawn by the one who
raised it, with its next ballot; declined when the reviser left the section as it was. A declined objection stands
for the model that raised it (its ballot cannot count until it withdraws) and for nobody else.

**Against moving targets:** from the third round on a new objection blocks only against a section that changed
since the model's last ballot. Against any other section it is kept as a note.

**When the table is stuck** (two rounds end with the same objections standing and no more approvals, or there is no
majority and nothing to revise), it asks the person and waits `FORUM_PERSON_WAIT_S`; with their answer it goes on,
without one the run ends there. A run also ends when its rounds are used up without a majority.

**The person has the last word.** `POST /api/rooms/<room>/accept` accepts a version, whatever the table said.
`POST /api/rooms/<room>/objection` objects to a section: no reviser can decline it, and the table accepts nothing
while it is open. Stop ends the run.

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


**Remote repositories** (`server/remote.ts`): an admin may name an https address instead (`repo: { url, ref }`) when
its host is in `FORUM_GIT_HOSTS` of the sources process (empty: off). The sources process fetches it once, when the
task is created: one commit, shallow, without tags and submodules, into a bare repository of its cache
(`FORUM_GIT_CACHE`), and from then on reads it like a local one, from the objects of that commit. Nothing is checked
out, so no hook and no filter runs. The fetch uses https only, follows no redirect, neither asks for nor sends
credentials, does not read the machine's or the user's git configuration, takes at most `FORUM_GIT_TIMEOUT_S` (60 s)
and brings at most `FORUM_GIT_MAX_MB` (200 MB); one that passes a limit is killed and removed. A sources process that
no longer has the commit in its cache fetches it again by its id, while the host is still allowed (a server that does
not hand out a commit by its id then leaves the source unreadable; the task says so). The page offers the field to an
admin when a sources process allows a host.

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
`PlanMessage`, `PlanDecision`, `PlanOutline`, `OutlinePick`, `PlanObjection`, `PlanBallot`, `PlanAccept`, `PlanDoc`, `PlanSection`, `PlanCheck`, `CheckRequest`, `CheckResult`, `ForumRun` (the run and its
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
npm --prefix codemode-forum run docker:image  # the image (typecheck and build inside)
npm --prefix codemode-forum run docker:local:up     # one container per role on this machine, http://localhost:4110
npm --prefix codemode-forum run docker:local:logs   # … :down stops them; docker:test runs the suite in a container
```

`server/restore.ts --from <file> --yes` puts a backup back while the space is stopped. Configuration:
`codemode-forum/.env.example`. Ports: web 4100, space 4180 when it listens on TCP.

**Docker** (`docker/Dockerfile`, `docker/docker-compose.yml`, taken over from codemode-chat): one image, one container
per role. The local test bed (`docker:local:up`, compose project `phi-spaces-forum-local`) runs the space and the
checker as host "nano" and web, agents, model and sources as host "big", over TCP as between two machines; it
publishes the page on 4110 and the space on 4190, both on loopback. The repositories a task may read in are mounted
read-only into the sources container only, whose file system is read-only as well: `FORUM_REPOS_DIR` is the directory
on this machine, `FORUM_DOCKER_REPOS` names the repositories as the container sees them
(`FORUM_REPOS_DIR=/home/me/src FORUM_DOCKER_REPOS=phi-space=/repos/phi-space`). The scripts read
`codemode-forum/.env` when there is one.

**The Rust space server** (`rust/forum-space`, a workspace of its own on the core's `phi-space-host`, like
`codemode-space` of codemode-chat): the same environment, the same ready line, the same store file as
`server/space-host.ts`.

```bash
cd codemode-forum/rust && cargo build --release && cargo test && cargo clippy --all-targets
FORUM_SPACE_SERVER=rust/target/release/forum-space npm run test:codemode-forum   # the suite against it
FORUM_SPACE_SERVER=rust/target/release/forum-space npm --prefix codemode-forum start
npm --prefix codemode-forum run docker:image:rust && npm --prefix codemode-forum run docker:rust:up   # the test bed with it
```

`FORUM_SPACE_SERVER` names the binary (relative to `codemode-forum/`); one that is not there ends the start, it never
falls back. `docker/docker-compose.rust.yml` lays the binary over the space container. big and nano run only the Rust
implementation (R-D12), so the scripts for a server are `docker:nano:rust:up` (space and checker) and `docker:big:up`
(web, agents, model, sources; `FORUM_DOCKER_SPACE` names nano's space); `docker:nano:up` refuses. Since 2026-11-27 the forum runs
on them (phase 3 of docs/forum-seite-plan-2026-11-26.en.md, models off): the space and checker on nano on
127.0.0.1:4180, reached from big through the user unit `forum-nano-tunnel` (`docker/forum-nano-tunnel.service`); web,
agents, model and sources on big on the host network (`docker/docker-compose.hostnet.yml`, the page on 127.0.0.1:4100)
behind the nginx site `https://codeforum.eibrain.org` (`docker/nginx-codeforum.conf`); the sign-in at
`https://id.eibrain.org`, Keycloak in the compose project `phi-idp` on big (`idp/server.sh`, `idp/nginx-id.conf`,
idp/README.md "On big"). The daily backup is `deploy/forum-backup.sh` with its systemd units on both hosts (the
space's store on nano, Keycloak's dump on big, each host holding both in `~/phi-backup/forum`). An update is
`git pull --ff-only` and the host's script; the help's operations article has the same in short.

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
section, and a round across a restart of every process. `tests/ballots.test.ts` covers the reading of a ballot and
when it counts, the tally (a majority of the models, not of the authors alone, nothing of the person open) and the
stall rule, and runs in which everybody approves (three agents a model, three ballots), approvals come without
evidence, an objection is declined, an objection comes too late against an unchanged section, the table is stuck and
goes on with the person's answer, and the person objects and accepts. `tests/table-a.test.ts` covers table A: the
turn going round the table before the ballots, a model that revises what it objects to in its turn and takes up what
the others objected to (and one that is passed over), a turn nobody takes in time, and an agents process killed in
the middle of a turn. `tests/both.test.ts` covers runs with both tables: the reading of a comparison, the base and
the points for the final round; a run in which both tables agree, the models compare blind and the final round takes
over two sections that name their origin; a final round that does not agree, which leaves the base as the result; a
table that takes over a section of the other, which agreed first, and then begins no further round; the tables'
shares of the budget; and a stopped run, which takes its tables with it. `tests/export.test.ts` covers the
difference between two texts (lines, the words inside a changed line, the cut of long unchanged stretches); the export
of a run with both tables, which equals the result text for text, with its appendix, the same through both addresses
and through `server/export-plan.ts`, and what the page is told of the comparison; the export after a failed final
round (the base, not the newest version), a German task with a German appendix and a declined objection named with
who holds it, and a version the person accepted. `tests/remote.test.ts` covers remote repositories against a git server on
this machine (`git http-backend` behind a small bridge): the addresses that are refused (another protocol, a user or
password, a host that is not allowed, which is never contacted), a redirect that is not followed, a branch that is
not there, a task whose repository is fetched once into a bare, shallow cache and read like a local one, a sources
process that lost its cache and fetches the task's commit again (and does not once the host is off the list), and a
repository that is too large and a server that is too slow, of which nothing stays. `tests/space-server.test.ts`
covers the switch to the Rust space server. `tests/page.test.ts` holds the FORUM page to its controls with label and
tip, its widths and its routes; `tests/auth.test.ts`, `tests/forum.test.ts` and `tests/talk.test.ts` also check the
rooms' states in the list. `tests/help.test.ts` holds the help articles to both languages, the
same anchors in each, and links that lead somewhere.

## Sign-in

`FORUM_LOGIN=oidc` puts the forum behind an OpenID provider (`server/auth.ts`, `server/oidc.ts`, a copy of spaces-files'
kept equal by `checks/shared-copies.test.mjs`; `docs/forum-seite-plan-2026-11-26.en.md`, section 5). The code flow with
PKCE, state and nonce; the ID token is verified here, and a person is the pair (issuer, subject) and nothing else from
it (`ForumUser`, with a name the person sets in the header). A session is a `UserSession` entry (the hash of the
handle, leased for one hour of idleness, twelve hours at most) and the cookie `__Host-forum` (Secure, HttpOnly,
SameSite=Strict). Then:

- every `/api/` call and the WebSocket need a session (`GET /api/me` says who, with the CSRF token); a call that changes
  something also needs our origin (`FORUM_PUBLIC_ORIGIN`) and the token as `x-forum-csrf`;
- what a person writes to the table carries their name, never one from the request;
- a run's budget of the day is counted per person (`FORUM_TOKENS_PER_IP_DAY` per person instead of per address);
- administrators are named by identity (`FORUM_ADMINS`); the admin password is taken only as `x-admin-token`;
- signing out ends the session and goes on to the provider's end-session address.

Locally: `idp/` at the repository root runs Keycloak (`idp/README.md`); the realm `phi` has the client
`codemode-forum` for `http://localhost:4100`. A room belongs to the person who made it
(`server/rooms.ts`, the entry `RoomAccess`, kept for good): the owner invites others by their ID (the menu under their
name shows it) as members, who write in the room (tasks, runs, the table, accepting and objecting), or as viewers, who
read along. A room in which a person has no role does not exist for them (404 on the API, the WebSocket refused), an
administrator included; a script with `x-admin-token` passes as the owner. `GET /api/rooms` lists the person's rooms,
`POST /api/rooms {room}` makes one, `/api/rooms/<room>/access` names the people (GET for anyone in the room, POST
`{userId, role}` with `role` `member`, `viewer` or null for the owner).

## Safety notes

Text from the sources is data: it is marked as such in every prompt, and the reading calls can change nothing. A
repository as a source needs the admin login, because its excerpts leave the machine. Without `FORUM_LOGIN` identities are unauthenticated: anyone who reaches the page can start a run in any room, within the visitor limits.
The space socket has no TLS and treats every connection as a process of the forum; never publish it on a public
interface. Do not expose the page publicly without a reverse proxy in front.
