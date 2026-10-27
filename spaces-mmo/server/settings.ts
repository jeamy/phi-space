// The operator's settings (docs/automaten.md, "Einstellungen für Betreiber"): limits and the model choice, kept as
// `Setting` entries in the world space, so they outlive a restart and every process that uses the space follows them
// without one. Who wins: a value saved in the space, then the environment (.env), then the built-in default. Each process
// reads them at most every SPACES_MMO_SETTINGS_MS (default 5 s).
//
// Model calls stay behind SPACES_MMO_LLM=1: the window can switch them off, never on against the environment.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";

export type SettingDef = {
	key: string; env: string; def: number; min: number; max: number;
	label: string; unit: string; help: string;
};

/** The numbers an admin may change, in the order the window shows them. */
export const SETTINGS: SettingDef[] = [
	{ key: "llm.perMin", env: "SPACES_MMO_LLM_PER_MIN", def: 20, min: 0, max: 600, label: "Modellaufrufe je Minute", unit: "Aufrufe", help: "Alle Prozesse zusammen: Übersetzungen und Modell-NPCs. 0 hält alle Aufrufe an." },
	{ key: "llm.perDay", env: "SPACES_MMO_LLM_PER_DAY", def: 500, min: 0, max: 100_000, label: "Modellaufrufe je Tag", unit: "Aufrufe", help: "Alle Prozesse zusammen, je Kalendertag (UTC). Die Kostengrenze." },
	{ key: "translate.perDay", env: "SPACES_MMO_TRANSLATE_PER_DAY", def: 200, min: 0, max: 10_000, label: "Übersetzungen je Konto und Tag", unit: "Sätze", help: "Freie Sätze, die die festen Regeln nicht verstehen und das Modell in einen Befehl übersetzt (registrierte Konten)." },
	{ key: "translate.guestPerDay", env: "SPACES_MMO_TRANSLATE_GUEST_PER_DAY", def: 20, min: 0, max: 10_000, label: "Übersetzungen je Gast und Tag", unit: "Sätze", help: "Dasselbe für Gäste." },
	{ key: "npc.max", env: "SPACES_MMO_NPC_MAX", def: 10, min: 0, max: 100, label: "Wache Modell-NPCs zugleich", unit: "NPCs", help: "So viele Modell-NPCs antworten gleichzeitig mit dem Modell; weitere dösen, bis ein Platz frei ist." },
	{ key: "npc.budgetDay", env: "SPACES_MMO_NPC_BUDGET_DAY", def: -1, min: -1, max: 10_000, label: "Modellaufrufe je NPC und Welttag", unit: "Aufrufe", help: "−1: das Budget, das die Welt jeder Rolle gibt (Ines 40, der Fremde 20). Sonst gilt diese Zahl für alle Rollen; 0: keine Modellaufrufe für NPCs." },
	{ key: "cmd.burst", env: "SPACES_MMO_CMD_BURST", def: 20, min: 1, max: 1_000, label: "Befehle auf einmal je Konto", unit: "Befehle", help: "Getippte Befehle, die ein Konto (alle offenen Seiten zusammen) auf einmal schicken darf. Schritte haben ihren eigenen Takt." },
	{ key: "cmd.perSec", env: "SPACES_MMO_CMD_PER_SEC", def: 5, min: 1, max: 100, label: "Befehle je Sekunde je Konto", unit: "je s", help: "Danach so viele je Sekunde." },
];

/** Where a value comes from: the space (the admin saved it), the environment, or the built-in default. */
export type Source = "space" | "env" | "default";
export type SettingsView = Record<string, { value: number; source: Source }>;
/** The model choice: `on` (false: the admin switched model calls off), `allowed` (labels; null: the default choice),
 *  `model` (the label calls use; null: the first allowed). */
export type ModelChoice = { on: boolean; allowed: string[] | null; model: string | null };

const envNumber = (name: string): number | undefined => { const v = process.env[name]; if (v === undefined || v.trim() === "") return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };

/** The settings as they stand, from the entries read (`saved`: key → value). */
export function resolve(saved: Map<string, unknown>): SettingsView {
	const out: SettingsView = {};
	for (const d of SETTINGS) {
		const s = saved.get(d.key), e = envNumber(d.env);
		out[d.key] = typeof s === "number" ? { value: s, source: "space" } : e !== undefined ? { value: e, source: "env" } : { value: d.def, source: "default" };
	}
	return out;
}

type Snapshot = { at: number; values: SettingsView; models: ModelChoice };
const caches = new WeakMap<SpaceLike, { snap: Snapshot | null; loading: Promise<Snapshot> | null }>();
const ttl = () => Number(process.env.SPACES_MMO_SETTINGS_MS) > 0 ? Number(process.env.SPACES_MMO_SETTINGS_MS) : 5_000;

async function load(space: SpaceLike): Promise<Snapshot> {
	const saved = new Map<string, unknown>();
	for (const e of await space.readAll({ type: "Setting" })) saved.set(String(e.fields.key), e.fields.value);
	const m = saved.get("llm.models") as { on?: boolean; allowed?: string[] | null; model?: string | null } | undefined;
	return { at: Date.now(), values: resolve(saved), models: { on: m?.on !== false, allowed: Array.isArray(m?.allowed) ? m!.allowed.map(String) : null, model: typeof m?.model === "string" ? m.model : null } };
}

/** The settings of `space`, read at most every few seconds (a failed read keeps the last ones). */
export async function settingsOf(space: SpaceLike): Promise<Snapshot> {
	let c = caches.get(space);
	if (!c) { c = { snap: null, loading: null }; caches.set(space, c); }
	if (c.snap && Date.now() - c.snap.at < ttl()) return c.snap;
	c.loading ??= load(space).then((s) => { c!.snap = s; return s; }, (e) => { if (c!.snap) return c!.snap; throw e; }).finally(() => { c!.loading = null; });
	return c.loading;
}

/** One number by key. */
export const setting = async (space: SpaceLike, key: string): Promise<number> => (await settingsOf(space)).values[key]!.value;

/** Forget the cached settings (the web process after saving, so its own next read sees them). */
export const forgetSettings = (space: SpaceLike) => { caches.delete(space); };

/** Saves values (null: back to the environment or the default). Refuses unknown keys and values out of range. */
export async function saveSettings(space: SpaceLike, values: Record<string, unknown>): Promise<void> {
	for (const [key, v] of Object.entries(values)) {
		const d = SETTINGS.find((x) => x.key === key);
		if (!d) throw new RangeError(`Unbekannte Einstellung ${key.slice(0, 40)}`);
		if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < d.min || v > d.max)) throw new RangeError(`${d.label}: eine ganze Zahl von ${d.min} bis ${d.max}`);
	}
	for (const [key, v] of Object.entries(values)) {
		while (await space.takeIfExists({ type: "Setting", fields: { key } }, NO_WAIT));
		if (v !== null) await space.write({ type: "Setting", fields: { key, value: v as number, at: Date.now() } }, null, FOREVER);
	}
	forgetSettings(space);
}

/** Saves the model choice (null: back to the default choice). */
export async function saveModelChoice(space: SpaceLike, choice: ModelChoice | null): Promise<void> {
	while (await space.takeIfExists({ type: "Setting", fields: { key: "llm.models" } }, NO_WAIT));
	if (choice) await space.write({ type: "Setting", fields: { key: "llm.models", value: { on: choice.on, allowed: choice.allowed, model: choice.model } as never, at: Date.now() } }, null, FOREVER);
	forgetSettings(space);
}

/** What the model process found (ModelInfo, renewed every few seconds): every model with credentials. */
export type ModelInfoFields = { enabled: boolean; models: Array<{ label: string; provider: string; id: string; name: string }>; at: number };
