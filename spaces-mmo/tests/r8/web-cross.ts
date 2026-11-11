// The Rust web process held against the TypeScript one on one stack (docs/rust-portierung.en.md, R8.5): an account
// registered on one logs in on the other, one cookie opens a game socket on both, and what the two sockets are told
// about the same play is compared frame by frame (the clock's values masked).
//
//   node --experimental-strip-types --no-warnings tests/r8/web-cross.ts <oracle spaces-mmo dir> <mmo-web binary>
//
// The stack, the space process, the world worker and the TypeScript web process are the oracle's; the Rust web process
// is started by the oracle's tests/stack.ts as SPACES_MMO_WEB_CMD. Prints each difference and ends with 1 when there is
// one.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [oracleArg, binArg] = process.argv.slice(2);
if (!oracleArg || !binArg) { console.error("usage: web-cross.ts <oracle spaces-mmo dir> <mmo-web binary>"); process.exit(2); }
const oracle = resolve(oracleArg), bin = resolve(binArg);
process.chdir(oracle);
const stackMod = await import(pathToFileURL(`${oracle}/tests/stack.ts`).href);
const webMod = await import(pathToFileURL(`${oracle}/server/index.ts`).href);
const { startStack, Player } = stackMod;

let differences = 0;
const differ = (what: string, ts: unknown, rust: unknown) => {
	differences++;
	console.log(`DIFF ${what}\n  ts:   ${JSON.stringify(ts).slice(0, 1500)}\n  rust: ${JSON.stringify(rust).slice(0, 1500)}`);
};
/** The values that move with the clock or are drawn anew. */
const VOLATILE = new Set(["now", "serverNowMs", "worldMs", "at", "until", "startedAt", "pid", "procId", "id"]);
const mask = (v: unknown, key = ""): unknown => {
	if (Array.isArray(v)) return v.map((x) => mask(x));
	if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, VOLATILE.has(k) && typeof x === "number" ? "#" : k === "id" && key === "m" ? "#" : mask(x, k)]));
	return v;
};
const same = (what: string, ts: unknown, rust: unknown) => { const a = JSON.stringify(mask(ts)), b = JSON.stringify(mask(rust)); if (a !== b) differ(what, mask(ts), mask(rust)); return a === b; };

const stack = await startStack();
let ts: { url: string; close(): Promise<void> } | null = null;
try {
	await stack.npcProcess();
	ts = await webMod.startServer({ port: 0, space: stack.world, accounts: stack.accounts, accountOptions: { setupToken: "cross-setup" } });
	process.env.SPACES_MMO_WEB_CMD = bin;
	const rust = await stack.webProcess({ SPACES_MMO_SETUP_TOKEN: "cross-setup" });
	const T = ts!.url, R = rust.url;

	// accounts: registered on one, logged in on the other
	const a = new Player(T), b = new Player(R);
	const ra = await a.post("/api/register", { name: "Kreuzer", password: "geheim-12345", setupToken: "cross-setup" });
	const rb = await b.post("/api/register", { name: "Querer", password: "geheim-67890" });
	same("register (the name aside)", { ...ra, body: { ...ra.body, account: { ...ra.body.account, name: "-", admin: "-" } } }, { ...rb, body: { ...rb.body, account: { ...rb.body.account, name: "-", admin: "-" } } });
	if (ra.body.account?.admin !== true) differ("the setup token makes an admin (ts)", ra, null);
	const a2 = new Player(R), b2 = new Player(T);
	const la = await a2.post("/api/login", { name: "kreuzer", password: "geheim-12345" }), lb = await b2.post("/api/login", { name: "Querer", password: "geheim-67890" });
	if (la.status !== 200 || lb.status !== 200) differ("login across", la, lb);
	same("me of Kreuzer (ts, rust)", await a.me(), await a2.me());
	same("me of Querer (rust, ts)", await b2.me(), await b.me());
	for (const [p, body] of [["/api/login", { name: "kreuzer", password: "falsch-falsch" }], ["/api/register", { name: "Kreuzer", password: "geheim-12345" }], ["/api/register", { name: "x", password: "1" }], ["/api/nichts", {}], ["/api/alias", { alias: "Querer" }]] as const) {
		const x = await new Player(T).post(p, body), y = await new Player(R).post(p, body);
		same(`POST ${p} ${JSON.stringify(body)}`, x, y);
	}
	for (const [p, who] of [["/api/admin/settings", "admin"], ["/api/admin/reports", "admin"], ["/api/admin/settings", "player"], ["/api/stats", "admin"], ["/api/system", "admin"]] as const) {
		const get = async (base: string, cookie: string) => { const r = await fetch(base + p, { headers: { cookie } }); return { status: r.status, body: await r.json() }; };
		const cookie = who === "admin" ? a.cookie : b.cookie;
		const x = await get(T, cookie), y = await get(R, cookie);
		if (p === "/api/system") { if (x.status !== y.status || JSON.stringify(Object.keys(x.body)) !== JSON.stringify(Object.keys(y.body))) differ("GET /api/system", x, y); continue; }
		same(`GET ${p} as ${who}`, x, y);
	}
	const plain = async (base: string, p: string, init?: RequestInit) => { const r = await fetch(base + p, init); return { status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), body: (await r.text()).slice(0, 200) }; };
	for (const p of ["/healthz", "/assets/leuchtfeuer/CREDITS.md", "/assets/leuchtfeuer/../world.json", "/assets/Leuchtfeuer/x.png", "/nirgends"]) same(`GET ${p}`, await plain(T, p), await plain(R, p));
	same("GET /api/me without x-mmo POST", await plain(T, "/api/guest", { method: "POST" }), await plain(R, "/api/guest", { method: "POST" }));
	same("PUT /api/me", await plain(T, "/api/me", { method: "PUT" }), await plain(R, "/api/me", { method: "PUT" }));

	// play: the same character on both sockets; what both are told after the same commands
	const onTs = new Player(T), onRust = new Player(R);
	onTs.cookie = onRust.cookie = a.cookie;
	const helloTs = await onTs.play(), helloRust = await onRust.play();
	same("hello", helloTs, helloRust);
	const start = { ts: onTs.frames.length, rust: onRust.frames.length };
	for (const line of ["schau", "sage Hallo zusammen", "inventar", "wer", "hilfe", "gehe nord", "schau", "gehe süd", "nimm stein", "zeit"]) {
		onTs.send(line);
		await new Promise((r) => setTimeout(r, 700));
	}
	onTs.ws!.send(JSON.stringify({ t: "step", seq: 1, dx: 1, dy: 0 }));
	onRust.ws!.send(JSON.stringify({ t: "step", seq: 2, dx: -1, dy: 0 }));
	await new Promise((r) => setTimeout(r, 2500));
	const strip = (fs: Array<Record<string, unknown>>) => fs.filter((f) => f.t !== "time" && f.t !== "chats" && f.t !== "chatlog" && f.t !== "chatme").map((f) => { const { ack: _, ...rest } = f; return rest; });
	const fTs = strip(onTs.frames.slice(start.ts) as never), fRust = strip(onRust.frames.slice(start.rust) as never);
	const n = Math.max(fTs.length, fRust.length);
	let shown = 0;
	for (let i = 0; i < n && shown < 12; i++) if (!same(`frame ${i} after play (${(fTs[i] as { t?: string })?.t} / ${(fRust[i] as { t?: string })?.t})`, fTs[i], fRust[i])) shown++;
	console.log(`frames after play: ts ${fTs.length}, rust ${fRust.length}`);
	await onTs.leave(); await onRust.leave();
} finally {
	await ts?.close();
	await stack.close();
}
console.log(differences ? `${differences} difference(s)` : "no differences");
process.exit(differences ? 1 : 0);
