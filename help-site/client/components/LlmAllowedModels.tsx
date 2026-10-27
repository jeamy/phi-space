"use client";
// The models the feed may use, chosen by the admin (as in codemode-chat's admin panel): every model with credentials,
// grouped by provider; one box per provider selects all of its models, below it every model on its own. Save keeps the
// choice in the space (it outlives a restart), Default goes back to codestral-latest and the newest haiku. The model
// picker (LlmModelPicker) then offers only these. Reads and writes GET/POST /api/llm/allowed (admin session + CSRF).
import { useEffect, useMemo, useRef, useState } from "react";

type AdminModel = { label: string; provider: string; id: string; name: string };
type AdminState = { enabled: boolean; models: AdminModel[]; allowed: string[]; custom: boolean };

/** Sent when the choice was saved: the picker loads its list again. */
export const LLM_MODELS_CHANGED = "llm-models-changed";

const T = {
	de: { title: "Erlaubte Modelle", filter: "Modelle filtern …", save: "Speichern", reset: "Standard", resetTitle: "Zurück zur Standardauswahl (codestral-latest und das neueste Haiku)", saved: "Gespeichert.", count: (k: number, n: number) => `${k} von ${n}`, std: "Standardauswahl aktiv", empty: "Mindestens ein Modell wählen (oder Standard)." },
	en: { title: "Allowed models", filter: "Filter models …", save: "Save", reset: "Default", resetTitle: "Back to the default choice (codestral-latest and the newest haiku)", saved: "Saved.", count: (k: number, n: number) => `${k} of ${n}`, std: "default choice active", empty: "Choose at least one model (or Default)." },
} as const;

/** A provider's box: checked when all its models are chosen, indeterminate when some are. */
function GroupBox({ all, some, onChange, label }: { all: boolean; some: boolean; onChange: (on: boolean) => void; label: string }) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => { if (ref.current) ref.current.indeterminate = some && !all; }, [all, some]);
	return <input ref={ref} type="checkbox" aria-label={label} checked={all} onChange={(e) => onChange(e.target.checked)} onClick={(e) => e.stopPropagation()} />;
}

async function call(body?: unknown): Promise<AdminState> {
	const init: RequestInit = {};
	if (body !== undefined) {
		const session = await fetch("/api/admin/session").then((r) => r.json());
		init.method = "POST";
		init.headers = { "content-type": "application/json", "x-csrf-token": session?.session?.csrfToken ?? "" };
		init.body = JSON.stringify(body);
	}
	const r = await fetch("/api/llm/allowed", init);
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((d as { error?: string }).error || r.statusText);
	return d as AdminState;
}

/** Shown to a signed-in admin only (`canManage`); nothing without credentials. */
export function LlmAllowedModels({ locale, canManage }: { locale: "de" | "en"; canManage: boolean }) {
	const t = T[locale];
	const [state, setState] = useState<AdminState | null>(null);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [filter, setFilter] = useState("");
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!canManage) { setState(null); return; }
		void call().then((s) => { setState(s); setChosen(new Set(s.allowed)); }).catch((e) => setMsg(String((e as Error).message)));
	}, [canManage]);

	const groups = useMemo(() => {
		const f = filter.trim().toLowerCase(), g = new Map<string, AdminModel[]>();
		for (const m of state?.models ?? []) if (!f || m.label.toLowerCase().includes(f) || m.name.toLowerCase().includes(f)) g.set(m.provider, [...(g.get(m.provider) ?? []), m]);
		return [...g.entries()];
	}, [state, filter]);

	if (!canManage || !state?.enabled) return null;
	const toggle = (labels: string[], add: boolean) => setChosen((cur) => { const n = new Set(cur); for (const l of labels) (add ? n.add(l) : n.delete(l)); return n; });
	const save = async (allowed: string[] | null) => {
		if (allowed && !allowed.length) { setMsg(t.empty); return; }
		setBusy(true); setMsg("");
		try {
			const s = await call({ allowed });
			setState(s); setChosen(new Set(s.allowed)); setMsg(t.saved);
			window.dispatchEvent(new Event(LLM_MODELS_CHANGED));
		} catch (e) { setMsg(String((e as Error).message)); }
		finally { setBusy(false); }
	};

	return (
		<div className="sf-llm-allowed">
			<div className="sf-llm-allowed__head"><span>{t.title}</span><span className="sf-llm-allowed__muted">{state.custom ? t.count(chosen.size, state.models.length) : t.std}</span></div>
			<input className="sf-llm-allowed__filter" placeholder={t.filter} value={filter} onChange={(e) => setFilter(e.target.value)} />
			<div className="sf-llm-allowed__list">
				{groups.map(([provider, ms]) => {
					const k = ms.filter((m) => chosen.has(m.label)).length;
					return (
						<details key={provider} open={!!filter.trim() || k > 0}>
							<summary>
								<GroupBox label={provider} all={k === ms.length} some={k > 0} onChange={(add) => toggle(ms.map((m) => m.label), add)} />
								<b>{provider}</b> <span className="sf-llm-allowed__muted">{t.count(k, ms.length)}</span>
							</summary>
							{ms.map((m) => (
								<label key={m.label} className="sf-llm-allowed__model" title={m.label}>
									<input type="checkbox" checked={chosen.has(m.label)} onChange={(e) => toggle([m.label], e.target.checked)} />
									<span>{m.id}{m.name && m.name !== m.id ? <span className="sf-llm-allowed__muted"> · {m.name}</span> : null}</span>
								</label>
							))}
						</details>
					);
				})}
			</div>
			<div className="sf-llm-allowed__row">
				<button type="button" className="sf-llm-allowed__btn sf-llm-allowed__btn--primary" disabled={busy} onClick={() => void save([...chosen])}>{t.save}</button>
				<button type="button" className="sf-llm-allowed__btn" disabled={busy} title={t.resetTitle} onClick={() => void save(null)}>{t.reset}</button>
			</div>
			{msg ? <div className="sf-llm-allowed__msg" role="status">{msg}</div> : null}
		</div>
	);
}
