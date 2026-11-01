"use client";
// The operator's window (docs/automaten.en.md, "Einstellungen für Betreiber"): the models (as in codemode-chat's admin
// panel and the help system's feed: every model with credentials, grouped by provider, one box per provider, the one
// calls use) and the limits as fields with unit, default, where the value comes from and a "?" each. Saving writes
// `Setting` entries into the space (server/settings.ts); every process follows within seconds, without a restart.
import { useEffect, useMemo, useRef, useState } from "react";

type Field = { key: string; label: string; unit: string; help: string; env: string; def: number; min: number; max: number; value: number; source: "space" | "env" | "default" };
type Model = { label: string; provider: string; id: string; name: string };
type Problem = { level: "error" | "warn"; text: string; fix: string };
type Noted = { text: string; at: number };
type RegionStatus = { region: string; problems: Problem[]; last: Noted | null; ok: Noted | null; day: { used: number; limit: number }; minute: { used: number; limit: number } };
type State = { status: RegionStatus[]; fields: Field[]; models: { enabled: boolean; published: boolean; on: boolean; custom: boolean; available: Model[]; allowed: string[]; model: string | null } };

const SOURCE = { space: "gespeichert", env: ".env", default: "Standard" } as const;

async function call(body?: unknown): Promise<State> {
	const r = await fetch("/api/admin/settings", body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json", "x-mmo": "1" }, body: JSON.stringify(body) });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((d as { error?: string }).error || `HTTP ${r.status}`);
	return d as State;
}

/** "vor 3 Min." for a time that lies `at` ms back. */
const ago = (at: number) => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 90 ? `vor ${s} s` : s < 5400 ? `vor ${Math.round(s / 60)} Min.` : s < 129_600 ? `vor ${Math.round(s / 3600)} Std.` : `vor ${Math.round(s / 86_400)} Tagen`; };

/** Why model calls do not work, or that nothing stands in their way: the problems of every region (one line each, with the regions it
 *  concerns when not all of them), what to do about it, the last refusal and the last answer, the use of today. */
function Status({ list }: { list: RegionStatus[] }) {
	const merged = new Map<string, { p: Problem; regions: string[] }>();
	for (const r of list) for (const p of r.problems) { const e = merged.get(p.text) ?? { p, regions: [] }; e.regions.push(r.region); merged.set(p.text, e); }
	const newest = (pick: (r: RegionStatus) => Noted | null) => list.map((r) => ({ n: pick(r), region: r.region })).filter((x): x is { n: Noted; region: string } => !!x.n).sort((a, b) => b.n.at - a.n.at)[0];
	const last = newest((r) => r.last), ok = newest((r) => r.ok);
	const where = (region: string) => (list.length > 1 ? ` (${region})` : "");
	return (
		<div className="admin-status">
			{merged.size === 0 ? <p className="admin-good">✔ Nichts steht den Modellaufrufen im Weg.</p> : (
				<ul className="admin-problems">
					{[...merged.values()].sort((a, b) => Number(b.p.level === "error") - Number(a.p.level === "error")).map(({ p, regions }) => (
						<li key={p.text} className={p.level}>
							<b>{p.text}</b>{regions.length < list.length ? <span className="muted"> ({regions.join(", ")})</span> : null}
							<span className="muted">{p.fix}</span>
						</li>
					))}
				</ul>
			)}
			{last && <p className="muted">Letzte Ablehnung {ago(last.n.at)}{where(last.region)}: {last.n.text}</p>}
			{ok ? <p className="muted">Letzte Antwort {ago(ok.n.at)}{where(ok.region)}: {ok.n.text}</p> : <p className="muted">Seit dem Start gab es noch keine Antwort des Modells.</p>}
			<p className="muted">Heute (UTC): {list.map((r) => `${list.length > 1 ? `${r.region} ` : ""}${r.day.used} von ${r.day.limit} Aufrufen`).join(" · ")}</p>
		</div>
	);
}

type Report = { reportId: string; byName: string; fromName: string; text: string; at: number };

/** Chat messages players reported (server/chat.ts), newest first; admins see no other talk. */
function Reports() {
	const [reports, setReports] = useState<Report[] | null>(null);
	useEffect(() => { void fetch("/api/admin/reports").then((r) => r.json()).then((d) => setReports((d as { reports?: Report[] }).reports ?? []), () => setReports([])); }, []);
	return (
		<>
			<h3>Gemeldete Nachrichten</h3>
			{!reports ? <p className="muted">Lädt …</p> : !reports.length ? <p className="muted">Keine Meldungen.</p> : (
				<ul className="admin-reports">
					{reports.map((r) => <li key={r.reportId}><span className="muted">{new Date(r.at).toLocaleString()} · {r.byName} meldet {r.fromName}:</span> {r.text}</li>)}
				</ul>
			)}
		</>
	);
}

/** A provider's box: checked when all its models are allowed, indeterminate when some are. */
function GroupBox({ all, some, onChange, label }: { all: boolean; some: boolean; onChange: (on: boolean) => void; label: string }) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => { if (ref.current) ref.current.indeterminate = some && !all; }, [all, some]);
	return <input ref={ref} type="checkbox" aria-label={label} checked={all} onChange={(e) => onChange(e.target.checked)} onClick={(e) => e.stopPropagation()} />;
}

export function AdminPanel({ onClose }: { onClose: () => void }) {
	const [state, setState] = useState<State | null>(null);
	const [draft, setDraft] = useState<Record<string, string>>({});
	const [allowed, setAllowed] = useState<Set<string>>(new Set());
	const [model, setModel] = useState<string | null>(null);
	const [on, setOn] = useState(true);
	const [filter, setFilter] = useState("");
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);

	const take = (s: State) => {
		setState(s);
		setDraft(Object.fromEntries(s.fields.map((f) => [f.key, String(f.value)])));
		setAllowed(new Set(s.models.allowed)); setModel(s.models.model); setOn(s.models.on);
	};
	useEffect(() => { void call().then(take, (e) => setMsg((e as Error).message)); }, []);

	const groups = useMemo(() => {
		const f = filter.trim().toLowerCase(), g = new Map<string, Model[]>();
		for (const m of state?.models.available ?? []) if (!f || m.label.toLowerCase().includes(f) || m.name.toLowerCase().includes(f)) g.set(m.provider, [...(g.get(m.provider) ?? []), m]);
		return [...g.entries()];
	}, [state, filter]);

	const run = async (body: unknown) => {
		setBusy(true); setMsg("");
		try { take(await call(body)); setMsg("Gespeichert. Alle Prozesse übernehmen es in wenigen Sekunden."); }
		catch (e) { setMsg((e as Error).message); }
		finally { setBusy(false); }
	};
	const toggle = (labels: string[], add: boolean) => setAllowed((cur) => { const n = new Set(cur); for (const l of labels) (add ? n.add(l) : n.delete(l)); return n; });

	if (!state) return <div className="panel admin"><h2>Systemeinstellungen</h2><p className="muted">{msg || "Lädt …"}</p></div>;
	const changed = state.fields.filter((f) => draft[f.key] !== String(f.value));
	const models = state.models, chosen = [...allowed].sort();
	// the select offers the allowed models grouped by provider, as the help site's picker does
	const usedGroups = [...chosen.reduce((g, l) => {
		const m = models.available.find((a) => a.label === l) ?? { label: l, provider: l.split("/")[0] ?? "", id: l.split("/").slice(1).join("/") || l, name: "" };
		return g.set(m.provider, [...(g.get(m.provider) ?? []), m]);
	}, new Map<string, Model[]>())];
	return (
		<div className="panel admin">
			<div className="admin-head"><h2>Systemeinstellungen</h2><button className="help-x" onClick={onClose} aria-label="Schließen">×</button></div>

			<h3>Modellaufrufe</h3>
			<Status list={state.status ?? []} />

			<h3>Modelle</h3>
			{!models.enabled ? (
				<p className="muted">Modellaufrufe sind in der <code>.env</code> aus (<code>SPACES_MMO_LLM=1</code> schaltet sie frei; sie kosten Tokens){models.published ? "" : " oder der Modellprozess läuft nicht"}. Ines und der Fremde antworten dann mit Skriptsätzen.</p>
			) : (
				<>
					<label className="admin-check"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Modell-NPCs und Übersetzen an</label>
					<div className="admin-row"><span className="muted">Erlaubte Modelle</span><span className="muted">{models.custom ? `${allowed.size} von ${models.available.length}` : "Standardauswahl aktiv"}</span></div>
					<input placeholder="Modelle filtern …" value={filter} onChange={(e) => setFilter(e.target.value)} />
					<div className="admin-models">
						{groups.map(([provider, ms]) => {
							const k = ms.filter((m) => allowed.has(m.label)).length;
							return (
								<details key={provider} open={!!filter.trim() || k > 0}>
									<summary><GroupBox label={provider} all={k === ms.length} some={k > 0} onChange={(add) => toggle(ms.map((m) => m.label), add)} /><b>{provider}</b> <span className="muted">{k} von {ms.length}</span></summary>
									{ms.map((m) => (
										<label key={m.label} className="admin-model" title={m.label}>
											<input type="checkbox" checked={allowed.has(m.label)} onChange={(e) => toggle([m.label], e.target.checked)} />
											<span>{m.id}{m.name && m.name !== m.id ? <span className="muted"> · {m.name}</span> : null}</span>
										</label>
									))}
								</details>
							);
						})}
					</div>
					<label className="admin-field"><span>Verwendet wird</span>
						<select value={model && allowed.has(model) ? model : chosen[0] ?? ""} onChange={(e) => setModel(e.target.value)} disabled={!chosen.length}>
							{usedGroups.map(([provider, ms]) => (
								<optgroup key={provider} label={provider}>
									{ms.map((m) => <option key={m.label} value={m.label}>{m.id}</option>)}
								</optgroup>
							))}
						</select>
					</label>
					<div className="admin-row">
						<button className="primary" disabled={busy || !allowed.size} onClick={() => void run({ models: { on, allowed: chosen, model: model && allowed.has(model) ? model : chosen[0] ?? null } })}>Modelle speichern</button>
						<button disabled={busy} title="Zurück zur Standardauswahl (das neueste Modell zu SPACES_MMO_LLM_MODEL, sonst Haiku)" onClick={() => void run({ models: null })}>Standard</button>
					</div>
				</>
			)}

			<h3>Grenzen</h3>
			<div className="admin-fields">
				{state.fields.map((f) => (
					<label key={f.key} className="admin-field">
						<span>{f.label} <span className="admin-q" title={`${f.help}\n\n.env: ${f.env} · Standard: ${f.def} · ${f.min} bis ${f.max}`}>?</span></span>
						<span className="admin-input">
							<input type="number" min={f.min} max={f.max} step={1} value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
							<span className="muted">{f.unit}</span>
							<span className={`admin-src admin-src--${f.source}`} title="Woher der Wert gerade kommt">{SOURCE[f.source]}</span>
							{f.source === "space" && <button className="link" disabled={busy} onClick={() => void run({ values: { [f.key]: null } })} title={`Zurück zum Wert aus der .env (${f.env}) oder zum Standard`}>zurücksetzen</button>}
						</span>
					</label>
				))}
			</div>
			<div className="admin-row">
				<button className="primary" disabled={busy || !changed.length} onClick={() => void run({ values: Object.fromEntries(changed.map((f) => [f.key, Number(draft[f.key])])) })}>Grenzen speichern{changed.length ? ` (${changed.length})` : ""}</button>
			</div>
			{msg && <p className="muted admin-msg" role="status">{msg}</p>}
			<Reports />
		</div>
	);
}
