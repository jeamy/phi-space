# arXiv Research: Data Contract and Workflow

As of 2026-10-07. Implementations:
[arxiv-tool.ts](../../agent/examples/arxiv-tool.ts),
[arxiv-research.ts](../../agent/examples/arxiv-research.ts),
[dark-energy-research.ts](../../agent/examples/dark-energy-research.ts),
[research-support.ts](../../agent/examples/research-support.ts).

## Source Contract

The public [arXiv API](https://info.arxiv.org/help/api/user-manual.html) delivers Atom metadata.
The parser outputs the versionless arxivId, title, year, original published date, complete authorNames,
the short-form authors, categories, primary category and the complete abstract.
The short author string serves display only; networks use authorNames.
An abstract is not the full text of a paper. Citation counts, reference graph and h-index are not delivered.

Per process, requests are serialized and at least 3.1 s apart; fetch has a 30 s timeout.
Several processes do not share this limiter. The search returns 1–25 results per call, no pagination.
The regex parser is designed for the Atom format used, not for arbitrary XML. HTTP errors are
propagated; there is no guaranteed retry/backoff contract. Inputs/responses are third-party data,
not instructions. Prompt markers do not completely prevent hallucinations or prompt injection.

## Simple Pipeline

Three collector conversations gather bibliographic paper entries and report CollectorDone.
A read-before-write check is not atomic deduplication; overlapping collectors can create duplicates.
After all completions or a collector timeout the host writes AnalyzeTask.
The analyst reserves the task via space_wait and writes analyses and PresentTask under the same wait txn.
The commit makes outputs visible and consumes the order. The presenter reserves PresentTask,
writes the Report likewise under its txn and commits.

## Dark-Energy Pipeline

Crawler → Host → ClassifyTask → ClassifiedPaper + ClassificationDone → Host → SummarizeTask →
PaperSummary + SummarizationDone → Host → AnalyzeTask → AnalysisResult + Analysis(order=99) →
Host → PresentTask → Presentation. Optional UserQuery → QueryResponse.

The host waits for committed completion markers; a result write alone does not count as a completed phase.
The monitor is periodic host code, not an autonomous LLM agent.
Without classified papers the summary is skipped and marked as such.

PaperSummary must carry basis=abstract and citationCount=null. Estimates are rejected.
CitationAnalysis must output an unknown citation ranking and graph as null with an unavailable reason.
Known citation metrics in AuthorNetwork are rejected. Evaluable are counts and co-authorships
**within the collected corpus**, no statement about the whole literature or complete author careers.
Monthly distributions use published; without a date the information remains unknown.
Dashboard JSON is a data artifact, not an implemented interactive dashboard.

## Atomicity and Fresh Runs

The shared result tools check the active txn, owner and matching reserved task type.
A missing txn is rejected server-side. Validation is task-scoped persistent so that a replay of an already
successful tool write can query its existing claim result even after the txn commit.
The actual mutation still checks the transaction; a first write after its expiry fails.
Result and task are atomic only within the local Space commit. Report/dashboard files are exported
separately afterwards and are not part of the Space transaction.

A new run requires a fresh empty directory and exclusively creates a manifest (`.research-run.json`).
With `--resume --dir <directory>` it reopens a compatible existing run (topic/query from the manifest, same run kind
and same model, otherwise an error); team IDs and phase come from the agent store. The Space lives in `space.sqlite`, the agent store as JSONL
in the same directory. A start without `--resume` in a non-empty directory fails early; new conversations
can thus not adopt old done markers as success.

Timeouts are workflow limits, not evidence of complete research. Each phase needs its confirmed
completion. On timeout the runner ends with an error and keeps the state for inspection; subsequent phases
are not started from incomplete material. List limits (100–500 per prompt)
and fixed search limits bound the corpus; ≥80 % literature coverage is not demonstrated.
Even a source link proves neither the correctness of a model summary nor the existence of invented IDs.
The guards check known structured metrics, not arbitrary statements in free Markdown.

## Invocation and Tests

```bash
# Requires model credentials, network and approval
npm run example:arxiv -- "Thema" --dir /tmp/fresh-arxiv-run
npm run example:dark-energy -- "Thema" --dir /tmp/fresh-dark-run --query "Frage"
# No real model or API calls
npm run test:agent
```

The runners can be imported as runArxivResearch/runDarkEnergyResearch. Tests inject models,
poll intervals and deadlines. [agent/test/examples/recovery.test.ts](../../agent/test/examples/recovery.test.ts) starts the actual runners with faux models and a real store,
checks reports, resume after SIGKILL, fresh directories and result guards. No paper is actually loaded from the network.
Older suites rebuild their own prompts/workflows. Real model runs, bibliometric quality,
fact validation and production operation are not accepted.
[Back to the overview](README.en.md).
