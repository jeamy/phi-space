// What can be done on a cell of the map: one function for the mouse's menu and the action sheet of a touch screen. Every
// entry is a text command; `run` is for what stays on the page. Pure, so it is tested without a browser.
import type { CharView, ItemUses, ObjView, PlanView } from "../shared/frames.ts";

export type CellEntry = { label: string; line: string; run?: () => void; /** asked before the line is sent (what cannot be undone) */ confirm?: string };
export type CellInput = {
	at: { x: number; y: number }; chars: Map<string, CharView>; objs: Map<string, ObjView>; self: CharView | undefined; room: string; me: string; plans: PlanView[]; guest: boolean;
	/** What burns, cheapest carried first (a fire's "nachlegen"). */ fuel: ObjView | undefined;
	offer?: (name: string) => void;
	/** The world's recipes (ItemUses.recipes): a building beside one offers those made at its plan. */ recipes?: ItemUses["recipes"];
	/** Whether a cell of this room is ground a spade digs sand from (ItemUses.sandTile). */ beachAt?: (x: number, y: number) => boolean;
	/** The operator: gives up anyone's bed beside it (server: garden.ts „beet aufgeben“). */ admin?: boolean;
	/** What the windmill grinds (ItemUses.grinds). */ grinds?: string[];
	/** The trade offers made to the player (TradeView.offersIn): a figure with one gets "accept" and "decline" first. */ offersIn?: Array<{ fromName: string; giveNames: string[]; want: Array<{ name: string; count: number }> }>;
	/** Chat with a player (not an NPC), and invite them into one of `groups` (none for a guest). */ chat?: { talk: (name: string) => void; invite: (name: string, group: string) => void; groups: string[] };
	/** Whether wild plants grow in the room (wildHere); without it seeds are offered anyway and the command answers. */ wild?: boolean;
	/** Which seeds go into which bed (ItemUses.beds); without it a bed offers every carried seed and the command answers. */ beds?: ItemUses["beds"];
	/** The rooms of the world and where a boat, a train and a cart can go (the overview's state); without it the commands list their places. */ travel?: { rooms: Array<{ roomId: string; name: string; island: string }>; stops: { jetties: string[]; stations: string[]; trainFare: number; roads: Array<[string, string]> }; /** each island's epoch above the first, and the epoch roads need: without them no road is offered */ epochs?: Record<string, number> | null; roadEpoch?: number };
	/** The islands a sailing boat goes to from here (the others, with the large ship's routes). */ sail?: string[];
	/** "Bauen …" was chosen: the caller shows the plans. */ onPlans: () => void;
	/** "Aushang" of a site: the caller shows the bag's list of them; without it the command answers. */ onOrders?: () => void;
};

/** Whether wild flowers or herbs grow in the room: there "sammle samen" can find something (server: garden.ts). */
export function wildHere(decor: Record<string, { model?: string }> | undefined, rows: string[] | undefined): boolean {
	const wild = new Set(Object.entries(decor ?? {}).filter(([, d]) => d.model === "flower" || d.model === "herb" || d.model === "grass" || d.model === "fern").map(([k]) => k));
	return (rows ?? []).some((row) => [...row].some((k) => wild.has(k)));
}

const INFO = /^(?:look|inventory|who|time|reputation|bau)\b/;
/** The order of the bar, what spoils or waits first: the harvest, then the care of what grows, the work on what is begun,
 *  the rest, and the seeds that can be looked for anytime. A sort keeps the order of equals, nearest cells first. */
const URGENT = [/^(?:ernte|abholen|einsammeln)\b/, /^(?:gieße|jäte|füttere|repariere|wache)\b/, /^(?:arbeite|liefere|breche|steche|harke|räume)\b/];
const rank = (line: string) => { const i = URGENT.findIndex((r) => r.test(line)); return line === "sammle samen" ? URGENT.length + 1 : i < 0 ? URGENT.length : i; };
/** What can be done from where the figure stands, for the bar "Hier möglich": what the menus of the cells around it offer
 *  (a site and a bed are worked from two cells away), each once, without going, looking and the figure's own information. */
export function hereEntries(input: Omit<CellInput, "at" | "onPlans">): CellEntry[] {
	const { self } = input, seen = new Map<string, CellEntry>();
	if (!self) return [];
	for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
		for (const e of cellEntries({ ...input, at: { x: self.x + dx, y: self.y + dy }, onPlans: () => {} })) {
			// what is done on a cell of one's choice is offered once, for the cell one stands on
			if ((dx || dy) && e.line.startsWith("flur anlegen ")) continue;
			if (e.run || e.line.startsWith("#") || e.line.startsWith("move ") || e.line.startsWith("umgraben ") || INFO.test(e.line) || /ansehen$/.test(e.label)) continue;
			if (!seen.has(e.line)) seen.set(e.line, e);
		}
	}
	return [...seen.values()].sort((a, b) => rank(a.line) - rank(b.line));
}

/** A figure a player gives and offers things to: a registered player's, not a guest's and not an NPC's. */
export const registered = (c: CharView) => !c.guest && !c.ai && !c.settler && !c.charId.startsWith("npc-");

/** Whether a carried seed `n` goes into a bed of `kind` (server: garden.ts pflanze): flowers into every bed, a garden
 *  bed's plants not into the flower bed, a field's seed into none. A seed of a crossing (a name of its own, not listed)
 *  is a flower's. Without `beds` every seed is offered. */
export function mayPlantIn(kind: ObjView["bedKind"], n: string, beds: ItemUses["beds"]): boolean {
	if (!/samen$/i.test(n) && !beds?.flowers.includes(n) && !beds?.plants.includes(n)) return false;
	if (!beds) return true;
	if (beds.field.includes(n)) return false;
	if (beds.plants.includes(n)) return kind !== "zier";
	return true;
}

/** Bar entries that need a thing without naming it. */
const NEEDS: Record<string, string[]> = { "Kanne Wasser": ["gieße"], Spitzhacke: ["breche"], Spaten: ["steche"] };
/** What a carried thing can do right now, besides laying it down and looking at it: what the bar offers with it or for it
 *  (a price in brackets counts when all of it is carried), and what only the thing brings: feeding, offering, the chest, recipes,
 *  people beside one and the market board. */
export function itemEntries(name: string, input: Omit<CellInput, "at" | "onPlans">, uses: ItemUses, o: { fuels: string[]; market?: () => void }): CellEntry[] {
	const { objs, chars, self, room, me, guest, offer } = input;
	if (!self) return [];
	const out = new Map<string, CellEntry>(), add = (e: CellEntry) => { if (!out.has(e.line)) out.set(e.line, e); };
	const count = new Map<string, number>();
	for (const i of objs.values()) if (i.kind === "item" && i.location === me) count.set(i.name, (count.get(i.name) ?? 0) + 1);
	const word = new RegExp(`(?<![\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu");
	// something to eat: sated, one rests less after work (server: food.ts iss); first, it is what the thing is for
	const sated = uses.foods?.[name];
	if (sated) add({ label: `Essen (satt ${sated} Std., kürzere Ruhe nach der Arbeit)`, line: `iss ${name}` });
	const here = hereEntries(input);
	for (const e of here) {
		const [head = "", price] = e.label.split(/ \((.*)\)$/);
		if (word.test(head) || NEEDS[name]?.includes(e.line) || (e.line === "pflege" && uses.flowers.includes(name))) { add(e); continue; }
		const costs = price?.split(", ").map((p) => /^(?:(\d+) )?(.+)$/.exec(p)!) ?? [];
		if (costs.some((c) => c[2] === name) && costs.every((c) => (count.get(c[2]!) ?? 0) >= Number(c[1] ?? 1))) add(e);
	}
	const beside = [...objs.values()].filter((b) => b.location === room && self.x >= b.x - 1 && self.y >= b.y - 1 && self.x <= b.x + (b.w ?? 1) && self.y <= b.y + (b.h ?? 1));
	const built = beside.filter((b) => b.kind === "building");
	if (o.fuels.includes(name) && beside.some((b) => b.kind === "beacon")) { const fire = beside.find((b) => b.kind === "beacon")!; add({ label: `${name} nachlegen`, line: `put ${name} in ${fire.name}` }); }
	for (const b of built) {
		if (b.herd && uses.feed[b.herd]?.includes(name)) add({ label: `${name} verfüttern`, line: `füttere ${name}` });
		if (b.keeper && uses.feed[b.keeper]?.includes(name)) add({ label: `${name} verfüttern (${b.keeper === "hund" ? "Hund" : "Katze"})`, line: `füttere ${b.keeper} ${name}` });
		if (b.plan === "kapelle" && uses.offerings.includes(name)) add({ label: `${name} opfern`, line: `opfere ${name}` });
		if (uses.stores.includes(b.plan ?? "") || (uses.chests.includes(b.plan ?? "") && b.ownerId === me)) add({ label: uses.stores.includes(b.plan ?? "") ? "Ins Lager legen" : "In die Truhe legen", line: `verstaue ${name}` });
	}
	if (name === "Spaten" && !guest) { add({ label: "Beet umgraben", line: "umgraben" }); add({ label: "Zierbeet umgraben (nur Blumen, sie kreuzen sich)", line: "umgraben zier" }); add({ label: "Gemeinschaftsbeet anlegen (3×3, eins je Feuer)", line: "umgraben gemeinschaft" }); }
	// a tool whose work wants a building beside it: offered anywhere (beside one the bar's own entry comes first), away from one
	// the server says where it works (quarry.ts breche, fishing.ts wirf netz)
	if (name === "Spitzhacke") add({ label: "Stein brechen", line: "breche" });
	if (name === "Netz") add({ label: "Netz auswerfen", line: "wirf netz" });
	if (name === "Spaten") { add({ label: "Lehm stechen", line: "steche" }); add({ label: "Sand schaufeln", line: "schaufle" }); if (!guest) add({ label: "Acker anlegen (4×4)", line: "flur anlegen" }); }
	if (name === "Kanne Wasser") add({ label: "Gießen", line: "gieße" });
	if (name === "Schlachtmesser" || name === "Muschelmesser") add({ label: "Ein Tier schlachten", line: "schlachte" });
	// a boat sets off from a jetty; alone the command says where it goes (fishing.ts rudere, segle; luke)
	if (name === "Ruderboot") add({ label: "Rudern: wohin?", line: "rudere" });
	if (name === "Segelboot") add({ label: "Segeln: wohin?", line: "segle" });
	if (name === "Ruderboot" || name === "Segelboot") add({ label: "Was liegt in der Luke?", line: "luke" });
	// a bill of exchange is paid out at a counting house (shop.ts wechsel)
	if (name === "Wechsel") { add({ label: "Wechsel einlösen", line: "wechsel einlösen" }); add({ label: "Meine Wechsel", line: "wechsel" }); }
	// a cart carried: set it down beside one (then its own menu loads it and sends it off by road), or see where one's carts are (server: cart.ts)
	if (name === "Karren" && !guest) { add({ label: "Karren abstellen", line: "karren stelle" }); add({ label: "Meine Karren", line: "karren" }); }
	for (const r of uses.recipes) {
		const uses1 = r.tool === name || r.needs.some((n) => n.name === name);
		if (!uses1 || (r.tool && !count.has(r.tool)) || r.needs.some((n) => (count.get(n.name) ?? 0) < n.count)) continue;
		// made only at a building (the cart at a workshop): offered anywhere too, away from one the server says where (trade.ts craft)
		if (![...out.values()].some((e) => e.label.startsWith(`${r.name} `))) add({ label: `${r.name} herstellen`, line: `craft ${r.key}` });
	}
	// to the registered players in the room, near or not (the server asks no more): those nearest first; not to guests, nor to NPCs
	if (!guest) for (const c of [...chars.values()].filter((x) => x.charId !== me && registered(x)).sort((x, y) => Math.max(Math.abs(x.x - self.x), Math.abs(x.y - self.y)) - Math.max(Math.abs(y.x - self.x), Math.abs(y.y - self.y)))) {
		add({ label: `${c.name} geben`, line: `give ${name} an ${c.name}` });
		if (offer) add({ label: `${c.name} anbieten …`, line: `#offer ${c.name}`, run: () => offer(c.name) });
	}
	if (o.market) add({ label: "Am Markt verkaufen …", line: "#sell", run: o.market });
	return [...out.values()];
}


/** What a field is sown with, and the crop's word for `bestelle` (server: world.fields.crops). */
const SOWN: Record<string, string> = { Weizen: "weizen", Gerste: "gerste", Hafer: "hafer", Kartoffel: "kartoffel", "Rübensamen": "rüben", Leinsamen: "flachs" };
/** The houses of animals by plan, with the animals (as their things are named) each takes in (server: world animals). */
// with the young ones that grow up in them (Küken, Ferkel)
const HOUSES: Record<string, string[]> = { huehnerstall: ["Huhn", "Küken"], gehege: ["Schaf", "Ziege", "Ente", "Gans", "Rind", "Schwein", "Ferkel"], bienenstock: ["Bienenvolk"] };
/** The animals that are slaughtered, as their things are named (server: world animals with `slaughter`; the young grow up first). */
const SLAUGHTERED = ["Huhn", "Schaf", "Ziege", "Ente", "Gans", "Rind", "Schwein"];
const AREA = new Set(["site", "building", "ruin", "bed", "field", "scenery", "liner"]);
const covers = (o: ObjView, c: { x: number; y: number }) => c.x >= o.x && c.y >= o.y && c.x < o.x + (o.w ?? 1) && c.y < o.y + (o.h ?? 1);

/** An offer in words, as the trade panel says it: "1 Münze für Muschel", "2× Treibholz als Geschenk". */
export function offerWords(o: { giveNames: string[]; want: Array<{ name: string; count: number }> }): string {
	const counted = (xs: Array<{ name: string; count: number }>) => {
		const m = new Map<string, number>();
		for (const x of xs) { const n = x.name.charAt(0).toUpperCase() + x.name.slice(1); m.set(n, (m.get(n) ?? 0) + x.count); }
		return [...m].map(([n, k]) => `${k} ${n}`).join(", ");
	};
	return `${counted(o.giveNames.map((name) => ({ name, count: 1 })))}${o.want.length ? ` für ${counted(o.want)}` : " als Geschenk"}`;
}

export function cellEntries({ at, chars, objs, self, room, me, plans, guest, fuel, offer, offersIn, chat, wild, beds, sail, travel, onPlans, onOrders, recipes, grinds, beachAt, admin }: CellInput): CellEntry[] {
	const reach = !!self && Math.max(Math.abs(at.x - self.x), Math.abs(at.y - self.y)) <= 1;
	const entries: CellEntry[] = [];
	/** The recipes made at a building of `plan`: what one carries enough for, and the whole list (server: trade.ts "craft hier"). */
	const made = (plan: string | undefined) => {
		const here = (recipes ?? []).filter((r) => r.at === plan);
		if (!here.length) return;
		const count = new Map<string, number>();
		for (const i of objs.values()) if (i.kind === "item" && i.location === me) count.set(i.name, (count.get(i.name) ?? 0) + 1);
		for (const r of here) if (r.needs.every((n) => (count.get(n.name) ?? 0) >= n.count) && (!r.tool || count.has(r.tool))) entries.push({ label: `${r.name} herstellen (${r.needs.map((n) => `${n.count} ${n.name}`).join(", ")})`, line: `craft ${r.key}` });
		entries.push({ label: "Was man hier herstellen kann", line: "craft hier" });
	};
	/** One's chest in building `buildId`: look into it, and each kind in it to take out, one or all (the server sends what
	 *  lies in it while one stands beside or inside; build.ts entnimm). */
	const chestEntries = (buildId: string) => {
		entries.push({ label: "Truhe ansehen", line: "truhe" });
		const held = new Map<string, number>();
		for (const i of objs.values()) if (i.kind === "item" && i.location === buildId) held.set(i.name, (held.get(i.name) ?? 0) + 1);
		for (const [n, k] of [...held].sort(([a], [b]) => a.localeCompare(b, "de")).slice(0, 12)) entries.push(k > 1 ? { label: `${n} entnehmen (alle ${k})`, line: `entnimm alle ${n}` } : { label: `${n} entnehmen`, line: `entnimm ${n}` });
	};
	for (const c of chars.values()) if (c.x === at.x && c.y === at.y && c.charId !== me) {
		// what the figure offers the player comes first: a tap on its speech bubble opens this menu (MapView3D)
		const offered = offersIn?.find((o) => o.fromName === c.name);
		if (offered) entries.push({ label: `accept ${c.name} – ${offerWords(offered)}`, line: `accept ${c.name}` }, { label: `decline ${c.name}`, line: `decline ${c.name}` });
		entries.push({ label: `${c.name} ansehen`, line: `look ${c.name}` });
		if (offer) entries.push({ label: `${c.name} einen Tausch anbieten …`, line: `#offer ${c.name}`, run: () => offer(c.name) });
		if (chat && !c.charId.startsWith("npc-")) {
			entries.push({ label: `Chat mit ${c.name}`, line: `#chat ${c.name}`, run: () => chat.talk(c.name) });
			for (const g of chat.groups.slice(0, 4)) entries.push({ label: `${c.name} in „${g}“ einladen`, line: `#invite ${c.name} ${g}`, run: () => chat.invite(c.name, g) });
		}
	}
	// a site or building covers more than one cell: its entries on every one of them
	for (const o of objs.values()) {
		// the large ship lying in the bay: its timetable, and a ride to each other island (server: fishing.ts)
		if (o.kind === "liner") {
			if (o.location === room && covers(o, at)) {
				entries.push({ label: "Fahrplan", line: "fahrplan" });
				if (!o.gliding) for (const r of o.routes ?? []) entries.push({ label: `Mitfahren nach ${r.island} · ${o.fare ?? 1} ${o.fare === 1 ? "Münze" : "Münzen"}`, line: `einschiffen ${r.island}` });
			}
			continue;
		}
		// a road on this cell (server: road.ts): look at it; while it is voted on, vote; while it is built, deliver what it lacks
		// of what one carries and work beside it; a finished one is mended
		if (o.kind === "road") {
			if (o.location !== room || !(o.runs?.[0] ?? []).some((c) => c.x === at.x && c.y === at.y)) continue;
			const to = o.name.replace(/^Straße nach /, ""), near = !!self && Math.max(Math.abs(at.x - self.x), Math.abs(at.y - self.y)) <= 2;
			entries.push({ label: "Straßen ansehen", line: "straße" });
			if (o.roadState === "vote" && !guest && !(o.votedIds ?? []).includes(me)) entries.push({ label: `Für die Straße nach ${to} stimmen`, line: `straße ja ${to}` }, { label: `Gegen die Straße nach ${to} stimmen`, line: `straße nein ${to}` });
			if (o.roadState === "build" && near) {
				const carried = new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me).map((i) => i.name));
				for (const n of (o.missing ?? "").split(",").map((p) => p.trim().replace(/^\d+\s+/, "")).filter((n) => n && carried.has(n))) entries.push({ label: `${n} an die Straße liefern`, line: `liefere ${n} an die straße` });
				if (/Arbeit/.test(o.missing ?? "")) entries.push({ label: "An der Straße mitarbeiten", line: "arbeite an der straße" });
			}
			if (o.roadState === "built" && near && !guest) entries.push({ label: "Straße ausbessern", line: "straße repariere" });
			continue;
		}
		// a door to another room of this island without a road: plan one (server: road.ts; it says when the island is too young)
		if (o.kind === "exit" && travel && !guest && o.location === room && o.x === at.x && o.y === at.y && o.toRoom) {
			const isl = (id: string) => travel.rooms.find((r) => r.roomId === id)?.island;
			const has = [...objs.values()].some((r) => r.kind === "road" && r.location === room && r.roadTo === o.toRoom);
			if (!has && isl(o.toRoom) && isl(o.toRoom) === isl(room) && travel.roadEpoch && (travel.epochs?.[isl(room)!] ?? 1) >= travel.roadEpoch) entries.push({ label: `Straße nach ${o.to ?? o.name} planen`, line: `straße plane ${o.to ?? o.name}` });
		}
		// a cart: its owner loads and unloads it beside it, or takes it back (server: cart.ts)
		if (o.kind === "cart") {
			if (o.location === room && o.x === at.x && o.y === at.y && o.ownerId === me && !guest) {
				const near = !!self && Math.max(Math.abs(o.x - self.x), Math.abs(o.y - self.y)) <= 1;
				entries.push({ label: "Karren ansehen", line: "karren" });
				if (near) {
					for (const n of [...new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me && i.name !== "Karren").map((i) => i.name))].slice(0, 6)) entries.push({ label: `${n} auf den Karren laden`, line: `karren lade ${n}` });
					entries.push({ label: "Karren entladen", line: "karren entlade" }, { label: "Karren wieder mitnehmen", line: "karren nimm" });
					// the rooms the roads reach from the cart's room, nearest first
					if (travel) {
						const near = new Map<string, string[]>();
						for (const [a, b] of travel.stops.roads) { (near.get(a) ?? near.set(a, []).get(a)!).push(b); (near.get(b) ?? near.set(b, []).get(b)!).push(a); }
						const seen = new Set([o.location]), queue = [o.location];
						for (let i = 0; i < queue.length; i++) for (const n of near.get(queue[i]!) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
						for (const id of queue.slice(1, 7)) entries.push({ label: `Karren nach ${travel.rooms.find((r) => r.roomId === id)?.name ?? id} schicken`, line: `karren fahre ${travel.rooms.find((r) => r.roomId === id)?.name ?? id}` });
					}
				}
			}
			continue;
		}
		// a furnishing inside a building (server: interior.ts): the hearth cooks the building's recipes, the chest is the
		// owner's chest, the bed is for sleep; each from beside it
		if (o.kind === "scenery" && o.use && o.location === room && covers(o, at)) {
			const beside = !!self && Math.max(Math.abs(o.x - self.x), Math.abs(o.y - self.y)) <= 1;
			// one's own chest beside one: „Truhe ansehen“ opens it (its description would be a second line of the same name)
			if (beside && o.use === "chest" && o.ownerId === me) chestEntries(room.slice(3));
			else entries.push({ label: `${o.name} ansehen`, line: `look ${o.name}` });
			if (beside && o.use === "cook") made(o.plan);
			if (beside && o.use === "sleep") entries.push({ label: "Schlafen", line: "schlafe" });
			continue;
		}
		if (o.kind === "scenery" && o.location === room && !o.through && !o.fixed && covers(o, at) && self && Math.max(Math.max(o.x - self.x, 0, self.x - (o.x + (o.w ?? 1) - 1)), Math.max(o.y - self.y, 0, self.y - (o.y + (o.h ?? 1) - 1))) <= 2) entries.push({ label: `${o.name} abräumen (noch ${o.left ?? 1})`, line: `räume ${o.x} ${o.y}` });
		if ((o.kind !== "site" && o.kind !== "building" && o.kind !== "ruin" && o.kind !== "bed" && o.kind !== "field") || o.location !== room || at.x < o.x || at.y < o.y || at.x >= o.x + (o.w ?? 1) || at.y >= o.y + (o.h ?? 1)) continue;
		const dist = self ? Math.max(Math.max(o.x - self.x, 0, self.x - (o.x + (o.w ?? 1) - 1)), Math.max(o.y - self.y, 0, self.y - (o.y + (o.h ?? 1) - 1))) : Infinity;
		// a site is worked on from two cells away (server: build.ts SITE_REACH), a building only from beside it
		const beside = dist <= 1, nearSite = dist <= 2;
		if (o.kind === "bed") {
			// a bed is tended from two cells away too, by its owner and its sponsors, a community bed by everyone; planting
			// there needs an account (server: garden.ts)
			const commons = o.bedKind === "gemein";
			entries.push({ label: commons ? "Gemeinschaftsbeet ansehen" : `${o.name} von ${o.owner ?? ""} ansehen`, line: `beet ansehen ${o.x} ${o.y}` });
			const mine = o.ownerId === me || (commons && !guest), mayTend = commons || mine || (!!self && (o.sponsorIds ?? []).includes(me));
			if (nearSite && mayTend) {
				const carried = [...objs.values()].filter((i) => i.kind === "item" && i.location === me).map((i) => i.name);
				if (carried.includes("Kanne Wasser")) entries.push({ label: "Gießen", line: "gieße" });
				if (o.weedy || (o.plants ?? []).some((pl) => pl.stage === 3)) entries.push({ label: "Jäten", line: "jäte" });
				if ((o.plants ?? []).some((pl) => pl.stage === 2)) entries.push({ label: "Ernten", line: "ernte" });
				if (beside && !o.fenced) entries.push({ label: "Zaun setzen (2 Treibholz, 1 Tangseil)", line: "zäune" });
				if (mine && (o.plants ?? []).length < (o.w ?? 1) * (o.h ?? 1)) for (const n of [...new Set(carried.filter((n) => mayPlantIn(o.bedKind, n, beds)))]) entries.push({ label: `${n} pflanzen`, line: `pflanze ${n}` });
			}
			// one's own bed (a community bed: who dug it) goes back to grass from beside it (server: garden.ts "beet aufgeben")
			if (beside && (o.ownerId === me || admin)) entries.push({ label: o.ownerId === me ? "Beet aufgeben (wird wieder Gras)" : "Beet auflösen (als Betreiber)", line: `beet aufgeben ja ${o.x} ${o.y}`, confirm: "Das Beet aufgeben? Was darin wächst, geht verloren, die Fläche wird wieder Gras." });
			continue;
		}
		if (o.kind === "field") {
			// a field is sown and harvested from two cells away, by its owner, or by everyone when it is open (server: field.ts)
			const mine = o.ownerId === me, may = mine || !!o.open;
			entries.push({ label: `Acker von ${o.owner ?? ""} ansehen`, line: `flur ansehen ${o.x} ${o.y}` });
			if (nearSite && may) {
				if (o.fieldStage === "brach" && mine) {
					const seeds = [...new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me && SOWN[i.name]).map((i) => i.name))];
					for (const n of seeds) entries.push({ label: `${n} säen`, line: `bestelle ${SOWN[n]}` });
					if (!seeds.length) entries.push({ label: "Bestellen …", line: "bestelle" });
				}
				if (o.fieldStage === "saat") entries.push({ label: "Bestellen (Saatgut, Arbeit)", line: "bestelle" });
				if (o.fieldStage === "reif" || o.fieldStage === "spaet") entries.push({ label: "Ernten", line: "ernte flur" });
				// bone meal on a growing field, once a crop (server: field.ts dünge)
				if (o.fieldStage === "waechst" && [...objs.values()].some((i) => i.kind === "item" && i.location === me && i.name === "Knochenmehl")) entries.push({ label: "Düngen (2 Knochenmehl)", line: "dünge" });
			}
			if (nearSite && mine) entries.push(o.open ? { label: "Acker für Fremde schließen", line: "flur zu" } : { label: "Acker für alle öffnen", line: "flur offen" });
			// one laid out by mistake goes back to grass, its light back to the fire (server: field.ts "flur aufgeben")
			if (nearSite && mine) entries.push({ label: "Acker aufgeben (wird wieder Gras)", line: "flur aufgeben ja", confirm: "Den Acker aufgeben? Was darauf wächst, geht verloren, die Fläche wird wieder Gras." });
			if (beside && may && !o.fenced) entries.push({ label: "Zaun um den Acker ziehen (6 Treibholz, 2 Tangseil)", line: "zäune" });
			continue;
		}
		// this one, not all in the room: the command takes its cell
		entries.push({ label: o.kind === "site" ? (o.ownerId === me ? `Deine Baustelle ${o.name}: was fehlt?` : `Baustelle ${o.name} von ${o.owner ?? ""}: was fehlt?`) : o.kind === "ruin" ? `Ruine (${o.name} von ${o.owner ?? ""})` : `${o.name} von ${o.owner ?? ""} ansehen`, line: o.kind === "building" && beside && HOUSES[o.plan ?? ""] ? "stall" : `baustelle ${o.x} ${o.y}` }); // beside a coop or pen, looking at it shows its animals
		if (o.kind === "building" && beside) {
			if (o.name === "Regentonne") entries.push({ label: "Wasser schöpfen", line: "schöpfe" });
			// anyone grinds at a mill and bakes at a bakery (server: mill.ts, the recipes "at" a plan)
			if (o.plan === "windmuehle") {
				entries.push({ label: "Mühle: wie lange noch?", line: "mahle" });
				// what the mill grinds (the world's list; grain and bones without it)
				const ground = grinds ?? ["Weizen", "Gerste", "Hafer", "Knochen"];
				const grain = [...new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me && ground.includes(i.name)).map((i) => i.name))];
				for (const n of grain) entries.push({ label: `${n} mahlen`, line: `mahle alle ${n}` });
			}
			// what is made at this building (the recipes "at" its plan, anyone's building); a building one goes into has its
			// hearth inside for that, but outside it stays as it was (docs/innenraeume.en.md)
			made(o.plan);
			// into one's own building or one invited into (server: interior.ts betrete); its owner sees who is invited
			if (o.interior && (o.ownerId === me || (o.guestIds ?? []).includes(me))) entries.push({ label: "Hineingehen", line: `betrete ${o.x} ${o.y}` });
			if (o.interior && o.ownerId === me) entries.push({ label: "Wer darf hinein?", line: "einladen" });
			// a coop, pen or hive: anyone feeds, the owner puts in, takes out and collects (server: animals.ts)
			if (HOUSES[o.plan ?? ""]) {
				// the house carries its herd while an animal is in it: nothing to feed in an empty one
				if (o.herd) entries.push({ label: "Füttern", line: "füttere" });
				if (o.ownerId === me) {
					const yields: Record<string, string> = { huhn: "Eier", ente: "Eier", schaf: "Wolle", ziege: "Milch", rind: "Milch", schwein: "Trüffel", gans: "Daunen", biene: "Honig" };
					if (o.herd) entries.push({ label: `${yields[o.herd] ?? "Ertrag"} einsammeln`, line: "einsammeln" });
					const fits = HOUSES[o.plan ?? ""]!;
					for (const n of [...new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me && fits.includes(i.name)).map((i) => i.name))]) entries.push({ label: `${n} einstallen`, line: `einstallen ${n}` });
					entries.push({ label: o.plan === "bienenstock" ? "Ein Volk herausnehmen" : "Ein Tier herausnehmen", line: "ausstallen" });
					// slaughtering takes a knife; bees are not slaughtered (server: animals.ts schlachte, which keeps the last pair)
					if (o.herd && o.herd !== "biene" && [...objs.values()].some((i) => i.kind === "item" && i.location === me && (i.name === "Schlachtmesser" || i.name === "Muschelmesser"))) entries.push({ label: "Ein Tier schlachten", line: "schlachte" });
					if (o.plan === "huehnerstall" && !o.fenced) entries.push({ label: "Zaun mit Tür setzen (3 Treibholz, 1 Tangseil)", line: "zäune" });
				}
			}
			// the butcher's shop: an animal one carries is slaughtered here, with a knife (server: animals.ts schlachte); without
			// one, or with no animal, the command says what is missing
			if (o.plan === "metzgerei") {
				const carried = [...objs.values()].filter((i) => i.kind === "item" && i.location === me);
				const animals = [...new Set(carried.filter((i) => SLAUGHTERED.includes(i.name)).map((i) => i.name))];
				const knife = carried.some((i) => i.name === "Schlachtmesser" || i.name === "Muschelmesser");
				if (knife && animals.length) for (const n of animals) entries.push({ label: `${n} schlachten`, line: `schlachte ${n.toLowerCase()}` });
				else entries.push({ label: "Ein Tier schlachten", line: "schlachte" });
			}
			// a dog or cat on guard: anyone feeds it; at an own building one leaves one or takes it along (server: animals.ts)
			const keeperName: Record<string, string> = { hund: "Hund", katze: "Katze" };
			if (o.keeper) entries.push({ label: `${keeperName[o.keeper] ?? "Tier"} füttern`, line: `füttere ${o.keeper}` }, { label: "Wer wacht hier?", line: "wache" });
			if (o.ownerId === me) {
				if (o.keeper) entries.push({ label: `${keeperName[o.keeper] ?? "Tier"} mitnehmen`, line: `ausstallen ${o.keeper}` });
				else for (const n of [...new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me && ["Hund", "Katze"].includes(i.name)).map((i) => i.name))]) entries.push({ label: `${n} hier wachen lassen`, line: `einstallen ${n}` });
			}
			entries.push({ label: "Ausbessern", line: "repariere" });
			if (o.plan === "bahnhof" && beside) {
			const island = travel?.rooms.find((r) => r.roomId === room)?.island, to = travel ? travel.rooms.filter((r) => r.island === island && r.roomId !== room && travel.stops.stations.includes(r.roomId)) : [];
			if (to.length) for (const r of to) entries.push({ label: `Mit dem Zug nach ${r.name} · ${travel!.stops.trainFare} ${travel!.stops.trainFare === 1 ? "Münze" : "Münzen"}`, line: `zug ${r.name}` });
			else entries.push({ label: "Mit dem Zug fahren: wohin?", line: "zug" });
		}
		if (o.plan === "steg" && beside) {
			const boats = new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me).map((i) => i.name));
			// fishing at anyone's jetty with a net (server: fishing.ts wirf)
			if (boats.has("Netz")) entries.push({ label: "Netz auswerfen", line: "wirf netz" });
			if (boats.has("Ruderboot")) {
				const island = travel?.rooms.find((r) => r.roomId === room)?.island, to = travel ? travel.rooms.filter((r) => r.island === island && r.roomId !== room && travel.stops.jetties.includes(r.roomId)) : [];
				if (to.length) for (const r of to) entries.push({ label: `Nach ${r.name} rudern`, line: `rudere ${r.name}` });
				else entries.push({ label: "Rudern: wohin?", line: "rudere" });
			}
			if (boats.has("Segelboot")) for (const island of sail ?? []) entries.push({ label: `Nach ${island} segeln`, line: `segle ${island}` });
			if (boats.has("Ruderboot") || boats.has("Segelboot")) entries.push({ label: "Was liegt in der Luke?", line: "luke" }, { label: "Luke leeren", line: "luke entlade alle" });
		}
		if (o.plan === "steinbruch") entries.push({ label: "Stein brechen", line: "breche" });
			if (o.plan === "kapelle") entries.push({ label: "Was man opfern kann", line: "opfere" });
			if (o.plan === "rathaus") entries.push({ label: "Laufender Antrag", line: "antrag" });
			if (o.plan === "park") entries.push({ label: "Park pflegen", line: "pflege" }, { label: "Laufendes Fest", line: "fest" });
			if (o.plan === "lehmgrube") entries.push({ label: "Lehm stechen", line: "steche" });
			if (o.plan === "salzgarten") entries.push({ label: "Salz harken", line: "harke" });
			if (o.plan === "lagerhaus") entries.push({ label: "Lager ansehen", line: "lager" });
			// only a plan with a chest of its own has one (a hut, a smokehouse); a scarecrow, a coop or a mill has none
			else if (o.ownerId === me && plans.some((p) => p.key === o.plan && p.chest)) {
				chestEntries(o.id);
			}
		}
		if (o.kind === "ruin" && o.ownerId === me) entries.push({ label: "Nachlass abholen", line: "nachlass" });
		// anyone registered clears a ruin from beside it (server: build.ts abriss)
		if (o.kind === "ruin" && beside && !guest) entries.push({ label: "Ruine abräumen", line: `abriss ruine ${o.name}` });
		if ((o.kind === "building" || o.kind === "ruin") && o.plan === "windmuehle" && nearSite) entries.push({ label: "Mehl abholen", line: "abholen" });
		if (o.kind === "site" && nearSite) {
			entries.push({ label: "Aushang ansehen", line: "aushang", ...(onOrders ? { run: onOrders } : {}) });
			entries.push({ label: "Mitarbeiten", line: "arbeite" });
			// what one carries that it still needs
			const carried = [...new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me).map((i) => i.name))];
			// "2 Tangseil, 5 Arbeit" → the names, matched whole: "Tang" is not the "Tangseil" it needs
			const needed = new Set((o.missing ?? "").split(",").map((p) => p.trim().replace(/^\d+\s+/, "")).filter(Boolean));
			for (const n of carried.filter((n) => needed.has(n))) entries.push({ label: `${n} liefern`, line: `liefere ${n}` });
		}
	}
	for (const o of objs.values()) {
		if (o.location !== room || o.x !== at.x || o.y !== at.y || o.kind === "zone" || o.kind === "scenery" || o.kind === "site" || o.kind === "building" || o.kind === "ruin" || o.kind === "bed" || o.kind === "field") continue;
		if (o.kind === "item") { entries.push({ label: `${o.name} ansehen`, line: `look ${o.name}` }); if (reach) entries.push({ label: `${o.name} aufheben`, line: `get ${o.name}` }); }
		if (o.kind === "beacon") { entries.push({ label: `${o.name} ansehen`, line: `look ${o.name}` }); if (reach && fuel) entries.push({ label: "Treibholz nachlegen", line: `put ${fuel.name} in ${o.name}` }); }
		if (o.kind === "exit") entries.push({ label: `Nach ${o.to ?? o.name} gehen`, line: `go ${o.name}` });
		// a hare, deer, fox or mouse from the fog: anyone scares it off from three cells (server: wild.ts)
		if (o.kind === "animal") entries.push({ label: `${o.animal === "hase" || !o.animal ? `${o.name}n` : o.name} verscheuchen`, line: `scheuche ${o.animal ?? "hase"}` });
	}
	// sand on the beach with a spade, where the figure stands (server: fishing.ts schaufle; elsewhere it walks there first)
	if (beachAt?.(at.x, at.y) && self && [...objs.values()].some((o) => o.kind === "item" && o.location === me && o.name === "Spaten")) {
		if (self.x === at.x && self.y === at.y) entries.push({ label: "Sand schaufeln", line: "schaufle" });
		else if (beachAt(self.x, self.y)) entries.push({ label: "Sand schaufeln (wo du stehst)", line: "schaufle" });
	}
	if (!(self && self.x === at.x && self.y === at.y)) entries.push({ label: "Hierhin gehen", line: `move ${at.x} ${at.y}` });
	// a cell nothing covers: build here (the plan's top left corner; the server says why not when it does not fit)
	const covered = [...objs.values()].some((o) => o.location === room && o.kind !== "item" && at.x >= o.x && at.y >= o.y && at.x < o.x + (o.w ?? 1) && at.y < o.y + (o.h ?? 1));
	if (!guest && plans.length && !covered) entries.push({ label: "Bauen …", line: "#bau", run: onPlans });
	if (!guest && !covered && [...objs.values()].some((o) => o.kind === "item" && o.location === me && o.name === "Spaten")) { entries.push({ label: "Beet umgraben", line: `umgraben ${at.x} ${at.y}` }); entries.push({ label: "Zierbeet umgraben (nur Blumen, sie kreuzen sich)", line: `umgraben zier ${at.x} ${at.y}` }); entries.push({ label: "Gemeinschaftsbeet anlegen (3×3, eins je Feuer)", line: `umgraben gemeinschaft ${at.x} ${at.y}` }); entries.push({ label: "Acker anlegen (4×4)", line: self && self.x === at.x && self.y === at.y ? "flur anlegen" : `flur anlegen ${at.x} ${at.y}` }); }
	// on the own figure: what works without anything more
	if (self && self.x === at.x && self.y === at.y) {
		entries.push({ label: "Umsehen", line: "look" }, { label: "Was trage ich?", line: "inventory" }, { label: "Wer spielt?", line: "who" }, { label: "Uhrzeit", line: "time" }, { label: "Mein Ruf", line: "reputation" });
		if (plans.length) entries.push({ label: "Baupläne", line: "bau" });
		if (wild !== false) entries.push({ label: "Samen sammeln", line: "sammle samen" });
	}
	return entries;
}

/** What a tap on `at` opens: the cell when something stands or lies there, or the own figure; null for free ground and exits,
 *  which are walked to. Only that cell counts: the cells beside a fire or a site must stay reachable. */
export function tapTarget(at: { x: number; y: number }, chars: Map<string, CharView>, objs: Map<string, ObjView>, room: string, me: string): { x: number; y: number } | null {
	const here = [...chars.values()].some((f) => f.x === at.x && f.y === at.y) || [...objs.values()].some((o) => o.location === room && !o.through && (AREA.has(o.kind) ? covers(o, at) : o.kind !== "exit" && o.x === at.x && o.y === at.y));
	if ([...objs.values()].some((o) => o.kind === "exit" && o.location === room && o.x === at.x && o.y === at.y)) return null;
	return here ? at : null;
}

/** The help article (with its section) for a kind of thing; a building has its plan's article first (HELP_OF_PLAN). */
export const HELP_OF_KIND: Record<string, string> = { site: "help.game.build#stake", building: "help.game.build", ruin: "help.game.build#decay", bed: "help.game.garden#bed", field: "help.game.fields#fields", beacon: "help.game.fire#beacon", animal: "help.game.wild#hares", exit: "help.game.controls#map", liner: "help.game.village#travel", cart: "help.game.village#travel" };
export const HELP_OF_PLAN: Record<string, string> = { windmuehle: "help.game.fields#mill", backhaus: "help.game.fields#mill", gehege: "help.game.animals#house", huehnerstall: "help.game.animals#house", bienenstock: "help.game.animals#bees", rathaus: "help.game.village#townhall", steg: "help.game.fishing", strasse: "help.game.village#travel", kaufhaus: "help.game.village#store", kontor: "help.game.village#store", lagerhaus: "help.game.village#store", bahnhof: "help.game.village#travel", werft: "help.game.village#travel", park: "help.game.village#ranks" };

/** A name for the sheet's head and the help article about what stands on a cell (help/articles.ts). */
export function cellAbout(at: { x: number; y: number }, chars: Map<string, CharView>, objs: Map<string, ObjView>, room: string): { title?: string; article?: string; desc?: string } {
	const area = [...objs.values()].find((o) => o.location === room && AREA.has(o.kind) && !o.through && covers(o, at));
	// a piece of scenery says itself what it is; the rest has its article
	if (area?.kind === "scenery") return { title: area.name, ...(area.desc ? { desc: area.desc } : {}) };
	if (area) return { title: area.owner ? `${area.name} von ${area.owner}` : area.name, article: (area.plan && HELP_OF_PLAN[area.plan]) || HELP_OF_KIND[area.kind] };
	const figure = [...chars.values()].find((c) => c.x === at.x && c.y === at.y);
	if (figure) return { title: figure.name };
	const o = [...objs.values()].find((o) => o.location === room && o.x === at.x && o.y === at.y);
	return o ? { title: o.name, article: HELP_OF_KIND[o.kind] } : {};
}
