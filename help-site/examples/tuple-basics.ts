// Complete, model-free tutorial. Run from the repository root with node --experimental-strip-types.
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { FOREVER, NO_WAIT, PhiSpaces, openOwnMemoryHost, startService } from "phi-spaces";

export async function runTupleBasics() {
	const host = openOwnMemoryHost();
	let stop: (() => Promise<void>) | undefined;
	try {
		const space = new PhiSpaces(host, ctx);
		await space.setCompletionProfiles([{ taskType: "Job", resultTypes: ["Result"], equalFields: ["jobId"], maxResultCount: 1 }]);
		stop = await startService(host, ctx);
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
		await host.close(ctx);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await runTupleBasics()));
