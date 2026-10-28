// The model process (docs/modell-npcs.md, "Kosten und Grenzen"): turns sentences no rule understood into commands. It
// takes a Translate entry, shows a cheap model the commands and what the player sees (exits, things, people, market),
// and writes the answer back as an Intent with `asked` (the original sentence), which a world worker runs like any
// command. An answer that is not a command is refused. Every call is counted (server/llm.ts): per account and day
// (SPACES_MMO_TRANSLATE_PER_DAY, default 200; guests SPACES_MMO_TRANSLATE_GUEST_PER_DAY, default 20) and shared limits.
// With SPACES_MMO_LLM unset this process only answers that translating is off.
import "./env.ts";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { DEFAULT_COMMANDS, helpLine } from "./engine/commands/default.ts";
import { TRADE_COMMANDS } from "./engine/commands/trade.ts";
import { msgOptions } from "./engine/context.ts";
import { loadWorld, type WorldDef } from "./engine/world.ts";
import { availableModels, complete, llmEnabled } from "./llm.ts";
import { setting, type ModelInfoFields } from "./settings.ts";
import { fieldsOf, type CharacterFields, type ExitFields, type IntentFields, type ItemFields, type ListingFields, type TranslateFields } from "./model.ts";
import { announce, awaitWork, connectSpace, DEFAULT_SPACE, envMs } from "./space.ts";

const COMMANDS = [...DEFAULT_COMMANDS, ...TRADE_COMMANDS].filter((c) => !c.hidden);
const VERBS = new Set(COMMANDS.flatMap((c) => [c.key, ...(c.aliases ?? [])].map((n) => n.toLowerCase())));

export const TRANSLATE_SYSTEM = "You turn what a player of a text adventure typed (German or English) into exactly one game command. Answer with the command alone on one line, no explanation, no quotes. Use the names of things, people and exits exactly as listed. When the player speaks to someone who is here (names them, greets them, asks them to do something), or greets anyone at all, that is talk, not a command for the player: answer say <the player's words, all of them, the name included>. If no command fits, answer ?";

/** What the model is shown: the commands, then what the player sees, then the sentence. */
export async function translatePrompt(space: SpaceLike, w: WorldDef, t: TranslateFields): Promise<string> {
	const names = (xs: Array<{ fields: Record<string, unknown> }>) => xs.map((e) => String(e.fields.name)).join(", ") || "–";
	const exits = (await space.readAll({ type: "Exit", fields: { location: t.room } })).map((e) => { const f = fieldsOf<ExitFields>(e); return `${f.name} (${[f.name, ...f.aliases].join("/")})`; });
	const here = await space.readAll({ type: "Item", fields: { location: t.room } });
	const carried = await space.readAll({ type: "Item", fields: { location: t.charId } });
	const people = (await space.readAll({ type: "Character", fields: { room: t.room } })).filter((e) => fieldsOf<CharacterFields>(e).charId !== t.charId);
	const listings = w.market.rooms.includes(t.room) ? (await space.readAll({ type: "Listing", fields: { room: t.room } })).map((e) => fieldsOf<ListingFields>(e)).sort((a, b) => a.at - b.at).map((l, i) => `${i + 1}. ${l.itemName} for ${l.price}`) : [];
	return [
		"Commands:", ...COMMANDS.map((c) => `  ${helpLine(c)}`),
		`Exits here: ${exits.join(", ") || "–"}`,
		`Things lying here: ${names(here)}`,
		`The player carries: ${carried.map((e) => fieldsOf<ItemFields>(e).name).join(", ") || "–"}`,
		`People here: ${names(people)}`,
		...(listings.length ? [`Market board: ${listings.join("; ")}`] : []),
		"",
		`The player typed: ${t.line}`,
	].join("\n");
}

/** The first line of an answer if it starts with a known command, else null. */
export function commandOf(text: string, exitNames: string[]): string | null {
	const line = (text.split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/^[`"'„“]+|[`"'„“]+$/g, "").trim();
	const verb = line.split(/\s+/)[0]?.toLowerCase() ?? "";
	if (!line || line === "?" || line.length > 200) return null;
	// a one-letter name ("i", "l", "o") only as the whole answer: "I think you mean look" is prose, not inventory
	if (verb.length === 1 && line.length > 1) return null;
	return VERBS.has(verb) || exitNames.includes(verb) ? line : null;
}

export async function startModel(o: { space?: string; world?: WorldDef } = {}) {
	const w = o.world ?? (await loadWorld());
	const conn = connectSpace(o.space ?? (process.env.SPACES_MMO_SPACE || DEFAULT_SPACE));
	const space = conn.space, halt = new AbortController();
	const msgLeaseMs = envMs("SPACES_MMO_MSG_LEASE_MS", 2 * 60_000);
	const say = async (t: TranslateFields, text: string, txn: string) => space.write({ type: "Msg", fields: { room: t.room, to: t.charId, kind: "error", text, from: "", at: Date.now() } as never }, txn, msgLeaseMs, await msgOptions(space, { to: t.charId, kind: "error" }));

	const step = async (): Promise<boolean> => {
		const [next] = await space.readAll({ type: "Translate" }, { limit: 1 });
		if (!next) return false;
		const txn = (await space.createTransaction(60_000)).id;
		try {
			const e = await space.takeIfExists({ type: "Translate", id: next.id }, NO_WAIT, { txn });
			if (!e) { await space.abort(txn); return true; }
			const t = fieldsOf<TranslateFields>(e);
			const perDay = await setting(space, t.guest ? "translate.guestPerDay" : "translate.perDay");
			const res = await complete(space, TRANSLATE_SYSTEM, await translatePrompt(space, w, t), { maxTokens: 60, own: { key: `translate:${t.accountId}`, perDay } }).catch((err) => { console.error("[model] translate:", (err as Error).message); return null; });
			const exitNames = (await space.readAll({ type: "Exit", fields: { location: t.room } })).flatMap((x) => [String(x.fields.name), ...((x.fields.aliases as string[]) ?? [])].map((n) => n.toLowerCase()));
			// talk is said as it was typed (the model may shorten it and drop the name of whom it is for)
			const cmd = res && commandOf(res.text, exitNames);
			const line = cmd && /^(say|sag|sage)\s/i.test(cmd) ? `say ${t.line}` : cmd;
			if (!res) await say(t, `„${t.line.slice(0, 80)}“ kann ich gerade nicht übersetzen (Modell aus oder Kontingent für heute aufgebraucht). „help“ zeigt die Befehle.`, txn);
			else if (!line) await say(t, `„${t.line.slice(0, 80)}“ habe ich nicht verstanden. „help“ zeigt die Befehle.`, txn);
			else await space.write({ type: "Intent", fields: { intentId: randomBytes(8).toString("hex"), charId: t.charId, line, at: Date.now(), asked: t.line } satisfies IntentFields as never }, txn, 30_000);
			await space.commit(txn);
		} catch (err) { await space.abort(txn).catch(() => {}); console.error("[model]", (err as Error).message); await new Promise((r) => setTimeout(r, 500)); }
		return true;
	};

	// what the admin's window offers: every model with credentials, published for the web process (it has none)
	const publish = async () => {
		const info: ModelInfoFields = { enabled: llmEnabled(), models: await availableModels(), at: Date.now() };
		const txn = (await space.createTransaction(10_000)).id;
		try {
			while (await space.takeIfExists({ type: "ModelInfo" }, NO_WAIT, { txn }));
			await space.write({ type: "ModelInfo", fields: info as never }, txn, 60_000);
			await space.commit(txn);
		} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
	};
	void publish().catch((e) => console.error("[model] publish:", (e as Error).message));
	const beat = setInterval(() => void publish().catch((e) => console.error("[model] publish:", (e as Error).message)), 20_000);
	beat.unref?.();

	const loop = (async () => {
		while (!halt.signal.aborted) {
			try { if (!(await step())) await awaitWork(space, { type: "Translate" }, halt.signal); }
			catch (e) { if (halt.signal.aborted) break; console.error("[model] loop:", (e as Error).message); await new Promise((r) => setTimeout(r, 1000)); }
		}
	})();
	const proc = announce(conn.space, "model");
	return { async close() { halt.abort(); clearInterval(beat); await loop; await proc.stop(); conn.close(); } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const m = await startModel();
	// the starter and the tests wait for this line
	console.log(`[model] ready (${process.env.SPACES_MMO_LLM === "1" ? "model calls on" : "model calls off"})`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await m.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
