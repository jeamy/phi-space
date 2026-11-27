"use client";
// A room of the FORUM page (docs/forum-seite-plan-2026-11-26.en.md, sections 4 and 10): three panes, Files (the
// material of the task shown), Table (the tasks, the run, the discussion and the questions to the person) and Plan
// (the document with its versions, objections and ballots). Above 1100 px all three side by side; from 760 px Table and
// Plan, Files as a drawer; below, one pane with a bar of the three at the bottom. The pane shown is the address's hash
// (#files, #table, #plan), so a link can name it.
import { useEffect, useState } from "react";
import { HelpTip } from "../HelpTip.tsx";
import { api, firstLine } from "../lib/api.ts";
import type { Table } from "../lib/forum-types.ts";
import type { Text } from "../lib/texts.ts";
import type { Lang } from "../lib/theme.ts";
import { useRoom } from "../lib/use-room.ts";
import { DocPane, OutcomePanel, RunPanel, TalkPane } from "../panes.tsx";
import { Act, Area, Choice, Field, Tick } from "./controls.tsx";
import { Skeleton, type RoomRow } from "./ForumPage.tsx";
import type { PageText } from "./texts.ts";

type Pane = "files" | "table" | "plan";
const PANES: Pane[] = ["files", "table", "plan"];
const paneOf = (hash: string): Pane | null => (PANES as string[]).includes(hash.slice(1)) ? (hash.slice(1) as Pane) : null;

/** `row`: the person's entry in the room list (undefined while it loads, null: no role here); without a sign-in every
 *  room is open. */
export function RoomPlace({ lang, p, t, room, login, row }: { lang: Lang; p: PageText; t: Text; room: string; login: boolean; row: RoomRow | null | undefined }) {
	const locale = lang === "de" ? "de-DE" : "en-US";
	const ready = !login || !!row;
	const canWrite = !login || (!!row && row.role !== "viewer");
	const r = useRoom(room, ready, t);
	const { rid, snap, live, blocks, block, setFocus, setTableSel, docTables, sideBySide, shown, docKey, talkOf, said, result, resultOf, available, limits, run, runHere, answers, table, name, who, threads } = r;
	const [pane, setPane] = useState<Pane>("table");
	const [filesOpen, setFilesOpen] = useState(false);
	const [msg, setMsg] = useState("");
	useEffect(() => {
		const read = () => setPane(paneOf(location.hash) ?? (() => { try { return paneOf("#" + (localStorage.getItem("forum.pane") ?? "")); } catch { return null; } })() ?? "table");
		read();
		window.addEventListener("hashchange", read);
		return () => window.removeEventListener("hashchange", read);
	}, []);
	useEffect(() => { try { localStorage.setItem("forum.pane", pane); } catch { /* a private window: the pane is not kept */ } }, [pane]);

	const act = async (fn: () => Promise<unknown>) => { setMsg(""); try { await fn(); return true; } catch (e) { setMsg((e as Error).message); return false; } };
	const send = (text: string, thread?: string) => act(() => api(`/rooms/${rid}/message`, { blockId: block?.blockId, text, ...(thread ? { thread } : {}) }));

	const typing = useKeyboard();
	useNotifyWhenAsked(block?.talk.forPerson ?? 0, room, p.waitingTitle);

	if (row === undefined) return <main className="fp-main"><Skeleton label={p.loading} lines={5} /></main>;
	if (row === null && login) return <main className="fp-main fp-narrow"><p className="fp-empty">{p.notHere}</p><p><a href="/">{p.back}</a></p></main>;

	const forPerson = block?.talk.forPerson ?? 0;
	const files = (
		<section className="fp-pane fp-pane--files" aria-label={p.files}>
			<h2>{p.files} <HelpTip id="files" lang={lang} label={p.files} /></h2>
			{!snap ? <Skeleton label={p.loading} /> : !block ? <p className="fp-empty">{p.noTaskFiles}</p> : block.sources.length ? (
				<ul className="fp-files">
					{block.sources.map((x) => (
						<li key={x.sourceId}>
							<b>{x.kind === "repo" ? `${p.sourceRepo} ${x.name}` : p.sourceDocs}</b>
							<span className="fp-meta">{p.filesN(x.files)} · {(x.bytes / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} kB{x.commit ? ` · ${x.commit.slice(0, 12)}` : ""}</span>
						</li>
					))}
				</ul>
			) : <p className="fp-empty">{p.noSources}</p>}
		</section>
	);

	return (
		<main className={`fp-room fp-room--${pane}${filesOpen ? " fp-room--drawer" : ""}${typing ? " fp-room--typing" : ""}`}>
			<div className="fp-roombar">
				<b className="fp-roomname">{room}</b>
				<span className={"fp-live" + (live ? " is-live" : "")}>{live ? t.live : t.offline}</span>
				{row ? <span className="fp-meta">{p.role[row.role]}</span> : null}
				<span className="fp-spacer" />
				<span className="fp-filesbtn"><Act label={filesOpen ? p.closeFiles : p.openFiles} tip="files" lang={lang} aria-expanded={filesOpen} onClick={() => setFilesOpen((o) => !o)} /></span>
			</div>
			{files}
			<section className="fp-pane fp-pane--table" aria-label={p.table}>
				<h2>{p.table} <HelpTip id="table" lang={lang} label={p.table} /></h2>
				{!snap ? <Skeleton label={p.loading} lines={5} /> : (
					<>
						{blocks.length > 1 ? (
							<Choice label={p.task} tip="task" lang={lang} value={block?.blockId ?? ""} onChange={(e) => { setFocus(e.target.value); setTableSel(null); }}>
								{blocks.map((b) => <option key={b.blockId} value={b.blockId}>{firstLine(b.brief, 60)}</option>)}
							</Choice>
						) : null}
						{block ? (
							<div className="fp-brief">
								<p>{block.brief}</p>
								{block.criteria.length ? <ul>{block.criteria.map((c) => <li key={c}>{c}</li>)}</ul> : null}
							</div>
						) : <p className="fp-empty">{canWrite ? p.noTask : p.viewer}</p>}
						{!canWrite ? (block ? <p className="fp-meta">{p.viewer}</p> : null) : <NewTask lang={lang} p={p} t={t} rid={rid} open={!block} act={act} onMade={(id) => { setFocus(id); setTableSel(null); }} />}
						{runHere ? <RunPanel t={t} locale={locale} runHere={runHere} table={table} answers={answers} /> : null}
						{canWrite && block ? <StartRun lang={lang} p={p} t={t} rid={rid} blockId={block.blockId} available={available} limits={limits} active={!!run?.active} act={act} /> : null}
						{msg ? <p className="fp-error" role="alert">{msg}</p> : null}
						{block ? <TalkPane t={t} lang={lang} block={block} said={said} docTables={docTables} shown={shown} name={name} who={who} threads={threads} send={send} /> : null}
					</>
				)}
			</section>
			<section className="fp-pane fp-pane--plan" aria-label={p.plan}>
				<h2>{p.plan} <HelpTip id="plan" lang={lang} label={p.plan} /></h2>
				{!snap ? <Skeleton label={p.loading} lines={6} /> : block && docTables.length ? (
					<>
						{docTables.length === 2 ? (
							<Choice label={p.tableView} tip="tableview" lang={lang} value={sideBySide ? "side" : shown} onChange={(e) => setTableSel(e.target.value as Table | "side")}>
								{docTables.map((x) => <option key={x} value={x}>{t.tableName(x)}{block.result?.table === x ? ` · ${t.isResult}` : ""}</option>)}
								<option value="side">{t.side}</option>
							</Choice>
						) : null}
						{result && (result.stat || result.compares.length) ? <OutcomePanel t={t} locale={locale} o={result} name={name} /> : null}
						<div className={sideBySide ? "docs docs--side" : "docs"}>
							{(sideBySide ? docTables : [shown]).map((x) => (
								<DocPane key={`${block.blockId}:${x}`} t={t} lang={lang} locale={locale} rid={rid} block={block} table={x} head={block.heads[x] ?? 0} titled={docTables.length === 2} resultVersion={resultOf(x)} objections={talkOf(x)?.objections ?? []} docKey={docKey} name={name} act={async (fn) => { await act(fn); }} />
							))}
						</div>
					</>
				) : <p className="fp-empty">{p.noPlan}</p>}
			</section>
			<nav className="fp-tabs" aria-label={p.panes}>
				{PANES.map((x) => (
					<a key={x} href={`#${x}`} aria-current={pane === x ? "page" : undefined} onClick={() => setPane(x)}>
						{p[x]}{x === "table" && forPerson ? <span className="fp-dot" aria-label={p.waitingTitle}>{forPerson}</span> : null}
					</a>
				))}
				<HelpTip id="panes" lang={lang} label={p.panes} />
			</nav>
		</main>
	);
}

/** Whether a phone's keyboard is open (the visual viewport well below the window): the bar at the bottom then gives way,
 *  and the field being written in is kept in sight above the keyboard (docs/forum-seite-plan-2026-11-26.en.md,
 *  section 10). */
function useKeyboard(): boolean {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const on = () => {
			const now = vv.height < window.innerHeight * 0.8;
			setOpen(now);
			const el = document.activeElement;
			if (now && el instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
				const box = el.getBoundingClientRect();
				if (box.bottom > vv.offsetTop + vv.height - 8 || box.top < vv.offsetTop) el.scrollIntoView({ block: "center" });
			}
		};
		vv.addEventListener("resize", on);
		return () => vv.removeEventListener("resize", on);
	}, []);
	return open;
}

/** The browser's permission to notify, asked on a person's click (starting a run), never on its own. */
function askToNotify(): void {
	try { if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission(); } catch { /* a browser without notifications */ }
}

/** While the room's page is open but not looked at, a new question to the person is announced by the browser, if the
 *  person allowed it. Nothing reaches a closed page (no Web Push). */
function useNotifyWhenAsked(forPerson: number, room: string, title: string): void {
	const [seen, setSeen] = useState(forPerson);
	useEffect(() => {
		if (forPerson > seen && document.hidden) {
			try { if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(`FORUM · ${room}`, { body: title, tag: `forum-${room}` }); } catch { /* a phone's browser that allows notifications only from a service worker */ }
		}
		if (forPerson !== seen) setSeen(forPerson);
	}, [forPerson, seen, room, title]);
}

/** A new plan task: the brief, the document's language, optionally an outline, criteria and documents to read. */
function NewTask({ lang, p, t, rid, open, act, onMade }: { lang: Lang; p: PageText; t: Text; rid: string; open: boolean; act: (fn: () => Promise<unknown>) => Promise<boolean>; onMade: (blockId: string) => void }) {
	const [brief, setBrief] = useState("");
	const [docLang, setDocLang] = useState<Lang>(lang);
	const [outline, setOutline] = useState("");
	const [criteria, setCriteria] = useState("");
	const [docs, setDocs] = useState<Array<{ name: string; text: string }>>([]);
	const addDocs = async (files: FileList | null) => {
		const read = await Promise.all([...(files ?? [])].map(async (f) => ({ name: f.name, text: await f.text() })));
		setDocs((cur) => [...cur.filter((d) => !read.some((x) => x.name === d.name)), ...read]);
	};
	const create = () => act(async () => {
		const r = await api<{ blockId: string }>(`/rooms/${rid}/task`, { brief, lang: docLang, outline, criteria, ...(docs.length ? { docs } : {}) });
		setBrief(""); setOutline(""); setCriteria(""); setDocs([]); onMade(r.blockId);
	});
	return (
		<details className="fp-fold" open={open}>
			<summary>{p.newTask}</summary>
			<Area label={t.brief} tip="brief" lang={lang} rows={5} maxLength={8000} value={brief} onChange={(e) => setBrief(e.target.value)} />
			<Choice label={t.docLang} tip="doclang" lang={lang} value={docLang} onChange={(e) => setDocLang(e.target.value as Lang)}><option value="de">Deutsch</option><option value="en">English</option></Choice>
			<Area label={t.outline} tip="outline" lang={lang} rows={3} value={outline} onChange={(e) => setOutline(e.target.value)} />
			<Area label={t.criteria} tip="criteria" lang={lang} rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
			<Field label={p.docs} tip="docs" lang={lang} type="file" multiple accept=".md,.markdown,.txt,.csv,.json,.yaml,.yml" onChange={(e) => { void addDocs(e.target.files); e.target.value = ""; }} />
			{docs.length ? (
				<ul className="fp-files">
					{docs.map((d) => <li key={d.name}><b>{d.name}</b> <span className="fp-meta">{(new Blob([d.text]).size / 1000).toFixed(1)} kB</span> <Act kind="danger" label={`${p.drop}: ${d.name}`} tip="docs" lang={lang} onClick={() => setDocs((cur) => cur.filter((x) => x.name !== d.name))}>{p.drop}</Act></li>)}
				</ul>
			) : null}
			{docs.length ? <p className="fp-meta">{t.sourceNote}</p> : null}
			{brief.trim() && brief.trim().length < 20 ? <p className="fp-meta">{p.briefShort}</p> : null}
			<Act kind="primary" label={t.create} tip="brief" lang={lang} disabled={brief.trim().length < 20} onClick={() => void create()} />
		</details>
	);
}

/** Starting a run on the task shown: the models at the table, the way of working, the rounds and the budget. */
function StartRun({ lang, p, t, rid, blockId, available, limits, active, act }: { lang: Lang; p: PageText; t: Text; rid: string; blockId: string; available: Array<{ id: string; label: string }>; limits: { minModels: number; maxModels: number; maxPerModel: number }; active: boolean; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [way, setWay] = useState<"both" | "parallel" | "turns">("both");
	const [rounds, setRounds] = useState(2);
	const [budget, setBudget] = useState("100000");
	const picked = available.filter((m) => chosen.has(m.label)).map((m) => m.label);
	const start = () => { askToNotify(); return act(() => api(`/rooms/${rid}/run`, { blockId, way, rounds, models: picked, perModel: 1, budgetTokens: budget || undefined })); };
	return (
		<details className="fp-fold">
			<summary>{p.startRun}</summary>
			{available.length ? (
				<>
					<fieldset className="fp-models">
						<legend>{t.pick(limits.minModels, limits.maxModels)}</legend>
						{available.map((m) => <Tick key={m.label} label={m.label} tip="models" lang={lang} checked={chosen.has(m.label)} disabled={!chosen.has(m.label) && picked.length >= limits.maxModels} onChange={(e) => setChosen((cur) => { const n = new Set(cur); if (e.target.checked) n.add(m.label); else n.delete(m.label); return n; })} />)}
					</fieldset>
					<Choice label={t.way} tip="way" lang={lang} value={way} onChange={(e) => setWay(e.target.value as "both" | "parallel" | "turns")}><option value="both">{t.wayBoth}</option><option value="parallel">{t.wayB}</option><option value="turns">{t.wayA}</option></Choice>
					<div className="fp-row">
						<Field label={t.rounds} tip="rounds" lang={lang} type="number" min={0} max={8} value={rounds} onChange={(e) => setRounds(Math.min(8, Math.max(0, Number(e.target.value) || 0)))} />
						<Field label={t.tokens} tip="budget" lang={lang} type="number" min={1000} step={1000} value={budget} onChange={(e) => setBudget(e.target.value)} />
					</div>
					{picked.length < limits.minModels ? <p className="fp-meta">{t.need(limits.minModels)}</p> : null}
				</>
			) : <p className="fp-empty">{p.noModels}</p>}
			<div className="fp-row">
				<Act kind="primary" label={t.start} tip="start" lang={lang} disabled={active || picked.length < limits.minModels} onClick={() => void start()} />
				<Act kind="danger" label={t.stop} tip="stop" lang={lang} disabled={!active} onClick={() => void act(() => api(`/rooms/${rid}/stop`, {}))} />
			</div>
		</details>
	);
}
