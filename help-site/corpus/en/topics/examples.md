---
standard: help_topic
id: help.topic.examples
title: "Examples: what exists and how to run it"
short: "Every runnable example at a glance: what it shows, how to start it, and which ones need a real model and cost tokens."
tags: [examples, agents, agent-examples, scripted, live, cli, arxiv, chat]
owner: tools
related: [help.topic.first_running_space, help.topic.agent_tools_and_replay, help.topic.apps, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Examples: what exists and how to run it

## Overview {#overview}

The examples are small programs that show phi-spaces at work. Most run straight away, without a model or network, and finish within seconds. Some let agents work together, with a scripted model giving the answers. Only the examples under [With a real model](#live) cost tokens.

For a first impression, start `npm run example:pipeline` for cooperation without agents and `npm run example:chat` for three agents in conversation. All commands apply in the repository root.

### Requirements {#requirements}

- Node.js with `--experimental-strip-types`; there is no build step.
- The agent examples need the `agent/` package's own dependencies in `agent/node_modules`. The space itself does not.
- After a change, `npm run test:agent` checks the agent examples with scripted models.

## Examples without agents or a model {#without-model}

Here every role is ordinary program code. You see the coordination pattern alone, and the result can be checked every time.

| Example | What it shows | Start | File |
|---|---|---|---|
| Sensor pipeline | Collectors deliver readings, competing analysts summarise time windows, a presenter reports; duplicates and invalid values are filtered out | `npm run example:pipeline` | `examples/sensor-pipeline.ts` |
| Prime sieve | A sieve split into tasks that workers take from the space | `npm run example:sieve -- 1001 4` (up to 1001, 4 workers) | `examples/sieve.ts` |
| Cache | Atomic key/value operations with expiry and version comparison; no replication | `npm run example:cache` | `examples/cache.ts` |
| Golomb ruler | A shared branch-and-bound search; the best result lives in the space. Order 4 with 2 workers takes about 10 seconds | `npm run example:golomb -- 4 --workers 2` | `examples/golomb.ts` |
| Codemode evolution | Random program contributions judged by a sandbox; the best are the basis of the next generation. 2 generations of 4 agents take about 20 seconds | `npm run example:codemode-evolve -- --gens 6 --agents 8` | `examples/codemode-evolve.ts` |
| Space-Chat, stage v1 | A chat made only of space building blocks: presence, tasks, alarms | `npm run example:space-chat` | `help-site/examples/v1-local-memory/run.ts` |

The sieve and the cache also run over a standalone space service:

```sh
npm run space-server -- --store /tmp/space.sqlite --listen unix:/tmp/space.sock
npm run example:sieve -- 1001 4 --remote unix:/tmp/space.sock
npm run example:cache -- --remote unix:/tmp/space.sock
```

Stages v2 to v6 of the Space-Chat are in the [stage plan](help.workflow.overview_v1_to_v6#overview).

## Agent examples {#agents}

These examples live in `agent/examples/`. Here the participants are real agents: `pi-durable` conversations that use the space through the [space tools](help.topic.agent_tools_and_replay#overview). A scripted model gives the answers, so nothing is charged and each run ends in about a second.

| Example | What it shows | Start | File |
|---|---|---|---|
| Master and worker | One conversation puts jobs in the space, another takes one | `npm run example` | `agent/examples/workers.ts` |
| Blocking take | An agent waits with `space_take` and a timeout for a job someone writes only afterwards | `npm run example:blocking` | `agent/examples/blocking-tool.ts` |
| Ring chat | Three agents talk in turn about a topic. Each subscribes to messages addressed to it, so a message wakes exactly its addressee | `npm run example:chat` | `agent/examples/chat.ts` |

### What to look for when reading {#agents-reading}

- The agents never call each other directly. They only see the space.
- The space runs as a host of its own beside the agents (`createSpaces(localSpaces(host))`). The tools act on it.

## With a real model {#live}

These examples cost tokens, so they never start by themselves, not even in the tests. The arXiv teams also need network access.

| Example | What it shows | Start | File |
|---|---|---|---|
| Live chat | The ring chat with a real model | `npm run example:chat -- --live "topic"` | `agent/examples/chat.ts` |
| arXiv research team | Three collectors search papers, an analyst evaluates, a presenter writes the report | `npm run example:arxiv -- "topic" --dir RUN --out report.md` | `agent/examples/arxiv-research.ts` |
| Dark energy research | A larger team of crawler, classifier, summarizer, analyst, presenter and monitor; with `--query` a chat agent answers a question | `npm run example:dark-energy -- --dir RUN --query "question"` | `agent/examples/dark-energy-research.ts` |
| Codemode evolution live | Models write the contributions themselves. About 600 tokens per contribution (agents × generations × contributions per agent) | `npm run example:codemode-evolve:live -- --agents 4 --gens 3` | `agent/examples/codemode-evolve-live.ts` |

### Model and access {#live-models}

- `PI_PROVIDER` and `PI_MODEL` pick the model. Without them, `agent/src/live-models.ts` takes the first available one.
- Credentials come from environment variables such as `ANTHROPIC_API_KEY` or from the pi CLI's login (`~/.pi/agent/auth.json`, read only).
- Without a choice, the live codemode evolution takes the first Mistral model.

### Resuming research runs {#live-resume}

A new run requires a fresh, empty directory. `--resume` reopens an interrupted run:

```sh
npm run example:arxiv -- --resume --dir RUN
npm run example:dark-energy -- --resume --dir RUN
```

The agent state lives as JSONL in the run directory, the report in `--out` (default `<directory>/report.md`). Resuming does not make expired transactions valid again, and model or arXiv requests may run again after a crash.

The tests check these programs with scripted models. They do not prove the quality of real results.

## Further reading {#further}

- Detailed evidence and limits per example are in the repository in `docs/examples.md` and `docs/examples/`.
- [A complete first space](help.topic.first_running_space#overview) builds your own first application step by step.
- Finished applications are under [Apps on phi-spaces](help.topic.apps#overview).
