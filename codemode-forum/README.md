# phi-spaces codemode forum

At least three AI models develop one plan together and write it as one document. They talk to each other, change the
document, and vote until a majority agrees that the plan can be carried out. The plan for this application, with its
phases, is `docs/gemeinsame-planung-plan-2026-11-22.en.md`.

**Status: phase 1 of that plan.** The application has its processes, its space, the run mechanics, the admin login and
the model limits. A run so far is its opening alone: the **roll call**, in which every model at the table says that it
is there. Plan tasks, sources, the discussion, the document and the ballots follow with phases 2 to 9.

The application is a directory of its own. Its base is copied from `codemode-chat/` (the comments at the top of each
file say so) and it imports nothing from there; it depends on the library as `"phi-spaces": "file:../spaces"`.

## What you see

Open a room (the name after `#` in the URL). Choose three to five models, a budget, and start the run. Each model gets
a name for this run, M1, M2, …, drawn anew every time; the models learn each other only by these names. The page shows
what each answered, what the run used, and the room's log. The system bar lists the processes and today's model calls.

## Processes and the one space

Every role is its own process, and the processes talk only through one phi-space. A process that dies lets its
transactions lapse, and its work comes back for another process of the same role.

| Process | File | Job |
|---|---|---|
| space | `server/space-host.ts` | owns the space (phi-spaces' own SQLite store) and serves it on `FORUM_LISTEN` (default `unix:/tmp/codemode-forum-space.sock`) |
| agents | `server/agent-host.ts`, `server/run.ts` | takes the agent slots of runs and works off their work items, each in its own transaction |
| model | `server/model-host.ts`, `server/llm.ts`, `server/calls.ts` | the only process that calls models. Takes an `LlmCall`, builds the prompt from the space, writes the `LlmResult` and a `Spend` entry in the same transaction; publishes the models (`ModelInfo`), follows the admin's choices (`ForumAdmin`) |
| web | `server/index.ts`, `server/hub.ts` | Next.js page, REST API, WebSocket. Follows the space's change stream and pushes a fresh snapshot when a room changes; starts and stops runs |

The roles `sources` (reads repositories and documents, read-only) and `checker` (the mechanical checks of a document)
follow with their phases. There is no judge and no sandbox: nothing here runs code from an entry.

Entries in the space so far: `ForumRoom`, `RoomLock`, `ForumRun` (the run and its lock, one per room), `AgentSlot`,
`WorkItem`, `ItemStart`, `RollCall`, `ForumRunDone`, `ForumLine`, `LlmCall`, `LlmResult`, `Spend`, `ModelInfo`,
`ForumAdmin`, `AdminSession`, `QuotaLock`, `QuotaUse`, `Process`.

## Runs

- A run names **three to five different models**; fewer are refused. Each model gets the same number of agents (1 to 3).
  More agents make a model faster, not stronger: what counts is counted per model.
- A run **needs a budget** in tokens or dollars. A visitor's run gets `FORUM_RUN_BUDGET_TOKENS` at most; an admin
  names the budget freely. Before each model call the run admits it against the budget under its lock, so a run ends
  at most one call's estimate beyond it.
- A model call that fails is tried three times, each paid call is booked, and after that the run goes on without it.
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
`spaces/agent/`. The web process and the tests never load it.

## Commands

```bash
npm --prefix codemode-forum install           # once: next, react, typescript and the link to ../spaces
npm --prefix codemode-forum run dev           # all four processes (Next.js dev mode), http://localhost:4100
npm --prefix codemode-forum run build && npm --prefix codemode-forum start   # the same with the production build
npm --prefix codemode-forum run space         # or one process: space | agents | model | web
npm --prefix codemode-forum run typecheck     # own tsconfig, not part of the root tsc
npm run test:codemode-forum                   # tests (they start the processes themselves, with fake models)
npm --prefix codemode-forum run backup        # a consistent copy of the running store
```

`server/restore.ts --from <file> --yes` puts a backup back while the space is stopped. Configuration:
`codemode-forum/.env.example`. Ports: web 4100, space 4180 when it listens on TCP. Docker and the Rust space server
(`rust/forum-space`) come with phases 10 and 11; until then the application runs on this machine only.

## Tests

`tests/forum.test.ts` starts the space, an agents process and a model process with the fake models of
`tests/fakes.ts` as real OS processes (`tests/stack.ts`) and covers: the roll call and its bookings, the refusals
(fewer than three models, unknown models, no budget), a stopped run, a model that does not answer, the budget, a run
across killed agents and a restarted space and model process, and the admin login.

## Safety notes

Identities are unauthenticated: anyone who reaches the page can start a run in any room, within the visitor limits.
The space socket has no TLS and treats every connection as a process of the forum; never publish it on a public
interface. Do not expose the page publicly without a reverse proxy in front.
