// The player's tasks (the events' tab "Aufgaben", docs/siedeln.en.md "Aufgaben"): what its own things want of it now,
// from what the gateway sees of them anyway: a ripe or late field, a bed that is ripe, dry or weedy, a site that still
// lacks something, animals that are hungry or have something ready, flour at the mill. Pure, so it is tested without
// processes; the gateway sends them with the overview's state (AtlasState.todos), so they cost the space nothing.
import type { HerdFields, MillLoadFields } from "./model.ts";
import type { WorldDef } from "./engine/world.ts";
import type { ObjView } from "./gateway.ts";

export type { Todo } from "../shared/frames.ts";
import type { Todo } from "../shared/frames.ts";

const hours = (ms: number) => { const h = Math.round(ms / 3600_000); return h >= 1 ? `${h} ${h === 1 ? "Stunde" : "Stunden"}` : "weniger als einer Stunde"; };

/** The tasks of `charId`, most urgent first. `herds`: the herd of each building by its id; `loads`: the grain at the
 *  mills; `now`: the world's time (null without a clock: nothing that goes by the time). */
export function todosFor(charId: string, objs: Iterable<ObjView>, herds: ReadonlyMap<string, HerdFields>, loads: Iterable<MillLoadFields>, w: WorldDef, now: number | null, patient = 1): Todo[] {
	const room = (id: string) => w.rooms.find((r) => r.roomId === id)?.name ?? id;
	const where = (o: { location: string; x: number; y: number }) => `in ${room(o.location)} (${o.x} ${o.y})`;
	const proto = (key: string) => w.prototypes.find((p) => p.key === key)?.name ?? key;
	const out: Todo[] = [];
	const add = (o: { id: string; location: string; x: number; y: number }, what: string, text: string, rank: Todo["rank"]) => out.push({ id: `${o.id}:${what}`, text, room: o.location, x: o.x, y: o.y, rank });
	for (const o of objs) {
		// a bed's sponsor waters it too (garden.ts mayTend): it is told when it gets dry, nothing else of it
		const own = o.ownerId === charId;
		if (!own && !(o.kind === "bed" && o.sponsorIds?.includes(charId))) continue;
		if (o.kind === "field") {
			if (o.fieldStage === "reif") add(o, "reif", `Dein ${o.name} ${where(o)} ist reif: ernten.`, 0);
			else if (o.fieldStage === "spaet") add(o, "spaet", `Dein ${o.name} ${where(o)} ist überreif: bald ernten, sonst verdirbt die Ernte.`, 0);
			else if (o.fieldStage === "brach") add(o, "brach", `Dein Acker ${where(o)} liegt brach: bestellen („bestelle“).`, 2);
		} else if (o.kind === "bed") {
			const plants = o.plants ?? [], ripe = plants.filter((p) => p.stage === 2).length, growing = plants.filter((p) => p.stage < 2).length;
			if (own && ripe) add(o, "reif", `In deinem ${o.name} ${where(o)} ${ripe === 1 ? "ist 1 Pflanze" : `sind ${ripe} Pflanzen`} reif: ernten („ernte“).`, 0);
			// by the engine's clock (garden.ts advance): the plants wilt when the thirst times the patience is over; "dry" from
			// three quarters of it, as „look“ says „braucht Wasser“, "soon" from half
			const thirst = (o.thirstMs ?? 0) * patient;
			if (growing && now !== null && thirst && o.wateredWorldMs !== undefined && now - o.wateredWorldMs > thirst / 2) {
				const dry = now - o.wateredWorldMs > thirst * 0.75, whose = own ? `Dein ${o.name}` : `Das ${o.name} von ${o.owner}`;
				add(o, "durst", dry ? `${whose} ${where(o)} ist trocken: gießen („gieße“), sonst welken die Pflanzen.` : `${whose} ${where(o)} braucht bald Wasser: gießen („gieße“).`, dry ? 0 : 1);
			}
			if (!own) continue;
			if (o.weedy) add(o, "unkraut", `In deinem ${o.name} ${where(o)} wächst Unkraut: jäten („jäte“).`, 1);
			if (plants.some((p) => p.stage === 3)) add(o, "welk", `In deinem ${o.name} ${where(o)} ist etwas verwelkt: neu pflanzen („pflanze“).`, 2);
			if (!plants.length) add(o, "leer", `Dein ${o.name} ${where(o)} ist leer: pflanzen („pflanze“).`, 2);
		} else if (o.kind === "site") {
			add(o, "bau", `Deine Baustelle ${o.name} ${where(o)}: ${o.missing ? `es fehlen noch ${o.missing}` : "fertig bauen"} („liefere“, „arbeite“).`, 1);
		} else if (o.kind === "building" && o.herd) {
			const h = herds.get(o.id), k = w.animals?.kinds.find((x) => x.key === o.herd);
			if (!h || !k || now === null) continue;
			// at least one animal: what it has given since the last look (the house counts the rest when one comes)
			const goods = Math.min(w.animals!.nestMax, h.goods + Math.max(0, Math.min(now, h.fedUntilWorldMs) - h.atWorldMs) / k.everyWorldMs);
			if (goods >= 1) add(o, "ertrag", `In deinem ${o.name} ${where(o)} liegt ${proto(k.yields)} bereit: einsammeln („einsammeln“).`, 0);
			if (h.fedUntilWorldMs <= now) add(o, "hunger", `Die Tiere in deinem ${o.name} ${where(o)} sind hungrig: füttern („füttere“).`, 0);
		}
	}
	const mill = w.building?.plans.find((p) => p.key === w.mill?.plan)?.name ?? "Mühle";
	for (const l of loads) {
		if (l.charId !== charId || now === null || l.untilWorldMs <= now) continue;
		const o = { id: l.loadId, location: l.room, x: l.x, y: l.y };
		if (l.readyWorldMs <= now) add(o, "mehl", `${l.count} ${proto(l.to)} wartet an der ${mill} ${where(o)}: abholen („abholen“).`, 0);
		else add(o, "mahlt", `${l.count} ${proto(l.to)} ist an der ${mill} ${where(o)} in etwa ${hours(l.readyWorldMs - now)} fertig.`, 2);
	}
	return out.sort((a, b) => a.rank - b.rank);
}
