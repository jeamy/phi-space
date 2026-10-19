"use client";
// Codemode chat UI: the Space-Chat workbench layout of the help system (task and run controls left, the
// conversation in the middle, leaderboard and best code right), for contributions of code. All text is rendered as
// React text nodes: agent code is untrusted data and never becomes markup.
import { useCallback, useEffect, useState } from "react";

type Lang = "de" | "en";
type L = { de: string; en: string };
type Contribution = { candidateId: string; author: string; via: string; host?: string; gen: number; ok: boolean | null; ms: number | null; error?: string; source: string; ts: number };
type Message = { author: string; text: string; ts: number };
type Snapshot = {
	session: string; task: { id: string; fn: string; title: L; prompt: L; cases?: number }; tasks: { id: string; title: L }[];
	messages: Message[]; contributions: Contribution[]; best: { candidateId: string; ms: number; source: string } | null;
	run: { active: boolean; mode: string; gen: number; gens: number; agents: number; perAgent: number; note?: string } | null;
};
type Llm = { enabled: boolean; on: boolean; current: string | null; models: { id: string; label: string }[] };
type Shard = { shard: string; up: boolean; host: { name: string; cpu: string; cores: number; memGiB: number } | null; judged: number | null };

const T = {
	de: { title: "Codemode-Chat", eyebrow: "AGENTEN UND MENSCHEN SCHREIBEN CODE IN EINEN GEMEINSAMEN SPACE", lead: "Jeder Beitrag ist ein Eintrag im Space; die Codemode-Sandbox bewertet ihn. Gezeigt wird der Code jedes Beitrags.", task: "Aufgabe", run: "Lauf", agents: "Agenten", gens: "Generationen", per: "Beiträge je Agent", mode: "Agenten", scripted: "skriptgesteuert", llm: "Modell", start: "Lauf starten", stop: "Stoppen", custom: "Eigene Aufgabe", fn: "Funktionsname", cases: "Testfälle (JSON: [{\"args\":[2],\"expect\":4}])", useTask: "Aufgabe setzen", yours: "Eigener Code", submit: "Code einreichen", you: "Name", say: "Nachricht", send: "Senden", board: "Rangliste", best: "Bester Code", none: "Noch keine Beiträge.", wait: "wartet", ok: "korrekt", bad: "falsch", code: "Code", gen: "Gen.", live: "live", offline: "getrennt", session: "Raum", off: "Modell-Agenten aus", nobest: "keine korrekten Beiträge", test: "Testsystem", judged: "bewertet", down: "nicht erreichbar" },
	en: { title: "Codemode chat", eyebrow: "AGENTS AND PEOPLE WRITE CODE INTO A SHARED SPACE", lead: "Every contribution is an entry in the space; the codemode sandbox judges it. The code of each contribution is shown.", task: "Task", run: "Run", agents: "Agents", gens: "Generations", per: "Contributions per agent", mode: "Agents", scripted: "scripted", llm: "model", start: "Start run", stop: "Stop", custom: "Custom task", fn: "Function name", cases: "Test cases (JSON: [{\"args\":[2],\"expect\":4}])", useTask: "Set task", yours: "Your code", submit: "Submit code", you: "Name", say: "Message", send: "Send", board: "Leaderboard", best: "Best code", none: "No contributions yet.", wait: "waiting", ok: "correct", bad: "wrong", code: "code", gen: "gen", live: "live", offline: "disconnected", session: "Room", off: "model agents off", nobest: "no correct contribution", test: "Test system", judged: "judged", down: "unreachable" },
} as const;

const store = (k: string, v?: string): string | null => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); return v; } catch { return null; } };
async function api<R = unknown>(path: string, body?: unknown): Promise<R> {
	const r = await fetch("/api" + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((data as { error?: string }).error || r.statusText);
	return data as R;
}
const shortCpu = (cpu: string) => cpu.replace(/\((R|TM)\)/g, "").replace(/\b(\d+-Core )?Processor\b/i, "").replace(/\s+/g, " ").trim();

function Card({ c, best, t }: { c: Contribution; best: Snapshot["best"]; t: (typeof T)[Lang] }) {
	const isBest = best?.candidateId === c.candidateId;
	return (
		<div className={"card" + (isBest ? " card--best" : "") + (c.ok === false ? " card--bad" : "")}>
			<div className="card__head">
				<span className="who">{c.author}</span>
				<span className="chip">{c.via}</span>
				{c.host ? <span className="chip">{c.host}</span> : null}
				{c.gen ? <span className="chip">{t.gen} {c.gen}</span> : null}
				{c.ok === null ? <span className="chip chip--wait">{t.wait}</span> : c.ok ? <span className="chip chip--ok">{t.ok} · {c.ms} ms</span> : <span className="chip chip--bad">{t.bad}</span>}
				{isBest ? <span className="chip chip--best">best</span> : null}
			</div>
			{c.error ? <div className="err">{c.error}</div> : null}
			<details open={isBest || c.ok === null}>
				<summary>{t.code}</summary>
				<pre className="code">{c.source}</pre>
			</details>
		</div>
	);
}

export function CodemodeChat() {
	const [lang, setLang] = useState<Lang>("en");
	const [mode, setMode] = useState<"dark" | "light">("dark");
	const [name, setName] = useState("guest");
	const [session, setSession] = useState("lobby");
	const [snap, setSnap] = useState<Snapshot | null>(null);
	const [live, setLive] = useState(false);
	const [llm, setLlm] = useState<Llm | null>(null);
	const [shards, setShards] = useState<Shard[]>([]);
	const [error, setError] = useState("");
	const [code, setCode] = useState("");
	const [msg, setMsg] = useState("");
	const [custom, setCustom] = useState({ fn: "", prompt: "", cases: "" });
	const [params, setParams] = useState({ agents: 4, gens: 3, per: 1, mode: "scripted" });
	const t = T[lang];
	const sid = encodeURIComponent(session);

	useEffect(() => {
		setLang((store("cm.lang") as Lang) || (navigator.language.startsWith("de") ? "de" : "en"));
		setMode((store("cm.mode") as "dark" | "light") || "dark");
		setName(store("cm.name") || "guest-" + Math.random().toString(36).slice(2, 5));
		const fromHash = () => setSession(decodeURIComponent(location.hash.slice(1)) || "lobby");
		fromHash();
		window.addEventListener("hashchange", fromHash);
		return () => window.removeEventListener("hashchange", fromHash);
	}, []);
	useEffect(() => { document.documentElement.dataset.mode = mode; }, [mode]);

	useEffect(() => {
		let dead = false, ws: WebSocket | null = null, retry = 0, timer: ReturnType<typeof setTimeout> | undefined;
		const open = () => {
			ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/" + sid);
			ws.onopen = () => { setLive(true); retry = 0; };
			ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type === "snapshot") setSnap(d); };
			ws.onclose = () => { setLive(false); if (!dead) timer = setTimeout(open, Math.min(10_000, 500 * 2 ** retry++)); };
		};
		open();
		return () => { dead = true; clearTimeout(timer); ws?.close(); };
	}, [sid]);

	useEffect(() => {
		let dead = false;
		const load = () => {
			api<Llm>("/llm").then((x) => { if (!dead) setLlm(x); }).catch(() => {});
			api<{ shards: Shard[] }>("/system").then((x) => { if (!dead) setShards(x.shards); }).catch(() => {});
		};
		load();
		const timer = setInterval(load, 15_000);
		return () => { dead = true; clearInterval(timer); };
	}, []);

	const act = useCallback(async (path: string, body: unknown) => {
		setError("");
		try { await api(`/sessions/${sid}${path}`, body); } catch (e) { setError((e as Error).message); }
	}, [sid]);

	type Item = { ts: number; m?: Message; c?: Contribution };
	const items: Item[] = [...(snap?.messages ?? []).map((m): Item => ({ ts: m.ts, m })), ...(snap?.contributions ?? []).map((c): Item => ({ ts: c.ts, c }))].sort((a, b) => a.ts - b.ts);
	const board = (snap?.contributions ?? []).filter((c) => c.ok).sort((a, b) => a.ms! - b.ms!).slice(0, 8);
	const run = snap?.run;
	const sendMsg = () => { const text = msg; if (!text.trim()) return; setMsg(""); void act("/message", { author: name, text }); };

	return (
		<>
			<header className="top">
				<span className="brand">PHI-SPACES / <b>CODEMODE CHAT</b></span>
				<span className="spacer" />
				<span className="pill">{t.session}: {session}</span>
				<span className={"pill" + (live ? " pill--accent" : "")}>{live ? t.live : t.offline}</span>
				{llm?.enabled ? (
					<select value={llm.current ?? ""} onChange={(e) => void api<Llm>("/llm", { model: e.target.value }).then(setLlm)}>
						{llm.models.map((m) => <option key={m.id} value={m.label}>{m.label}</option>)}
					</select>
				) : <span className="pill">{t.off}</span>}
				<button className="btn" onClick={() => { const n = lang === "de" ? "en" : "de"; setLang(n); store("cm.lang", n); }}>{lang.toUpperCase()}</button>
				<button className="btn" onClick={() => { const n = mode === "dark" ? "light" : "dark"; setMode(n); store("cm.mode", n); }}>{mode === "dark" ? "☀" : "☾"}</button>
			</header>
			<main>
				<aside>
					<div className="panel">
						<h2>{t.task}</h2>
						<div className="row">
							<select value={snap?.task.id ?? ""} onChange={(e) => e.target.value !== "custom" && void act("/task", { taskId: e.target.value })}>
								{(snap?.tasks ?? []).map((x) => <option key={x.id} value={x.id}>{x.title[lang]}</option>)}
								{snap?.task.id === "custom" ? <option value="custom">{t.custom}</option> : null}
							</select>
						</div>
						{snap ? <p className="lead">{snap.task.prompt[lang]} <code>{snap.task.fn}</code></p> : null}
						<details>
							<summary>{t.custom}</summary>
							<div className="row"><input placeholder={t.fn} value={custom.fn} onChange={(e) => setCustom({ ...custom, fn: e.target.value })} /></div>
							<div className="row"><input style={{ width: "100%" }} placeholder={t.task} value={custom.prompt} onChange={(e) => setCustom({ ...custom, prompt: e.target.value })} /></div>
							<textarea rows={4} placeholder={t.cases} value={custom.cases} onChange={(e) => setCustom({ ...custom, cases: e.target.value })} />
							<div className="row"><button className="btn" onClick={() => { let cases: unknown; try { cases = JSON.parse(custom.cases); } catch { setError("JSON?"); return; } void act("/task", { custom: { fn: custom.fn, prompt: custom.prompt, cases } }); }}>{t.useTask}</button></div>
						</details>
					</div>
					<div className="panel">
						<h2>{t.run}</h2>
						{(["agents", "gens", "per"] as const).map((k) => (
							<div className="row" key={k}>
								<label htmlFor={"r" + k}>{t[k]}</label>
								<input id={"r" + k} type="number" min={1} max={k === "agents" ? 8 : k === "gens" ? 6 : 3} value={params[k]} onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })} />
							</div>
						))}
						<div className="row">
							<label htmlFor="rmode">{t.mode}</label>
							<select id="rmode" value={params.mode} onChange={(e) => setParams({ ...params, mode: e.target.value })}>
								<option value="scripted">{t.scripted}</option>
								<option value="llm" disabled={!llm?.enabled}>{t.llm}</option>
							</select>
						</div>
						<div className="row">
							<button className="btn btn--primary" disabled={!!run?.active} onClick={() => void act("/run", { agents: params.agents, gens: params.gens, perAgent: params.per, mode: params.mode, lang })}>{t.start}</button>
							<button className="btn" disabled={!run?.active} onClick={() => void act("/stop", {})}>{t.stop}</button>
						</div>
						{run ? <div className={"pill" + (run.active ? " pill--accent" : "")}>{run.mode} · {run.gen}/{run.gens}</div> : null}
						{run?.note ? <div className="notice">{run.note}</div> : null}
					</div>
					<div className="panel">
						<h2>{t.yours}</h2>
						<textarea rows={7} spellCheck={false} placeholder={snap ? `function ${snap.task.fn}(...) { ... }` : ""} value={code} onChange={(e) => setCode(e.target.value)} />
						<div className="row"><button className="btn btn--primary" onClick={() => { const source = code; setCode(""); void act("/code", { author: name, source }); }}>{t.submit}</button></div>
					</div>
				</aside>
				<section>
					<span className="eyebrow">{t.eyebrow}</span>
					<h1>{t.title}</h1>
					<p className="lead">{t.lead}</p>
					{error ? <div className="notice">{error}</div> : null}
					{items.length ? (
						<div className="timeline">
							{items.map((i, n) => i.m
								? <div key={"m" + n} className={"msg" + (i.m.author === "system" ? " msg--system" : "")}><b>{i.m.author}</b>{i.m.text}</div>
								: <Card key={i.c!.candidateId} c={i.c!} best={snap!.best} t={t} />)}
						</div>
					) : <div className="empty">{t.none}</div>}
					<div className="panel" style={{ marginTop: 14 }}>
						<div className="row"><label htmlFor="name">{t.you}</label><input id="name" value={name} onChange={(e) => { setName(e.target.value.slice(0, 40)); store("cm.name", e.target.value.slice(0, 40)); }} /></div>
						<div className="row">
							<input style={{ flex: 1 }} placeholder={t.say} value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendMsg()} />
							<button className="btn" onClick={sendMsg}>{t.send}</button>
						</div>
					</div>
				</section>
				<aside>
					<div className="panel">
						<h2>{t.board}</h2>
						{board.length ? <table className="board"><tbody>{board.map((c, i) => <tr key={c.candidateId}><td>{i + 1}. {c.author}</td><td>{c.ms} ms</td></tr>)}</tbody></table> : <div className="empty">{t.nobest}</div>}
					</div>
					<div className="panel">
						<h2>{t.best}</h2>
						{snap?.best ? <pre className="code">{snap.best.source}</pre> : <div className="empty">{t.nobest}</div>}
					</div>
				</aside>
			</main>
			{shards.length ? (
				<div className="system-bar" role="contentinfo">
					<span>{t.test}</span>
					{shards.map((s) => s.up ? (
						<span key={s.shard}><b>{s.host?.name ?? s.shard}</b>{s.host ? ` · ${shortCpu(s.host.cpu)} · ${s.host.cores} vCPU · ${s.host.memGiB} GiB` : ""}{s.judged !== null ? ` · ${s.judged.toLocaleString(lang === "de" ? "de-DE" : "en-US")} ${t.judged}` : ""}</span>
					) : <span key={s.shard} className="system-bar__host--down"><b>{s.shard}</b>: {t.down}</span>)}
				</div>
			) : null}
		</>
	);
}
