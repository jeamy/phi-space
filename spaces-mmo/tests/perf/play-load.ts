// A load test of registered players who play the whole game against a running world (docs/betrieb.en.md, "Load test of
// players"): N players register over the web process as pages do and then, with a pause of 1 to 3 s between two commands,
// play activities of all four epochs picked at random: gather, feed the fire, trade with each other, the market board, a
// hut built the whole way, chest, rain barrel, bed, jetty, smokehouse, food, crafts, coop and pen, workshop, warehouse,
// mill, bakery, loom (cloth, pillow), quarry, clay pit, brickworks, chapel, field, department store, counting house, park,
// brewery, sand and glassworks, shipyard, the hatch, the island railway, signal fires, the large ship, beaming, and look
// around and walk through the exits. As epochs.ts does, the world is set up through its region spaces so each activity
// tests its commands and not the long way there: things put into the pack, a building placed beside the player (named
// load-…, taken away afterwards), `epoch.force` set to the epoch asked for (put back at the end).
//
// It changes the world it plays in (accounts, figures, what they made): run it against production only with a backup
// that is put back afterwards. Model calls: the players never speak to an NPC, and `llm.perMin` is 0 while they play
// (a line the rules do not read would go to the model; such a line counts as "model" in commands.jsonl).
//
//   LOAD_URL=http://127.0.0.1:3900      the web process (its loopback port: x-forwarded-for counts only from there)
//   LOAD_SPACES=west=tcp:127.0.0.1:3950,nord=…   every region's space
//   LOAD_BOTS=200  LOAD_SECONDS=1800  LOAD_EPOCH=4  LOAD_OUT=<dir> (commands.jsonl, activities.jsonl, bots.json, summary.json)
//   LOAD_NET=18                         the second octet of the players' addresses (198.<net>.x.y; another run, other addresses)
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { connectSpace } from "../../server/space.ts";
import { saveSettings } from "../../server/settings.ts";
import { loadWorld, walkable } from "../../server/engine/world.ts";
import { resolvePrototype, spawn } from "../../server/engine/prototypes.ts";
import { regionOfRoom } from "../../server/engine/regions.ts";
import type { BuildingFields } from "../../server/model.ts";
import type { PrototypeFields } from "../../shared/model.ts";

const env = (k: string, d: string) => process.env[k] || d;
const BASE = env("LOAD_URL", "http://127.0.0.1:3900"), BOTS = Number(env("LOAD_BOTS", "50")), SECONDS = Number(env("LOAD_SECONDS", "600"));
const EPOCH = Number(env("LOAD_EPOCH", "4")), OUT = env("LOAD_OUT", "load-out"), NET = Number(env("LOAD_NET", "18")), ANSWER_MS = 10_000;
const w = await loadWorld();
const conns = new Map(env("LOAD_SPACES", "").split(",").filter(Boolean).map((kv) => { const [id, addr] = kv.split("="); return [id!, connectSpace(addr!)] as const; }));
const space = (region: string): SpaceLike => { const c = conns.get(region); if (!c) throw new Error(`no space for the region ${region}`); return c.space; };
const REGIONS = [...conns.keys()];

type Frame = { t: string; seq?: number; [k: string]: any };
type Obj = { id: string; kind: string; name: string; location?: string; x: number; y: number; plan?: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]!;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const protoCache = new Map<string, PrototypeFields>();
const protoName = (key: string) => w.prototypes.find((p) => p.key === key)?.name ?? key;
/** Letters only (names take no digits). */
const letters = (n: number) => { let s = ""; do { s = "abcdefghijklmnopqrstuvwxyz"[n % 26] + s; n = Math.floor(n / 26); } while (n > 0); return s; };
const RUN = letters(Math.floor(Date.now() / 1000) % 17_576);

mkdirSync(OUT, { recursive: true });
for (const f of ["commands.jsonl", "activities.jsonl"]) writeFileSync(join(OUT, f), "");
const log = (file: string, o: object) => appendFileSync(join(OUT, file), JSON.stringify(o) + "\n");

class Skip extends Error {}
class Refused extends Error {}

class Bot {
	readonly n: number; readonly ip: string; readonly name: string;
	cookie = ""; me = ""; account = ""; room = ""; x = 0; y = 0;
	objs = new Map<string, Obj>(); chars = new Map<string, { charId: string; name: string; x: number; y: number }>();
	frames: Frame[] = []; seq = 0; ws: WebSocket | null = null; commands = 0; act = "";
	constructor(n: number) { this.n = n; this.ip = `198.${NET}.${Math.floor(n / 250)}.${(n % 250) + 1}`; this.name = `Last${RUN}${letters(n)}`.slice(0, 20); }

	get region(): string { return regionOfRoom(w, this.room) ?? REGIONS[0]!; }
	get space(): SpaceLike { return space(this.region); }
	async post(path: string, body: unknown = {}): Promise<{ status: number; body: any }> {
		const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", "x-mmo": "1", "x-forwarded-for": this.ip, ...(this.cookie ? { cookie: this.cookie } : {}) }, body: JSON.stringify(body) });
		const set = r.headers.get("set-cookie");
		if (set) { const v = /mmo_sid=([^;]*)/.exec(set)?.[1] ?? ""; this.cookie = v ? `mmo_sid=${v}` : ""; }
		return { status: r.status, body: await r.json().catch(() => ({})) };
	}
	async join(): Promise<void> {
		const r = await this.post("/api/register", { name: this.name, password: `last-${RUN}-passwort` });
		if (r.status !== 200) throw new Error(`register: ${r.status} ${JSON.stringify(r.body)}`);
		const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws", { headers: { cookie: this.cookie, "x-forwarded-for": this.ip } } as never);
		this.ws = ws;
		ws.onmessage = (e) => this.onFrame(JSON.parse(String(e.data)));
		ws.onclose = () => { if (this.ws === ws) this.ws = null; };
		await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error("websocket did not open")); });
		const hello = await this.until((f) => f.t === "hello", 0, ANSWER_MS);
		if (!hello) throw new Error("no hello");
		this.me = hello.me.charId;
		const ch = (await this.space.readAll({ type: "Character", fields: { charId: this.me } }))[0];
		this.account = String(ch?.fields.accountId ?? "");
	}
	onFrame(f: Frame): void {
		f.seq = ++this.seq;
		this.frames.push(f);
		if (this.frames.length > 400) this.frames.splice(0, 200);
		if (f.t === "hello") {
			this.room = f.room.roomId;
			this.objs = new Map((f.objs as Obj[]).map((o) => [o.id, o]));
			this.chars = new Map((f.chars as Array<{ charId: string; name: string; x: number; y: number }>).map((c) => [c.charId, c]));
			const meNow = this.chars.get(this.me || f.me.charId); if (meNow) { this.x = meNow.x; this.y = meNow.y; }
		} else if (f.t === "obj") this.objs.set(f.o.id, f.o);
		else if (f.t === "objgone") this.objs.delete(f.id);
		else if (f.t === "char") { this.chars.set(f.c.charId, f.c); if (f.c.charId === this.me) { this.x = f.c.x; this.y = f.c.y; } }
		else if (f.t === "gone") this.chars.delete(f.charId);
		// another player's offer to this one: taken after a moment, as a player would
		else if (f.t === "msg" && f.m.toMe && /„accept /.test(String(f.m.text)) && /bietet dir/.test(String(f.m.text))) {
			setTimeout(() => { if (this.ws) void this.cmd("tausch-annehmen", "accept", /Tausch|tauscht|angenommen|bekommst/).catch(() => {}); }, 1000 + Math.random() * 1000);
		}
	}
	async until(pred: (f: Frame) => boolean, after: number, ms: number): Promise<Frame | null> {
		const end = Date.now() + ms;
		for (;;) {
			const f = this.frames.find((x) => x.seq! > after && pred(x));
			if (f) return f;
			if (Date.now() > end || !this.ws) return null;
			await sleep(15);
		}
	}
	/** One command, timed to its first answer for this player; `want` names the answer that counts as done. Throws
	 *  Refused on an error answer (a game rule) and Error on no answer. */
	async cmd(act: string, line: string, want?: RegExp): Promise<string> {
		if (!this.ws) throw new Error("socket closed");
		const from = this.seq, t0 = performance.now(), at = Date.now();
		this.ws.send(JSON.stringify({ t: "cmd", line }));
		this.commands++;
		const mine = (x: Frame) => x.t === "msg" && (x.m.from === this.name || x.m.toMe === true);
		const f = await this.until((x) => (x.t === "msg" && mine(x) && (x.m.kind === "error" || !want || want.test(String(x.m.text))))
			|| (!want && ((x.t === "char" && x.c.charId === this.me) || x.t === "hello" || x.t === "trade")), from, ANSWER_MS);
		const ms = Math.round(performance.now() - t0);
		const asked = this.frames.some((x) => x.seq! > from && x.t === "msg" && /ich versuche das zu verstehen/.test(String(x.m.text)));
		const outcome = asked ? "model" : !f ? "timeout" : f.t === "msg" && f.m.kind === "error" ? "refused" : "ok";
		const text = f?.t === "msg" ? String(f.m.text).slice(0, 160) : "";
		log("commands.jsonl", { at, bot: this.n, act, line, ms, outcome, ...(outcome !== "ok" ? { text } : {}) });
		if (outcome === "refused") throw new Refused(`„${line}“: ${text}`);
		if (outcome === "model") throw new Error(`„${line}“: not understood by the rules, sent to the model`);
		if (outcome === "timeout") {
			const heard = this.frames.filter((x) => x.seq! > from && x.t === "msg" && mine(x)).map((x) => String(x.m.text).slice(0, 80)).slice(-3).join(" | ");
			throw new Error(`„${line}“: no answer in ${ANSWER_MS} ms${heard ? `; heard: ${heard}` : ""}`);
		}
		await sleep(1000 + Math.random() * 2000);
		return f!.t === "msg" ? String(f!.m.text) : "";
	}
	/** Walks to (x, y): done when the server has the figure there. */
	async moveTo(x: number, y: number): Promise<void> {
		if (this.x === x && this.y === y) return;
		await this.cmd("gehen", `move ${x} ${y}`);
		const end = Date.now() + 15_000;
		while ((this.x !== x || this.y !== y) && Date.now() < end) await sleep(100);
		if (this.x !== x || this.y !== y) throw new Refused(`kam nicht nach ${x} ${y}`);
	}
	async beside(x: number, y: number): Promise<void> {
		const def = w.rooms.find((r) => r.roomId === this.room);
		const taken = new Set([...this.chars.values()].filter((c) => c.charId !== this.me).map((c) => `${c.x},${c.y}`));
		for (const [dx, dy] of [[-1, 0], [1, 0], [0, 1], [0, -1], [-1, 1], [1, 1], [-1, -1], [1, -1]] as const) {
			const cx = x + dx, cy = y + dy;
			if (!def || taken.has(`${cx},${cy}`) || !walkable(w, def.ground, cx, cy)) continue;
			if (this.x === cx && this.y === cy) return;
			try { return await this.moveTo(cx, cy); } catch (e) { if (!(e instanceof Refused)) throw e; }
		}
		throw new Refused(`kein freies Feld neben ${x} ${y}`);
	}
	/** Things into the pack, through the region's space. */
	async give(proto: string, n = 1): Promise<void> {
		let p = protoCache.get(proto);
		if (!p) { p = (await resolvePrototype(this.space, proto)) ?? undefined; if (!p) throw new Error(`no prototype ${proto}`); protoCache.set(proto, p); }
		for (let i = 0; i < n; i++) await spawn(this.space, null, w, p, { location: this.me, x: -1, y: -1 });
	}
	/** A building of this player's placed right of where it stands, taken away after `run`. */
	async withBuilding<T>(plan: string, run: (b: BuildingFields) => Promise<T>, over: Partial<BuildingFields> = {}): Promise<T> {
		const def = w.building!.plans.find((p) => p.key === plan);
		if (!def) throw new Error(`no plan ${plan}`);
		const beacon = w.beacons.find((b) => b.room === this.room) ?? w.beacons[0]!;
		const b: BuildingFields = { buildId: `load-${plan}-${this.n}-${Date.now().toString(36)}`, plan, name: def.name, room: this.room, x: this.x + 1, y: this.y, w: 1, h: 1, owner: this.me, ownerName: this.name, accountId: this.account, beaconId: beacon.beaconId, points: def.points, by: {}, untilWorldMs: FOREVER, builtAt: 0, ...over } as BuildingFields;
		const s = this.space;
		await s.write({ type: "Building", fields: b as never }, null, FOREVER);
		try { return await run(b); }
		finally { for (const e of await s.readAll({ type: "Building", fields: { buildId: b.buildId } })) await s.takeIfExists({ id: e.id }, 0); }
	}
	async leave(): Promise<void> {
		const ws = this.ws; this.ws = null;
		if (ws && ws.readyState === WebSocket.OPEN) await new Promise<void>((r) => { ws.onclose = () => r(); ws.close(); setTimeout(r, 3000); });
	}
}

const bots: Bot[] = Array.from({ length: BOTS }, (_, i) => new Bot(i));
const other = (b: Bot) => bots.find((o) => o !== b && o.ws && o.room === b.room && o.chars.has(o.me) && b.chars.has(o.me));
const objsOf = (b: Bot, kind: string, re?: RegExp) => [...b.objs.values()].filter((o) => o.kind === kind && (!re || re.test(o.name)));

// ---- what a player does: [name, weight, the commands] --------------------------------------------------------------
type Act = [string, number, (b: Bot) => Promise<string | void>];
const ACTS: Act[] = [
	["umschauen", 6, async (b) => { await b.cmd("umschauen", pick(["schau", "inventar", "wer", "epoche", "markt", "hilfe", "zeit", "fahrplan", "stall"])); }],
	["wandern", 8, async (b) => {
		const exits = objsOf(b, "exit");
		if (!exits.length) throw new Skip("kein Ausgang");
		const before = b.room;
		await b.cmd("wandern", `go ${pick(exits).name.toLowerCase()}`);
		return before === b.room ? "blieb" : `nach ${b.room}`;
	}],
	["sammeln", 6, async (b) => {
		const items = [...b.objs.values()].filter((o) => o.kind === "item" && o.location === b.room).sort((x, y) => dist(b, x) - dist(b, y));
		if (!items.length) throw new Skip("nichts am Boden");
		const it = items[0]!;
		if (dist(b, it) > 1) await b.moveTo(it.x, it.y);
		await b.cmd("sammeln", `nimm ${it.name.toLowerCase()}`);
	}],
	["feuer", 4, async (b) => {
		const fire = objsOf(b, "beacon")[0];
		if (!fire) throw new Skip("kein Feuer hier");
		await b.give("treibholz", 1);
		await b.beside(fire.x, fire.y);
		await b.cmd("feuer", "put treibholz in feuer", /legst .* ins|brennt|Feuer/);
	}],
	["tausch", 3, async (b) => {
		const o = other(b);
		if (!o) throw new Skip("niemand hier");
		await b.give("muschel", 1); await o.give(w.currency, 1);
		await b.cmd("tausch", `offer muschel an ${o.name} für münze`, /bietet|bietest/);
	}],
	["marktbrett", 3, async (b) => {
		if (!w.market.rooms.includes(b.room)) throw new Skip("kein Marktbrett hier");
		await b.give("muschel", 1); await b.give(w.currency, 3);
		await b.cmd("marktbrett", "market biete muschel für 2", /Marktbrett|bietet|hängt/);
		const board = await b.cmd("marktbrett", "market", /\d+\.|Marktbrett/);
		const lines = [...board.matchAll(/(\d+)\. [^\n]*\(von (?!Last)[^)]*\)|(\d+)\. [^\n]*\(von Last[^)]*\)/g)].map((m) => m[1] ?? m[3]).filter(Boolean);
		const mineRe = new RegExp(`(\\d+)\\. [^\\n]*\\(von ${b.name}\\)`);
		const own = mineRe.exec(board)?.[1];
		const nr = lines.find((x) => x !== own);
		if (nr) await b.cmd("marktbrett", `market kaufe ${nr}`, /kaufst|gekauft/);
	}],
	["hütte", 2, async (b) => {
		const def = w.building!.plans.find((p) => p.key === "huette")!;
		for (const n of def.needs) await b.give(n.proto, n.count);
		await b.cmd("hütte", "bau hütte", /steckt eine Baustelle ab/);
		for (const n of def.needs) await b.cmd("hütte", `liefere ${n.count} ${protoName(n.proto)}`, /lieferst|liefert/);
		for (let i = 0; i < def.work + 2; i++) {
			const t = await b.cmd("hütte", "arbeite", /arbeitet an der|ruhst|fertig/);
			const m = /\((\d+)\/(\d+)\)/.exec(t);
			if (m && m[1] === m[2]) return "gebaut";
		}
		return "nicht fertig";
	}],
	["truhe", 3, async (b) => b.withBuilding("huette", async () => {
		await b.give("muschel", 3);
		await b.cmd("truhe", "verstaue 3 muschel", /Truhe|verstaust/);
		const inside = await b.cmd("truhe", "truhe", /In der Truhe|Truhe/);
		if (!/Muschel/.test(inside)) throw new Error(`the shells are not in the chest: ${inside.slice(0, 120)}`);
		await b.cmd("truhe", "entnimm 2 muschel", /nimmst|Truhe/);
	})],
	["regentonne", 2, async (b) => b.withBuilding("regentonne", async () => { await b.give("wasserkanne", 1); await b.cmd("regentonne", "schöpfe", /Kanne|Wasser/); })],
	["beet", 2, async (b) => {
		await b.give("spaten", 1); await b.give("samen-moehre", 1); await b.give("wasserkanne", 1);
		await b.cmd("beet", "umgraben", /Beet/);
		await b.cmd("beet", "pflanze samen-moehre", /setzt|pflanzt|Beet/);
		await b.cmd("beet", "gieße", /gießt|gegossen|Kanne/);
	}],
	["steg", 2, async (b) => b.withBuilding("steg", async () => { await b.give("netz", 1); await b.cmd("steg", "wirf netz", /aus dem Wasser|Netz/); })],
	["räucherei", 2, async (b) => b.withBuilding("raeucherei", async () => {
		await b.give("fisch", 2); await b.give("treibholz", 1);
		await b.cmd("räucherei", "craft räucherfisch", /Räucherfisch/);
	})],
	["essen", 3, async (b) => { const f = pick(["brot", "kaese", "honig"] as const); await b.give(f, 1); await b.cmd("essen", `iss ${protoName(f).toLowerCase()}`, /satt|isst/); }],
	["handwerk", 3, async (b) => {
		const r = pick([["tang", 4, "craft tangseil", /Tangseil/], ["treibholz", 1, "craft spindel", /Spindel/]] as const);
		await b.give(r[0], r[1]); if (r[2] === "craft spindel") await b.give("muschel", 1);
		await b.cmd("handwerk", r[2], r[3]);
	}],
	["hühnerstall", 2, async (b) => b.withBuilding("huehnerstall", async () => {
		await b.give("huhn", 1); await b.give("weizen", 1);
		await b.cmd("hühnerstall", "einstallen huhn", /Stall|stallst/);
		await b.cmd("hühnerstall", "füttere", /füttert|fütterst|satt/);
		await b.cmd("hühnerstall", "stall", /Huhn|Hühner|Stall/);
	})],
	["gehege", 1, async (b) => b.withBuilding("gehege", async () => { await b.give("schaf", 1); await b.cmd("gehege", "einstallen schaf", /Schaf/); })],
	["werkstatt", 2, async (b) => b.withBuilding("werkstatt", async () => {
		await b.give("muschelmesser", 1); await b.give("treibholz", 2);
		await b.cmd("werkstatt", "craft bohle", /Bohle/);
	})],
	["lagerhaus", 1, async (b) => b.withBuilding("lagerhaus", async () => {
		await b.give("stein", 2);
		await b.cmd("lagerhaus", "verstaue 2 stein", /Lager|verstaust|Truhe/);
		await b.cmd("lagerhaus", "lager", /Lager/);
	})],
	["windmühle", 2, async (b) => b.withBuilding("windmuehle", async () => { await b.give("weizen", 2); await b.cmd("windmühle", "mahle 2 weizen", /Mühle|mahlt|Mehl/); })],
	["backhaus", 2, async (b) => b.withBuilding("backhaus", async () => {
		await b.give("mehl", 2); await b.give("wasserkanne", 1); await b.give("treibholz", 1);
		await b.cmd("backhaus", "backe brot", /Brot/);
	})],
	["webstuhl", 2, async (b) => b.withBuilding("webstuhl", async () => {
		await b.give("wolle", 3); await b.give("spindel", 1);
		await b.cmd("webstuhl", "craft tuch", /Tuch/);
		await b.give("federn", 4);
		await b.cmd("webstuhl", "craft kissen", /Federkissen/);
	})],
	["steinbruch", 1, async (b) => b.withBuilding("steinbruch", async () => { await b.give("spitzhacke", 1); await b.cmd("steinbruch", "breche", /Stein/); })],
	["lehmgrube", 1, async (b) => b.withBuilding("lehmgrube", async () => { await b.give("spaten", 1); await b.cmd("lehmgrube", "steche", /Lehm/); })],
	["ziegelei", 1, async (b) => b.withBuilding("ziegelei", async () => { await b.give("lehm", 3); await b.give("treibholz", 1); await b.cmd("ziegelei", "craft ziegel", /Ziegel/); })],
	["kapelle", 1, async (b) => b.withBuilding("kapelle", async () => { await b.give("perle", 1); await b.cmd("kapelle", "opfere perle", /opfer|Segen|halb/i); })],
	["acker", 1, async (b) => {
		await b.give("spaten", 1); await b.give("gerste", 4);
		await b.cmd("acker", "flur anlegen", /bricht einen Acker um/);
		await b.cmd("acker", "bestelle gerste", /Gerste|Saat|bestell/);
	}],
	["kaufhaus", 2, async (b) => b.withBuilding("kaufhaus", async () => {
		await b.give(w.currency, 16); await b.give("fisch", 2);
		await b.cmd("kaufhaus", "laden einlegen 6", /Kasse|legst/);
		await b.cmd("kaufhaus", "laden", /Regal|Kaufhaus/);
		await b.cmd("kaufhaus", "laden verkaufe fisch", /verkaufst/);
		await b.cmd("kaufhaus", "laden kaufe fisch", /kaufst/);
	})],
	["kontor", 1, async (b) => b.withBuilding("kontor", async (x) => {
		await b.give(w.currency, 12); await b.give("perle", 1);
		const p = protoCache.get(w.currency) ?? (await resolvePrototype(b.space, w.currency))!;
		for (let i = 0; i < 10; i++) await spawn(b.space, null, w, p, { location: x.buildId, x: -1, y: -1 });
		await b.cmd("kontor", "kredit 5 gegen perle", /Du leihst/);
		await b.cmd("kontor", "tilge", /Pfand wieder/);
	})],
	["park", 1, async (b) => b.withBuilding("park", async () => { await b.give("strandnelke", 1); await b.cmd("park", "pflege", /Park|Ruf|setzt/); })],
	["brauerei", 1, async (b) => b.withBuilding("brauerei", async () => {
		await b.give("gerste", 3); await b.give("hopfen", 1); await b.give("wasserkanne", 1);
		await b.cmd("brauerei", "craft bier", /Bier/);
	})],
	["glashütte", 1, async (b) => b.withBuilding("glashuette", async () => { await b.give("sand", 3); await b.give("treibholz", 2); await b.cmd("glashütte", "craft glas", /Glas/); })],
	["sand", 1, async (b) => {
		const def = w.rooms.find((r) => r.roomId === b.room)!, cells: Array<[number, number]> = [];
		def.ground.forEach((row, y) => [...row].forEach((t, x) => { if (t === w.sand!.tile) cells.push([x, y]); }));
		if (!cells.length) throw new Skip("kein Strand hier");
		const [x, y] = cells.sort((p, q) => dist(b, { x: p[0], y: p[1] }) - dist(b, { x: q[0], y: q[1] }))[0]!;
		await b.give("spaten", 1);
		await b.moveTo(x, y);
		await b.cmd("sand", "schaufle", /Sand/);
	}],
	["werft", 1, async (b) => b.withBuilding("werft", async () => {
		await b.give("bohle", 10); await b.give("leinen", 4); await b.give("tauwerk", 2);
		await b.cmd("werft", "craft segelboot", /Segelboot/);
	})],
	["luke", 1, async (b) => b.withBuilding("steg", async () => {
		await b.give("ruderboot", 1); await b.give("muschel", 2);
		await b.cmd("luke", "luke lade 2 muschel", /Luke/);
		await b.cmd("luke", "luke", /Luke/);
		await b.cmd("luke", "luke entlade alle", /Luke|nimmst/);
	})],
	["inselbahn", 2, async (b) => b.withBuilding(w.rail!.plan, async () => { await b.cmd("inselbahn", "zug", /Bahnh|Zug|Inselbahn|Fahrplan/); }, { w: 3, h: 2 })],
	["signalfeuer", 1, async (b) => { await b.cmd("signalfeuer", "signalfeuer", /Signalfeuer|Kette|kein/); }],
	["schiff", 1, async (b) => { await b.cmd("schiff", "fahrplan", /Schiff|Fahrplan/); }],
	["beamen", 2, async (b) => {
		await b.give(w.currency, 20);
		const t = await b.cmd("beamen", "beam", /Ziel|beam|Münz|Feuer/);
		const target = pick(w.beacons.filter((x) => x.room !== b.room && regionOfRoom(w, x.room) === b.region));
		if (target && /Ziel/.test(t)) {
			const room = w.rooms.find((r) => r.roomId === target.room)!;
			await b.cmd("beamen", `beam ${room.name.toLowerCase()}`, /beamst|landest|springst|Feuer|Pause|Münz/);
		}
	}],
];
const TOTAL = ACTS.reduce((n, a) => n + a[1], 0);
const pickAct = (): Act => { let r = Math.random() * TOTAL; for (const a of ACTS) { r -= a[1]; if (r <= 0) return a; } return ACTS[0]!; };

async function play(b: Bot, until: number): Promise<void> {
	while (Date.now() < until && b.ws) {
		const [name, , run] = pickAct();
		const t0 = Date.now(), at = t0;
		let outcome = "ok", detail = "";
		try { detail = (await run(b)) ?? ""; }
		catch (e) { outcome = e instanceof Skip ? "skipped" : e instanceof Refused ? "refused" : "failed"; detail = (e as Error).message.slice(0, 240); }
		log("activities.jsonl", { at, bot: b.n, act: name, room: b.room, ms: Date.now() - t0, outcome, detail });
		if (outcome === "skipped") await sleep(300);
	}
}

// ---- the run -------------------------------------------------------------------------------------------------------
// the epoch asked for, and no model calls at all (a line the rules do not read would go to the model: tokens)
const SET = { "epoch.force": EPOCH, "llm.perMin": 0 } as const;
const settingOf = async (id: string, key: string) => ((await space(id).readAll({ type: "Setting", fields: { key } }))[0]?.fields.value as number | undefined) ?? null;
const savedSettings = new Map(await Promise.all(REGIONS.map(async (id) => [id, Object.fromEntries(await Promise.all(Object.keys(SET).map(async (k) => [k, await settingOf(id, k)] as const)))] as const)));
for (const id of REGIONS) await saveSettings(space(id), SET);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { void Promise.all([...savedSettings].map(([id, v]) => saveSettings(space(id), v))).finally(() => process.exit(130)); });
console.log(`${JSON.stringify(SET)} in ${REGIONS.join(", ")} (before: ${JSON.stringify(Object.fromEntries(savedSettings))}); waiting for the processes to read it`);
await sleep(8_000);

const t0 = Date.now();
for (let i = 0; i < bots.length; i += 10) {
	const group = bots.slice(i, i + 10);
	const joined = await Promise.allSettled(group.map((b) => b.join()));
	joined.forEach((r, k) => { if (r.status === "rejected") console.error(`bot ${i + k}: ${(r.reason as Error).message}`); });
}
writeFileSync(join(OUT, "bots.json"), JSON.stringify(bots.filter((b) => b.me).map((b) => ({ n: b.n, charId: b.me, name: b.name, accountId: b.account })), null, 1));
const playing = bots.filter((b) => b.ws);
console.log(`${playing.length} of ${BOTS} players joined in ${((Date.now() - t0) / 1000).toFixed(1)} s; playing ${SECONDS} s`);
const until = Date.now() + SECONDS * 1000;
const ticker = setInterval(() => console.log(`${new Date().toISOString()} commands ${playing.reduce((n, b) => n + b.commands, 0)}, open sockets ${playing.filter((b) => b.ws?.readyState === WebSocket.OPEN).length}`), 60_000);
// started over the first minute, not all in one millisecond
await Promise.all(playing.map(async (b) => { await sleep(Math.random() * 60_000); await play(b, until); }));
clearInterval(ticker);
await Promise.all(playing.map((b) => b.leave()));
// the buildings a player left placed (a run stopped halfway) and the epoch as before
let left = 0;
for (const id of REGIONS) for (const e of await space(id).readAll({ type: "Building" })) if (String(e.fields.buildId).startsWith("load-") && (await space(id).takeIfExists({ id: e.id }, 0))) left++;
for (const [id, v] of savedSettings) await saveSettings(space(id), v);
console.log(`done: ${playing.reduce((n, b) => n + b.commands, 0)} commands; ${left} placed buildings left over and taken; settings put back`);
for (const c of conns.values()) c.close();
process.exit(0);
