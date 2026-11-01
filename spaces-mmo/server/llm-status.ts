// What the admin's window says about the model calls (client/AdminPanel.tsx): what stands in their way and what to do about it,
// worked out from what the model process published (ModelInfo), the settings, the counters of llm.ts and the last notes
// (LlmStatus). One view per region: each has its own space, its own model process and its own counters.
import type { SpaceLike } from "phi-spaces";
import { chosen } from "./llm.ts";
import { setting, settingsOf, type ModelInfoFields } from "./settings.ts";

export type LlmProblem = { level: "error" | "warn"; text: string; fix: string };
export type Noted = { text: string; at: number };
export type LlmStatusView = { region: string; problems: LlmProblem[]; last: Noted | null; ok: Noted | null; day: { used: number; limit: number }; minute: { used: number; limit: number } };

const used = async (space: SpaceLike, key: string): Promise<number> => Number((await space.readIfExists({ type: "LlmCount", fields: { key } }, 0))?.fields.used ?? 0);
const noted = async (space: SpaceLike, key: string): Promise<Noted | null> => {
	const f = (await space.readIfExists({ type: "LlmStatus", fields: { key } }, 0))?.fields as { text?: string; at?: number } | undefined;
	return f?.text ? { text: String(f.text), at: Number(f.at ?? 0) } : null;
};

export async function llmStatus(region: string, space: SpaceLike): Promise<LlmStatusView> {
	const info = (await space.readAll({ type: "ModelInfo" }, { limit: 1 }))[0]?.fields as unknown as ModelInfoFields | undefined;
	const s = await settingsOf(space), now = new Date(), day = now.toISOString().slice(0, 10), minute = now.toISOString().slice(0, 16);
	const perMin = await setting(space, "llm.perMin"), perDay = await setting(space, "llm.perDay");
	const day_ = { used: await used(space, `day:${day}`), limit: perDay }, minute_ = { used: await used(space, `min:${minute}`), limit: perMin };
	const last = await noted(space, "last"), ok = await noted(space, "ok");
	const problems: LlmProblem[] = [];
	const add = (level: LlmProblem["level"], text: string, fix: string) => problems.push({ level, text, fix });
	if (!info) add("error", "Der Modellprozess meldet sich nicht (er meldet sich alle 20 Sekunden).", `Prüfe, ob der Container model-${region} läuft (docker ps), und lies sein Log.`);
	else if (!info.enabled) add("error", "Modellaufrufe sind in der Umgebung aus: SPACES_MMO_LLM ist nicht 1.", "Trage SPACES_MMO_LLM=1 in die .env des Servers ein und starte die Container neu. Die Aufrufe kosten Tokens.");
	else if (!s.models.on) add("error", "Die Modellaufrufe sind hier im Fenster ausgeschaltet.", "Setze unter „Modelle“ den Haken bei „Modell-NPCs und Übersetzen an“ und speichere.");
	else if (!info.models.length) add("error", "Kein Modell mit Zugangsdaten gefunden.", "Lege den API-Schlüssel in die Umgebung des Modellprozesses (oder ~/.pi/agent/auth.json) und starte ihn neu.");
	else if (!chosen(info.models, s.models).model) add("error", "Kein erlaubtes Modell wählbar: das Standardmodell (SPACES_MMO_LLM_MODEL, sonst Haiku) fehlt unter den verfügbaren, oder die gewählten gibt es nicht mehr.", "Wähle unter „Modelle“ eines aus und speichere.");
	if (info?.enabled && s.models.on) {
		if (perDay === 0) add("error", "Modellaufrufe je Tag stehen auf 0: alle Aufrufe sind angehalten.", "Erhöhe „Modellaufrufe je Tag“ unter „Grenzen“.");
		else if (day_.used >= perDay) add("error", `Das Tageskontingent ist aufgebraucht: ${day_.used} von ${perDay} Aufrufen (Kalendertag UTC, neu ab 00:00 UTC).`, "Erhöhe „Modellaufrufe je Tag“ unter „Grenzen“ oder warte bis zum nächsten UTC-Tag.");
		if (perMin === 0) add("error", "Modellaufrufe je Minute stehen auf 0: alle Aufrufe sind angehalten.", "Erhöhe „Modellaufrufe je Minute“ unter „Grenzen“.");
		else if (minute_.used >= perMin) add("warn", `Das Minutenkontingent ist gerade erreicht: ${minute_.used} von ${perMin}.`, "Es setzt zur nächsten Minute zurück; erhöhe „Modellaufrufe je Minute“, wenn das oft vorkommt.");
		const perAccount = await setting(space, "translate.perDay");
		if (perAccount === 0) add("warn", "Übersetzungen je Konto stehen auf 0: freie Sätze werden nicht übersetzt.", "Erhöhe „Übersetzungen je Konto und Tag“ unter „Grenzen“.");
		else {
			const full = (await space.readAll({ type: "LlmCount" })).filter((e) => String(e.fields.key).startsWith("translate:") && String(e.fields.key).endsWith(`:${day}`) && Number(e.fields.used) >= perAccount).length;
			if (full) add("warn", `${full} ${full === 1 ? "Konto hat" : "Konten haben"} heute die Grenze für Übersetzungen erreicht (${perAccount} je Konto).`, "Erhöhe „Übersetzungen je Konto und Tag“ unter „Grenzen“. Gäste haben ihre eigene, kleinere Grenze.");
		}
		if (await setting(space, "translate.guestPerDay") === 0) add("warn", "Übersetzungen je Gast stehen auf 0: Gäste bekommen keine Übersetzung.", "Erhöhe „Übersetzungen je Gast und Tag“ unter „Grenzen“.");
	}
	if (last && /^Fehler des Anbieters/.test(last.text) && Date.now() - last.at < 15 * 60_000) add("error", `Der Anbieter antwortet mit Fehlern. ${last.text}`, "Prüfe den API-Schlüssel, das Guthaben beim Anbieter und die Erreichbarkeit; wähle sonst ein anderes Modell.");
	return { region, problems, last, ok, day: day_, minute: minute_ };
}
