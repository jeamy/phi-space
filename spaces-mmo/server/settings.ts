// The operator's settings (docs/automaten.en.md, "Einstellungen für Betreiber"): limits and the model choice, kept as
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
	{ key: "settlers.min", env: "SPACES_MMO_SETTLERS_MIN", def: 30, min: 0, max: 200, label: "Figuren, die immer spielen", unit: "Figuren", help: "So viele Figuren sind mindestens unterwegs: fehlen Menschen, spielen Siedler (Skript, kein Modell) ihren Teil, sammeln, bauen, säen und helfen auf Baustellen. Jeder Mensch, der spielt, ersetzt einen Siedler seiner Region. 0: keine Siedler." },
	{ key: "epoch.dorf", env: "SPACES_MMO_EPOCH_DORF", def: 15, min: 0, max: 10_000, label: "Punkte einer Insel für das Dorf", unit: "Punkte", help: "Gehaltener Bestand einer Insel (Bauten, Beete, Äcker nach ihren Lichtpunkten), ab dem sie Epoche 2 erreicht und Mühle, Backhaus, Gehege, Webstuhl und Äcker freischaltet. Wenige Spieler: kleiner." },
	{ key: "epoch.stadt", env: "SPACES_MMO_EPOCH_STADT", def: 40, min: 0, max: 10_000, label: "Punkte einer Insel für die Stadt", unit: "Punkte", help: "Dasselbe für Epoche 3." },
	{ key: "epoch.netz", env: "SPACES_MMO_EPOCH_NETZ", def: 80, min: 0, max: 10_000, label: "Punkte einer Insel für das Netz", unit: "Punkte", help: "Dasselbe für Epoche 4." },
	{ key: "clock.life", env: "SPACES_MMO_CLOCK_LIFE", def: -1, min: -1, max: 100_000, label: "Lebenstakt", unit: "Welttage je Tag", help: "Wie schnell die Welt lebt, in allen Regionen: Tag und Nacht, Wetter, Wachstum, Arbeit, Tiere. 1 ist Echtzeit, 24 ein Welttag je Stunde. −1: Die Uhr bleibt, wie sie steht." },
	{ key: "clock.decay", env: "SPACES_MMO_CLOCK_DECAY", def: -1, min: -1, max: 100_000, label: "Verfallstakt", unit: "Tage je Tag", help: "Wie schnell läuft, was auf Menschen wartet: Verfall, Abstimmungen, Feste, Durst, Erntefenster, Marktangebote, Feuer, Strandgut. 1 ist Echtzeit, die Tage hier sind dann echte Tage. −1: bleibt, wie es steht." },
	{ key: "work.rest", env: "SPACES_MMO_WORK_REST", def: 15, min: 0, max: 1_440, label: "Ruhe nach der Arbeit", unit: "Weltminuten", help: "So lange ruht eine Figur nach einem Arbeitspunkt (Baustelle, Acker, Steinbruch, Lehmgrube, Netz). Es sind Minuten der Weltzeit, sie laufen also im Lebenstakt. Segen und Essen kürzen die Ruhe. Gilt ab der nächsten Arbeit; wer schon ruht, ruht zu Ende. 0: keine Ruhe." },
	{ key: "year.days", env: "SPACES_MMO_YEAR_DAYS", def: 56, min: 0, max: 1_000, label: "Länge eines Jahres", unit: "Welttage", help: "Vier gleich lange Jahreszeiten. Im Winter wächst draußen nichts, das Erntefest gibt es im Herbst, die Blumenschau im Frühling und Sommer. 0: keine Jahreszeiten." },
	{ key: "epoch.force", env: "SPACES_MMO_EPOCH_FORCE", def: 0, min: 0, max: 4, label: "Epoche erzwingen (zum Testen)", unit: "Epoche", help: "0: die Epoche jeder Insel folgt ihrem Bestand. 1 bis 4 setzt sie für alle Inseln fest, damit sich testen lässt, was eine Epoche freischaltet (Pläne, Äcker, Beamen). Danach wieder auf 0 stellen („Standard“ im Feld); der Bestand zählt dann wieder." },
	{ key: "beam.cost", env: "SPACES_MMO_BEAM_COST", def: 1, min: 0, max: 100, label: "Beamen: Münzen je Kartenfeld", unit: "Münzen", help: "So viele Münzen kostet das Beamen von einem brennenden Feuer zu einem anderen je Feld Abstand auf der Weltkarte (mindestens ein Feld). 0: kostenlos." },
	{ key: "beam.cooldown", env: "SPACES_MMO_BEAM_COOLDOWN", def: 10, min: 0, max: 1_440, label: "Beamen: Pause danach", unit: "Weltminuten", help: "So lange muss eine Figur nach dem Beamen warten, bis sie wieder beamen kann (Weltzeit, sie läuft im Lebenstakt). 0: keine Pause." },
	{ key: "beam.epoch", env: "SPACES_MMO_BEAM_EPOCH", def: 4, min: 1, max: 4, label: "Beamen ab Epoche", unit: "Epoche", help: "Ab dieser Epoche der Insel, auf der man steht, kann man beamen (4: das Netz, 1: von Anfang an)." },
	{ key: "keep.scheuche", env: "SPACES_MMO_KEEP_SCHEUCHE", def: 40, min: 1, max: 1_000, label: "Vogelscheuche steht", unit: "Tage", help: "So lange hält sie nach Bau oder Reparatur. Gilt für Neues und die nächste Reparatur; was steht, behält sein Datum." },
	{ key: "keep.bau", env: "SPACES_MMO_KEEP_BAU", def: 40, min: 1, max: 1_000, label: "Hütten, Mühle, Backhaus, Ställe stehen", unit: "Tage", help: "Dasselbe für Hütte, Windmühle, Backhaus, Webstuhl, Hühnerstall, Gehege und Regentonne." },
	{ key: "keep.lager", env: "SPACES_MMO_KEEP_LAGER", def: 45, min: 1, max: 1_000, label: "Lager, Gruben, Werkstätten, Rathaus stehen", unit: "Tage", help: "Dasselbe für Lagerhaus, Steinbruch, Lehmgrube, Ziegelei, Werkstatt und Rathaus." },
	{ key: "keep.kapelle", env: "SPACES_MMO_KEEP_KAPELLE", def: 60, min: 1, max: 1_000, label: "Kapelle steht", unit: "Tage", help: "Dasselbe für die Kapelle." },
	{ key: "keep.park", env: "SPACES_MMO_KEEP_PARK", def: 120, min: 1, max: 1_000, label: "Park steht", unit: "Tage", help: "Dasselbe für den Park." },
	{ key: "build.max1", env: "SPACES_MMO_BUILD_MAX_1", def: 10, min: 1, max: 1_000, label: "Bauten je Konto im Fischerdorf", unit: "Bauten", help: "So viele Bauten und Baustellen darf ein Konto haben, wenn die Insel, auf der es baut, noch Fischerdorf ist (Epoche 1). Kleine Bauten und Tierhäuser zählen nicht mit: Regentonne, Vogelscheuche, Hühnerstall, Gehege, Bienenstock, Straße, Signalfeuer (Tierhäuser haben ihre eigene Grenze, darunter)." },
	{ key: "build.max2", env: "SPACES_MMO_BUILD_MAX_2", def: 15, min: 1, max: 1_000, label: "Bauten je Konto im Dorf", unit: "Bauten", help: "Dasselbe auf einer Insel, die Dorf ist (Epoche 2)." },
	{ key: "build.max3", env: "SPACES_MMO_BUILD_MAX_3", def: 18, min: 1, max: 1_000, label: "Bauten je Konto in der Stadt", unit: "Bauten", help: "Dasselbe in der Stadt (Epoche 3)." },
	{ key: "build.max4", env: "SPACES_MMO_BUILD_MAX_4", def: 20, min: 1, max: 1_000, label: "Bauten je Konto im Netz", unit: "Bauten", help: "Dasselbe im Netz (Epoche 4)." },
	{ key: "animals.houses", env: "SPACES_MMO_ANIMAL_HOUSES", def: 5, min: 0, max: 1_000, label: "Ställe, Gehege und Bienenstöcke je Konto", unit: "Bauten", help: "So viele Häuser für Tiere (Hühnerstall, Gehege, Bienenstock) darf ein Konto zusammen haben, Baustellen eingerechnet. Sie zählen nicht zu den Bauten oben." },
	{ key: "pack.max", env: "SPACES_MMO_PACK_MAX", def: 1000, min: 1, max: 100_000, label: "Gepäck je Figur", unit: "Last", help: "So viel Last trägt eine Figur. Jedes Ding wiegt nach seiner Art (Muschel und Samen ½, Treibholz und Stein 2, Holzbündel und Tiere 4, Rind und Segelboot 8, sonst 1; Münzen nichts). Wer mehr trägt, verliert nichts, nimmt aber nichts mehr auf, bis er etwas in eine Truhe legt." },
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

/** How long a figure rests after a point of work, in world milliseconds. */
export const workRestMs = async (space: SpaceLike): Promise<number> => (await setting(space, "work.rest")) * 60_000;

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
