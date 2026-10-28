// A load test against a running spaces-mmo (docs/betrieb.md, "Lasttest"): N guest figures play over the web process
// like pages do (HTTP for the guest login, the game socket for commands): they pick up driftwood and shells, carry the
// wood to the fire and put it in, sell shells to Kalle, look at the market and walk through the exits. Every command is
// timed from sending it to the first answer meant for the figure (its own position, a message to it, an error, the
// next room). No imports: it runs with a plain `node` (types stripped) next to the web process, without node_modules.
//
//   LOAD_URL=http://127.0.0.1:3900   the web process (behind nginx: the loopback port, so x-forwarded-for counts)
//   LOAD_BOTS=100                     figures at once
//   LOAD_SECONDS=600                  how long they play
//   LOAD_OUT=/tmp/mmo-load            directory for commands.jsonl (one line per command) and bots.json (who they are)
//
// Each figure sends its own x-forwarded-for (198.18.x.y, the benchmark range): the web process counts guests and
// requests per client address, and one address for all would stop at the guest quota. At the end every figure logs out;
// live-load-cleanup.ts then removes them from the world (tests/perf/live-load-cleanup.ts).
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const env = (k: string, d: string) => process.env[k] || d;
const BASE = env("LOAD_URL", "http://127.0.0.1:3900"), BOTS = Number(env("LOAD_BOTS", "100")), SECONDS = Number(env("LOAD_SECONDS", "600"));
const OUT = env("LOAD_OUT", "/tmp/mmo-load"), ANSWER_MS = 10_000;

type Obj = { id: string; kind: "item" | "exit" | "beacon"; name: string; location: string; x: number; y: number };
type Char = { charId: string; name: string; x: number; y: number };
type Frame = { t: string; [k: string]: any };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

class Bot {
	readonly n: number;
	readonly ip: string;
	cookie = "";
	me = { charId: "", name: "" };
	room = "";
	objs = new Map<string, Obj>();
	chars = new Map<string, Char>();
	frames: Frame[] = [];
	/** Frames ever received; a frame's `seq` is its number, so a wait survives the trimming of `frames`. */
	seq = 0;
	ws: WebSocket | null = null;
	commands = 0;
	constructor(n: number) { this.n = n; this.ip = `198.18.${Math.floor(n / 250)}.${(n % 250) + 1}`; }

	async post(path: string, body: unknown = {}): Promise<any> {
		const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", "x-mmo": "1", "x-forwarded-for": this.ip, ...(this.cookie ? { cookie: this.cookie } : {}) }, body: JSON.stringify(body) });
		const set = r.headers.get("set-cookie");
		if (set) { const v = /mmo_sid=([^;]*)/.exec(set)?.[1] ?? ""; this.cookie = v ? `mmo_sid=${v}` : ""; }
		const b = await r.json();
		if (r.status !== 200) throw new Error(`${path}: ${r.status} ${JSON.stringify(b)}`);
		return b;
	}
	async join(): Promise<void> {
		await this.post("/api/guest");
		const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws", { headers: { cookie: this.cookie, "x-forwarded-for": this.ip } } as never);
		this.ws = ws;
		ws.onmessage = (e) => this.onFrame(JSON.parse(String(e.data)));
		await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error("websocket did not open")); });
		const hello = await this.until((f) => f.t === "hello", 0, ANSWER_MS);
		if (!hello) throw new Error("no hello");
		this.me = { charId: hello.me.charId, name: hello.me.name };
	}
	onFrame(f: Frame): void {
		f.seq = ++this.seq;
		this.frames.push(f);
		if (this.frames.length > 400) this.frames.splice(0, 200);
		if (f.t === "hello") {
			this.room = f.room.roomId;
			this.objs = new Map((f.objs as Obj[]).map((o) => [o.id, o]));
			this.chars = new Map((f.chars as Char[]).map((c) => [c.charId, c]));
		} else if (f.t === "obj") this.objs.set(f.o.id, f.o);
		else if (f.t === "objgone") this.objs.delete(f.id);
		else if (f.t === "char") this.chars.set(f.c.charId, f.c);
		else if (f.t === "gone") this.chars.delete(f.charId);
	}
	/** The first frame after frame number `after` that satisfies `pred`; null after `ms`. */
	async until(pred: (f: Frame) => boolean, after: number, ms: number): Promise<Frame | null> {
		const end = Date.now() + ms;
		for (;;) {
			const f = this.frames.find((x) => x.seq > after && pred(x));
			if (f) return f;
			if (Date.now() > end) return null;
			await sleep(10);
		}
	}
	/** Sends one command and times it to its first answer for this figure. */
	async cmd(kind: string, line: string): Promise<void> {
		const from = this.seq, t0 = performance.now(), at = Date.now();
		this.ws!.send(JSON.stringify({ t: "cmd", line }));
		this.commands++;
		const f = await this.until((x) =>
			(x.t === "char" && x.c.charId === this.me.charId) || x.t === "hello" || x.t === "trade"
			// the answer to a command comes from the figure itself (its look, its inventory, its error) or is meant for it
			|| (x.t === "msg" && (x.m.from === this.me.name || x.m.toMe === true)), from, ANSWER_MS);
		const ms = performance.now() - t0;
		const outcome = !f ? "timeout" : f.t === "msg" && f.m.kind === "error" ? "refused" : "ok";
		appendFileSync(join(OUT, "commands.jsonl"), JSON.stringify({ at, bot: this.n, kind, line, ms: Math.round(ms), outcome }) + "\n");
	}

	pos(): { x: number; y: number } { return this.chars.get(this.me.charId) ?? { x: 0, y: 0 }; }
	carried(re: RegExp): Obj[] { return [...this.objs.values()].filter((o) => o.kind === "item" && o.location === this.me.charId && re.test(o.name)); }
	/** The next thing to do, from what the figure sees and carries. */
	next(): [string, string] {
		const me = this.pos();
		const beacon = [...this.objs.values()].find((o) => o.kind === "beacon");
		if (beacon && this.carried(/treibholz/i).length) {
			return dist(me, beacon) > 1 ? ["walk-fire", `move ${beacon.x} ${beacon.y + 1}`] : ["feed", "lege treibholz ins feuer"];
		}
		const kalle = [...this.chars.values()].some((c) => c.name === "Kalle");
		if (kalle && this.carried(/muschel/i).length && Math.random() < 0.6) return ["trade", "biete muschel an Kalle für 1 münze"];
		const ground = [...this.objs.values()].filter((o) => o.kind === "item" && o.location === this.room && /treibholz|muschel/i.test(o.name)).sort((a, b) => dist(me, a) - dist(me, b));
		if (ground.length && Math.random() < 0.8) {
			const it = ground[0]!;
			return dist(me, it) > 1 ? ["walk", `move ${it.x} ${it.y}`] : ["get", `nimm ${it.name.toLowerCase()}`];
		}
		const r = Math.random();
		if (r < 0.1) return ["info", pick(["markt", "inventar", "wer", "schau"])];
		const exits = [...this.objs.values()].filter((o) => o.kind === "exit");
		if (exits.length && r < 0.6) return ["go", `go ${pick(exits).name.toLowerCase()}`];
		return ["walk", `move ${Math.max(1, me.x + Math.floor(Math.random() * 7) - 3)} ${Math.max(1, me.y + Math.floor(Math.random() * 7) - 3)}`];
	}
	async play(until: number): Promise<void> {
		while (Date.now() < until) {
			const [kind, line] = this.next();
			try { await this.cmd(kind, line); } catch { /* a closed socket ends this figure's play below */ }
			if (this.ws?.readyState !== WebSocket.OPEN) return;
			await sleep(1000 + Math.random() * 2000);
		}
	}
	async leave(): Promise<void> {
		const ws = this.ws; this.ws = null;
		if (ws && ws.readyState === WebSocket.OPEN) await new Promise<void>((r) => { ws.onclose = () => r(); ws.close(); setTimeout(r, 3000); });
		await this.post("/api/logout").catch(() => {});
	}
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "commands.jsonl"), "");
const bots = Array.from({ length: BOTS }, (_, i) => new Bot(i));
const t0 = Date.now();
// joined in small groups: a page load per figure, not a hundred logins in one millisecond
for (let i = 0; i < bots.length; i += 10) {
	const group = bots.slice(i, i + 10);
	const joined = await Promise.allSettled(group.map((b) => b.join()));
	joined.forEach((r, k) => { if (r.status === "rejected") console.error(`bot ${i + k}: ${(r.reason as Error).message}`); });
	writeFileSync(join(OUT, "bots.json"), JSON.stringify(bots.filter((b) => b.me.charId).map((b) => ({ n: b.n, ...b.me })), null, 1));
}
const playing = bots.filter((b) => b.ws);
console.log(`${playing.length} of ${BOTS} figures joined in ${((Date.now() - t0) / 1000).toFixed(1)} s; playing ${SECONDS} s`);
const until = Date.now() + SECONDS * 1000;
const ticker = setInterval(() => console.log(`${new Date().toISOString()} commands ${playing.reduce((n, b) => n + b.commands, 0)}, open sockets ${playing.filter((b) => b.ws?.readyState === WebSocket.OPEN).length}`), 60_000);
await Promise.all(playing.map((b) => b.play(until)));
clearInterval(ticker);
await Promise.all(playing.map((b) => b.leave()));
console.log(`done: ${playing.reduce((n, b) => n + b.commands, 0)} commands; figures in ${join(OUT, "bots.json")}`);
