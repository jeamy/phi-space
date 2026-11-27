// The pdf worker (docs/forum-seite-plan-2026-11-26.en.md, section 6): where the sandbox process cannot make namespaces
// for its children (in Docker), it hands each PDF to this process, which runs in a container of its own with no
// network, no Space, no file of the forum and nothing mounted but the directory of its socket. It reads each PDF in a
// child (pdf-extract.ts, Node's permission model, bounded heap and time) and answers on the same connection:
//
//   in:   a line of JSON { pages, textBytes, bytes }, then the PDF's bytes
//   out:  a line of JSON, what pdf-extract.ts says (or code "sandbox": what went wrong with the child)
//
// It starts only where it can isolate: in a container without a network interface but loopback ("contained"), or with
// user namespaces (this machine, the tests).
//
//   FORUM_PDF_WORKER=/run/pdf/pdf.sock node --experimental-strip-types server/pdf-worker.ts
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import { PDF_LIMITS } from "./pdf-extract.ts";
import { extractIsolated, namespaces, PDF_MAX_BYTES, type Isolation } from "./sandbox-host.ts";

/** Contained when no interface but loopback is there, else user namespaces, else nothing. */
export function workerIsolation(): Exclude<Isolation, { mode: "worker" }> | null {
	const outside = Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal);
	return outside.length === 0 ? { mode: "contained" } : namespaces();
}

export function startPdfWorker(path: string, o: { timeoutMs?: number; memoryMb?: number; at?: number } = {}) {
	const iso = workerIsolation();
	if (!iso) throw new Error("the pdf worker runs only without a network or with user namespaces");
	if (existsSync(path)) unlinkSync(path);
	let running = 0;
	const at = o.at ?? 2;
	const server = net.createServer({ allowHalfOpen: true }, (c) => {
		if (running >= at) { c.end(JSON.stringify({ ok: false, code: "sandbox", message: "the pdf worker is busy" }) + "\n"); return; }
		running++;
		const parts: Buffer[] = [];
		let got = 0, head: { pages: number; textBytes: number; bytes: number } | null = null, done = false;
		const answer = (r: unknown) => { if (done) return; done = true; c.end(JSON.stringify(r) + "\n"); };
		c.on("close", () => { running--; });
		c.on("error", () => {});
		c.on("data", (d: Buffer) => {
			if (done) return;
			parts.push(d); got += d.length;
			if (!head) {
				const all = Buffer.concat(parts), nl = all.indexOf(10);
				if (nl < 0) { if (all.length > 200) answer({ ok: false, code: "sandbox", message: "no request" }); return; }
				try {
					const h = JSON.parse(all.subarray(0, nl).toString("utf8")) as { pages: number; textBytes: number; bytes: number };
					if (![h.pages, h.textBytes, h.bytes].every((n) => Number.isInteger(n) && n > 0) || h.bytes > PDF_MAX_BYTES) throw new Error();
					head = { pages: Math.min(h.pages, PDF_LIMITS.pages), textBytes: Math.min(h.textBytes, PDF_LIMITS.textBytes), bytes: h.bytes };
				} catch { answer({ ok: false, code: "sandbox", message: "no request" }); return; }
				parts.length = 0; parts.push(all.subarray(nl + 1)); got = parts[0]!.length;
			}
			if (got > head.bytes) answer({ ok: false, code: "sandbox", message: "more bytes than announced" });
		});
		c.on("end", () => {
			if (done) return;
			if (!head || got !== head.bytes) { answer({ ok: false, code: "sandbox", message: "the PDF arrived incomplete" }); return; }
			const h = head;
			void extractIsolated(Buffer.concat(parts), h, { iso, hide: [], timeoutMs: o.timeoutMs, memoryMb: o.memoryMb }).then(answer, (e) => answer({ ok: false, code: "sandbox", message: String((e as Error).message).slice(0, 200) }));
		});
	});
	return new Promise<{ isolation: string; close(): Promise<void> }>((ok, fail) => {
		server.once("error", fail);
		server.listen(path, () => {
			chmodSync(path, 0o600);
			ok({ isolation: iso.mode, close: () => new Promise<void>((r) => server.close(() => r())) });
		});
	});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const path = process.env.FORUM_PDF_WORKER;
	if (!path?.startsWith("/")) throw new Error("FORUM_PDF_WORKER: the absolute path of the socket to listen on");
	const w = await startPdfWorker(path, { timeoutMs: Math.max(1000, Number(process.env.FORUM_PDF_TIMEOUT_S || 30) * 1000), memoryMb: Math.max(64, Number(process.env.FORUM_PDF_MEMORY_MB || 256)) });
	console.log(`[pdf-worker] reading PDFs on ${path}, isolated by ${w.isolation}`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await w.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
