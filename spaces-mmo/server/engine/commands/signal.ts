// Signal fires (docs/siedeln.en.md, epoch 4): a signal fire is a building of the network epoch, and signal fires in rooms
// one way apart, over land or a ferry, are a chain when they stand in the light of two fires or more. While every one of
// those fires burns, they share their light (fire.ts coversOf); the chain tick counts how long each island stays linked
// by a burning chain. `signalfeuer` tells the chains of this island and the longest runs of the islands of this region.
import { fieldsOf, type FireChainFields } from "../../model.ts";
import type { Command } from "../cmdsets.ts";
import { msg } from "../context.ts";
import { worldNowOf } from "../clock.ts";
import { chainsOf } from "../fire.ts";

/** A span of world time in words: minutes, hours or days. */
export function spanText(ms: number): string {
	const min = Math.round(ms / 60_000), h = Math.round(ms / 3600_000), d = Math.round(ms / (24 * 3600_000));
	if (min < 60) return `${Math.max(1, min)} Weltminute${min === 1 ? "" : "n"}`;
	if (h < 48) return `${h} Weltstunde${h === 1 ? "" : "n"}`;
	return `${d} Welttage`;
}

const list = (xs: string[]) => xs.join(", ");

const signalfeuer: Command = {
	key: "signalfeuer", aliases: ["signale", "signalkette", "feuerkette", "signal fires"],
	help: "signalfeuer – die Ketten der Signalfeuer dieser Insel: welche Feuer sie verbinden, ob sie brennen, und welche Insel dieser Gegend ihre Kette am längsten brennen ließ",
	async func(c) {
		const w = c.world, roomOf = (id: string) => w.rooms.find((r) => r.roomId === id);
		const island = roomOf(c.actor.room)?.island ?? w.title, fire = (id: string) => w.beacons.find((b) => b.beaconId === id)?.name ?? id;
		const now = await worldNowOf(c.space, c.txn), chains = (await chainsOf(c.space, w, c.txn)).filter((x) => x.islands.includes(island));
		const lines = chains.map((x) => `Die Signalfeuer in ${list(x.rooms.map((r) => roomOf(r)?.name ?? r))} verbinden die Feuer ${list(x.fires.map(fire))}; ${x.lit ? "die Kette brennt, ihre Feuer teilen ihr Licht." : `die Kette ist unterbrochen; aus: ${list(x.out.map((o) => fire(o.beaconId)))}.`}`);
		if (!chains.length) lines.push(`Auf ${island} bilden keine Signalfeuer eine Kette. Ein Signalfeuer (ab der Epoche Netz) in zwei Räumen nebeneinander, auch über eine Fähre, im Licht zweier Feuer verbindet sie: Solange beide brennen, teilen sie ihr Licht.`);
		// the runs of this region's islands, the one burning now counted to this moment
		const runs = (await c.space.readAll({ type: "FireChain" }, { txn: c.txn })).map((e) => fieldsOf<FireChainFields>(e)).map((f) => ({ island: f.island, since: f.since, best: Math.max(f.best, f.since ? now - f.since : 0) })).filter((f) => f.best > 0).sort((a, b) => b.best - a.best || a.island.localeCompare(b.island));
		const here = runs.find((f) => f.island === island);
		if (here?.since) lines.push(`Die Kette brennt auf ${island} seit ${spanText(now - here.since)} ohne Unterbrechung.`);
		if (runs.length) lines.push(`Am längsten brannte eine Kette hier in der Gegend: ${runs.slice(0, 5).map((f, i) => `${i + 1}. ${f.island} (${spanText(f.best)})`).join(", ")}.`);
		for (const line of lines) await msg(c, c.actor.charId, "info", line);
	},
};

export const SIGNAL_COMMANDS: Command[] = [signalfeuer];
