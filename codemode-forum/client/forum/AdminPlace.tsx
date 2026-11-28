"use client";
// The administration of the FORUM page (docs/forum-seite-plan-2026-11-26.en.md, section 8): the providers of each model
// process with their credentials (add a key, sign in, test, remove), a login's questions answered on the page (the
// answer is sealed in the web process to the model process that asked, server/seal.ts), the models that may take part,
// and the limits within the operator's ceilings. Administrators only; the server checks every request again.
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import type { Lang } from "../lib/theme.ts";
import { Act, Choice, Field, Tick } from "./controls.tsx";
import { Skeleton } from "./ForumPage.tsx";
import type { PageText } from "./texts.ts";
import { HelpTip } from "../HelpTip.tsx";

type View = { id: string; name: string; models: number; apiKey: string | null; oauth: string | null; state: { type: "api_key" | "oauth"; source?: string } | null; stored: boolean };
type Proc = { procId: string; host: string; llm: boolean; providers: View[] };
type Prompt = { promptId: string; seq: number; prompt?: { type: "text" | "secret" | "manual_code" | "select"; message: string; placeholder?: string; options?: Array<{ id: string; label: string; description?: string }> }; event?: { type: string; message?: string; url?: string; instructions?: string; userCode?: string; verificationUri?: string; links?: Array<{ url: string; label?: string }> } };
type Login = { loginId: string; procId: string; provider: string; auth: "api_key" | "oauth"; state: "running" | "done" | "failed"; error?: string; ts: number; prompts: Prompt[] };
type Result = { jobId: string; procId: string; provider: string; kind: "logout" | "test"; ok: boolean; model?: string; ms?: number; error?: string; ts: number };
type State = { procs: Proc[]; logins: Login[]; results: Result[]; pending: Array<{ jobId: string; procId: string; kind: string; provider: string }> };
type Limits = { limits: Record<string, number>; ceilings: Record<string, number>; effective: Record<string, number> };

const A = {
	de: {
		providers: "Modelle und Anbieter", noProcs: "Kein Modell-Prozess meldet sich. Läuft er?", filter: "Anbieter suchen", more: (n: number) => `${n} weitere Anbieter ohne Zugang`,
		key: "Schlüssel eintragen", signIn: "Anmelden", test: "Testen", remove: "Entfernen", none: "kein Zugang", fromEnv: (s: string) => `aus ${s}`, stored: "gespeichert", oauth: "angemeldet", apiKey: "Schlüssel",
		llmOff: "Modellaufrufe sind in diesem Prozess aus (FORUM_LLM): Anmelden geht, Testen nicht.", running: "Anmeldung läuft", cancel: "Abbrechen", send: "Senden", answer: "Antwort",
		openLink: "Link öffnen", deviceCode: "Gib diesen Code dort ein:", done: "Angemeldet.", failed: "Nicht angemeldet:", waiting: "Wartet auf den Modell-Prozess …",
		testOk: (m: string, ms: number) => `Antwortet (${m}, ${(ms / 1000).toFixed(1)} s)`, testBad: "Test fehlgeschlagen:", removed: "Zugang entfernt.",
		research: "Recherche", researchOn: "Die Modelle dürfen im Web suchen (wo der Raum es erlaubt)", researchDay: (n: number) => `Höchstens ${n} Suchen am Tag für alle Räume zusammen (FORUM_SEARCH_PER_DAY).`,
		allowed: "Erlaubte Modelle", allowedNone: "Noch keine Modelle mit Zugang. Trage oben einen Schlüssel ein oder melde dich an.", modelsOn: "Modell-Agenten an", save: "Speichern", saved: "Gespeichert.", std: "Auswahl aus FORUM_MODELS", reset: "Zurück zur Auswahl aus FORUM_MODELS",
		limits: "Grenzen", ceiling: (n: number) => n ? `höchstens ${n.toLocaleString("de-DE")}` : "keine Grenze vom Betrieb", inForce: (n: number) => n ? `gilt: ${n.toLocaleString("de-DE")}` : "gilt: keine",
		perMin: "Modellaufrufe pro Minute", perDay: "Modellaufrufe pro Tag", personTokens: "Tokens pro Person und Tag", runBudget: "Größtes Budget eines Laufs (Tokens)",
	},
	en: {
		providers: "Models and providers", noProcs: "No model process reports. Is it running?", filter: "Find a provider", more: (n: number) => `${n} more providers without access`,
		key: "Enter a key", signIn: "Sign in", test: "Test", remove: "Remove", none: "no access", fromEnv: (s: string) => `from ${s}`, stored: "stored", oauth: "signed in", apiKey: "key",
		llmOff: "Model calls are off in this process (FORUM_LLM): signing in works, testing does not.", running: "Login in progress", cancel: "Cancel", send: "Send", answer: "Answer",
		openLink: "Open the link", deviceCode: "Enter this code there:", done: "Signed in.", failed: "Not signed in:", waiting: "Waiting for the model process …",
		testOk: (m: string, ms: number) => `Answers (${m}, ${(ms / 1000).toFixed(1)} s)`, testBad: "Test failed:", removed: "Access removed.",
		research: "Research", researchOn: "The models may search the web (where the room allows it)", researchDay: (n: number) => `At most ${n} searches a day for all rooms together (FORUM_SEARCH_PER_DAY).`,
		allowed: "Allowed models", allowedNone: "No models with access yet. Enter a key above or sign in.", modelsOn: "Model agents on", save: "Save", saved: "Saved.", std: "the choice of FORUM_MODELS", reset: "Back to the choice of FORUM_MODELS",
		limits: "Limits", ceiling: (n: number) => n ? `at most ${n.toLocaleString("en-US")}` : "no limit from the operator", inForce: (n: number) => n ? `in force: ${n.toLocaleString("en-US")}` : "in force: none",
		perMin: "Model calls per minute", perDay: "Model calls per day", personTokens: "Tokens per person and day", runBudget: "Largest budget of a run (tokens)",
	},
} as const;

/** The administration, shown on the settings page to administrators. */
export function AdminPlace({ lang, p }: { lang: Lang; p: PageText }) {
	const a = A[lang];
	const [st, setSt] = useState<State | null>(null);
	const [err, setErr] = useState("");
	const load = () => api<State>("/admin/providers").then(setSt).catch((e) => setErr((e as Error).message));
	// read again every two seconds while a login runs or a job waits, every ten otherwise
	const busy = !!st && (st.logins.some((l) => l.state === "running") || st.pending.length > 0);
	useEffect(() => {
		void load();
		const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, busy ? 2000 : 10_000);
		return () => clearInterval(timer);
	}, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
	const act = async (fn: () => Promise<unknown>) => { setErr(""); try { await fn(); await load(); } catch (e) { setErr((e as Error).message); } };
	const job = (procId: string, provider: string, kind: "login" | "logout" | "test", auth?: "api_key" | "oauth") => act(() => api("/admin/providers/job", { procId, provider, kind, ...(auth ? { auth } : {}) }));
	return (
		<>
			<section className="fp-card">
				<h2>{a.providers}</h2>
				{!st ? <Skeleton label={p.loading} lines={4} /> : !st.procs.length ? <p className="fp-empty">{a.noProcs}</p> : st.procs.map((proc) => (
					<Providers key={proc.procId} lang={lang} proc={proc} st={st} job={job} act={act} many={st.procs.length > 1} />
				))}
				{err ? <p className="fp-error" role="alert">{err}</p> : null}
			</section>
			<Allowed lang={lang} p={p} />
			<ResearchCard lang={lang} p={p} />
			<LimitsCard lang={lang} p={p} />
		</>
	);
}

function Providers({ lang, proc, st, job, act, many }: { lang: Lang; proc: Proc; st: State; job: (procId: string, provider: string, kind: "login" | "logout" | "test", auth?: "api_key" | "oauth") => Promise<void>; act: (fn: () => Promise<unknown>) => Promise<void>; many: boolean }) {
	const a = A[lang];
	const [filter, setFilter] = useState("");
	const f = filter.trim().toLowerCase();
	const shown = proc.providers.filter((x) => !f || x.name.toLowerCase().includes(f) || x.id.includes(f));
	const withAccess = shown.filter((x) => x.state), without = shown.filter((x) => !x.state);
	const row = (x: View) => {
		const login = st.logins.find((l) => l.procId === proc.procId && l.provider === x.id);
		const result = st.results.find((r) => r.procId === proc.procId && r.provider === x.id);
		const waiting = st.pending.some((j) => j.procId === proc.procId && j.provider === x.id);
		const running = login?.state === "running";
		return (
			<li key={x.id} className="fp-provider">
				<div className="fp-row">
					<b>{x.name}</b>
					<span className="fp-meta">{x.state ? `${x.state.type === "oauth" ? a.oauth : a.apiKey}${x.stored ? ` · ${a.stored}` : x.state.source ? ` · ${a.fromEnv(x.state.source)}` : ""}` : a.none}</span>
				</div>
				<div className="fp-row">
					{x.apiKey ? <Act label={`${a.key}: ${x.name}`} tip="providerkey" lang={lang} disabled={running || waiting} onClick={() => void job(proc.procId, x.id, "login", "api_key")}>{a.key}</Act> : null}
					{x.oauth ? <Act label={`${a.signIn}: ${x.name}`} tip="providersignin" lang={lang} disabled={running || waiting} onClick={() => void job(proc.procId, x.id, "login", "oauth")}>{x.oauth}</Act> : null}
					{x.state ? <Act label={`${a.test}: ${x.name}`} tip="providertest" lang={lang} disabled={!proc.llm || running || waiting} onClick={() => void job(proc.procId, x.id, "test")}>{a.test}</Act> : null}
					{x.stored ? <Act kind="danger" label={`${a.remove}: ${x.name}`} tip="providerremove" lang={lang} disabled={running || waiting} onClick={() => void job(proc.procId, x.id, "logout")}>{a.remove}</Act> : null}
				</div>
				{waiting ? <p className="fp-meta" role="status">{a.waiting}</p> : null}
				{login ? <LoginBox lang={lang} login={login} act={act} /> : null}
				{result && (!login || result.ts > login.ts) ? <p className={result.ok ? "fp-meta" : "fp-error"} role="status">{result.kind === "logout" ? (result.ok ? a.removed : `${a.testBad} ${result.error ?? ""}`) : result.ok ? a.testOk(result.model ?? "", result.ms ?? 0) : `${a.testBad} ${result.error ?? ""}`}</p> : null}
			</li>
		);
	};
	return (
		<div className="fp-proc">
			{many ? <h3>{proc.host} <span className="fp-meta">{proc.procId}</span></h3> : null}
			{!proc.llm ? <p className="fp-meta">{a.llmOff}</p> : null}
			<Field label={a.filter} tip="providers" lang={lang} value={filter} onChange={(e) => setFilter(e.target.value)} />
			<ul className="fp-providers">{withAccess.map(row)}</ul>
			{without.length ? (
				<details className="fp-fold" open={!!f}>
					<summary>{a.more(without.length)}</summary>
					<ul className="fp-providers">{without.map(row)}</ul>
				</details>
			) : null}
		</div>
	);
}

/** One login: what the flow said, the open question with its field, the end. */
function LoginBox({ lang, login, act }: { lang: Lang; login: Login; act: (fn: () => Promise<unknown>) => Promise<void> }) {
	const a = A[lang];
	const [value, setValue] = useState("");
	if (login.state !== "running") return <p className={login.state === "done" ? "fp-meta" : "fp-error"} role="status">{login.state === "done" ? a.done : `${a.failed} ${login.error ?? ""}`}</p>;
	const open = [...login.prompts].reverse().find((x) => x.prompt);
	const send = () => act(async () => { await api("/admin/providers/answer", { loginId: login.loginId, promptId: open!.promptId, value }); setValue(""); });
	return (
		<div className="fp-login" role="group" aria-label={a.running}>
			{login.prompts.filter((x) => x.event).map((x) => {
				const e = x.event!;
				if (e.type === "auth_url") return <p key={x.promptId}>{e.instructions ?? ""} <a href={e.url} target="_blank" rel="noopener noreferrer">{a.openLink}</a></p>;
				if (e.type === "device_code") return <p key={x.promptId}>{a.deviceCode} <code className="fp-code">{e.userCode}</code> <a href={e.verificationUri} target="_blank" rel="noopener noreferrer">{e.verificationUri}</a></p>;
				return <p key={x.promptId} className="fp-meta">{e.message}{(e.links ?? []).map((l) => <span key={l.url}> <a href={l.url} target="_blank" rel="noopener noreferrer">{l.label ?? l.url}</a></span>)}</p>;
			})}
			{open?.prompt ? (
				<form className="fp-row" onSubmit={(e) => { e.preventDefault(); if (value) void send(); }}>
					{open.prompt.type === "select" ? (
						<Choice label={open.prompt.message} tip="loginanswer" lang={lang} value={value} onChange={(e) => setValue(e.target.value)}>
							<option value="" disabled>…</option>
							{(open.prompt.options ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}{o.description ? ` (${o.description})` : ""}</option>)}
						</Choice>
					) : (
						<Field label={open.prompt.message} tip="loginanswer" lang={lang} type={open.prompt.type === "text" ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder={open.prompt.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
					)}
					<Act type="submit" kind="primary" label={a.send} tip="loginanswer" lang={lang} disabled={!value} />
				</form>
			) : <p className="fp-meta" role="status">{a.waiting}</p>}
			<Act label={a.cancel} tip="providersignin" lang={lang} onClick={() => void act(() => api("/admin/providers/cancel", { loginId: login.loginId }))} />
		</div>
	);
}

type AdminModels = { enabled: boolean; on: boolean; models: Array<{ label: string; provider: string; id: string; name: string }>; allowed: string[]; custom: boolean };

function Allowed({ lang, p }: { lang: Lang; p: PageText }) {
	const a = A[lang];
	const [m, setM] = useState<AdminModels | null>(null);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [on, setOn] = useState(true);
	const [msg, setMsg] = useState("");
	const take = (x: AdminModels) => { setM(x); setChosen(new Set(x.allowed)); setOn(x.on); };
	useEffect(() => { api<AdminModels>("/admin/models").then(take).catch((e) => setMsg((e as Error).message)); }, []);
	const groups = useMemo(() => { const g = new Map<string, AdminModels["models"]>(); for (const x of m?.models ?? []) g.set(x.provider, [...(g.get(x.provider) ?? []), x]); return [...g.entries()]; }, [m]);
	const save = (allowed: string[] | null) => api<AdminModels>("/admin/models", { allowed, on }).then((x) => { take(x); setMsg(a.saved); }).catch((e) => setMsg((e as Error).message));
	return (
		<section className="fp-card">
			<h2>{a.allowed}</h2>
			{!m ? <Skeleton label={p.loading} /> : !m.models.length ? <p className="fp-empty">{a.allowedNone}</p> : (
				<>
					<Tick label={a.modelsOn} tip="allowed" lang={lang} checked={on} onChange={(e) => setOn(e.target.checked)} />
					{groups.map(([provider, ms]) => (
						<details key={provider} className="fp-fold" open={ms.some((x) => chosen.has(x.label))}>
							<summary><b>{provider}</b> <span className="fp-meta">{ms.filter((x) => chosen.has(x.label)).length} / {ms.length}</span></summary>
							{ms.map((x) => <Tick key={x.label} label={x.name && x.name !== x.id ? `${x.id} · ${x.name}` : x.id} tip="allowed" lang={lang} checked={chosen.has(x.label)} onChange={(e) => setChosen((cur) => { const n = new Set(cur); if (e.target.checked) n.add(x.label); else n.delete(x.label); return n; })} />)}
						</details>
					))}
					<p className="fp-meta">{m.custom ? `${chosen.size} / ${m.models.length}` : a.std}</p>
					<div className="fp-row">
						<Act kind="primary" label={a.save} tip="allowed" lang={lang} onClick={() => void save([...chosen])} />
						<Act label={a.reset} tip="allowed" lang={lang} onClick={() => void save(null)} />
					</div>
				</>
			)}
			{msg ? <p className="fp-meta" role="status">{msg}</p> : null}
		</section>
	);
}

/** The administrator's switch for web searches by the models (server/research.ts). */
function ResearchCard({ lang, p }: { lang: Lang; p: PageText }) {
	const a = A[lang];
	const [r, setR] = useState<{ on: boolean; perDay: number } | null>(null);
	const [msg, setMsg] = useState("");
	useEffect(() => { api<{ on: boolean; perDay: number }>("/admin/research").then(setR).catch((e) => setMsg((e as Error).message)); }, []);
	const save = (on: boolean) => api<{ on: boolean; perDay: number }>("/admin/research", { on }).then((x) => { setR(x); setMsg(a.saved); }).catch((e) => setMsg((e as Error).message));
	return (
		<section className="fp-card">
			<h2>{a.research} <HelpTip id="research" lang={lang} label={a.research} /></h2>
			{!r ? <Skeleton label={p.loading} /> : (
				<>
					<Tick label={a.researchOn} tip="research" lang={lang} checked={r.on} onChange={(e) => void save(e.target.checked)} />
					<p className="fp-meta">{a.researchDay(r.perDay)}</p>
				</>
			)}
			{msg ? <p className="fp-meta" role="status">{msg}</p> : null}
		</section>
	);
}

const FIELDS = [["perMin", "perMin"], ["perDay", "perDay"], ["personTokensPerDay", "personTokens"], ["runBudgetTokens", "runBudget"]] as const;

function LimitsCard({ lang, p }: { lang: Lang; p: PageText }) {
	const a = A[lang];
	const [l, setL] = useState<Limits | null>(null);
	const [draft, setDraft] = useState<Record<string, string>>({});
	const [msg, setMsg] = useState("");
	const take = (x: Limits) => { setL(x); setDraft(Object.fromEntries(FIELDS.map(([k]) => [k, x.limits[k] === undefined ? "" : String(x.limits[k])]))); };
	useEffect(() => { api<Limits>("/admin/limits").then(take).catch((e) => setMsg((e as Error).message)); }, []);
	const save = () => api<Limits>("/admin/limits", Object.fromEntries(FIELDS.map(([k]) => [k, draft[k] ? Number(draft[k]) : undefined]))).then((x) => { take(x); setMsg(a.saved); }).catch((e) => setMsg((e as Error).message));
	return (
		<section className="fp-card">
			<h2>{a.limits}</h2>
			{!l ? <Skeleton label={p.loading} /> : (
				<form onSubmit={(e) => { e.preventDefault(); void save(); }}>
					{FIELDS.map(([k, label]) => (
						<div key={k} className="fp-limit">
							<Field label={a[label]} tip="limits" lang={lang} type="number" min={1} max={l.ceilings[k] || undefined} placeholder={String(l.ceilings[k] || "")} value={draft[k] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} />
							<span className="fp-meta">{a.ceiling(l.ceilings[k] ?? 0)} · {a.inForce(l.effective[k] ?? 0)}</span>
						</div>
					))}
					<Act type="submit" kind="primary" label={a.save} tip="limits" lang={lang} />
				</form>
			)}
			{msg ? <p className="fp-meta" role="status">{msg}</p> : null}
		</section>
	);
}
