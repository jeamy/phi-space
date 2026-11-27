"use client";
// The admin panel (taken over from codemode-chat/client/AdminPanel.tsx): login with the admin password from .env (the server answers with
// an HttpOnly cookie, the password is not kept in the browser), then model agents on/off and the models that may take
// part, grouped by provider: one box per provider selects all of its models, below it every model on its own.
import { useEffect, useMemo, useRef, useState } from "react";
import { authHeaders } from "./lib/me.ts";
import type { Lang } from "./lib/theme.ts";

type AdminModel = { label: string; provider: string; id: string; name: string };
type AdminState = { enabled: boolean; on: boolean; models: AdminModel[]; allowed: string[]; custom: boolean };

const T = {
	de: { title: "ADMIN", badge: "🔐 admin", login: "🔐 Admin-Login", tokenPh: "Admin-Passwort", signIn: "Anmelden", logout: "Abmelden", noToken: "Kein Admin-Passwort gesetzt (FORUM_ADMIN_PASSWORD in der .env).", byIdentity: "Nur für Administratoren (FORUM_ADMINS in der .env nennt sie nach ihrer Anmeldung).", agentsOn: "Modell-Agenten an", models: "Erlaubte Modelle", filter: "Modelle filtern …", save: "Speichern", reset: "Standard", resetTitle: "Zurück zur Auswahl aus FORUM_MODELS", saved: "Gespeichert.", none: "Keine Modelle mit Zugangsdaten (FORUM_LLM=1 und API-Schlüssel oder pi-CLI-Anmeldung).", count: (k: number, n: number) => `${k} von ${n}`, std: "Auswahl aus FORUM_MODELS" },
	en: { title: "ADMIN", badge: "🔐 admin", login: "🔐 Admin login", tokenPh: "Admin password", signIn: "Sign in", logout: "Sign out", noToken: "No admin password set (FORUM_ADMIN_PASSWORD in .env).", byIdentity: "For administrators only (FORUM_ADMINS in .env names them by their sign-in).", agentsOn: "Model agents on", models: "Allowed models", filter: "Filter models …", save: "Save", reset: "Default", resetTitle: "Back to the choice of FORUM_MODELS", saved: "Saved.", none: "No models with credentials (FORUM_LLM=1 and an API key or the pi CLI login).", count: (k: number, n: number) => `${k} of ${n}`, std: "choice of FORUM_MODELS" },
} as const;

async function call<R>(path: string, body?: unknown): Promise<R> {
	const r = await fetch("/api/admin" + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json", "x-forum-admin": "1", ...authHeaders() }, body: JSON.stringify(body) });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((data as { error?: string }).error || r.statusText);
	return data as R;
}

/** A provider's box: checked when all its models are chosen, indeterminate when some are. */
function GroupBox({ all, some, onChange, label }: { all: boolean; some: boolean; onChange: (on: boolean) => void; label: string }) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => { if (ref.current) ref.current.indeterminate = some && !all; }, [all, some]);
	return <input ref={ref} type="checkbox" aria-label={label} checked={all} onChange={(e) => onChange(e.target.checked)} onClick={(e) => e.stopPropagation()} />;
}

/** `onSession`: whether this browser is signed in as admin (an admin names the budget of a run freely). */
export function AdminPanel({ lang, onChanged, onSession }: { lang: Lang; onChanged: () => void; onSession?: (admin: boolean) => void }) {
	const t = T[lang];
	// signIn: the forum has a sign-in, administrators are named by identity (FORUM_ADMINS), no password login
	const [session, setSession] = useState<{ admin: boolean; available: boolean; signIn?: boolean } | null>(null);
	const [form, setForm] = useState(false);
	const [token, setToken] = useState("");
	const [state, setState] = useState<AdminState | null>(null);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [on, setOn] = useState(true);
	const [filter, setFilter] = useState("");
	const [msg, setMsg] = useState("");
	useEffect(() => { onSession?.(!!session?.admin); }, [session?.admin]);

	const load = async () => { const s = await call<AdminState>("/models"); setState(s); setChosen(new Set(s.allowed)); setOn(s.on); };
	useEffect(() => {
		void call<{ admin: boolean; available: boolean; signIn?: boolean }>("/session").then((s) => { setSession(s); if (s.admin) void load().catch((e) => setMsg((e as Error).message)); }).catch(() => {});
	}, []);

	const groups = useMemo(() => {
		const f = filter.trim().toLowerCase(), g = new Map<string, AdminModel[]>();
		for (const m of state?.models ?? []) if (!f || m.label.toLowerCase().includes(f) || m.name.toLowerCase().includes(f)) g.set(m.provider, [...(g.get(m.provider) ?? []), m]);
		return [...g.entries()];
	}, [state, filter]);

	const toggle = (labels: string[], add: boolean) => setChosen((cur) => { const n = new Set(cur); for (const l of labels) (add ? n.add(l) : n.delete(l)); return n; });
	const run = async (fn: () => Promise<void>) => { setMsg(""); try { await fn(); } catch (e) { setMsg((e as Error).message); } };

	if (!session) return null;
	return (
		<div className="panel admin">
			<h2>{t.title} {session.admin ? <span className="admin__badge">{t.badge}</span> : null}</h2>
			{session.signIn && !session.admin ? <div className="notice">{t.byIdentity}</div>
			: !session.admin && !session.available ? <div className="notice">{t.noToken}</div>
			: !session.admin ? (
				form ? (
					<form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await call("/login", { password: token }); setToken(""); setSession({ ...session, admin: true }); await load(); }); }}>
						<input type="password" autoFocus autoComplete="current-password" placeholder={t.tokenPh} value={token} onChange={(e) => setToken(e.target.value)} />
						<button type="submit" className="btn btn--primary" disabled={!token}>{t.signIn}</button>
					</form>
				) : <button type="button" className="btn" onClick={() => setForm(true)}>{t.login}</button>
			) : state ? (
				<>
					{!state.enabled ? <div className="notice">{t.none}</div> : (
						<>
							<label className="check"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> {t.agentsOn}</label>
							<div className="fieldlabel"><span>{t.models}</span><span className="muted">{state.custom ? t.count(chosen.size, state.models.length) : t.std}</span></div>
							<input className="wide" placeholder={t.filter} value={filter} onChange={(e) => setFilter(e.target.value)} />
							<div className="admin__models">
								{groups.map(([provider, ms]) => {
									const k = ms.filter((m) => chosen.has(m.label)).length;
									return (
										<details key={provider} open={!!filter.trim() || k > 0}>
											<summary>
												<GroupBox label={provider} all={k === ms.length} some={k > 0} onChange={(add) => toggle(ms.map((m) => m.label), add)} />
												<b>{provider}</b> <span className="muted">{t.count(k, ms.length)}</span>
											</summary>
											{ms.map((m) => (
												<label key={m.label} className="check admin__model" title={m.label}>
													<input type="checkbox" checked={chosen.has(m.label)} onChange={(e) => toggle([m.label], e.target.checked)} />
													<span>{m.id}{m.name && m.name !== m.id ? <span className="muted"> · {m.name}</span> : null}</span>
												</label>
											))}
										</details>
									);
								})}
							</div>
							<div className="row">
								<button type="button" className="btn btn--primary" onClick={() => void run(async () => { setState(await call<AdminState>("/models", { allowed: [...chosen], on })); setMsg(t.saved); onChanged(); })}>{t.save}</button>
								<button type="button" className="btn" title={t.resetTitle} onClick={() => void run(async () => { const s = await call<AdminState>("/models", { allowed: null, on }); setState(s); setChosen(new Set(s.allowed)); setMsg(t.saved); onChanged(); })}>{t.reset}</button>
							</div>
						</>
					)}
					{session.signIn ? null : <div className="row"><button type="button" className="btn" onClick={() => void run(async () => { await call("/logout", {}); setSession({ ...session, admin: false }); setState(null); setForm(false); })}>{t.logout}</button></div>}
				</>
			) : null}
			{msg ? <div className="notice">{msg}</div> : null}
		</div>
	);
}
