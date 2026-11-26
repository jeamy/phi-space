// One live run against a running forum (phase 12 of docs/gemeinsame-planung-plan-2026-11-22.en.md): creates a room and a
// plan task, starts a run, waits for its end and writes what it left into a directory: the result as Markdown with its
// appendix, each table's document, the outcome, the snapshot and a summary. It calls real models through the stack it
// talks to: it costs tokens. Not part of `npm test`.
//
//   node --experimental-strip-types tests/live/run.ts --url http://127.0.0.1:4130 --token <admin password> \
//     --brief docs/live/brief-website.md --doc docs/live/website-requirements.md --models a,b,c \
//     --way both --rounds 3 --budget-usd 6 --out <dir> [--lang en] [--repo name --ref HEAD] [--per-model 1] [--max-min 90]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const args = process.argv.slice(2), many = (k: string) => args.flatMap((a, i) => (a === `--${k}` && args[i + 1] ? [args[i + 1]!] : []));
const one = (k: string, dflt = "") => many(k).at(-1) ?? dflt;
const url = one("url", "http://127.0.0.1:4100"), token = one("token", process.env.FORUM_ADMIN_PASSWORD ?? ""), out = one("out");
if (!one("brief") || !out || many("models").join(",").split(",").filter(Boolean).length < 3) throw new Error("--brief FILE --out DIR --models a,b,c are needed");
const models = many("models").join(",").split(",").map((m) => m.trim()).filter(Boolean);
const room = one("room", `live-${Date.now().toString(36)}`);
const call = async (path: string, body?: unknown): Promise<any> => {
	const res = await fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token ? { "x-admin-token": token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	const text = await res.text();
	if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 300)}`);
	return res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
};
const md = (path: string) => call(path).catch(() => null) as Promise<string | null>;

await mkdir(out, { recursive: true });
const docs = await Promise.all(many("doc").map(async (f) => ({ name: basename(f), text: await readFile(f, "utf8") })));
const repo = one("repo") ? { name: one("repo"), ref: one("ref", "HEAD") } : undefined;
const { blockId } = await call(`/api/rooms/${room}/task`, { brief: (await readFile(one("brief"), "utf8")).trim(), lang: one("lang", "en"), ...(docs.length ? { docs } : {}), ...(repo ? { repo } : {}) });
const started = Date.now();
const { runId } = await call(`/api/rooms/${room}/run`, { blockId, way: one("way", "both"), rounds: Number(one("rounds", "3")), models, perModel: Number(one("per-model", "1")), ...(one("budget-usd") ? { budgetUsd: Number(one("budget-usd")) } : {}), ...(one("budget-tokens") ? { budgetTokens: Number(one("budget-tokens")) } : {}) });
console.log(`room ${room} block ${blockId} run ${runId}: ${url}/?room=${room}`);

const maxMs = Number(one("max-min", "90")) * 60_000;
let snap: any, seen = 0, stopped = false;
for (;;) {
	await new Promise((ok) => setTimeout(ok, 5000));
	snap = await call(`/api/rooms/${room}`).catch((e) => { console.log(`(snapshot failed: ${(e as Error).message})`); return snap; });
	for (const l of (snap?.lines ?? []).filter((l: { ts: number }) => l.ts > seen)) { console.log(`${new Date(l.ts).toISOString().slice(11, 19)} ${l.text}`); seen = l.ts; }
	if (snap?.run && !snap.run.active) break;
	if (!stopped && Date.now() - started > maxMs) { stopped = true; console.log(`stopping the run after ${one("max-min", "90")} min`); await call(`/api/rooms/${room}/stop`, {}); }
}
const minutes = (Date.now() - started) / 60_000, block = snap.blocks.find((b: { blockId: string }) => b.blockId === blockId);
const outcome = await call(`/api/rooms/${room}/outcome/${blockId}`).catch(() => null);
const result = await md(`/api/plan/${room}/${blockId}.md`);
if (result) await writeFile(join(out, "result.md"), result);
for (const t of ["A", "B"]) { const text = await md(`/api/plan/${room}/${blockId}.md?table=${t}`); if (text) await writeFile(join(out, `table-${t}.md`), text); }
for (const t of ["A", "B"]) { const talk = await call(`/api/rooms/${room}/talk/${blockId}?table=${t}`).catch(() => null); if (talk) await writeFile(join(out, `talk-${t}.json`), JSON.stringify(talk, null, 1)); }
await writeFile(join(out, "snapshot.json"), JSON.stringify(snap, null, 1));
if (outcome) await writeFile(join(out, "outcome.json"), JSON.stringify(outcome, null, 1));
const summary = { room, blockId, runId, models, minutes: Math.round(minutes * 10) / 10, stoppedByScript: stopped, run: snap.run, accepted: block?.accepted ?? null, result: block?.result ?? null, heads: block?.heads ?? null, doc: block?.doc ?? null, resultBytes: result?.length ?? 0, stat: outcome?.stat ?? null };
await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
