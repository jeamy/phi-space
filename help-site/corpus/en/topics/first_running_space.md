---
standard: help_topic
id: help.topic.first_running_space
title: "Your First Complete Space: Task to Result"
short: "A complete example without models, credentials or servers: write, inspect, reserve and complete a job with a matching result. Use the repository's existing dependencies and Node with TypeScript stripping."
tags: [start, beginner, tutorial, job, result, shutdown]
owner: client
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Your First Complete Space: Task to Result

## Goal and Prerequisites {#overview}

A complete example without models, credentials or servers: write, inspect, reserve and complete a job with a matching result. Use the repository's existing dependencies and Node with TypeScript stripping.

## Run and Verify {#run}

Run from the repository root. Expect exactly { inspected: 7, squared: 49, jobsRemaining: 0 }. Reading does not consume the job; its final removal and result become visible together. The task is FOREVER; the processing reservation lasts 30 seconds.

```bash
PHI_SPACES_LLM=0 node --experimental-strip-types help-site/examples/tuple-basics.ts
```


## Complete Tested Program {#complete-program}

This is help-site/examples/tuple-basics.ts; relative imports assume that exact location. The build includes the same source checked by TypeScript and the executable test.

```ts
// Complete, model-free tutorial. Run from the repository root with node --experimental-strip-types.
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { FOREVER, NO_WAIT, PhiSpaces, spaces, startService } from "../../src/index.ts";

export async function runTupleBasics() {
	const registry = createRegistry(); registry.install(spaces);
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, ctx);
	let stop: (() => Promise<void>) | undefined;
	try {
		const space = new PhiSpaces(harness, ctx);
		await space.setCompletionProfiles([{ taskType: "Job", resultTypes: ["Result"], equalFields: ["jobId"], maxResultCount: 1 }]);
		stop = await startService(harness, ctx);
		await space.write({ type: "Job", fields: { jobId: "square-7", value: 7 } }, null, FOREVER);
		const inspected = await space.read({ type: "Job" }, NO_WAIT);
		if (!inspected) throw new Error("Expected one visible job");
		const txn = await space.createTransaction(30_000);
		try {
			const job = await space.take({ type: "Job" }, NO_WAIT, { txn: txn.id });
			if (!job) throw new Error("Expected a reserved job");
			await space.write({ type: "Result", fields: { jobId: job.fields.jobId!, squared: Number(job.fields.value) ** 2 } }, txn.id, FOREVER);
			await space.commit(txn.id);
		} catch (error) {
			await space.abort(txn.id).catch(() => {});
			throw error;
		}
		const result = await space.read({ type: "Result" }, NO_WAIT);
		return { inspected: inspected.fields.value, squared: result?.fields.squared, jobsRemaining: await space.count({ type: "Job" }) };
	} finally {
		await stop?.();
		await harness.close(ctx);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await runTupleBasics()));
```


## Failure and Persistence {#failure-and-storage}

Experiment by omitting the Result write: commit raises CompletionViolation and catch aborts, returning the job. Finally stops the service and closes the harness even on failure. MemoryStorage loses data at process exit; use persistent storage for restart survival. This example proves neither power-loss nor multi-host guarantees. Next: [task lifecycle](help.topic.task_lifecycle#overview).
