// The sandbox process (docs/forum-seite-plan-2026-11-26.en.md, section 6, decision 2): the one role that opens
// hostile input. In phase 6 it has one job, the text of a PDF; scripts follow in phase 10. Like every role it talks
// only through the Space:
//
//   PdfRequest   a PDF to read: its parts (PdfPart, base64, written by the sources process outside a transaction), its
//                hash, the limits
//   PdfResult    the text with a mark at every page, or what the PDF is instead (pdf-extract.ts)
//   SandboxInfo  that a sandbox is there and how it isolates (renewed every 10 s); without one no PDF is read
//
// The process itself holds no key and reads no file of the forum, but it does reach the Space. So it never opens a PDF
// itself: each one goes to a child (pdf-extract.ts) that runs isolated, and without isolation no PDF is opened.
//
//   unshare   (Linux with user namespaces, this machine) the child gets a network of its own with nothing in it, and a
//             mount namespace in which the directory of the Space's socket is covered by an empty one
//   worker    (FORUM_PDF_WORKER=<unix socket path>; Docker, where a container may not make namespaces) each PDF goes over
//             that socket to the pdf worker (pdf-worker.ts) in a container of its own with no network, no Space and no
//             file of the forum, which reads it in a child there
//
// The child itself: Node's permission model lets it read the extractor and pdfjs-dist and nothing else, and it runs
// with at most FORUM_PDF_MEMORY_MB (256) of heap for at most FORUM_PDF_TIMEOUT_S (30) seconds.
//
//   FORUM_SPACE=unix:/tmp/codemode-forum-space.sock   (default)
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NO_WAIT, TransactionError, type SpaceLike } from "phi-spaces";
import { ROOT } from "./env.ts";
import { PDF_LIMITS, type PdfText } from "./pdf-extract.ts";
import { announce, awaitWork, connectSpace, DEFAULT_SPACE, keepAlive, parseTarget } from "./space.ts";

const LEASE_MS = 30_000;
const RESULT_LEASE_MS = 10 * 60_000;
/** Base64 characters a PdfPart holds. */
export const PDF_PART = 48_000;
/** The bytes of a PDF the sources process sends at most (pdfjs reads a PDF whole). */
export const PDF_MAX_BYTES = 16 * 1024 * 1024;

export type PdfRequest = { jobId: string; parts: number; hash: string; bytes: number; maxPages: number; maxText: number; ts: number };
export type PdfResult = { jobId: string; result: PdfText | { ok: false; code: "sandbox"; message: string }; ms: number; ts: number };
export type SandboxInfo = { procId: string; isolation: "unshare" | "worker"; pdf: true; ts: number };
/** How a child is kept from the rest: "contained" only inside the pdf worker's container without a network. */
export type Isolation = { mode: "unshare" } | { mode: "worker"; socket: string } | { mode: "contained" };

const EXTRACTOR = fileURLToPath(new URL("./pdf-extract.ts", import.meta.url));
const PDFJS = join(ROOT, "node_modules", "pdfjs-dist");

/** How the children are isolated here, or null when they cannot be (then no PDF is opened). */
export function isolation(env: Readonly<Record<string, string | undefined>> = process.env): Exclude<Isolation, { mode: "contained" }> | null {
	if (env.FORUM_PDF_WORKER) {
		if (!env.FORUM_PDF_WORKER.startsWith("/")) throw new Error("FORUM_PDF_WORKER: the absolute path of the pdf worker's unix socket");
		return { mode: "worker", socket: env.FORUM_PDF_WORKER };
	}
	return namespaces();
}

/** User namespaces for a child, or null where they cannot be made. */
export function namespaces(): { mode: "unshare" } | null {
	if (process.platform !== "linux") return null;
	const probe = spawnSync("unshare", ["-rnm", "true"], { stdio: "ignore", timeout: 5000 });
	return probe.status === 0 ? { mode: "unshare" } : null;
}

/** The directories a child must not reach although the sandbox process does: the one of the Space's socket. */
export function hiddenDirs(spaceSpec = process.env.FORUM_SPACE || DEFAULT_SPACE): string[] {
	const t = parseTarget(spaceSpec) as { kind?: string; path?: string };
	return t.kind === "unix" && t.path ? [dirname(t.path)] : [];
}

/** Starts `script` (with `args`) isolated as described above; `read`: further paths the child may read. */
export function spawnIsolated(script: string, args: string[], o: { iso: { mode: "unshare" } | { mode: "contained" }; hide: string[]; read?: string[]; memoryMb?: number }): import("node:child_process").ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, null> {
	const node = [process.execPath, "--no-warnings", "--experimental-strip-types", "--permission", ...[script, join(ROOT, "package.json"), PDFJS, ...(o.read ?? [])].map((p) => `--allow-fs-read=${p}`), `--max-old-space-size=${o.memoryMb ?? 256}`, script, ...args];
	const env = { PATH: "/usr/bin:/bin", NODE_OPTIONS: "" } as unknown as NodeJS.ProcessEnv;
	if (o.iso.mode === "contained") return spawn(node[0]!, node.slice(1), { stdio: ["pipe", "pipe", "ignore"], env, cwd: "/" });
	// a mount namespace of its own: an empty file system over every hidden directory, then the child
	const cover = 'for d in "$@"; do [ "$d" = -- ] && break; mount -t tmpfs -o size=64k,mode=0 none "$d" || exit 97; done; while [ "$1" != -- ]; do shift; done; shift; exec "$@"';
	return spawn("unshare", ["-rnm", "--", "/bin/sh", "-c", cover, "sh", ...o.hide, "--", ...node], { stdio: ["pipe", "pipe", "ignore"], env, cwd: "/" });
}

/** The text of a PDF from an isolated child; what went wrong with the child itself is a result too. */
export async function extractIsolated(bytes: Buffer, lim: { pages: number; textBytes: number }, o: { iso: Isolation; hide: string[]; timeoutMs?: number; memoryMb?: number }): Promise<PdfText | { ok: false; code: "sandbox"; message: string }> {
	if (o.iso.mode === "worker") return askWorker(o.iso.socket, bytes, lim, (o.timeoutMs ?? 30_000) + 5000);
	const child = spawnIsolated(EXTRACTOR, [String(lim.pages), String(lim.textBytes)], { ...o, iso: o.iso });
	const out: Buffer[] = [];
	child.stdout!.on("data", (c: Buffer) => { if (out.reduce((n, x) => n + x.length, 0) < 3 * lim.textBytes) out.push(c); });
	child.stdin!.on("error", () => {});
	child.stdin!.end(bytes);
	const timeoutMs = o.timeoutMs ?? 30_000;
	const code = await new Promise<number | string | null>((ok) => {
		const timer = setTimeout(() => { child.kill("SIGKILL"); ok("timeout"); }, timeoutMs);
		child.on("exit", (c, sig) => { clearTimeout(timer); ok(c ?? sig); });
		child.on("error", () => { clearTimeout(timer); ok("error"); });
	});
	if (code === "timeout") return { ok: false, code: "sandbox", message: `reading the PDF took longer than ${Math.round(timeoutMs / 1000)} s` };
	try { return JSON.parse(Buffer.concat(out).toString("utf8").trim().split("\n").at(-1) ?? "") as PdfText; }
	catch { return { ok: false, code: "sandbox", message: code === 97 ? "the sandbox could not isolate the reader" : `the reader ended without an answer (${String(code)}; memory or a crash)` }; }
}

/** A PDF read by the pdf worker: a line of JSON with the limits and the size, the bytes, and one line of JSON back. */
export function askWorker(socket: string, bytes: Buffer, lim: { pages: number; textBytes: number }, timeoutMs: number): Promise<PdfText | { ok: false; code: "sandbox"; message: string }> {
	return new Promise((done) => {
		const out: Buffer[] = [];
		let size = 0, over = false;
		const c = net.createConnection(socket);
		const fail = (message: string) => { over = true; c.destroy(); done({ ok: false, code: "sandbox", message }); };
		const timer = setTimeout(() => fail(`reading the PDF took longer than ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
		c.on("connect", () => { c.write(JSON.stringify({ pages: lim.pages, textBytes: lim.textBytes, bytes: bytes.length }) + "\n"); c.end(bytes); });
		c.on("data", (d: Buffer) => { size += d.length; if (size > 3 * lim.textBytes + 4096) { clearTimeout(timer); fail("the pdf worker answered too much"); } else out.push(d); });
		c.on("error", (e) => { clearTimeout(timer); if (!over) fail(`the pdf worker cannot be reached (${(e as NodeJS.ErrnoException).code ?? e.message})`); });
		c.on("close", () => {
			clearTimeout(timer);
			if (over) return;
			try { done(JSON.parse(Buffer.concat(out).toString("utf8").trim()) as PdfText); }
			catch { done({ ok: false, code: "sandbox", message: "the pdf worker ended without an answer" }); }
		});
	});
}

export async function startSandboxHost(o: { space?: string } = {}) {
	const iso = isolation();
	const conn = connectSpace(o.space);
	const space = conn.space;
	const presence = announce(space, "sandbox");
	const open = new Set<string>();
	let stopping = false;
	const halt = new AbortController();
	const hide = hiddenDirs(o.space ?? process.env.FORUM_SPACE ?? DEFAULT_SPACE);
	const timeoutMs = Math.max(1000, Number(process.env.FORUM_PDF_TIMEOUT_S || 30) * 1000), memoryMb = Math.max(64, Number(process.env.FORUM_PDF_MEMORY_MB || 256));

	// without isolation the process says so and takes nothing: a PDF stays unread rather than opened unguarded
	const procId = randomBytes(6).toString("hex");
	let infoLease: string | null = null;
	const publish = async () => {
		if (!iso) return;
		try {
			if (infoLease) { try { await space.renew(infoLease, 30_000); return; } catch { infoLease = null; } }
			infoLease = (await space.write({ type: "SandboxInfo", fields: { procId, isolation: iso.mode, pdf: true, ts: Date.now() } satisfies SandboxInfo as never }, null, 30_000)).id;
		} catch (e) { if (!stopping) console.error("[sandbox] publishing failed", (e as Error).message); }
	};
	await publish();
	const beat = setInterval(() => void publish(), 10_000); beat.unref?.();

	const answerOne = async (): Promise<boolean> => {
		if (!(await awaitWork(space, { type: "PdfRequest" }, halt.signal))) return false;
		const t = await space.createTransaction(LEASE_MS);
		open.add(t.id);
		const stop = keepAlive(space, t.id, LEASE_MS);
		try {
			const e = await space.take({ type: "PdfRequest" }, NO_WAIT, { txn: t.id });
			if (!e) { await space.abort(t.id); return false; }
			const req = e.fields as unknown as PdfRequest, began = Date.now();
			const parts = (await space.readAll({ type: "PdfPart", fields: { jobId: req.jobId } }, { limit: req.parts + 2 })).map((x) => x.fields as { part: number; data: string }).sort((a, b) => a.part - b.part);
			const bytes = Buffer.from(parts.map((p) => p.data).join(""), "base64");
			const whole = parts.length === req.parts && parts.every((p, i) => p.part === i) && createHash("sha256").update(bytes).digest("hex") === req.hash;
			const result: PdfResult["result"] = !whole ? { ok: false, code: "sandbox", message: "the PDF arrived incomplete" }
				: await extractIsolated(bytes, { pages: Math.min(req.maxPages, PDF_LIMITS.pages), textBytes: Math.min(req.maxText, PDF_LIMITS.textBytes) }, { iso: iso!, hide, timeoutMs, memoryMb });
			await space.write({ type: "PdfResult", fields: { jobId: req.jobId, result, ms: Date.now() - began, ts: Date.now() } satisfies PdfResult as never }, t.id, RESULT_LEASE_MS);
			await space.commit(t.id);
			// the parts are nobody's now (the sources process also removes them; their lease ends them in any case)
			while (await space.take({ type: "PdfPart", fields: { jobId: req.jobId } }, NO_WAIT).catch(() => null)) { /* every part */ }
			return true;
		} catch (err) {
			await space.abort(t.id).catch(() => {});
			if (err instanceof TransactionError) return true;
			throw err;
		} finally { stop(); open.delete(t.id); }
	};
	const loops = iso ? [0, 1].map(async () => {
		while (!stopping) {
			try { await answerOne(); }
			catch (e) { if (stopping) return; console.error("[sandbox] request failed", (e as Error).message); await new Promise((r) => setTimeout(r, 1000)); }
		}
	}) : [];
	return {
		isolation: iso?.mode ?? null,
		async close() {
			stopping = true; halt.abort(); clearInterval(beat);
			await Promise.allSettled([...open].map((id) => space.abort(id)));
			await Promise.race([Promise.allSettled(loops), new Promise((r) => setTimeout(r, 3000))]);
			if (infoLease) await space.cancel(infoLease).catch(() => {});
			await presence.stop(); conn.close();
		},
	};
}

/** How long the sources process waits for a PDF's text (FORUM_PDF_WAIT_S, default 60 s). */
export const pdfWaitMs = () => Math.max(1000, Number(process.env.FORUM_PDF_WAIT_S || 60) * 1000);

/** The sources process's side: hands a PDF to the sandbox and waits for its text. Null when no sandbox is there to
 *  read it, or none answered in time (the request is then withdrawn). */
export async function askPdf(space: SpaceLike, bytes: Buffer, lim: { pages: number; textBytes: number }, waitMs = pdfWaitMs()): Promise<PdfResult["result"] | null> {
	if (!(await space.readIfExists({ type: "SandboxInfo" }, NO_WAIT))) return null;
	const jobId = `pdf-${randomBytes(8).toString("hex")}`, data = bytes.toString("base64"), parts = Math.ceil(data.length / PDF_PART);
	const ttl = waitMs + 120_000;
	try {
		for (let part = 0; part < parts; part++) await space.write({ type: "PdfPart", fields: { jobId, part, data: data.slice(part * PDF_PART, (part + 1) * PDF_PART) } }, null, ttl);
		const req: PdfRequest = { jobId, parts, hash: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, maxPages: lim.pages, maxText: lim.textBytes, ts: Date.now() };
		await space.write({ type: "PdfRequest", fields: req as never }, null, ttl);
		let r = null as Awaited<ReturnType<SpaceLike["take"]>>;
		for (const end = Date.now() + waitMs; !r && Date.now() < end; ) r = await space.take({ type: "PdfResult", fields: { jobId } }, Math.min(20_000, Math.max(1, end - Date.now())));
		if (!r) { await space.take({ type: "PdfRequest", fields: { jobId } }, NO_WAIT).catch(() => null); return null; }
		return (r.fields as unknown as PdfResult).result;
	} finally { while (await space.take({ type: "PdfPart", fields: { jobId } }, NO_WAIT).catch(() => null)) { /* every part */ } }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const host = await startSandboxHost();
	console.log(host.isolation ? `[sandbox] reading PDFs for ${process.env.FORUM_SPACE || DEFAULT_SPACE}, isolated by ${host.isolation}` : "[sandbox] no isolation here (neither FORUM_PDF_WORKER nor user namespaces): no PDF is read");
	const shutdown = async () => { setTimeout(() => process.exit(0), 4000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
