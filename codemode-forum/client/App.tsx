"use client";
// The forum's page. A room holds plan tasks; each is a block with its documents (one per table). The page shows the
// run, the discussion with its ballots and objections, each table's document version by version (also as the
// difference between two versions, and both tables side by side), the comparison of the two tables and the standings
// (docs/gemeinsame-planung-plan-2026-11-22.en.md, section 11).
import { useEffect, useState } from "react";
import { AdminPanel } from "./AdminPanel.tsx";
import { RoomsPanel, type RoomRole } from "./RoomsPanel.tsx";
import { ThemeControls } from "./ThemeControls.tsx";
import { DocPane, OutcomePanel, RunPanel, StandingsPanel, TalkPane } from "./panes.tsx";
import { api, firstLine } from "./lib/api.ts";
import { loadMe, rename, signOut, type Me } from "./lib/me.ts";
import { T } from "./lib/texts.ts";
import { useRoom } from "./lib/use-room.ts";
import { HelpTip } from "./HelpTip.tsx";
import { useTheme } from "./lib/theme.ts";

export function CodemodeForum() {
	const theme = useTheme();
	const lang = theme.lang, t = T[lang], locale = lang === "de" ? "de-DE" : "en-US";
	const [me, setMe] = useState<Me | null>(null);
	const [nameDraft, setNameDraft] = useState("");
	const [rooms, setRooms] = useState<Array<{ room: string; role: RoomRole }> | null>(null);
	const [room, setRoom] = useState("lobby");
	useEffect(() => { loadMe().then(setMe).catch(() => setMe({ login: false })); }, []);
	const signedIn = !!(me?.login && me.user);
	const loadRooms = () => { api<{ rooms: Array<{ room: string; role: RoomRole }> }>("/rooms").then((x) => setRooms(x.rooms)).catch(() => setRooms([])); };
	useEffect(() => { if (signedIn) loadRooms(); }, [signedIn]);
	// with a sign-in nothing is loaded before a person is signed in, and a room only once they have a role in it
	const roleHere = rooms?.find((r) => r.room === room)?.role ?? null;
	const ready = me !== null && (!me.login || (signedIn && roleHere !== null));
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [perModel, setPerModel] = useState(1);
	const [way, setWay] = useState<"both" | "parallel" | "turns">("both");
	const [rounds, setRounds] = useState(2);
	const [budgetTokens, setBudgetTokens] = useState("100000");
	const [budgetUsd, setBudgetUsd] = useState("");
	const [admin, setAdmin] = useState(false);
	const [msg, setMsg] = useState("");
	const [brief, setBrief] = useState("");
	const [docLang, setDocLang] = useState<"de" | "en" | "">("");
	const [outline, setOutline] = useState("");
	const [criteria, setCriteria] = useState("");
	const [docs, setDocs] = useState<Array<{ name: string; text: string }>>([]);
	const [repos, setRepos] = useState<string[]>([]);
	const [repo, setRepo] = useState("");
	const [hosts, setHosts] = useState<string[]>([]);
	const [remote, setRemote] = useState("");
	const [ref, setRef] = useState("");
	const { rid, snap, live, system, loadModels, blocks, block, setFocus, setTableSel, docTables, sideBySide, shown, docKey, talkOf, said, result, resultOf, available, limits, run, runHere, answers, table, name, who, threads } = useRoom(room, ready, t);

	useEffect(() => {
		const fromHash = () => setRoom(decodeURIComponent(location.hash.slice(1)) || "lobby");
		fromHash();
		window.addEventListener("hashchange", fromHash);
		return () => window.removeEventListener("hashchange", fromHash);
	}, []);

	// the repositories a task may read in: only an admin is told them
	useEffect(() => {
		if (!admin) { setRepos([]); setRepo(""); setHosts([]); setRemote(""); return; }
		api<{ repos: string[]; hosts?: string[] }>("/sources").then((x) => { setRepos(x.repos); setHosts(x.hosts ?? []); }).catch(() => {});
	}, [admin]);
	const addDocs = async (files: FileList | null) => {
		const read = await Promise.all([...(files ?? [])].map(async (f) => ({ name: f.name, text: await f.text() })));
		setDocs((cur) => [...cur.filter((d) => !read.some((r) => r.name === d.name)), ...read]);
	};

	const picked = available.filter((m) => chosen.has(m.label)).map((m) => m.label);
	const act = async (fn: () => Promise<unknown>) => { setMsg(""); try { await fn(); } catch (e) { setMsg((e as Error).message); } };
	const create = () => act(async () => {
		const r = await api<{ blockId: string }>(`/rooms/${rid}/task`, { brief, lang: docLang || lang, outline, criteria, ...(docs.length ? { docs } : {}), ...(remote.trim() ? { repo: { url: remote.trim(), ref } } : repo ? { repo: { name: repo, ref } } : {}) });
		setBrief(""); setOutline(""); setCriteria(""); setDocs([]); setRepo(""); setRemote(""); setRef(""); setFocus(r.blockId); setTableSel(null);
	});
	const start = () => act(() => api(`/rooms/${rid}/run`, { blockId: block?.blockId, way, rounds, models: picked, perModel, budgetTokens: budgetTokens || undefined, budgetUsd: budgetUsd || undefined }));
	const toggle = (label: string, add: boolean) => setChosen((cur) => { const n = new Set(cur); if (add) n.add(label); else n.delete(label); return n; });
	const send = async (text: string, thread?: string) => {
		setMsg("");
		try { await api(`/rooms/${rid}/message`, { blockId: block?.blockId, text, ...(thread ? { thread } : {}) }); return true; } catch (e) { setMsg((e as Error).message); return false; }
	};

	const controls = <ThemeControls lang={theme.lang} setLang={theme.setLang} mode={theme.mode} changeMode={theme.changeMode} palette={theme.palette} changePalette={theme.changePalette} />;
	// until the page knows whether a sign-in is needed: the bar alone, so the forum never flashes before the sign-in
	if (me === null) return (
		<header className="top">
			<span className="brand">PHI-SPACES / <b>FORUM</b></span>
			<span className="spacer" />
			<a className="toplink" href={`/help?lang=${lang}`}>{t.helpLink}</a>
			{controls}
		</header>
	);
	// with a sign-in and nobody signed in: the way in, and nothing else
	if (me.login && !me.user) return (
		<>
			<header className="top">
				<span className="brand">PHI-SPACES / <b>FORUM</b></span>
				<span className="spacer" />
				<a className="toplink" href={`/help?lang=${lang}`}>{t.helpLink}</a>
				{controls}
			</header>
			<main className="signin">
				<div className="panel">
					<h2>{t.signInTitle}</h2>
					<p>{t.signInText}</p>
					<div className="row"><a className="btn btn--primary" href="/auth/login">{t.signIn}</a> <HelpTip id="signin" lang={lang} label={t.signIn} /></div>
				</div>
			</main>
		</>
	);
	const person = me?.login && me.user ? me.user : null;

	return (
		<>
			<header className="top">
				<span className="brand">PHI-SPACES / <b>CODEMODE FORUM</b></span>
				<span className="spacer" />
				<span className="pill">{t.room}: {room}</span>
				<span className={"pill" + (live ? " pill--accent" : "")}>{live ? t.live : t.offline}</span>
				<span className="pill">{available.length ? `${available.length} ${t.models}` : t.off}</span>
				<a className="toplink" href={`/help?lang=${lang}`}>{t.helpLink}</a>
				{person && (
					<details className="me">
						<summary className="pill">{person.name}</summary>
						<form onSubmit={(e) => { e.preventDefault(); rename(nameDraft).then((m) => { setMe(m); setNameDraft(""); }).catch((err) => setMsg((err as Error).message)); }}>
							<label>{t.yourName} <HelpTip id="name" lang={lang} label={t.yourName} /> <input value={nameDraft} placeholder={person.name} maxLength={40} onChange={(e) => setNameDraft(e.target.value)} /></label>
							<button className="btn" type="submit" disabled={!nameDraft.trim()}>{t.saveName}</button>
							<span className="row"><button className="btn" type="button" onClick={() => void signOut()}>{t.signOut}</button> <HelpTip id="signout" lang={lang} label={t.signOut} /></span>
						</form>
					</details>
				)}
				{controls}
			</header>
			<main>
				<aside>
					{person && <RoomsPanel lang={lang} room={room} rooms={rooms} reload={loadRooms} userId={person.id} />}
					<div className="panel">
						<h2>{t.task}</h2>
						<textarea className="task-field" rows={5} maxLength={8000} placeholder={t.brief} aria-label={t.brief} value={brief} onChange={(e) => setBrief(e.target.value)} />
						<div className="row">
							<label htmlFor="doclang">{t.docLang}</label>
							<select id="doclang" value={docLang || lang} onChange={(e) => setDocLang(e.target.value as "de" | "en")}><option value="de">Deutsch</option><option value="en">English</option></select>
						</div>
						<details>
							<summary>{t.outline}</summary>
							<textarea rows={4} aria-label={t.outline} value={outline} onChange={(e) => setOutline(e.target.value)} />
						</details>
						<details>
							<summary>{t.criteria}</summary>
							<textarea rows={3} aria-label={t.criteria} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
						</details>
						<details open={docs.length > 0 || !!repo || !!remote}>
							<summary>{t.sources}</summary>
							<label className="fieldlabel" htmlFor="docs">{t.docs}</label>
							<input id="docs" type="file" multiple accept=".md,.markdown,.txt,.csv,.json,.yaml,.yml" onChange={(e) => { void addDocs(e.target.files); e.target.value = ""; }} />
							{docs.map((d) => <div key={d.name} className="row"><span>{d.name}</span><span className="muted">{(new Blob([d.text]).size / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} kB</span><button type="button" className="btn" onClick={() => setDocs((cur) => cur.filter((x) => x.name !== d.name))}>{t.drop}</button></div>)}
							{admin && repos.length ? (
								<div className="row">
									<label htmlFor="repo">{t.repo}</label>
									<select id="repo" value={repo} onChange={(e) => setRepo(e.target.value)}><option value="">{t.noRepo}</option>{repos.map((r) => <option key={r} value={r}>{r}</option>)}</select>
								</div>
							) : null}
							{admin && hosts.length ? (
								<>
									<label className="fieldlabel" htmlFor="remote">{t.remote(hosts.join(", "))}</label>
									<input id="remote" className="wide" type="url" maxLength={300} placeholder="https://…" value={remote} onChange={(e) => setRemote(e.target.value)} />
								</>
							) : null}
							{repo || remote ? <div className="row"><input className="wide" aria-label={t.ref} placeholder={t.ref} value={ref} onChange={(e) => setRef(e.target.value)} /></div> : null}
							{docs.length || repo || remote ? <div className="notice">{t.sourceNote}</div> : null}
						</details>
						<div className="row"><button type="button" className="btn btn--primary" disabled={brief.trim().length < 20} onClick={() => void create()}>{t.create}</button></div>
					</div>
					<div className="panel">
						<h2>{t.run}</h2>
						{!block ? <div className="notice">{t.noTask}</div> : available.length ? (
							<>
								<div className="fieldlabel"><span>{t.on}:</span> <span className="muted">{firstLine(block.brief, 60)}</span></div>
								<fieldset className="models">
									<legend>{t.pick(limits.minModels, limits.maxModels)}</legend>
									{available.map((m) => (
										<label key={m.label} className="check" title={m.label}>
											<input type="checkbox" checked={chosen.has(m.label)} disabled={!chosen.has(m.label) && picked.length >= limits.maxModels} onChange={(e) => toggle(m.label, e.target.checked)} />
											<span>{m.label}</span>
										</label>
									))}
								</fieldset>
								<div className="row">
									<label htmlFor="way">{t.way}</label>
									<select id="way" value={way} onChange={(e) => setWay(e.target.value as "both" | "parallel" | "turns")}><option value="both">{t.wayBoth}</option><option value="parallel">{t.wayB}</option><option value="turns">{t.wayA}</option></select>
								</div>
								<div className="row"><label htmlFor="rounds">{t.rounds}</label><input id="rounds" type="number" min={0} max={8} value={rounds} onChange={(e) => setRounds(Math.min(8, Math.max(0, Number(e.target.value) || 0)))} /></div>
								<div className="row">
									<label htmlFor="permodel">{t.perModel}</label>
									<input id="permodel" type="number" min={1} max={limits.maxPerModel} value={perModel} onChange={(e) => setPerModel(Math.min(limits.maxPerModel, Math.max(1, Number(e.target.value) || 1)))} />
								</div>
								<div className="row">
									<label htmlFor="btokens">{t.tokens}</label>
									<input id="btokens" type="number" min={1000} step={1000} style={{ width: 110 }} value={budgetTokens} onChange={(e) => setBudgetTokens(e.target.value)} />
									{admin ? <><label htmlFor="busd">{t.usd}</label><input id="busd" type="number" min={0} step={0.5} value={budgetUsd} onChange={(e) => setBudgetUsd(e.target.value)} /></> : null}
								</div>
								{picked.length < limits.minModels ? <div className="notice">{t.need(limits.minModels)}</div> : null}
								<div className="row">
									<button type="button" className="btn btn--primary" disabled={!!run?.active || picked.length < limits.minModels} onClick={() => void start()}>{t.start}</button>
									<button type="button" className="btn" disabled={!run?.active} onClick={() => void act(() => api(`/rooms/${rid}/stop`, {}))}>{t.stop}</button>
								</div>
							</>
						) : <div className="notice">{t.none}</div>}
						{msg ? <div className="notice">{msg}</div> : null}
					</div>
					<AdminPanel lang={lang} onChanged={loadModels} onSession={setAdmin} />
				</aside>
				<section>
					<div className="eyebrow">CODEMODE FORUM</div>
					<h1>{t.room} {room}</h1>
					<p className="lead">{t.lead}</p>
					{blocks.length > 1 ? (
						<div className="tasks" role="tablist" aria-label={t.tasks}>
							{blocks.map((b) => <button key={b.blockId} type="button" role="tab" aria-selected={b.blockId === block?.blockId} className={"tasks__tab" + (b.blockId === block?.blockId ? " is-active" : "")} onClick={() => { setFocus(b.blockId); setTableSel(null); }}>{firstLine(b.brief, 48)}</button>)}
						</div>
					) : null}
					{block ? (
						<>
							<div className="panel">
								<h2>{t.task}</h2>
								<p className="briefing">{block.brief}</p>
								{block.criteria.length ? <ul className="criteria">{block.criteria.map((c) => <li key={c}>{c}</li>)}</ul> : null}
								{block.sources.length ? <div className="runline sources">{block.sources.map((x) => <span key={x.sourceId} className="pill">{x.kind === "repo" ? t.srcRepo(x.name, (x.commit ?? "").slice(0, 12), x.files) : t.srcDocs(x.files)}</span>)}</div> : null}
							</div>
							{runHere ? <RunPanel t={t} locale={locale} runHere={runHere} table={table} answers={answers} /> : null}
							{docTables.length === 2 ? (
								<div className="tasks" role="tablist" aria-label={t.way}>
									{docTables.map((x) => <button key={x} type="button" role="tab" aria-selected={!sideBySide && shown === x} className={"tasks__tab" + (!sideBySide && shown === x ? " is-active" : "")} onClick={() => setTableSel(x)}>{t.tableName(x)}{block.result?.table === x ? ` · ${t.isResult}` : ""}</button>)}
									<button type="button" role="tab" aria-selected={sideBySide} className={"tasks__tab" + (sideBySide ? " is-active" : "")} onClick={() => setTableSel("side")}>{t.side}</button>
								</div>
							) : null}
							{result && (result.stat || result.compares.length) ? <OutcomePanel t={t} locale={locale} o={result} name={name} /> : null}
							<TalkPane t={t} lang={lang} block={block} said={said} docTables={docTables} shown={shown} name={name} who={who} threads={threads} send={send} />
							<div className={sideBySide ? "docs docs--side" : "docs"}>
								{(sideBySide ? docTables : [shown]).map((x) => (
									<DocPane key={`${block.blockId}:${x}`} t={t} lang={lang} locale={locale} rid={rid} block={block} table={x} head={block.heads[x] ?? 0} titled={docTables.length === 2} resultVersion={resultOf(x)} objections={talkOf(x)?.objections ?? []} docKey={docKey} name={name} act={act} />
								))}
							</div>
						</>
					) : <div className="empty">{t.empty}</div>}
					{snap?.standings?.runs ? <StandingsPanel t={t} locale={locale} s={snap.standings} /> : null}
					{snap?.lines.length ? (
						<div className="panel">
							<h2>{t.log}</h2>
							<div className="timeline">
								{snap.lines.map((l, i) => <div key={`${l.ts}-${i}`} className="msg msg--system">{l.text}</div>)}
							</div>
						</div>
					) : null}
				</section>
			</main>
			{system?.hosts.length ? (
				<div className="system-bar" role="contentinfo">
					<span>{t.hosts}</span>
					{system.hosts.map((h) => <span key={h.name}><b>{h.name}</b> ({h.roles.join(", ")}) · {h.host.cores} vCPU · {h.host.memGiB} GiB</span>)}
					<span>{t.today(system.today.calls, system.today.tokens)}</span>
				</div>
			) : null}
		</>
	);
}

