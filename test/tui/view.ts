import type { Inspection, InspectedItem } from "../testbed/inspect.ts";
import type { Action, Service } from "./actions.ts";
import { clean, type RunRecord } from "./backend.ts";

export type ScreenState = {
	tab: number; service: Service; localDir?: string; dry: boolean; snapshot?: Inspection; stale?: string;
	space: number; item: number; itemFocus: boolean; filter: string; itemsKind: string; detailOffset: number;
	actions: Action[]; action: number; history: RunRecord[]; report: number; log: string[]; logOffset: number;
	busy?: string; notice: string; prompt?: string; input: string;
};
export const itemList = (s: ScreenState): InspectedItem[] => (s.snapshot?.spaces[s.space]?.items ?? []).filter(i =>
	(s.itemsKind === "all" || i.kind === s.itemsKind) && (!s.filter || clean(JSON.stringify(i)).toLowerCase().includes(s.filter.toLowerCase())));
const clip = (s: string, width: number): string => clean(s).replaceAll("\t", "  ").replaceAll("\n", " ").slice(0, Math.max(0, width));
const pad = (s: string, width: number): string => clip(s, width).padEnd(Math.max(0, width));
const windowAt = (index: number, count: number): number => Math.max(0, index - Math.floor(count / 2));
const jsonLines = (value: unknown, width: number): string[] => JSON.stringify(value, null, 2).split("\n").flatMap(line => {
	const safe = clean(line); return safe.length ? Array.from({ length: Math.ceil(safe.length / width) }, (_, i) => safe.slice(i * width, (i + 1) * width)) : [""];
});

export function render(s: ScreenState, columns = 120, rows = 36): string {
	const width = Math.max(40, Math.min(columns, 180)), height = Math.max(12, rows), bodyHeight = height - 8;
	const lines = [
		`phi-spaces  |  ${s.localDir ? `lokal: ${s.localDir}` : `Server / ${s.service}`}  |  ${s.dry ? "VORSCHAU" : "LIVE"}`,
		["Spaces", "Aktionen", "Berichte", "Log"].map((t, i) => `${s.tab === i ? "[" : " "}${i + 1} ${t}${s.tab === i ? "]" : " "}`).join("   "),
		`${s.stale ? `VERALTET: ${s.stale}` : `${s.busy ? `LÄUFT: ${s.busy}` : "bereit"} | Snapshot: ${s.snapshot?.capturedAt ?? "noch keiner"}`}`,
		"─".repeat(width),
	];
	const body: string[] = [];
	if (s.tab === 0) {
		const spaces = s.snapshot?.spaces ?? [], space = spaces[s.space], items = itemList(s);
		const left = Math.min(30, Math.floor(width / 3)), right = width - left - 3;
		const stats = space?.stats;
		body.push(`${pad("SPACES", left)} │ OBJEKTE (${s.itemsKind})  Filter: ${s.filter || "*"}`);
		body.push(`${pad(spaces.length ? `${spaces.length} Spaces` : "kein Space gefunden", left)} │ ${stats ? `sichtbar ${stats.entries} | reserviert ${stats.locked} | Txns ${stats.txns} | Events ${stats.outbox}` : "Runner starten / Szenario create / r aktualisieren"}`);
		const kinds = Object.entries(stats?.byType ?? {}).slice(0, 4).map(([type, count]) => `${type} ${"█".repeat(Math.min(10, count))} ${count}`).join(" | ");
		body.push(`${pad(space?.alias ?? "", left)} │ ${kinds}`);
		const count = Math.max(2, Math.floor((bodyHeight - 5) / 2)), spaceStart = windowAt(s.space, count), itemStart = windowAt(s.item, count);
		for (let n = 0; n < count; n++) {
			const a = spaces[spaceStart + n], b = items[itemStart + n];
			body.push(`${pad(a ? `${spaceStart + n === s.space ? "▶" : " "} ${a.alias}` : "", left)} │ ${clip(b ? `${itemStart + n === s.item ? "▶" : " "} ${b.kind} ${b.type} [${b.state}] ${b.id}` : "", right)}`);
		}
		body.push("─".repeat(width));
		body.push(`${s.itemFocus ? "Objekt" : "Space"}-Auswahl | ${items.length} Treffer${space?.truncated ? ` | ${space.truncated} weitere Objekte ausgelassen` : ""} | ${space?.spaceId ?? ""}`);
		const detail = items[s.item];
		const value = detail?.value as Record<string, unknown> | undefined;
		const shown = detail?.kind === "entry" && value ? { fields: value.fields, ...value } : value;
		body.push(...jsonLines(shown ?? { info: "Mit ←/→ zwischen Spaces und Objekten wechseln. / filtert; i wechselt Objektart." }, width).slice(s.detailOffset, s.detailOffset + bodyHeight - body.length));
	} else if (s.tab === 1) {
		body.push("MENÜ  ↑/↓ auswählen · Enter ausführen · geplante Funktionen sind gesperrt");
		const start = windowAt(s.action, bodyHeight - 3);
		for (const [n, a] of s.actions.slice(start, start + bodyHeight - 3).entries()) body.push(`${start + n === s.action ? "▶" : " "} ${a.unavailable ? "○" : "●"} ${a.group}: ${a.label}`);
		const a = s.actions[s.action];
		body.push(a?.unavailable ?? (a?.scope === "remote" ? `Serveraktion: testbed ${a.args.join(" ")}` : `Lokal: ${a?.program ?? "npm"} ${a?.args.join(" ")}`));
	} else if (s.tab === 2) {
		body.push("AUSWERTUNGEN  ↑/↓ Auswahl · Enter vollständiges Protokoll öffnen");
		const n = Math.max(2, Math.floor((bodyHeight - 3) / 2)), start = windowAt(s.report, n);
		for (const r of s.history.slice(start, start + n)) body.push(`${s.history[s.report]?.id === r.id ? "▶" : " "} ${r.status.toUpperCase().padEnd(10)} ${r.label} | ${r.endedAt ?? r.startedAt}`);
		const record = s.history[s.report];
		if (record?.counts) body.push(`Node-TAP: ${record.counts.tests} Tests, ${record.counts.passed} bestanden, ${record.counts.failed} fehlgeschlagen, ${record.counts.skipped} übersprungen (bei alten Tests ggf. Dateisuiten).`);
		body.push("─".repeat(width));
		for (const r of s.snapshot?.reports ?? []) {
			const report = r.value as { passed?: boolean; runId?: string; checks?: { name: string; ok: boolean; detail: string }[] };
			body.push(`Sieb ${r.current ? report.passed ? "BESTANDEN" : "FEHLGESCHLAGEN" : "ALTER/UNBESTÄTIGTER BERICHT"} | ${report.runId} | ${r.updatedAt}`);
			for (const c of report.checks ?? []) body.push(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
		}
		if (!s.history.length && !s.snapshot?.reports.length) body.push("Noch keine Auswertung. Aktionen → Tests oder Szenario evaluate.");
	} else {
		const end = Math.max(0, s.log.length - s.logOffset);
		body.push(`PROTOKOLL  ${s.logOffset ? "zurückgescrollt" : "live"} · PgUp/PgDn scrollen · x bricht lokalen Aufruf ab`);
		body.push(...s.log.slice(Math.max(0, end - bodyHeight + 1), end));
	}
	while (body.length < bodyHeight) body.push("");
	lines.push(...body.slice(0, bodyHeight), "─".repeat(width), s.prompt ? `${s.prompt} ${s.input}` : s.notice,
		"1–4/Tab Ansicht · ↑↓ Auswahl · ←→ Fokus · s Host · r Update · / Filter · i Art",
		"PgUp/PgDn scrollen · Enter Aktion · x Abbruch · q Ende | Container-Stopp ≠ Pause");
	return lines.map(line => pad(line, width)).join("\n");
}
