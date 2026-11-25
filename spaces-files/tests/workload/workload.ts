// The repeatable workload fixture (docs/zanzibar-agent-filesystem-plan.en.md, phase 5: "Record queue wait, operation
// latency, evaluator work, live and free file sizes, together with tenant count, directory depth, concurrency and
// hardware"). A seeded mix of reads, saves, listings and directory creations by several users per tenant in a shared
// workspace whose files sit `depth` directories deep, run by `concurrency` workers through the adapters' operation
// table (so the counters see what the agent socket and the browser would), on an on-disk store. The same parameters
// and seed give the same operation mix; the times are this machine's.
//
//   node --experimental-strip-types tests/workload/workload.ts [--tenants 4] [--users 4] [--depth 4] [--files 8]
//     [--concurrency 8] [--ops 2000] [--seed 1] [--bytes 2048] [--dir DIR (kept)] [--out report.json]
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluator } from "../../server/metrics.ts";
import { FilesService } from "../../server/service.ts";
import { FILE_OPS, runOp } from "../../server/wire.ts";

export type WorkloadParams = { tenants: number; users: number; depth: number; files: number; concurrency: number; ops: number; seed: number; bytes: number; dir?: string };
export const DEFAULTS: WorkloadParams = { tenants: 4, users: 4, depth: 4, files: 8, concurrency: 8, ops: 2000, seed: 1, bytes: 2048 };

/** A small seeded generator (mulberry32): the operation mix depends on the seed alone. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const dirBytes = (dir: string): number => {
	let n = 0;
	for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) n += statSync(join(e.parentPath, e.name)).size;
	return n;
};

export async function runWorkload(p: WorkloadParams) {
	const dir = p.dir ?? mkdtempSync(join(os.tmpdir(), "spaces-files-wl-"));
	const o = { dataDir: join(dir, "data"), stateDir: join(dir, "state"), blobDir: join(dir, "blobs") };
	const svc = await FilesService.open(o);
	try {
		const call = async (h: string, op: string, args: Record<string, unknown>) => {
			const r = await runOp(FILE_OPS, svc, h, op, args);
			if (!r.ok) throw Object.assign(new Error(`${op}: ${r.error.code} ${r.error.message}`), { code: r.error.code, currentVersion: r.error.currentVersion });
			return r.value as any;
		};
		const opId = async (h: string) => (await call(h, "issueOperationIds", { count: 1 }))[0] as string;
		// setup: per tenant an administrator, users, the shared workspace with the users as editors, the directory chain
		const users: Array<{ tenant: string; handle: string }> = [];
		const chain = Array.from({ length: p.depth }, (_, i) => `d${i}`);
		for (let t = 0; t < p.tenants; t++) {
			const tenant = `t${t}`;
			await svc.createTenant(tenant, { actorId: "adm", homeName: "adm", issuer: "wl", subject: `${tenant}-adm` });
			const adm = (await svc.login(tenant, "user", { issuer: "wl", subject: `${tenant}-adm` })).handle;
			await svc.createWorkspace(adm, "team", { kind: "user", id: "adm" }, await opId(adm));
			for (let u = 0; u < p.users; u++) {
				const ident = { issuer: "wl", subject: `${tenant}-u${u}` };
				await svc.registerActor(adm, "user", `u${u}`, `u${u}`, ident, await opId(adm));
				await svc.grant(adm, "team", ".", "editor", { kind: "user", id: `u${u}` }, await opId(adm));
				users.push({ tenant, handle: (await svc.login(tenant, "user", ident)).handle });
			}
			for (let i = 1; i <= p.depth; i++) await call(adm, "mkdir", { workspace: "team", path: chain.slice(0, i).join("/"), operationId: await opId(adm) });
		}
		const leaf = chain.join("/");
		const fileAt = (i: number) => `${leaf}/f${i}.txt`;
		const versions = new Map<string, number>();
		const body = (r: () => number): string => Buffer.alloc(p.bytes, Math.floor(r() * 256)).toString("base64");
		const mix: Record<string, number> = {}, outcomes: Record<string, number> = {};
		const count = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

		const ev0 = { ...evaluator };
		const start = performance.now();
		// each worker draws a fixed share from its own seeded generator, so the mix never depends on timing or outcomes
		await Promise.all(Array.from({ length: p.concurrency }, async (_, w) => {
			const r = rng(p.seed * 1000 + w);
			for (let left = Math.floor(p.ops / p.concurrency) + (w < p.ops % p.concurrency ? 1 : 0); left > 0; left--) {
				const who = users[Math.floor(r() * users.length)];
				const f = Math.floor(r() * p.files);
				const key = `${who.tenant}/${f}`;
				const x = r();
				const op = x < 0.55 ? "read" : x < 0.85 ? "write" : x < 0.97 ? "list" : "mkdir";
				count(mix, op);
				try {
					if (op === "read") {
						if (!versions.has(key)) { count(outcomes, "read:absent"); continue; }
						await call(who.handle, "read", { workspace: "team", path: fileAt(f) });
					} else if (op === "write") {
						const v = versions.get(key) ?? 0;
						const got = await call(who.handle, "write", { workspace: "team", path: fileAt(f), contents: body(r), expectedVersion: v, operationId: await opId(who.handle) });
						versions.set(key, Math.max(versions.get(key) ?? 0, got.version));
					} else if (op === "list") {
						await call(who.handle, "list", { workspace: "team", path: leaf });
					} else {
						await call(who.handle, "mkdir", { workspace: "team", path: `${leaf}/m${Math.floor(r() * 64)}`, operationId: await opId(who.handle) });
					}
					count(outcomes, `${op}:ok`);
				} catch (e) {
					const c = (e as { code?: string; currentVersion?: number }).code ?? "error";
					// a save that lost a race learns the current version; the next save of that file uses it
					if (c === "versionConflict") versions.set(key, Math.max(versions.get(key) ?? 0, (e as { currentVersion?: number }).currentVersion ?? 0));
					count(outcomes, `${op}:${c}`);
				}
			}
		}));
		const wallMs = performance.now() - start;
		const m = svc.metrics.snapshot();
		return {
			params: { ...p, dir: undefined },
			hardware: { cpu: os.cpus()[0]?.model ?? "unknown", cores: os.cpus().length, memoryBytes: os.totalmem(), platform: `${os.platform()} ${os.release()}`, node: process.version },
			mix, outcomes,
			wallMs: Math.round(wallMs), opsPerSecond: Math.round(p.ops / (wallMs / 1000)),
			queueWait: m.queueWait, queueRun: m.queueRun,
			latency: Object.fromEntries(Object.entries(m.ops).map(([k, v]) => [k, { count: v.latency.count, p50Ms: v.latency.p50Ms, p99Ms: v.latency.p99Ms, maxMs: v.latency.maxMs }])),
			evaluator: { decisions: evaluator.decisions - ev0.decisions, lookups: evaluator.lookups - ev0.lookups, maxPerDecision: evaluator.maxPerDecision },
			store: svc.storeSizes(), blobBytes: dirBytes(o.blobDir),
		};
	} finally {
		await svc.close();
		if (p.dir === undefined) rmSync(dir, { recursive: true, force: true });
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const p: WorkloadParams = { ...DEFAULTS };
	let out: string | null = null;
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i += 2) {
		const k = argv[i].replace(/^--/, ""), v = argv[i + 1];
		if (k === "out") out = v;
		else if (k === "dir") p.dir = v;
		else if (Object.hasOwn(DEFAULTS, k) && /^\d+$/.test(v ?? "")) (p as unknown as Record<string, number>)[k] = Number(v);
		else { console.error(`unknown or malformed option --${k}`); process.exit(2); }
	}
	const report = await runWorkload(p);
	const text = JSON.stringify(report, null, 2);
	if (out) writeFileSync(out, text + "\n"); else console.log(text);
}
