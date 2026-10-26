// Scripts of the npc process. A script is one round of an NPC's life: it reads the world, types at most a few commands
// (npc.act waits until each is taken) and sleeps; the npc process calls it again and again. Pauses are game time.
import { randomInt } from "node:crypto";
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { burnText, flameOf, fogOf } from "../engine/fire.ts";
import { llmEnabled } from "../llm.ts";
import { isAwake, keepAwake, remember, sleep, think, tryWake } from "./minds.ts";
import { gameMs } from "../engine/time.ts";
import type { NpcDef, WorldDef } from "../engine/world.ts";
import { ECONOMY } from "./economy.ts";
import { gather, requestOf, unclear } from "./requests.ts";
import { fieldsOf, type CharacterFields, type ExitFields, type ListingFields, type MsgFields, type OfferFields } from "../model.ts";

export type Npc = {
	def: NpcDef; charId: string; space: SpaceLike; world: WorldDef; halt: AbortSignal;
	sleep(ms: number): Promise<void>;
	/** Shows or hides the NPC in the world (a wanderer comes and goes); showing it steps it onto a free cell. */
	setOnline(on: boolean): Promise<void>;
	isOnline(): boolean;
	/** Types a command (an intent) and waits until a world worker has run it. */
	act(line: string): Promise<void>;
};
export type Script = (npc: Npc) => Promise<void>;

/** The NPC's character, or null while the world has not created it yet (the npc process may start first). */
export const self = async (n: Npc) => { const e = await n.space.readIfExists({ type: "Character", fields: { charId: n.charId } }, 5_000); return e ? fieldsOf<CharacterFields>(e) : null; };

/** The beacon keeper: watches its fire, who comes and what is said. As a model role (docs/modell-npcs.md) the events of
 *  its wake list wake it and it answers with the model while awake; asleep, without model calls or with its budget used
 *  up it dozes and says script lines (the warnings and greetings of Phase 2). */
function waerter(): Script {
	let state: "ok" | "low" | "out" | null = null;
	let lastDoze = Date.now(), pensive = false, budgetSaid = false;
	const heardSince = newHeard(), worldEvents = newWorldEvents();
	let present: Set<string> | null = null, offered: Set<string> | null = null;
	const greeted = new Map<string, number>();
	return async (n) => {
		const me = await self(n);
		if (!me) { await n.sleep(1000); return; }
		const events: string[] = [];
		const beacon = n.world.beacons.find((b) => b.beaconId === n.def.beacon);
		let fireText: string | undefined;
		if (beacon) {
			const f = await flameOf(n.space, beacon.beaconId), now = Date.now();
			const piece = Math.min(...Object.values(n.world.fire.fuel).map((ms) => gameMs(ms)));
			const next = !f || f.until <= now ? "out" : f.until - now < piece * 1.5 ? "low" : "ok";
			if (state !== null && next !== state) events.push(next === "low" ? "fire.low" : next === "out" ? "fire.out" : "fire.ok");
			state = next;
			fireText = burnText(f, now);
		}
		const said = await heardSince(n, me);
		// only people wake a model role or keep it talking: NPCs chatting next to it would cost a model call each round
		const fromPeople = said.filter(byPerson);
		if (fromPeople.some((m) => m.text.toLowerCase().includes(me.name.toLowerCase()))) events.push("spoken");
		const people = await humansIn(n, me.room);
		if (present && people.some((p) => !present!.has(p))) events.push("person.enters");
		present = new Set(people);
		const offers = (await n.space.readAll({ type: "Offer", fields: { to: me.charId } })).map((e) => e.id);
		if (offered && offers.some((id) => !offered!.has(id))) events.push("offer");
		for (const kind of await worldEvents(n)) events.push(kind); // dates of the world clock: the evening
		offered = new Set(offers);
		const m = n.def.model;
		if (m && llmEnabled()) {
			const awakeMs = gameMs(5 * 60_000);
			const wakes = events.filter((e) => m.wake.includes(e) || e === "fire.ok");
			const awake = await isAwake(n.space, n.def.npcId);
			if (wakes.length || (awake && fromPeople.length)) {
				if (!awake && !(await tryWake(n.space, n.def.npcId, npcMax(), awakeMs))) {
					if (!pensive) { pensive = true; await n.act(`emote ist in Gedanken.`); }
				} else {
					pensive = false;
					await keepAwake(n.space, n.def.npcId, awakeMs);
					const r = await think(n.space, { npcId: n.def.npcId, name: me.name, persona: m.persona, budgetDay: m.budgetDay }, { room: (await roomName(n, me.room)), people, ...(fireText ? { fire: fireText } : {}), ...(beacon ? { fireAt: { x: beacon.x, y: beacon.y } } : {}), event: wakes.join(", ") || "talk", heard: fromPeople.map((x) => x.text), ...(await surroundings(n, me)) });
					if (r === "budget") { if (!budgetSaid) { budgetSaid = true; await n.act(`emote ${dozeLine(me.name, m.dozing, 0)}`); } }
					else if (r !== "off") { budgetSaid = false; for (const line of r.lines) await n.act(line); if (r.note) await remember(n.space, n.def.npcId, r.note); }
				}
			} else if (!awake && people.length && Date.now() - lastDoze > gameMs(3 * 60_000)) {
				lastDoze = Date.now();
				await n.act(`emote ${dozeLine(me.name, m.dozing, randomInt(0, m.dozing.length))}`);
			}
			await n.sleep(gameMs(3_000, 100));
			return;
		}
		// no model: the script of Phase 2
		if (events.includes("fire.low")) await n.act("say Das Feuer wird schwach – bringt Treibholz!");
		else if (events.includes("fire.out")) await n.act("say Das Feuer ist aus! Ohne Licht frisst uns der Nebel.");
		else if (events.includes("fire.ok")) await n.act("say Danke! So brennt es wieder.");
		else if (events.includes("evening") && people.length) await n.act("say Der Abend kommt: wer kann, bringe Holz für die Nacht.");
		for (const x of fromPeople) {
			// asked for something by name: do it (or say why not), before any greeting
			const ask = requestOf(x.text.startsWith(`${x.from}: `) ? x.text.slice(x.from.length + 2) : x.text, me.name); // the text of a say starts with the speaker
			if (ask && ask.kind !== "greet") {
				if (ask.kind === "gather") await gather(n, me, x.from, ask.count, async () => { const c = await self(n); return c ? { x: c.x, y: c.y, room: c.room } : null; });
				else if (ask.kind === "feed") await gather(n, me, x.from, 0, async () => { const c = await self(n); return c ? { x: c.x, y: c.y, room: c.room } : null; });
				else await n.act(`say ${unclear(x.from)}`);
				continue;
			}
			if (!/\b(hallo|hi|moin|hello|servus)\b/i.test(x.text)) continue;
			if (Date.now() - (greeted.get(x.from) ?? 0) < gameMs(10 * 60_000)) continue;
			greeted.set(x.from, Date.now());
			await n.act(`say Willkommen am Feuer, ${x.from}!`);
		}
		await n.sleep(gameMs(3_000, 100));
	};
}

/** A wanderer: away until its event (a room in dense fog for two game minutes), then it appears, at most once per its
 *  cooldown; it speaks when people are there (with the model while awake, else a script line) and goes when nobody has
 *  spoken to it for its stay, or when nobody is there for two game minutes. */
function wanderer(): Script {
	let denseSince = 0, lastSpoken = 0, aloneSince = 0;
	const heardSince = newHeard();
	return async (n) => {
		const wd = n.def.wanderer!, m = n.def.model, now = Date.now();
		const me = await self(n);
		if (!me) { await n.sleep(1000); return; }
		if (!n.isOnline()) {
			const dense = (await fogOf(n.space, n.def.room)) >= n.world.fog.max;
			denseSince = dense ? denseSince || now : 0;
			const cool = !(await n.space.readIfExists({ type: "NpcVisit", fields: { npcId: n.def.npcId } }, NO_WAIT));
			if (denseSince && now - denseSince >= gameMs(2 * 60_000) && cool) {
				await n.space.write({ type: "NpcVisit", fields: { npcId: n.def.npcId, at: now } }, null, gameMs(wd.cooldownMs));
				await n.setOnline(true);
				lastSpoken = now; aloneSince = 0;
				await heardSince(n, me); // what was said before he came is not for him
				if ((await humansIn(n, n.def.room)).length) await speak(n, me.name, wd.event, []);
			}
			await n.sleep(gameMs(10_000, 100)); // away: it waits for its event, nobody is waiting on it
			return;
		}
		const said = (await heardSince(n, me)).filter(byPerson);
		if (said.some((x) => /fremd/i.test(x.text) || x.text.toLowerCase().includes(me.name.toLowerCase()))) { lastSpoken = now; await speak(n, me.name, "spoken", said.map((x) => x.text)); }
		const people = await humansIn(n, me.room);
		aloneSince = people.length ? 0 : aloneSince || now;
		if (now - lastSpoken >= gameMs(wd.stayMs) || (aloneSince && now - aloneSince >= gameMs(2 * 60_000))) {
			if (people.length) await n.act("emote verschwindet im Nebel.");
			if (m) await sleep(n.space, n.def.npcId);
			await n.setOnline(false);
		}
		await n.sleep(gameMs(3_000, 100));
	};
}

/** A wanderer's words: the model while it can be woken, else its script line. */
async function speak(n: Npc, name: string, event: string, heard: string[]): Promise<void> {
	const m = n.def.model;
	if (m && llmEnabled() && (await tryWake(n.space, n.def.npcId, npcMax(), gameMs(5 * 60_000)))) {
		const me = await self(n);
		const r = await think(n.space, { npcId: n.def.npcId, name, persona: m.persona, budgetDay: m.budgetDay }, { room: await roomName(n, me?.room ?? n.def.room), people: await humansIn(n, me?.room ?? n.def.room), event, heard, ...(me ? await surroundings(n, me) : {}) });
		if (typeof r === "object") { for (const line of r.lines) await n.act(line); if (r.note) await remember(n.space, n.def.npcId, r.note); return; }
	}
	await n.act(event === "spoken" ? "say Licht … wo brennt das nächste Licht?" : "say Wo geht es hier aus dem Nebel?");
}

/** The kinds of the world events (engine/worldevents.ts) that appeared since the last call, each once; what was there when
 *  the role started is not new. */
export function newWorldEvents() {
	let known: Set<string> | null = null;
	return async (n: Npc): Promise<string[]> => {
		const all = await n.space.readAll({ type: "WorldEvent" });
		const fresh = known ? all.filter((e) => !known!.has(String(e.fields.eventId))) : [];
		known = new Set(all.map((e) => String(e.fields.eventId)));
		return fresh.map((e) => String(e.fields.kind));
	};
}

/** Said by a person, not by an NPC. */
export const byPerson = (m: MsgFields) => !(m.fromId ?? "").startsWith("npc-");

/** What others said in the NPC's room since the last call, by message id (a time would miss a message read while its
 *  transaction was still open: its time is older than its commit). The first call takes what was said since the role
 *  started here (a process that just took the role over answers what was said meanwhile, not the old talk). */
export function newHeard() {
	let known: Set<string> | null = null;
	const started = Date.now() - 2_000;
	return async (n: Npc, me: CharacterFields): Promise<MsgFields[]> => {
		const all = await n.space.readAll({ type: "Msg", fields: { room: me.room, to: "*", kind: "say" } });
		const fresh = known ? all.filter((e) => !known!.has(e.id)) : all.filter((e) => Number(e.fields.at) >= started);
		known = new Set(all.map((e) => e.id)); // messages lapse with their lease: the set stays as small as the room's talk
		return fresh.map((e) => fieldsOf<MsgFields>(e)).filter((m) => m.from !== me.name);
	};
}

/** What a model NPC needs to act like a player: where it stands, what it carries, what lies in its room, the exits,
 *  the offers made to it and, at the market, the board (what look, inventory and market would show). */
async function surroundings(n: Npc, me: CharacterFields) {
	const carried = (await n.space.readAll({ type: "Item", fields: { location: me.charId } })).map((e) => String(e.fields.name));
	const things = (await n.space.readAll({ type: "Item", fields: { location: me.room } })).map((e) => ({ name: String(e.fields.name), x: Number(e.fields.x), y: Number(e.fields.y) }));
	const exits = (await n.space.readAll({ type: "Exit", fields: { location: me.room } })).map((e) => fieldsOf<ExitFields>(e).name);
	const offers = (await n.space.readAll({ type: "Offer", fields: { to: me.charId } })).map((e) => fieldsOf<OfferFields>(e)).map((o) => `${o.fromName} offers ${o.giveNames.join(", ")}${o.want.length ? ` for ${o.want.map((w) => `${w.count}× ${w.name}`).join(", ")}` : " as a gift"} (accept ${o.fromName} / decline ${o.fromName})`);
	const board = n.world.market.rooms.includes(me.room) ? (await n.space.readAll({ type: "Listing", fields: { room: me.room } })).map((e) => fieldsOf<ListingFields>(e)).sort((a, b) => a.at - b.at || a.listingId.localeCompare(b.listingId)).map((l, i) => `${i + 1}: ${l.itemName} for ${l.price} by ${l.sellerName}`) : undefined;
	return { me: { x: me.x, y: me.y }, carried, things, exits, offers, ...(board ? { board } : {}) };
}

/** Online characters of players in a room (not NPCs). */
export async function humansIn(n: Npc, room: string): Promise<string[]> {
	const live = new Set((await n.space.readAll({ type: "Session" })).map((s) => String(s.fields.charId)));
	return (await n.space.readAll({ type: "Character", fields: { room } })).map((e) => fieldsOf<CharacterFields>(e)).filter((c) => live.has(c.charId) && !c.charId.startsWith("npc-")).map((c) => c.name);
}
const roomName = async (n: Npc, room: string) => String((await n.space.readIfExists({ type: "Room", fields: { roomId: room } }, NO_WAIT))?.fields.name ?? room);
/** "Ines flickt ein Netz." → "flickt ein Netz." (emote puts the name in front). */
const dozeLine = (name: string, lines: string[], i: number) => (lines[i] ?? `${name} döst.`).replace(new RegExp(`^${name}\\s+`), "");
const npcMax = () => Number(process.env.SPACES_MMO_NPC_MAX ?? 10);

/** The ferryman: walks to the exit of the room he is in that leads to another room of his route, takes it, rests, and
 *  goes back the same way. Fog that hides the way stops him until it clears (the world refuses the step; he tries
 *  again later). */
function faehrmann(): Script {
	return async (n) => {
		const me = await self(n);
		if (!me) { await n.sleep(1000); return; }
		const exits = (await n.space.readAll({ type: "Exit", fields: { location: me.room } })).map((e) => fieldsOf<ExitFields>(e));
		const route = n.def.route ?? [];
		const exit = exits.find((x) => route.includes(x.destination) && x.destination !== me.room) ?? (route.length ? undefined : exits[0]);
		if (!exit) { await n.sleep(gameMs(30_000)); return; }
		await n.act(`move ${exit.x} ${exit.y}`);
		const after = await self(n);
		await n.sleep(after && after.room !== me.room ? gameMs(30_000) : gameMs(15_000));
	};
}

const MAKERS: Record<string, () => Script> = { waerter, faehrmann, wanderer, ...ECONOMY };

/** A fresh instance of the named script (state such as "already greeted" is per NPC), or undefined. */
export const scriptFor = (name: string): Script | undefined => (Object.hasOwn(MAKERS, name) ? MAKERS[name]!() : undefined);
