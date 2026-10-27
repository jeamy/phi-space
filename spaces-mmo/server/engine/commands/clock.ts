// The world's clock as commands (docs/weltzeit.md): `time` tells everyone the world time; `clock` is the operator's
// (Admin): status, pause, resume and rate. A change takes the clock entry and writes it again with both anchors moved to
// the moment of the change, in the command's transaction: no jump, and two changes at once cannot both succeed.
import { FOREVER, NO_WAIT } from "phi-spaces";
import type { Command } from "../cmdsets.ts";
import { CommandError, msg, type CommandCtx } from "../context.ts";
import { fieldsOf, type WorldClockFields } from "../../model.ts";
import { calendar, formatWorldTime, MAX_RATE, MIN_RATE, paused, resumed, withRate, worldNow } from "../worldtime.ts";
import { peek } from "../../space.ts";

const ADMIN = "cmd:perm(Admin)";

async function readClock(c: CommandCtx) {
	const e = await peek(c.space, { type: "WorldClock", fields: { worldId: c.world.id } }, { txn: c.txn });
	if (!e) throw new CommandError("Diese Welt hat noch keine Uhr.");
	return { e, clock: fieldsOf<WorldClockFields>(e) };
}

const describe = (clock: WorldClockFields, now: number) => {
	const t = calendar(worldNow(clock, now));
	const speed = clock.rate === 1 ? "in Echtzeit" : clock.rate > 1 ? `${clock.rate}-fach beschleunigt` : `${clock.rate}-fach verlangsamt`;
	return `${formatWorldTime(worldNow(clock, now))} Uhr (Welttag ${t.day + 1}); ${clock.paused ? "die Uhr ist angehalten" : `die Uhr läuft ${speed}`}.`;
};

const time: Command = {
	key: "time", aliases: ["zeit", "uhrzeit"],
	help: "time – die Zeit in der Welt: Tag und Uhrzeit",
	async func(c) {
		const { clock } = await readClock(c);
		await msg(c, c.actor.charId, "info", `Es ist ${formatWorldTime(worldNow(clock, Date.now()))} Uhr${clock.paused ? " (die Zeit steht still)" : ""}.`);
	},
};

const clock: Command = {
	key: "clock", aliases: ["uhr"], locks: ADMIN,
	help: "clock [pause|weiter|rate <n>] – die Weltuhr: Stand, anhalten, fortsetzen, Tempo (Weltsekunden je Sekunde; 1 = Echtzeit)",
	async func(c, arg) {
		const { e, clock: now } = await readClock(c);
		const [verb = "", value] = arg.trim().split(/\s+/);
		const realNow = Date.now();
		let next: WorldClockFields | null = null;
		if (/^(pause|halt|stop|anhalten)$/i.test(verb)) { if (now.paused) throw new CommandError("Die Uhr steht schon still."); next = paused(now, realNow); }
		else if (/^(weiter|resume|start|fortsetzen)$/i.test(verb)) { if (!now.paused) throw new CommandError("Die Uhr läuft schon."); next = resumed(now, realNow); }
		else if (/^(rate|tempo|speed)$/i.test(verb)) {
			const rate = Number(value?.replace(",", "."));
			if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) throw new CommandError(`So geht es: clock rate <n> mit ${MIN_RATE} bis ${MAX_RATE} (1 = Echtzeit, 60 = eine Weltminute je Sekunde).`);
			next = withRate(now, rate, realNow);
		} else if (verb && !/^(status|stand)$/i.test(verb)) throw new CommandError("So geht es: clock | clock pause | clock weiter | clock rate <n>");
		if (next) {
			const t = await c.space.take({ type: e.type, id: e.id }, NO_WAIT, { txn: c.txn });
			if (!t) throw new CommandError("Die Uhr wird gerade geändert; bitte gleich noch einmal.");
			await c.space.write({ type: "WorldClock", fields: next as never }, c.txn, FOREVER);
		}
		await msg(c, c.actor.charId, "info", describe(next ?? now, realNow));
	},
};

export const CLOCK_COMMANDS: Command[] = [time, clock];
