// What can be done on a cell of the map: one function for the mouse's menu and the action sheet of a touch screen. Every
// entry is a text command; `run` is for what stays on the page. Pure, so it is tested without a browser.
import type { CharView, ItemUses, ObjView, PlanView } from "../server/gateway.ts";

export type CellEntry = { label: string; line: string; run?: () => void };
export type CellInput = {
	at: { x: number; y: number }; chars: Map<string, CharView>; objs: Map<string, ObjView>; self: CharView | undefined; room: string; me: string; plans: PlanView[]; guest: boolean;
	/** What burns, cheapest carried first (a fire's "nachlegen"). */ fuel: ObjView | undefined;
	offer?: (name: string) => void;
	/** Chat with a player (not an NPC), and invite them into one of `groups` (none for a guest). */ chat?: { talk: (name: string) => void; invite: (name: string, group: string) => void; groups: string[] };
	/** Whether wild plants grow in the room (wildHere); without it seeds are offered anyway and the command answers. */ wild?: boolean;
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
const URGENT = [/^(?:ernte|abholen|einsammeln)\b/, /^(?:gieße|jäte|füttere|repariere|wache)\b/, /^(?:arbeite|liefere|breche|steche|räume)\b/];
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
			if (e.run || e.line.startsWith("#") || e.line.startsWith("move ") || e.line.startsWith("umgraben ") || INFO.test(e.line) || e.line === "beet" || /ansehen$/.test(e.label)) continue;
			if (!seen.has(e.line)) seen.set(e.line, e);
		}
	}
	return [...seen.values()].sort((a, b) => rank(a.line) - rank(b.line));
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
	if (name === "Spaten" && !guest) add({ label: "Beet umgraben", line: "umgraben" });
	for (const r of uses.recipes) {
		const uses1 = r.tool === name || r.needs.some((n) => n.name === name);
		if (!uses1 || (r.tool && !count.has(r.tool)) || r.needs.some((n) => (count.get(n.name) ?? 0) < n.count)) continue;
		if (r.at && !built.some((b) => b.plan === r.at)) continue;
		if (![...out.values()].some((e) => e.label.startsWith(`${r.name} `))) add({ label: `${r.name} herstellen`, line: `craft ${r.key}` });
	}
	if (!guest) for (const c of chars.values()) if (c.charId !== me && Math.max(Math.abs(c.x - self.x), Math.abs(c.y - self.y)) <= 1) {
		add({ label: `${c.name} geben`, line: `give ${name} an ${c.name}` });
		if (offer) add({ label: `${c.name} anbieten …`, line: `#offer ${c.name}`, run: () => offer(c.name) });
	}
	if (o.market) add({ label: "Am Markt verkaufen …", line: "#sell", run: o.market });
	return [...out.values()];
}

/** How many entries the bar shows before "Mehr": it must not push the rest of the panel out of the window. */
export const HERE_SHOWN = 5;

/** What a field is sown with, and the crop's word for `bestelle` (server: world.fields.crops). */
const SOWN: Record<string, string> = { Weizen: "weizen", Gerste: "gerste", Hafer: "hafer", Kartoffel: "kartoffel", "Rübensamen": "rüben", Leinsamen: "flachs" };
const AREA = new Set(["site", "building", "ruin", "bed", "field", "scenery"]);
const covers = (o: ObjView, c: { x: number; y: number }) => c.x >= o.x && c.y >= o.y && c.x < o.x + (o.w ?? 1) && c.y < o.y + (o.h ?? 1);

export function cellEntries({ at, chars, objs, self, room, me, plans, guest, fuel, offer, chat, wild, onPlans, onOrders }: CellInput): CellEntry[] {
	const reach = !!self && Math.max(Math.abs(at.x - self.x), Math.abs(at.y - self.y)) <= 1;
	const entries: Array<{ label: string; line: string; run?: () => void }> = [];
	for (const c of chars.values()) if (c.x === at.x && c.y === at.y && c.charId !== me) {
		entries.push({ label: `${c.name} ansehen`, line: `look ${c.name}` });
		if (offer) entries.push({ label: `${c.name} einen Tausch anbieten …`, line: `#offer ${c.name}`, run: () => offer(c.name) });
		if (chat && !c.charId.startsWith("npc-")) {
			entries.push({ label: `Chat mit ${c.name}`, line: `#chat ${c.name}`, run: () => chat.talk(c.name) });
			for (const g of chat.groups.slice(0, 4)) entries.push({ label: `${c.name} in „${g}“ einladen`, line: `#invite ${c.name} ${g}`, run: () => chat.invite(c.name, g) });
		}
	}
	// a site or building covers more than one cell: its entries on every one of them
	for (const o of objs.values()) {
		if (o.kind === "scenery" && o.location === room && !o.through && !o.fixed && covers(o, at) && self && Math.max(Math.max(o.x - self.x, 0, self.x - (o.x + (o.w ?? 1) - 1)), Math.max(o.y - self.y, 0, self.y - (o.y + (o.h ?? 1) - 1))) <= 2) entries.push({ label: `${o.name} abräumen (noch ${o.left ?? 1})`, line: `räume ${o.x} ${o.y}` });
		if ((o.kind !== "site" && o.kind !== "building" && o.kind !== "ruin" && o.kind !== "bed" && o.kind !== "field") || o.location !== room || at.x < o.x || at.y < o.y || at.x >= o.x + (o.w ?? 1) || at.y >= o.y + (o.h ?? 1)) continue;
		const dist = self ? Math.max(Math.max(o.x - self.x, 0, self.x - (o.x + (o.w ?? 1) - 1)), Math.max(o.y - self.y, 0, self.y - (o.y + (o.h ?? 1) - 1))) : Infinity;
		// a site is worked on from two cells away (server: build.ts SITE_REACH), a building only from beside it
		const beside = dist <= 1, nearSite = dist <= 2;
		if (o.kind === "bed") {
			// a bed is tended from two cells away too, by its owner and its sponsors, a community bed by everyone; planting
			// there needs an account (server: garden.ts)
			const commons = o.bedKind === "gemein";
			entries.push({ label: commons ? "Gemeinschaftsbeet ansehen" : `${o.name} von ${o.owner ?? ""} ansehen`, line: "beet" });
			const mine = o.ownerId === me || (commons && !guest), mayTend = commons || mine || (!!self && (o.sponsorIds ?? []).includes(me));
			if (nearSite && mayTend) {
				const carried = [...objs.values()].filter((i) => i.kind === "item" && i.location === me).map((i) => i.name);
				if (carried.includes("Kanne Wasser")) entries.push({ label: "Gießen", line: "gieße" });
				if (o.weedy || (o.plants ?? []).some((pl) => pl.stage === 3)) entries.push({ label: "Jäten", line: "jäte" });
				if ((o.plants ?? []).some((pl) => pl.stage === 2)) entries.push({ label: "Ernten", line: "ernte" });
				if (beside && !o.fenced) entries.push({ label: "Zaun setzen (2 Treibholz, 1 Tangseil)", line: "zäune" });
				if (mine && (o.plants ?? []).length < (o.w ?? 1) * (o.h ?? 1)) for (const n of [...new Set(carried.filter((n) => /samen$/i.test(n)))]) entries.push({ label: `${n} pflanzen`, line: `pflanze ${n}` });
			}
			continue;
		}
		if (o.kind === "field") {
			// a field is sown and harvested from two cells away, by its owner, or by everyone when it is open (server: field.ts)
			const mine = o.ownerId === me, may = mine || !!o.open;
			entries.push({ label: `Acker von ${o.owner ?? ""} ansehen`, line: "flur" });
			if (nearSite && may) {
				if (o.fieldStage === "brach" && mine) {
					const seeds = [...new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me && SOWN[i.name]).map((i) => i.name))];
					for (const n of seeds) entries.push({ label: `${n} säen`, line: `bestelle ${SOWN[n]}` });
					if (!seeds.length) entries.push({ label: "Bestellen …", line: "bestelle" });
				}
				if (o.fieldStage === "saat") entries.push({ label: "Bestellen (Saatgut, Arbeit)", line: "bestelle" });
				if (o.fieldStage === "reif" || o.fieldStage === "spaet") entries.push({ label: "Ernten", line: "ernte flur" });
			}
			if (nearSite && mine) entries.push(o.open ? { label: "Acker für Fremde schließen", line: "flur zu" } : { label: "Acker für alle öffnen", line: "flur offen" });
			if (beside && may && !o.fenced) entries.push({ label: "Zaun um den Acker ziehen (6 Treibholz, 2 Tangseil)", line: "zäune" });
			continue;
		}
		// this one, not all in the room: the command takes its cell
		entries.push({ label: o.kind === "site" ? (o.ownerId === me ? `Deine Baustelle ${o.name}: was fehlt?` : `Baustelle ${o.name} von ${o.owner ?? ""}: was fehlt?`) : o.kind === "ruin" ? `Ruine (${o.name} von ${o.owner ?? ""})` : `${o.name} von ${o.owner ?? ""} ansehen`, line: `baustelle ${o.x} ${o.y}` });
		if (o.kind === "building" && beside) {
			if (o.name === "Regentonne") entries.push({ label: "Wasser schöpfen", line: "schöpfe" });
			// anyone grinds at a mill and bakes at a bakery (server: mill.ts, the recipes "at" a plan)
			if (o.plan === "windmuehle") {
				entries.push({ label: "Mühle: wie lange noch?", line: "mahle" });
				const grain = [...new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me && ["Weizen", "Gerste", "Hafer"].includes(i.name)).map((i) => i.name))];
				for (const n of grain) entries.push({ label: `${n} mahlen`, line: `mahle alle ${n}` });
			}
			if (o.plan === "backhaus") entries.push({ label: "Brot backen (2 Mehl, 1 Kanne Wasser, 1 Treibholz)", line: "backe brot" });
			if (o.plan === "webstuhl") entries.push({ label: "Tuch weben (3 Wolle, Spindel)", line: "craft tuch" }, { label: "Daunendecke nähen (2 Tuch, 3 Daunen)", line: "craft decke" });
			if (o.plan === "huette") entries.push({ label: "Käse machen (3 Milch, 1 Treibholz)", line: "craft käse" });
			// a coop or pen: anyone feeds, the owner puts in, takes out and collects (server: animals.ts)
			if (o.plan === "huehnerstall" || o.plan === "gehege") {
				entries.push({ label: "Tiere ansehen", line: "stall" }, { label: "Füttern", line: "füttere" });
				if (o.ownerId === me) {
					const yields: Record<string, string> = { huhn: "Eier", ente: "Eier", schaf: "Wolle", ziege: "Milch", rind: "Milch", gans: "Daunen" };
					if (o.herd) entries.push({ label: `${yields[o.herd] ?? "Ertrag"} einsammeln`, line: "einsammeln" });
					const fits = o.plan === "huehnerstall" ? ["Huhn"] : ["Schaf", "Ziege", "Ente", "Gans"];
					for (const n of [...new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me && fits.includes(i.name)).map((i) => i.name))]) entries.push({ label: `${n} einstallen`, line: `einstallen ${n}` });
					entries.push({ label: "Ein Tier herausnehmen", line: "ausstallen" });
					if (o.plan === "huehnerstall" && !o.fenced) entries.push({ label: "Zaun mit Tür setzen (3 Treibholz, 1 Tangseil)", line: "zäune" });
				}
			}
			// a dog or cat on guard: anyone feeds it; at an own building one leaves one or takes it along (server: animals.ts)
			const keeperName: Record<string, string> = { hund: "Hund", katze: "Katze" };
			if (o.keeper) entries.push({ label: `${keeperName[o.keeper] ?? "Tier"} füttern`, line: `füttere ${o.keeper}` }, { label: "Wer wacht hier?", line: "wache" });
			if (o.ownerId === me) {
				if (o.keeper) entries.push({ label: `${keeperName[o.keeper] ?? "Tier"} mitnehmen`, line: `ausstallen ${o.keeper}` });
				else for (const n of [...new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me && ["Hund", "Katze"].includes(i.name)).map((i) => i.name))]) entries.push({ label: `${n} hier wachen lassen`, line: `einstallen ${n}` });
			}
			entries.push({ label: "Ausbessern", line: "repariere" });
			if (o.plan === "steinbruch") entries.push({ label: "Stein brechen", line: "breche" });
			if (o.plan === "kapelle") entries.push({ label: "Was man opfern kann", line: "opfere" });
			if (o.plan === "rathaus") entries.push({ label: "Laufender Antrag", line: "antrag" });
			if (o.plan === "park") entries.push({ label: "Park pflegen", line: "pflege" }, { label: "Laufendes Fest", line: "fest" });
			if (o.plan === "lehmgrube") entries.push({ label: "Lehm stechen", line: "steche" });
			if (o.plan === "ziegelei") entries.push({ label: "Ziegel brennen", line: "craft ziegel" });
			if (o.plan === "lagerhaus") entries.push({ label: "Lager ansehen", line: "lager" });
			else if (o.ownerId === me) entries.push({ label: "Truhe ansehen", line: "truhe" });
		}
		if (o.kind === "ruin" && o.ownerId === me) entries.push({ label: "Nachlass abholen", line: "nachlass" });
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
	if (!(self && self.x === at.x && self.y === at.y)) entries.push({ label: "Hierhin gehen", line: `move ${at.x} ${at.y}` });
	// a cell nothing covers: build here (the plan's top left corner; the server says why not when it does not fit)
	const covered = [...objs.values()].some((o) => o.location === room && o.kind !== "item" && at.x >= o.x && at.y >= o.y && at.x < o.x + (o.w ?? 1) && at.y < o.y + (o.h ?? 1));
	if (!guest && plans.length && !covered) entries.push({ label: "Bauen …", line: "#bau", run: onPlans });
	if (!guest && !covered && [...objs.values()].some((o) => o.kind === "item" && o.location === me && o.name === "Spaten")) { entries.push({ label: "Beet umgraben", line: `umgraben ${at.x} ${at.y}` }); entries.push({ label: "Acker anlegen (4×4)", line: `flur anlegen ${at.x} ${at.y}` }); }
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

/** A name for the sheet's head and the help article about what stands on a cell (help/articles.ts). */
export function cellAbout(at: { x: number; y: number }, chars: Map<string, CharView>, objs: Map<string, ObjView>, room: string): { title?: string; article?: string; desc?: string } {
	const articles: Record<string, string> = { site: "help.game.build", building: "help.game.build", ruin: "help.game.build", bed: "help.game.garden", field: "help.game.fields", beacon: "help.game.fire", animal: "help.game.wild", exit: "help.game.controls" };
	const area = [...objs.values()].find((o) => o.location === room && AREA.has(o.kind) && !o.through && covers(o, at));
	// a piece of scenery says itself what it is; the rest has its article
	if (area?.kind === "scenery") return { title: area.name, ...(area.desc ? { desc: area.desc } : {}) };
	if (area) return { title: area.owner ? `${area.name} von ${area.owner}` : area.name, article: articles[area.kind] };
	const figure = [...chars.values()].find((c) => c.x === at.x && c.y === at.y);
	if (figure) return { title: figure.name };
	const o = [...objs.values()].find((o) => o.location === room && o.x === at.x && o.y === at.y);
	return o ? { title: o.name, article: articles[o.kind] } : {};
}
