---
standard: help_topic
id: help.topic.first_running_space
title: "Erster vollständiger Space: Aufgabe bis Ergebnis"
short: "Ein vollständiges Beispiel ohne Modell, Credentials oder Server: einen Job schreiben, lesen, reservieren und mit passendem Ergebnis abschließen. Vorhandene Repository-Abhängigkeiten und Node mit TypeScript-Stripping genügen."
tags: [start, beginner, tutorial, job, result, shutdown]
owner: client
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Erster vollständiger Space: Aufgabe bis Ergebnis

## Ziel und Voraussetzungen {#overview}

Ein vollständiges Beispiel ohne Modell, Credentials oder Server: einen Job schreiben, lesen, reservieren und mit passendem Ergebnis abschließen. Vorhandene Repository-Abhängigkeiten und Node mit TypeScript-Stripping genügen.

## Ausführen und prüfen {#run}

Im Repository-Root ausführen. Erwartet wird exakt { inspected: 7, squared: 49, jobsRemaining: 0 }. Lesen verbraucht den Job nicht; Ergebnis und endgültige Entnahme werden gemeinsam sichtbar. Der Task ist FOREVER, die Bearbeitungsreservierung 30 Sekunden gültig.

```bash
PI_SPACES_LLM=0 node --experimental-strip-types help-site/examples/tuple-basics.ts
```


## Vollständiges, getestetes Programm {#complete-program}

Dies ist der Inhalt von help-site/examples/tuple-basics.ts; relative Imports gelten an genau diesem Speicherort. Der Build übernimmt denselben Quelltext, der durch Typecheck und Laufzeittest geprüft wird.

```ts
// Complete, model-free tutorial. Run from the repository root with node --experimental-strip-types.
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { FOREVER, NO_WAIT, PiSpaces, spaces, startService } from "../../src/index.ts";

export async function runTupleBasics() {
	const registry = createRegistry(); registry.install(spaces);
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, ctx);
	let stop: (() => Promise<void>) | undefined;
	try {
		const space = new PiSpaces(harness, ctx);
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


## Fehlerfall und Persistenz {#failure-and-storage}

Zum Experimentieren den Result-Write auslassen: commit meldet CompletionViolation, der catch bricht ab und gibt den Job zurück. Das finally stoppt den Dienst und schließt den Harness auch bei Fehlern. MemoryStorage verliert Daten beim Prozessende; für Neustarts einen persistenten Store verwenden. Das Beispiel beweist keine Stromausfall- oder Multi-Host-Garantie. Weiter: [Task-Lebenszyklus](help.topic.task_lifecycle#overview).
