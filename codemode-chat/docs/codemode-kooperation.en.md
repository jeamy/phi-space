# Codemode chat: cooperation of the agents (concept, 2026-10-20)

Goal: agents solve problems **together**: not only programming tasks, but also questions whose result is a text,
an analysis or a plan. They research, analyze, propose, design, criticize and
merge. Coordination happens only through the Space, following the Linda principle, without a clock.

## Current state

- A run is a sequence of **generations**. Within a generation all agents work in parallel and do not see
  each other. Only the next generation sees the attempts, their test results and the notes.
- The roles are **repair, improve, new approach**. Every contribution records which one it builds on
  (`basedOn`). In the run `#test-golomb11c` codestral took over 54 % of the template code, haiku wrote almost anew
  with 17 to 23 % reuse.
- Missing are critique between agents, merging of partial solutions, a shared plan, research and
  tasks without program code.
- The run state used to live in memory: a restart of the hub aborted a run. Since 2026-10-20 runs survive a
  restart (section "Durable runs").

## Core: work items in the Space

Instead of generations, the Space holds **open work items**. A free agent takes one (`take` under a
transaction, like the judges today), completes it, writes the result and **creates follow-up items**. Because the
whole run state consists of entries in the Space, a run survives a restart.

| Entry | Content |
|---|---|
| `WorkItem` | `kind`, `inputs` (ids), `blockId`, `depth`, `claimedBy?`; the kinds are listed below |
| `Finding` | finding of a research: source (URL), excerpt, who |
| `Proposal` | proposal: approach or plan, with rationale |
| `Critique` | critique of an entry: `target`, `addressedTo`, concrete points |
| `Answer` | draft of an answer (text tasks) |
| `CodeCandidate` / `CodeScore` | as today (code tasks) |

All entries carry `blockId` and provenance (`inputs`, author, model, consumption).

| Work item | What the agent does | typically creates |
|---|---|---|
| `research` | searches for data, sources | `Finding` → `analyze` |
| `analyze` | evaluates findings or attempts | `Proposal` |
| `propose` | proposes approaches; others rate them | `draft` / `implement` for the best |
| `draft` | writes an answer from proposals and findings | `Answer` → `critique` |
| `implement` | writes code (code tasks) | `CodeCandidate` → rating → `critique` |
| `critique` | examines a contribution critically, addressed to the author | `Critique` → `revise` |
| `revise` | revises using the critique | new version → `critique` |
| `merge` | merges two partial solutions | new version |
| `judge` | final check against a list of criteria (text tasks) | done, or `revise` |

A run ends when the task is solved (code: test cases; text: the judges agree), the budget is exhausted
or Stop is pressed. Downrating by a human remains the final word.

## Safety and cost

- **Budget per run:** upper limit in tokens or dollars, from the existing consumption tracking. Plus upper limits for
  the number of work items and their depth; asynchronous work items would otherwise multiply.
- **Web search:** every request sends task text to a third party. A tool that fetches arbitrary URLs is an SSRF entry point on
  a public hub (localhost, nano, Docker, NetBird, LAN). Therefore: only search results
  (title, excerpt, URL), or fetching only with a block on private address ranges, size and time limits. Plus a
  daily limit for search requests.
- **Prompt injection:** content from the web reaches all following agents. In the prompt it is marked as
  untrusted data and is never an instruction.
- **Rating of texts:** there is no sandbox truth. Rating models are easily flattered and
  tricked. Therefore the human provides a list of criteria, several judges must agree, and downrating by
  the human remains possible.

## Decisions (2026-10-20)

- **Web search:** ordinary web research without an API key, via the HTML results page of DuckDuckGo
  (`html.duckduckgo.com`). This is unofficial: with many requests DuckDuckGo may block, and a layout change
  requires an adjustment. Plus a daily limit for search requests.
- **Access:** runs with web search only after the admin login (`CODEMODE_ADMIN_PASSWORD` in the `.env`); normal runs stay open to everyone.
- **Only agents search.** Web search is a tool of the research agents: they formulate their search queries
  themselves, from the task, in order to solve it. There is no search box for visitors and no work item that executes a
  given search query; a task such as "search the web for xyz" contradicts the purpose of the platform. The
  platform is not a search service: findings are always only an intermediate step for analysis and answer, never themselves the
  result of a run.
- **Budget:** per run in tokens **and** dollars; whichever is reached first ends the run. Plus upper limits for number
  and depth of work items. Runs of visitors (without admin login) always have a token budget, at most
  `CODEMODE_RUN_BUDGET_TOKENS` (default 300 000); all visitor runs of one address together at most
  `CODEMODE_TOKENS_PER_IP_DAY` tokens a day (default 1 000 000, counted in the hub's memory).

- **Text tasks (stage 3):** criteria are an optional field; if it stays empty, the verifier agent writes them from
  the question, visible in the block. Three agents check these criteria and vote on each criterion (keep, correct,
  strike); the majority decides. Reason: in the run `#test-text-himmel2` a criterion contained a false fact.
  An answer is accepted if at least two judges (never the author) rate every criterion as met and
  back each one with a verbatim quote from the answer, or if a human gives 👍 "Fits". If the run has a
  model other than the author's, at least one agreeing judge must use it (`crossNeeded` on the answer);
  a judging work item waits up to `CODEMODE_CROSS_WAIT_S` seconds (default 300) for such an agent.
  Interrupting works in three ways: 👍 (accepted, the run ends), 👎 (downrated) and ■ (abort); each with
  an optional reason that goes to the agents as a note.
- **Reuse:** accepted answers and the best code of a block stay as `CodeEarlier` in the Space,
  longer than the entries of the rooms (`CODEMODE_EARLIER_DAYS`, default 30 days, at most 1000). For a new,
  similar task the agents receive them as material ("accepted earlier, check whether it fits here"). An acceptance
  by a human counts only in its own room: anyone can give a 👍, so it must not
  reach the agents of other rooms.

## Stages (each tested individually, with test models, own commit)

1. **Work board** as a new run mode alongside the generations, for code tasks: `implement`, `critique`, `revise`,
   `merge`. The previous mode and its tests stay unchanged.
2. **Planning round:** `propose` and rating of the proposals before anything is implemented.
3. **Text tasks:** `draft`, `critique`, `revise`, `judge` with a list of criteria.
4. **Research:** `research` with web search, behind a switch, with the safeguards above. Implemented (2026-10-20):
   for a new task half of the agents research first. Each writes up to three search queries itself,
   the model process searches on DuckDuckGo (`server/search.ts`, only search results: title, URL, excerpt; no page is
   fetched, hence no SSRF), the agent records with source citation what helps (`CodeFinding`). Planning, drafts and
   critique receive the findings as untrusted data. Only with admin login; daily limit
   `CODEMODE_SEARCH_PER_DAY` (default 100). The request goes through `node:https`: `fetch` sends headers to which
   DuckDuckGo responds with a bot query (HTTP 202).
5. **Interface:** traces per role, addressed critique, sources on the answers, budget display.

Web search needs no tool calls from the model (pi-ai has no ready-made tool loop): the agent writes
its search queries as text, the model process executes them and returns the results in the next call. This works
with any model, including one without support for function tools.

## Durable runs (2026-10-20)

A run survives a restart of the hub and continues afterwards. Everything it knows lives in the Space:

- `CodeRun` per active run: start parameters, consumption, progress (at most once per second, replaced under a
  transaction). At start the hub resumes every run that has a `CodeRun` (`resumeRuns`). A stop by a human
  removes `CodeRun` immediately, a shutdown does not.
- `BoardState` per run on the work board: phase (research, planning, rating, work) and counters. A
  phase change writes the new state and the work items of the new phase in one transaction.
- Taken work items: an agent takes a work item and writes it back as taken, in one transaction.
  After a restart, taken work items are open again.
- Follow-up items (`followup`): a contribution leaves a work item that waits for its verdict and then creates critique or
  merge. If the verdict is missing, it prompts the judges (after a crash a contribution only comes
  back when the transaction of the old judge expires).
- Generations: the aborted generation runs once more after the restart.

Limit: model calls that were in flight at the restart are lost and are repeated; that costs tokens. Whoever changes
files in `server/` during a run restarts the dev server and pays for these repetitions.

## Corrections after the review (2026-10-21)

- **Verdicts from nano:** the hub fetches every `CodeScore` from nano immediately into its own Space (`imported`), even
  one that arrives after the wait of 90 s or after a restart of the hub. Before, they lay only on nano: a
  late verdict did not reach the best code, and every snapshot read up to 1000 verdicts together with the code over the socket.
  A candidate that a judge on nano is currently holding is no longer given up.
- **Failed work items:** a work item whose model call fails comes up again later (at most
  three times). If the day's model calls are used up, the run ends as "budget used up" instead of "idle".
- **Read order:** `readAll` returns the oldest entries first. Findings are therefore read completely and shortened only
  after sorting, so that the newest reach the agents.
- **Limit of the implementation:** phase, counters and the agents themselves still live in the memory of a hub process; the
  Space is journal and queue. Only the judges on nano work decoupled through the Space.
