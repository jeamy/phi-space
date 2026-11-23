# codemode-forum: several models develop one plan together (plan, 2026-11-22)

Status: phases 1 to 7 implemented on 2026-11-22, phases 8 to 11 on 2026-11-23 (`codemode-forum/`, see its README); phases 0 and 12 (live runs) open. Second version,
after the decisions of 2026-11-22 (section 2).
Starting point: `codemode-chat/` and `spaces/` as of commit `87aff982`.

## 1. Goal

A person gives a brief and sources. At least three AI models develop a plan together and write it as one document.
They talk to each other while they do it: they ask, answer, propose, object and decide. They change the document
until a majority of the models agrees that the plan can be carried out sensibly. Two ways of working, taking turns
and working at the same time, run side by side, and the better one supplies the base of the result.

Two briefs the first version must handle:

- "Plan how the 3D world of spaces-mmo gets four times the resolution, and how to carry that out." Sources: a git
  repository at a commit.
- "Plan a website with these requirements." Sources: an uploaded document with the list of requirements.

The result is a Markdown document of the kind this repository keeps in `docs/` (the plan
`spaces-mmo/docs/3d-welt-und-raster-plan-2026-11-21.en.md` has 59 kB). Carrying the plan out is not part of this
work (section 14).

## 2. Decisions taken (2026-11-22)

| Decision | Consequence in this plan |
|---|---|
| At least three models take part. | A run with fewer than three distinct models is refused. One vote per model. |
| The plan is developed jointly; the agents communicate and work out the best document. | A discussion in the Space that every work item reads and writes (section 6). The two ways of working are not sealed off from each other: they exchange after every round, and the result is completed jointly (section 7). |
| Agents reach the sources they need, read-only. | A role `sources` with three reading calls and nothing else (section 8). |
| A new application `codemode-forum/` in a directory of its own with all sources it needs. codemode-chat and spaces are the starting point. | Section 3. codemode-chat is not changed and not imported. |

## 3. The new application

`codemode-forum/` sits beside `codemode-chat/`, `spaces-mmo/` and `help-site/`. It depends on the library as
`"phi-spaces": "file:../spaces"` and imports only `phi-spaces` and its exported subpaths. It copies what it needs
from codemode-chat and imports nothing from that directory; codemode-chat stays as it is.

**The name.** The application is called codemode-forum: a forum in which the models discuss a plan and vote on it. Its
variables carry the prefix `FORUM_` (codemode-chat owns `CODEMODE_*`), its socket is
`/tmp/codemode-forum-space.sock`, and it has ports of its own (web 4100, space 4180; the local Docker test bed
4110 and 4190).

**Processes.** As in codemode-chat, every role is a process and they talk only through one Space.

| Process | File | Job |
|---|---|---|
| space | `server/space-host.ts` | owns the Space (own SQLite store) and serves it on `FORUM_LISTEN` |
| web | `server/index.ts`, `server/hub.ts` | Next.js page, REST, WebSocket; creates plan tasks, starts and stops runs, follows the change stream |
| agents | `server/agent-host.ts`, `server/run.ts` | takes the agent slots of runs and works off their work items |
| model | `server/model-host.ts`, `server/llm.ts`, `server/context.ts` | the only process that calls models and holds credentials |
| sources | `server/source-host.ts` | the only process that sees repositories and files; answers reading calls |
| checker | `server/check-host.ts` | runs the mechanical checks of a document version, without a model |

There is no judge and no sandbox: nothing here runs code from an entry.

**Taken over from codemode-chat (copied, then cut down):**

| From | What stays |
|---|---|
| `server/space-host.ts`, `space-server.ts`, `space.ts`, `launch.ts`, `env.ts`, `limits.ts` | as they are, with the new prefix |
| `server/quota.ts`, `backup.ts`, `restore.ts` | as they are |
| `server/model-host.ts`, `server/llm.ts` | the guarded call, quotas, model list, admin choice, spend; the prompts are new |
| `server/agent-host.ts`, `server/run.ts` | slots, leases, work items, `pending`, three attempts, budget admission; the board's kinds are new |
| `server/hub.ts`, `server/index.ts`, `server/room.ts` | rooms, blocks, room lock, admin session, snapshots, request limits |
| `client/` | theme controls, palettes, Markdown renderer, help reader, admin panel; the page itself is new |
| `tests/stack.ts`, `tests/fakes.ts`, `tests/test-env.ts` | the process stack and the fake models |
| `docker/` | one image, one container per role, the local test bed |

**Not taken over:** judge, ▶, sandbox and pi-codemode; code, tool, data, bot and harness tasks; Jev; islands and
experiments; the durable code agent and with it pi-durable (section 8 says how reading survives a crash without it);
web search (a later step).

**Dependencies:** next, react, react-dom, phi-spaces, and pi-ai for the model process, all in the versions
codemode-chat pins. No package the repository does not already use.

**What the repository must learn about the new application** (each of these fails `npm test` otherwise):

- `checks/roots.mjs`: `APPS` gets `codemode-forum`;
- `checks/durable-imports.mjs`: its directories are scanned, pi-ai is allowed there, pi-durable and chord are not;
- `checks/shared-copies.test.mjs`: its copies of `client/lib/palettes.ts`, `client/lib/markdown.ts`, `server/env.ts`;
- `checks/package-imports.mjs`: covers it (no relative imports into `spaces/src`);
- root `package.json`: `codemode-forum`, `codemode-forum:dev`, `test:codemode-forum` (`checks/root-scripts.mjs`);
- `dashboard.apps.json`: its Space with the addresses above;
- `AGENTS.md`: commands and layout.

**Space server.** Locally and in the tests the Space is `server/space-host.ts` (TypeScript). big and nano run only
the Rust implementation (R-D12), so before any deployment the application gets a binary of its own,
`codemode-forum/rust/forum-space`, as codemode-chat has `codemode-space` (phase 11).

## 4. The task and the document

A **plan task** is the application's only task kind: a brief (up to 8000 characters), a list of sources, the
document's language, and optionally an outline to keep and criteria of the person's own.

The document is kept in the Space as versions of sections, never as one text: an entry holds at most 64 KiB and a
commit 192 KiB.

| Entry | Content |
|---|---|
| `PlanTask` | brief, language, criteria, limits; one per block |
| `PlanSource` | one source pack of the block: kind, origin, commit, number of files, bytes, hash of the index |
| `PlanDoc` | one version of a table's document: table, version, author, model, ordered section ids with the hash of each |
| `PlanSection` | one section's text (at most 24 kB), its base version, author, model, the sources it cites |
| `PlanMessage` | one contribution to the discussion (section 6) |
| `PlanDecision` | what a thread ended with, and who agreed |
| `PlanCheck` | the result of the mechanical checks of one `PlanDoc` version (section 9) |
| `PlanObjection` | section, quote, defect, what would resolve it, who, state (open, resolved, withdrawn, declined with reason) |
| `PlanBallot` | one model's vote on one `PlanDoc` version: approve or reject, the criteria with evidence |
| `PlanAccept` | the accepted version of the block, by majority or by a person |

A new version writes only the sections that changed. A section revision names the version it builds on, and
`unique` on (table, section, base version) lets only the first one in: a second writer of the same section gets its
work item back with the newer text. The whole document stays below 96 kB so that a reviewer reads it in one call.

## 5. Who takes part

- A run names three to five models. Each gets the same number of agents (default one, at most three).
- Everything that counts is counted per model: votes, turns, the limit of messages. More agents of a model make it
  faster, not stronger.
- An agent sees its own model's name and the names of the others as `M1`, `M2`, …; the mapping is drawn per run, so
  no model is treated by its reputation. The appendix of the result names them.

## 6. Communication

The agents talk through `PlanMessage` entries. A message has a thread, a kind, an author (agent and model), an
addressee (one model or all), optionally a section and a quote, and at most 2000 characters of text.

| Kind | Meaning | What must follow |
|---|---|---|
| `question` | to a model, to all, or to the person | an answer by the addressee before it may write its next ballot |
| `answer` | closes a question | nothing |
| `proposal` | a change of approach, outline or a section, with its reason | every other model answers with agree, disagree with reason, or a counter-proposal |
| `objection` | a defect; creates a `PlanObjection` | resolved, withdrawn, or declined with a reason |
| `note` | an observation, a source worth reading | nothing |

How it enters the work:

- **Kickoff.** Before any outline, every model posts how it understands the brief, what it found in the sources,
  and its questions. Questions to the person appear on the page; what the person does not answer within the
  kickoff's time is written into the document as an assumption.
- **In every work item.** The context of a draft, a revision or a review contains the open threads that concern
  its section or are addressed to its model. One model call may return the work and several messages; talking
  costs no call of its own unless a `reply` item is due.
- **Reply items.** A question or proposal addressed to a model becomes a `reply` work item only that model's agents
  take, with a deadline. Without a reply by then the thread is marked unanswered and no longer blocks.
- **Decisions.** A proposal with agreement of more than half of the models becomes a `PlanDecision`. Decisions are
  binding for later work items (they are in every context) until a new proposal overturns them the same way. The
  decisions and their reasons go into the appendix of the document.
- **The person** can write into any thread. Such a message is in every later context and outranks a decision.
- **Limits.** At most 12 messages per model and round, and a thread closes after 8 messages with a vote on the last
  proposal, so that talking cannot use up the budget.

The page shows the discussion beside the document, per section and per thread.

## 7. The two ways of working

Every run sets up two **tables**. Each table has all models, its own document and its own discussion, and half of
the run's budget.

**Table A, taking turns.** One writer at a time.

1. After the kickoff the first model (drawn at the run's start) writes the outline and the first draft.
2. The next model reviews. If it approves, it writes its ballot. If not, it writes its objections, revises the
   sections they concern in the same turn and takes the open objections of others.
3. The turn passes on. After each full cycle, every model writes a ballot on the current version.

The turn is a work item only one model takes. If nobody takes it before its deadline, it passes to the next model
and the run's note says so.

As built (phase 8): a model does not write its ballot inside its turn. In its turn it objects and revises, each
section in a work item of its own (so a section stays one model call, as everywhere else); the ballots of all follow
after the turns of the round, and what a ballot objects to waits for the turns of the next round. In the first round
the writer has no turn (the first draft was it); from the second round on a model whose ballot counts as an approval
is passed over while no objection is open, so a round costs no call that has nothing to do.

**Table B, at the same time.** Several writers at once.

1. After the kickoff every model proposes an outline; the table decides one by the rule for proposals.
2. The sections are dealt out among the models and drafted in parallel.
3. Rounds: all models review the whole version at once; every open objection becomes a `revise` item for its
   section, taken by an agent whose model did not raise it; then the next ballots.

**Exchange between the tables.** The tables are not sealed off. After each round:

- each table gets the other's current version, its decisions and its open objections as reading material;
- a model may post a `proposal` at its own table to take over a section or a decision of the other, with the
  origin named; it is decided like any proposal;
- messages do not cross tables, so each discussion stays readable.

**Which way of working wins, and the joint result.**

1. The table whose version is accepted first (section 9) is the base. The other finishes the round it is in.
2. If both are accepted, every model compares the two documents pairwise and blind (no table, no author), with a
   reason per criterion; the majority decides, a tie goes to the table that spent less. If neither is accepted when
   rounds or budget run out, the same comparison picks the base.
3. **Joint final round.** All models work at one table on the base: the comparison's reasons name what the other
   document does better, each such point becomes a proposal, the agreed ones are worked in, and a last ballot
   follows. If that ballot fails, the base as it was accepted stays the result.
4. Every run writes a `PlanStrategyStat` (tables, rounds, cost, approvals, sections taken over, winner, models).
   The page shows the standings over all runs. Shifting the budget towards the way that wins more often is a later
   step and needs at least 20 runs.

A run can be started with one table only (about half the cost; no comparison, no final round).

As built (phase 9), where it differs from the above:

- Each table gets 45 % of the budget; the comparison and the final round have what is left of the whole.
- Each table is a run of its own beside the other, with its own roll call and kickoff.
- A table is shown the other's document as it stood after that table's last round. Taking over is a proposal in a
  fixed form that names a section there and a section here; once decided the section is revised with the other as
  material and names its origin. A decision of the other table is reading material only; it is not taken over by a
  form of its own.
- A table whose rival agreed first still has its first round: a document nobody voted on is not compared.
- The models compare whenever there are two documents, also when only one table agreed: that table is the base
  then, and the comparison supplies the points for the final round.
- The final round works at the base's table, on its document (no third document), with one round of ballots.
- `PlanStrategyStat` counts the points of the final round and how many were agreed, not sections taken over during
  the tables' rounds.
- The page shows each table's state, the base, the final round, the result and the standings. Both documents side
  by side, and the diff, come with phase 10.

## 8. Sources, read-only

A source pack is fixed when the task is created and does not change during the run.

| Kind | How it arrives | Limits |
|---|---|---|
| Uploaded documents | Markdown, text, CSV, JSON through the page | 10 files, 800 kB together; stored as pages of the block |
| Local repository | a name from `FORUM_REPOS` (name=path pairs, set by the operator) and a commit or branch | tracked files only (the objects of the commit), text files up to 200 kB each, 20 000 files |
| Remote repository | an https URL whose host is in `FORUM_GIT_HOSTS`; shallow fetch of one commit | admin only; no submodules, no LFS, no hooks, 200 MB, 60 s |

A repository is not copied into the Space (this one has 2171 tracked files with 42 MB) and not unpacked either:
the sources process reads the objects of the commit (`git ls-tree`, `git cat-file`, `git grep`) and answers
`SourceRequest` entries with `SourceResult` entries:

- `list <dir>`: names and sizes, at most 200;
- `read <path> [from] [lines]`: at most 400 lines or 16 kB;
- `search <text> [in <glob>]`: fixed text, any case, at most 40 hits (no patterns in the first version).

There is no fourth call. The process has no write call, starts no program from the pack and opens no network
connection. Since nothing is unpacked, no path can lead out of the tree and a symbolic link is an entry that is not
offered. The index (paths, sizes) lies in the Space as pages, for the checks of section 9.

**How a model reads.** A work item is a sequence of steps. In each step the model either asks for up to four
reading calls, written as text in a fixed form, or hands in its work. The agents process writes the requests,
takes the results and stores both as `ReadStep` entries of the work item before the next model call. This needs no
tool support of the provider, works with every model, and an agent that takes the work item over after a crash
finds the steps and goes on without reading again. At most 8 steps and 24 reading calls per work item; each model
call is admitted against the budget.

**Safety.**

- Source text is untrusted data in every prompt and never an instruction.
- Excerpts of the sources go to the model providers. The page says so where a pack is chosen.
- Only tracked files are read, so an untracked `.env` never is; a deny list (`*.pem`, `*.key`, `.env*`,
  `auth.json`) is applied on top.
- A path is looked up in the commit's tree and nowhere else; symbolic links are not offered.
- Only the sources process gets the repository paths, as only the model process gets credentials.
- Runs with a repository need the admin login in the first version.

As built (phase 11), remote repositories (`server/remote.ts`):

- The fetch is the one moment at which the sources process opens a connection: when the task is created, and again
  only when its cache lost the task's commit (then by the commit's id, while the host is still on the list; a server
  that hands out no commit by its id leaves the source unreadable, and the reading call says so).
- One commit, `--depth=1`, no tags, no submodules, into a bare repository of the cache; nothing is checked out, so
  hooks and LFS filters never run. https only, no redirect, no credentials asked or sent, the machine's and the
  user's git configuration not read; the address carries no user, password, query or fragment.
- The 200 MB are measured on the disk while the fetch runs (the cache's repository of that address), the 60 s on
  the clock; a fetch that passes either is killed with its helper and what it wrote is removed. Both are settings
  (`FORUM_GIT_MAX_MB`, `FORUM_GIT_TIMEOUT_S`).
- The tests serve repositories from this machine over plain http, which the sources process accepts for 127.0.0.1
  with `FORUM_TEST=1` only; https itself was tried once by hand against a public repository.

As built (phase 11), the Rust space server: `codemode-forum/rust/forum-space` is the counterpart of codemode-chat's
`codemode-space` on `phi-space-host`; `FORUM_SPACE_SERVER` switches launch and tests to it, and
`docker/docker-compose.rust.yml` the space container. Scripts for nano and big exist; the forum has not been deployed.

## 9. When a plan counts as agreed

**Mechanical checks first.** The checker runs them for every new `PlanDoc` version, without a model:

- every path and file name the plan names exists in the pack, or the plan marks it as new;
- every quoted line is in the file it is quoted from;
- the outline's required sections are there and none is empty;
- every phase names how it is verified;
- links between sections resolve, sizes are within the limits.

A version that fails gets no ballots. The failures go back to the table as objections of the checker, which nobody
can decline.

The checks need a form they can read, which every writer is told: paths in backticks, a new file marked "(new)", a
quote as a line of its own with its file, phases numbered. Whether a section contradicts a decision of the table is
not something a program can tell from the wording; that stays with the reviewers (phase 7). Until the review rounds
exist, what the checker finds goes straight back to the writer, at most twice in a run.

**Criteria.** Fixed for every plan task, plus those of the person:

1. The plan answers the brief and names what it leaves out.
2. Every step says what changes, where (files, modules, formats), and in which order.
3. Dependencies between steps are named, and no step needs a later one.
4. Every phase ends runnable and has a check that can fail.
5. Risks and the way back are named for the steps that change stored data or shared servers.
6. Open decisions are listed with a recommendation each, not hidden in the text.
7. Effort and cost are estimated where the sources allow it, and marked as a guess where they do not.

**Ballots.** One vote per model. A ballot rates every criterion and backs each "met" with a quote from the plan
and each "not met" with an objection. An objection names the section, the defect and what would resolve it; "could
be more detailed" is not one. The reviewer does not see who wrote which section.

**Accepted** means:

- more than half of the participating models approve the same version (three models: two; four: three; five: three);
- at least one approving model wrote none of the sections that changed since the last round of ballots (in the first
  round, where every section is new, each section needs an approver who did not write it);
- the mechanical checks of that version pass and no objection of the checker is open;
- no question addressed to an approving model is unanswered.

A person's 👍 accepts a version at any time, 👎 with a reason becomes an objection nobody can decline, ■ ends the
run.

**Against moving targets.** From the third round on, a model may raise a new blocking objection only against a
section that changed since its last ballot (the exception for an objection backed by a source quote is not built:
such a contradiction is the checker's to find). Everything else is a
note; notes are appended to the document and do not block. Who raised an objection confirms in its next ballot
whether it is resolved. An author may decline an objection with a reason; it then stays open and counts against
approval only for the model that raised it.

## 10. Run, budget and end

The run is a `PlanRun` (the lock of the run, as `CodeRun` in codemode-chat) with a state per table: round, turn,
version, open items, spent. Work items: `kickoff`, `outline`, `draft`, `review`, `revise`, `reply`, `check`,
`ballot`, `compare`, `final`. Slots, leases, three attempts, `pending` and the admission before each model call are
the ones taken over.

- **Budget.** Required for every run, in dollars and tokens. Each table reserves against its share (45 % each, 10 %
  held back for comparison and final round). Output limit per call: 3000 tokens for a section, 1500 for a review
  with its messages, 600 for a ballot or a reply.
- **Rounds.** At most `rounds` per table (default 5, at most 8).
- **Stall.** If two rounds in a row end with the same open objections and no more approvals, the table stops and
  asks the person: the page lists the open points, and the answer goes into the discussion.
- **End.** Accepted, compared and completed; or rounds, budget or Stop. The run's end entry names which.

A rough cost of one run with three models, both tables, twelve sections and three rounds: 200 to 250 model calls,
most of them with 20 to 40 thousand input tokens (document, discussion, source excerpts). This is an estimate
before any measurement; phase 0 replaces it with a measured number.

## 11. The result

- The page shows per table the document with its outline, its versions with a diff, the discussion and the
  objections beside their sections, and the ballots per model; after the end, the comparison and the final round.
- `GET /api/plan/<room>/<block>.md` returns the result as Markdown.
- The document ends with a generated appendix: brief, sources with commit, models, the way of working that won and
  why, sections taken over from the other table, decisions with their reasons, assumptions, rounds, ballots, notes,
  objections still open and who holds them, cost.
- `node --experimental-strip-types server/export-plan.ts --room <room> --block <id> --out <file>` writes it to a
  file, for example into `docs/`. No process of the application writes into a repository.

As built (phase 10), where it adds to or differs from the above:

- Which version "the result" is, in this order: the version a person accepted; else the result of the newest run
  with both tables (`PlanResult`); else the version a table accepted by majority; else the newest draft of the table
  the block shows, and the appendix says that nobody accepted it. `?table=` and `?version=` export another version,
  described as what it is; `?plain=1` and `--plain` leave the appendix out. The address is served under
  `/api/rooms/<room>/plan/<block>.md` as well.
- The appendix is written in the language of the task, by a program (`server/export.ts`), after a line with a fixed
  marker. Its cost is what the run recorded: each table's use from the `PlanStrategyStat`, and the whole use of the
  room's last run when that run worked on this task. The use of earlier runs on the same task is not kept per task
  and is not in the appendix.
- On the page the objections that still stand are beside their sections; the discussion (messages, decisions,
  ballots) is a panel per table, not beside the sections.
- The difference between versions is computed in the page (`client/lib/diff.ts`), by lines and inside a changed line
  by words, from the two versions' texts.
- The help articles are part of the application (`/help`, eight articles in German and English), not of the help
  site's corpus.
- Docker: the image and a local test bed with one container per role (`docker:local:up`, ports 4110 and 4190). The
  compose file splits the roles into the profiles nano (space, checker) and big (web, agents, model, sources)
  already; scripts for the servers come with phase 11, when the forum has its Rust space server. The sources
  container alone sees the repositories, mounted read-only, and its own file system is read-only.

## 12. Phases

Each phase is tested with fake models, keeps the application runnable and is one commit. Checks after each:
`npm --prefix codemode-forum run typecheck`, `npm run test:codemode-forum`, and in the root `npm run typecheck`,
`npm test`.

| Phase | Content | Tests |
|---|---|---|
| 0 | Baseline in codemode-chat as it is: both example briefs as text tasks with three models, by hand; record where it breaks, calls and cost. | none (live, costs tokens: ask first) |
| 1 ✓ | The directory `codemode-forum/` with the copied base: space, web, agents and model processes, launcher, admin, quotas, the run mechanics with the roll call as a run's opening, the refusal of runs with fewer than three models, a page for it; the registrations of section 3. | the stack starts and restarts; the repository's checks pass; a fake model call is booked |
| 2 ✓ | Plan task, the document entries of section 4 (`PlanTask`, `PlanDoc`, `PlanSection`), sectioned document, snapshot and a read-only document view with its versions. One table; one model writes: after the roll call the first model at the table writes the outline and the first draft of every section. No sources. | versions share unchanged sections; a second writer of a section is refused; sizes at their limits |
| 3 ✓ | Uploaded documents as a pack; the sources process with local repositories, read from the objects of a commit; reading in steps. | path escape, symbolic link, deny list, limits; a killed sources process; a killed agent goes on from its `ReadStep`s |
| 4 ✓ | Discussion: messages, threads, reply items, decisions, the person's messages, limits; kickoff. Messages travel with a work call from phase 6 on (review and revise); until then they are written at the kickoff and in the replies. | an unanswered question holds the table until its deadline; a decision reaches the next context; the message limit |
| 5 ✓ | The checker process and its six checks; the conventions told to the writer; check after the drafts, revision of the sections with findings, at most three checks a run. | each check with a plan that fails exactly it |
| 6 ✓ | Table B: an outline proposed by every model and one picked, sections dealt out and drafted in parallel, rounds of review and revise with objections kept as entries; messages travel with a review. A run chooses its table (`way`). | restart of all processes in a round; an objection becomes one item |
| 7 ✓ | Ballots per model, objection ledger, acceptance, the rule against moving targets, stall; the person's yes and no. | three agents of one model are one vote; approval by authors alone is not enough; a declined objection |
| 8 ✓ | Table A with the turn. | a turn nobody takes passes on; a killed agent in its turn |
| 9 ✓ | Both tables in one run: shares of the budget, exchange after each round, blind comparison, joint final round, `PlanStrategyStat`. | no table exceeds its share; a section taken over names its origin; a failed final ballot keeps the base |
| 10 ✓ | Page: diff, discussion, ballots, standings, export; help articles in German and English; README; Docker with the local test bed. | help links and both languages; the export equals the result |
| 11 ✓ | `codemode-forum/rust/forum-space` and its compose files; remote repositories (admin, host allowlist). | the suite against the Rust server; refused hosts, size and time limits with a local git server |
| 12 | Live runs of both example briefs, three models, both tables, three times each; report in `codemode-forum/docs/`. | live, costs tokens: ask first |

Phases 6 and 8 are independent after phase 5. Everything up to phase 12 runs on this machine; big and nano follow
only after the local release.

## 13. Risks

| Risk | What is done about it |
|---|---|
| Models approve each other's text without checking | blind ballots, evidence per criterion, checks before any ballot, a non-author among the approvers, the person's 👎 |
| Talking replaces working, or eats the budget | messages travel with work calls, limits per model and thread, decisions close threads |
| Agreement never comes | rounds, budget, the rule against moving targets, stall with a question to the person |
| The plan names things that do not exist | the checks against the pack's index and the quoted lines |
| Cost | budget required, one-table runs, phase 0 measures before anything is built |
| Source text steers the models | untrusted data in every prompt; the calls only read |
| Private code reaches a provider | the operator's allowlist, admin login, the notice on the page |
| The copied base drifts from codemode-chat | accepted: the applications are separate; only the three shared copies are held equal by the repository's check |
| The standings say little after few runs | they show counts, not a verdict; no budget shift before 20 runs |

## 14. Open and not part of this plan

Open, with a recommendation each:

| Question | Recommendation |
|---|---|
| Prefix `FORUM_` and the ports 4100/4180 | as proposed; `CODEMODE_*` belongs to codemode-chat |
| Does the application get the durable agent later? | only if reading in steps proves too weak in phase 12 |
| Where does the sources process run in operation? | on big, beside agents and model; a local repository there is a checkout the operator updates |
| Web research beside the source pack | after phase 12, taken from codemode-chat's `server/search.ts` |

Not part of this plan:

- carrying a plan out; a later step can turn the phases of a result into tasks;
- writing into a repository, opening pull requests, or any call that changes something;
- any change to codemode-chat;
- deploying to big or nano.

## 15. Proposed addition: the process in a GitHub repository (asked 2026-11-22, not decided)

The wish: a new repository for one decision process, named by the person; access to that repository only; every
intermediate document and step of the decision kept there in a form one can follow; Markdown, HTML and PDF of the
result at the end.

**Access to one repository only.** A token that may create repositories can reach more than one, so the creation
and the daily access are kept apart:

1. *Once, by the operator:* a script (`server/github-setup.ts`) asks for the name, creates the private repository with
   the operator's own `gh` login, generates a key pair, and registers the public key as a **deploy key with write
   access** of that repository. The `gh` login is never given to a process of the forum.
2. *From then on:* a new role, the **archive** process, pushes with that deploy key. GitHub itself confines a deploy
   key to its one repository; nothing in the forum can widen it.

**What is kept, and how.** The archive process follows the Space's change stream and turns events into commits, in
their order, so the history of the repository is the history of the process:

| Path | Content | Commit |
|---|---|---|
| `brief.md`, `sources.md` | the task; the source packs by name and commit (never their content) | task created |
| `discussion/round-<n>.md`, `decisions.md` | messages by thread, votes, decisions, the person's word | each phase of talking |
| `outlines/<model>.md` | the outlines proposed and which one the table picked | outline round |
| `plan.md` | the document; **one commit per version**, authored as the model that wrote it, the changed sections in the message | every version |
| `checks/v<n>.md`, `objections.md`, `ballots/v<n>.md` | what the checker found, objections with their state, votes | each check, review, ballot |
| `runs/<run>.md` | the run's log, models at the table, cost | run ended |
| `result/plan.md`, `plan.html`, `plan.pdf`, `PROCESS.md` | the accepted plan and the generated account of how it came about | acceptance |

What a model read in the sources is not archived by default: a private source would otherwise leave through the
archive. A cursor entry in the Space says how far the archive is, so a restart neither loses nor repeats a commit.

**HTML and PDF.** HTML comes from the Markdown renderer the page already has. PDF needs a program the repository does
not have yet: a headless Chromium on the host (`--print-to-pdf`) or pandoc. That is a new dependency to decide; without
one, the PDF is left out and the archive says so.

**Effort,** measured in phases of the size built so far (each of phases 2 to 5 was one):

| Part | Size | Tests |
|---|---|---|
| Setup script, deploy key, the archive process, layout and commits, cursor | one phase | against a local bare repository: every event one commit, a killed archive process, a rejected push |
| Result export (Markdown with the appendix, HTML), PDF if a renderer is decided | half a phase; overlaps the export of phase 10 | the export equals the accepted version |
| One real run against GitHub | an hour with the operator's `gh` login | by hand |

Not verified: the GitHub side (deploy keys, `gh repo create`) is written here from knowledge, not tried. Best placed
after phase 9, when ballots and acceptance exist and there is a result to archive.

## 16. Proposed addition: a map of the decision process (asked 2026-11-22, not decided)

The wish: a flip chart or organisation chart of how the decision came about, clickable, with the documents linked.

Everything such a map needs is already an entry with a time in the Space: the roll call, the kickoff messages, threads
and decisions, the outlines and the picks, every version of the document with who changed which section, every check,
every review round with its objections and what became of them. So the map is a view, not new data.

- **The page.** Per table a lane, time from left to right, a node per step: roll call, kickoff, each decision, the
  outlines and the one picked, each version, each check (passed or what it found), each review round, later ballots
  and acceptance. Arrows say what led to what: an objection to the revision that took it up, a finding to the version
  that mended it, a decision to the sections written under it. Colours say how a step ended.
- **Clickable.** A node opens what it stands for: a version opens the document at that version with its changes, a
  decision its thread with the votes, an objection the section before and after, a check its findings.
- **Drawn without a new dependency:** as SVG from a small layout of its own (lanes and columns), like the rest of the
  page.
- **In the archive of section 15,** the same map as a static `process.html` whose nodes link to the files of the
  repository at their commits.

**Effort:** about half a phase for the map on the page (a function that turns the entries of a block into steps and
arrows, with tests; the SVG view), and a small addition to the archive for the static copy. Best placed after phase
9, when both tables, ballots and acceptance are steps the map can show; a first version over what exists now would
need redoing then.
