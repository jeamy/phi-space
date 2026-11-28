"use client";
// A room of the FORUM page (docs/forum-seite-plan-2026-11-26.en.md, sections 4 and 10): three panes, Files (the
// material of the task shown), Table (the tasks, the run, the discussion and the questions to the person) and Plan
// (the document with its versions, objections and ballots). Above 1100 px all three side by side; from 760 px Table and
// Plan, Files as a drawer; below, one pane with a bar of the three at the bottom. The pane shown is the address's hash
// (#files, #table, #plan), so a link can name it.
import { useEffect, useState } from "react";
import { HelpTip } from "../HelpTip.tsx";
import { api, firstLine } from "../lib/api.ts";
import type { RoomDefaults, Table, TaskPicture } from "../lib/forum-types.ts";
import { reducePicture, sendPicture } from "../lib/pictures.ts";
import { authHeaders } from "../lib/me.ts";
import type { Text } from "../lib/texts.ts";
import type { Lang } from "../lib/theme.ts";
import { useRoom } from "../lib/use-room.ts";
import { DocPane, OutcomePanel, RunPanel, TalkPane } from "../panes.tsx";
import { Act, Area, Choice, Field, Tick } from "./controls.tsx";
import { Skeleton, type RoomRow } from "./ForumPage.tsx";
import { SaveDocs } from "./SaveDocs.tsx";
import { Register } from "./Register.tsx";
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
			{!snap ? <Skeleton label={p.loading} /> : !block ? <p className="fp-empty">{p.noTaskFiles}</p> : <>{block.sources.length ? (
				<>
					<ul className="fp-files">
						{block.sources.map((x) => (
							<li key={x.sourceId}>
								<b>{x.kind === "repo" ? `${p.sourceRepo} ${x.name}` : x.kind === "files" ? `${p.sourceFiles}${x.tenant ? ` · ${x.tenant}` : ""}` : x.kind === "room" ? `${p.sourceRoom}: ${x.name}` : p.sourceDocs}</b>
								<span className="fp-meta">{p.filesN(x.files)}{x.texts !== undefined ? ` (${p.textsN(x.texts)})` : ""} · {(x.bytes / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} kB{x.commit ? ` · ${x.commit.slice(0, 12)}` : ""}</span>
							</li>
						))}
					</ul>
					{block.sources.some((x) => x.kind === "files") ? <WorkspaceFiles key={block.blockId} lang={lang} p={p} locale={locale} rid={rid} blockId={block.blockId} canWrite={canWrite} act={act} /> : null}
				</>
			) : <p className="fp-empty">{p.noSources}</p>}
			{snap.link && canWrite ? <UploadFiles lang={lang} p={p} rid={rid} act={act} /> : null}
			<TaskPictures key={`${block.blockId}-${block.images ?? 0}`} lang={lang} p={p} rid={rid} blockId={block.blockId} count={block.images ?? 0} canWrite={canWrite} act={act} />
			<Register lang={lang} p={p} rid={rid} canWrite={canWrite} act={act} stamp={`${snap.lines.length}:${snap.lines.at(-1)?.ts ?? 0}`} />
			</>}
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
								{blocks.map((b) => <option key={b.blockId} value={b.blockId}>{b.name ? `${b.name} · ` : ""}{firstLine(b.brief, 60)}</option>)}
							</Choice>
						) : null}
						{block ? (
							<div className="fp-brief">
								<p>{block.brief}</p>
								{block.criteria.length ? <ul>{block.criteria.map((c) => <li key={c}>{c}</li>)}</ul> : null}
							</div>
						) : <p className="fp-empty">{canWrite ? p.noTask : p.viewer}</p>}
						{!canWrite ? (block ? <p className="fp-meta">{p.viewer}</p> : null) : <NewTask lang={lang} p={p} t={t} rid={rid} open={!block} linked={!!snap.link} others={blocks.filter((b) => b.doc).map((b) => ({ blockId: b.blockId, label: `${b.name ?? firstLine(b.brief, 50)}${b.accepted ? ` · ${p.isAccepted(b.accepted.version)}` : ` · ${p.isDraft}`}` }))} act={act} onMade={(id) => { setFocus(id); setTableSel(null); }} />}
						{runHere ? <RunPanel t={t} locale={locale} runHere={runHere} table={table} answers={answers} /> : null}
						{canWrite && block ? <StartRun key={JSON.stringify(snap.defaults ?? {})} lang={lang} p={p} t={t} rid={rid} blockId={block.blockId} available={available} limits={limits} defaults={snap.defaults ?? {}} active={!!run?.active} act={act} /> : null}
						{(!login || row?.role === "owner") ? <RoomLinkForm lang={lang} p={p} rid={rid} act={act} /> : null}
						{(!login || row?.role === "owner") ? <RoomDefaultsForm lang={lang} p={p} t={t} rid={rid} available={available} defaults={snap.defaults ?? {}} act={act} /> : null}
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
						{snap.link && canWrite ? <SaveDocs lang={lang} p={p} t={t} rid={rid} blocks={blocks} block={block} folder={`${snap.link.project.workspace}/${snap.link.project.path || ""}`.replace(/\/$/, "")} /> : null}
						<div className={sideBySide ? "docs docs--side" : "docs"}>
							{(sideBySide ? docTables : [shown]).map((x) => (
								<DocPane key={`${block.blockId}:${x}`} t={t} lang={lang} locale={locale} rid={rid} block={block} table={x} head={block.heads[x] ?? 0} titled={docTables.length === 2} resultVersion={resultOf(x)} objections={talkOf(x)?.objections ?? []} docKey={docKey} name={name} act={async (fn) => { await act(fn); }} canEdit={canWrite} />
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

/** A new task: a plan or a document with its name, the brief, the document's language, optionally an outline,
 *  criteria, documents to read and the room's other documents. */
function NewTask({ lang, p, t, rid, open, linked, others, act, onMade }: { lang: Lang; p: PageText; t: Text; rid: string; open: boolean; linked: boolean; others: Array<{ blockId: string; label: string }>; act: (fn: () => Promise<unknown>) => Promise<boolean>; onMade: (blockId: string) => void }) {
	const [fromWs, setFromWs] = useState(true);
	const [kind, setKind] = useState<"plan" | "document">(others.length ? "document" : "plan");
	const [docName, setDocName] = useState("");
	const [reads, setReads] = useState<Set<string>>(new Set());
	const [brief, setBrief] = useState("");
	const [docLang, setDocLang] = useState<Lang>(lang);
	const [outline, setOutline] = useState("");
	const [criteria, setCriteria] = useState("");
	const [docs, setDocs] = useState<Array<{ name: string; text: string }>>([]);
	const [pics, setPics] = useState<File[]>([]);
	const addDocs = async (files: FileList | null) => {
		const read = await Promise.all([...(files ?? [])].map(async (f) => ({ name: f.name, text: await f.text() })));
		setDocs((cur) => [...cur.filter((d) => !read.some((x) => x.name === d.name)), ...read]);
	};
	const create = () => act(async () => {
		const r = await api<{ blockId: string }>(`/rooms/${rid}/task`, { brief, lang: docLang, outline, criteria, kind, ...(docName.trim() ? { name: docName.trim() } : {}), ...(reads.size ? { room: [...reads] } : {}), ...(docs.length ? { docs } : {}), ...(linked && fromWs ? { files: true } : {}) });
		setBrief(""); setOutline(""); setCriteria(""); setDocs([]); setDocName(""); setReads(new Set()); onMade(r.blockId);
		// the pictures go after the task is there, each as its reduced copy; one that fails is named, the others go on
		const failed: string[] = [];
		for (const f of pics) { try { await sendPicture(rid, r.blockId, f.name, await reducePicture(f)); } catch (e) { failed.push(`${f.name}: ${(e as Error).message}`); } }
		setPics([]);
		if (failed.length) throw new Error(`${p.pictureFailed} ${failed.join("; ")}`);
	});
	return (
		<details className="fp-fold" open={open}>
			<summary>{p.newTask}</summary>
			<div className="fp-row">
				<Choice label={p.taskKind} tip="taskkind" lang={lang} value={kind} onChange={(e) => setKind(e.target.value as "plan" | "document")}><option value="plan">{p.kindPlan}</option><option value="document">{p.kindDocument}</option></Choice>
				<Field label={p.docName} tip="taskkind" lang={lang} value={docName} maxLength={60} placeholder={kind === "document" ? p.docNameHint : "plan"} onChange={(e) => setDocName(e.target.value)} />
			</div>
			{others.length ? (
				<fieldset className="fp-folder">
					<legend>{p.readRoom} <HelpTip id="roomdocs" lang={lang} label={p.readRoom} /></legend>
					{others.map((o) => <Tick key={o.blockId} label={o.label} tip="roomdocs" lang={lang} checked={reads.has(o.blockId)} onChange={(e) => setReads((cur) => { const n = new Set(cur); if (e.target.checked) n.add(o.blockId); else n.delete(o.blockId); return n; })} />)}
				</fieldset>
			) : null}
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
			<Field label={p.addPictures} tip="pictures" lang={lang} type="file" multiple accept="image/*" onChange={(e) => { const got = [...(e.target.files ?? [])]; setPics((cur) => [...cur, ...got].slice(0, 12)); e.target.value = ""; }} />
			{pics.length ? (
				<ul className="fp-files">
					{pics.map((f, i) => <li key={`${f.name}-${i}`}><b>{f.name}</b> <Act kind="danger" label={`${p.drop}: ${f.name}`} tip="pictures" lang={lang} onClick={() => setPics((cur) => cur.filter((_x, j) => j !== i))}>{p.drop}</Act></li>)}
				</ul>
			) : null}
			{pics.length ? <p className="fp-meta">{p.picturesGo}</p> : null}
			{linked ? <Tick label={p.fromWorkspace} tip="fromworkspace" lang={lang} checked={fromWs} onChange={(e) => setFromWs(e.target.checked)} /> : null}
			{docs.length || (linked && fromWs) ? <p className="fp-meta">{t.sourceNote}</p> : null}
			{brief.trim() && brief.trim().length < 20 ? <p className="fp-meta">{p.briefShort}</p> : null}
			<Act kind="primary" label={t.create} tip="brief" lang={lang} disabled={brief.trim().length < 20 || (kind === "document" && !docName.trim())} onClick={() => void create()} />
		</details>
	);
}

/** Starting a run on the task shown: the models at the table, the way of working, the rounds and the budget. */
function StartRun({ lang, p, t, rid, blockId, available, limits, defaults, active, act }: { lang: Lang; p: PageText; t: Text; rid: string; blockId: string; available: Array<{ id: string; label: string }>; limits: { minModels: number; maxModels: number; maxPerModel: number; visitorTokens: number }; defaults: RoomDefaults; active: boolean; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
	// the room's defaults come first, the page's own otherwise; a member's budget is held to the room's and the largest one
	const [chosen, setChosen] = useState<Set<string>>(new Set(defaults.models ?? []));
	const [way, setWay] = useState<"both" | "parallel" | "turns">(defaults.way ?? "both");
	const [rounds, setRounds] = useState(defaults.rounds ?? 2);
	const most = Math.min(...[limits.visitorTokens, defaults.budgetTokens ?? 0].filter((x) => x > 0), Infinity);
	const [budget, setBudget] = useState(String(defaults.budgetTokens ?? Math.min(100_000, most)));
	const picked = available.filter((m) => chosen.has(m.label)).map((m) => m.label);
	const start = () => { askToNotify(); return act(() => api(`/rooms/${rid}/run`, { blockId, way, rounds, models: picked, perModel: defaults.perModel ?? 1, budgetTokens: budget || undefined })); };
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
						<Field label={t.tokens} tip="budget" lang={lang} type="number" min={1000} step={1000} max={Number.isFinite(most) ? most : undefined} value={budget} onChange={(e) => setBudget(e.target.value)} />
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

/** The room's defaults for a run, set by its owner within the operator's ceilings (server/settings.ts): the models, the
 *  way, the rounds, agents per model, the budget (also the most a member's run may ask for) and how long the table waits
 *  for the person. */
function RoomDefaultsForm({ lang, p, t, rid, available, defaults, act }: { lang: Lang; p: PageText; t: Text; rid: string; available: Array<{ id: string; label: string }>; defaults: RoomDefaults; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
	const [models, setModels] = useState<Set<string>>(new Set(defaults.models ?? []));
	const [way, setWay] = useState<string>(defaults.way ?? "");
	const [rounds, setRounds] = useState(defaults.rounds === undefined ? "" : String(defaults.rounds));
	const [perModel, setPerModel] = useState(defaults.perModel === undefined ? "" : String(defaults.perModel));
	const [budget, setBudget] = useState(defaults.budgetTokens === undefined ? "" : String(defaults.budgetTokens));
	const [wait, setWait] = useState(defaults.personWaitS === undefined ? "" : String(defaults.personWaitS));
	const [onAccept, setOnAccept] = useState(!!defaults.saveOnAccept);
	const [ceil, setCeil] = useState<{ runBudgetTokens: number; personWaitS: number } | null>(null);
	const [saved, setSaved] = useState(false);
	const load = () => api<{ ceilings: { runBudgetTokens: number; personWaitS: number } }>(`/rooms/${rid}/settings`).then((x) => setCeil(x.ceilings)).catch(() => {});
	const num = (v: string) => (v === "" ? undefined : Number(v));
	const save = () => act(async () => {
		setSaved(false);
		await api(`/rooms/${rid}/settings`, { models: [...models], way: way || undefined, rounds: num(rounds), perModel: num(perModel), budgetTokens: num(budget), personWaitS: num(wait), saveOnAccept: onAccept });
		setSaved(true);
	});
	return (
		<details className="fp-fold" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !ceil) void load(); }}>
			<summary>{p.roomDefaults}</summary>
			<p className="fp-meta">{p.roomDefaultsText}</p>
			{available.length ? (
				<fieldset className="fp-models">
					<legend>{p.models}</legend>
					{available.map((m) => <Tick key={m.label} label={m.label} tip="roomdefaults" lang={lang} checked={models.has(m.label)} onChange={(e) => setModels((cur) => { const n = new Set(cur); if (e.target.checked) n.add(m.label); else n.delete(m.label); return n; })} />)}
				</fieldset>
			) : null}
			<Choice label={t.way} tip="roomdefaults" lang={lang} value={way} onChange={(e) => setWay(e.target.value)}><option value="">{p.noDefault}</option><option value="both">{t.wayBoth}</option><option value="parallel">{t.wayB}</option><option value="turns">{t.wayA}</option></Choice>
			<div className="fp-row">
				<Field label={t.rounds} tip="roomdefaults" lang={lang} type="number" min={0} max={8} value={rounds} onChange={(e) => setRounds(e.target.value)} />
				<Field label={p.perModel} tip="roomdefaults" lang={lang} type="number" min={1} max={3} value={perModel} onChange={(e) => setPerModel(e.target.value)} />
			</div>
			<div className="fp-row">
				<Field label={t.tokens} tip="roomdefaults" lang={lang} type="number" min={1000} step={1000} max={ceil?.runBudgetTokens || undefined} value={budget} onChange={(e) => setBudget(e.target.value)} />
				<Field label={p.personWait} tip="roomdefaults" lang={lang} type="number" min={0} max={ceil?.personWaitS} value={wait} onChange={(e) => setWait(e.target.value)} />
			</div>
			<Tick label={p.saveOnAccept} tip="saveonaccept" lang={lang} checked={onAccept} onChange={(e) => setOnAccept(e.target.checked)} />
			{ceil ? <p className="fp-meta">{p.ceilings(ceil.runBudgetTokens, ceil.personWaitS)}</p> : null}
			<Act kind="primary" label={p.saveDefaults} tip="roomdefaults" lang={lang} onClick={() => void save()} />
			{saved ? <p className="fp-meta" role="status">{p.saved}</p> : null}
		</details>
	);
}

/** The files of a task's copy of the workspace (server/files.ts): every file with its size, the ones not copied as
 *  text with their kind; a picture shown as it is in the workspace now, a file without text with the note a member
 *  writes for the models. */
function WorkspaceFiles({ lang, p, locale, rid, blockId, canWrite, act }: { lang: Lang; p: PageText; locale: string; rid: string; blockId: string; canWrite: boolean; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
	type F = { path: string; size: number; kind: string; readable: boolean; note?: string };
	const [files, setFiles] = useState<F[] | null>(null);
	const load = () => api<{ files: F[] }>(`/rooms/${rid}/files/${blockId}`).then((x) => setFiles(x.files)).catch(() => setFiles([]));
	useEffect(() => { void load(); }, [rid, blockId]);
	const picture = (f: F) => ["png", "jpeg", "gif", "webp"].includes(f.kind) || (f.kind === "text" && /\.svg$/i.test(f.path));
	return (
		<details className="fp-fold" open>
			<summary>{p.filesOf} <HelpTip id="workspacefiles" lang={lang} label={p.filesOf} /></summary>
			{files === null ? <Skeleton label={p.loading} /> : (
				<ul className="fp-files fp-wsfiles">
					{files.map((f, i) => (
						<li key={f.path}>
							<span className="fp-path">{f.path}</span>
							<span className="fp-meta">{f.size < 1000 ? `${f.size} B` : `${(f.size / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} kB`}{f.kind === "text" ? "" : ` · ${f.kind}${f.readable ? "" : ` · ${p.notText}`}`}</span>
							{picture(f) && i < 400 ? <img className="fp-wspic" src={`/api/rooms/${rid}/preview?path=${encodeURIComponent(f.path)}`} alt={f.path} loading="lazy" /> : null}
							{!f.readable ? <FileNoteForm key={f.note ?? ""} lang={lang} p={p} rid={rid} f={f} canWrite={canWrite} act={act} reload={load} /> : null}
						</li>
					))}
				</ul>
			)}
		</details>
	);
}

/** The note on a file the models cannot read, by a member: they get it with the file's name, kind and size. */
function FileNoteForm({ lang, p, rid, f, canWrite, act, reload }: { lang: Lang; p: PageText; rid: string; f: { path: string; note?: string }; canWrite: boolean; act: (fn: () => Promise<unknown>) => Promise<boolean>; reload: () => Promise<unknown> }) {
	const [text, setText] = useState(f.note ?? "");
	if (!canWrite) return f.note ? <p className="fp-meta">{p.fileNote}: {f.note}</p> : null;
	return (
		<div className="fp-filenote">
			<Field label={`${p.fileNote}: ${f.path}`} tip="filenote" lang={lang} maxLength={1000} value={text} placeholder={p.fileNoteHint} onChange={(e) => setText(e.target.value)} />
			<Act label={p.saveNote} tip="filenote" lang={lang} disabled={text === (f.note ?? "")} onClick={() => void act(async () => { await api(`/rooms/${rid}/filenote`, { path: f.path, text }); await reload(); })} />
		</div>
	);
}

/** Files of a member into `material/` of the room's project folder (server/files.ts): chosen, or dropped onto the
 *  part on a desk. A later task's copy has them. */
function UploadFiles({ lang, p, rid, act }: { lang: Lang; p: PageText; rid: string; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState<string[]>([]);
	const send = (files: File[]) => act(async () => {
		setBusy(true);
		try { for (const f of files.slice(0, 20)) { const r = await sendFile(rid, f); setDone((cur) => [...cur, r]); } }
		finally { setBusy(false); }
	});
	return (
		<details className="fp-fold">
			<summary>{p.upload} <HelpTip id="upload" lang={lang} label={p.upload} /></summary>
			<div className="fp-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void send([...e.dataTransfer.files]); }}>
				<Field label={p.uploadPick} tip="upload" lang={lang} type="file" multiple disabled={busy} onChange={(e) => { const got = [...(e.target.files ?? [])]; e.target.value = ""; void send(got); }} />
				<p className="fp-meta">{busy ? p.uploading : p.uploadNote}</p>
			</div>
			{done.length ? <ul className="fp-files">{done.map((x) => <li key={x}><span className="fp-path">{x}</span></li>)}</ul> : null}
		</details>
	);
}

/** Sends one file to the project folder; the ID is drawn once, so a second try after a lost reply is one file. */
async function sendFile(rid: string, f: File): Promise<string> {
	const id = `u${crypto.getRandomValues(new Uint32Array(3)).reduce((s, n) => s + n.toString(36), "")}`.slice(0, 24).padEnd(12, "0");
	for (let attempt = 0; ; attempt++) {
		try {
			const r = await fetch(`/api/rooms/${rid}/upload?id=${id}&name=${encodeURIComponent(f.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-forum-admin": "1", ...authHeaders() }, body: f });
			const data = (await r.json().catch(() => ({}))) as { error?: string; upload?: { workspace: string; path: string; kind: string } };
			if (!r.ok) throw Object.assign(new Error(`${f.name}: ${data.error || r.statusText}`), { final: true });
			return `${data.upload!.workspace}/${data.upload!.path} (${data.upload!.kind})`;
		} catch (e) {
			if ((e as { final?: boolean }).final || attempt >= 2) throw e;
			await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1)));
		}
	}
}

/** The task's pictures for the models (server/images.ts): each shown with its description, which a member corrects;
 *  a member adds more (reduced in the browser first) or removes one. */
function TaskPictures({ lang, p, rid, blockId, count, canWrite, act }: { lang: Lang; p: PageText; rid: string; blockId: string; count: number; canWrite: boolean; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
	const [pics, setPics] = useState<TaskPicture[] | null>(count ? null : []);
	const [busy, setBusy] = useState(false);
	const load = () => api<{ images: TaskPicture[] }>(`/rooms/${rid}/images/${blockId}`).then((x) => setPics(x.images)).catch(() => setPics([]));
	useEffect(() => { if (count) void load(); }, [rid, blockId, count]);
	const add = (files: File[]) => act(async () => {
		setBusy(true);
		try { for (const f of files.slice(0, 12)) await sendPicture(rid, blockId, f.name, await reducePicture(f)); }
		finally { setBusy(false); await load(); }
	});
	return (
		<details className="fp-fold" open={count > 0}>
			<summary>{p.pictures}{count ? ` (${count})` : ""} <HelpTip id="pictures" lang={lang} label={p.pictures} /></summary>
			{pics === null ? <Skeleton label={p.loading} /> : pics.length ? (
				<ul className="fp-pics">
					{pics.map((x) => <Picture key={x.imageId + (x.note?.ts ?? 0)} lang={lang} p={p} rid={rid} x={x} canWrite={canWrite} act={act} reload={load} />)}
				</ul>
			) : <p className="fp-empty">{p.noPictures}</p>}
			{canWrite ? (
				<>
					<Field label={p.addPictures} tip="pictures" lang={lang} type="file" multiple accept="image/*" disabled={busy} onChange={(e) => { const got = [...(e.target.files ?? [])]; e.target.value = ""; void add(got); }} />
					<p className="fp-meta">{busy ? p.reducing : p.picturesGo}</p>
				</>
			) : null}
		</details>
	);
}

/** One picture: the reduced copy, its size, the description that counts (by which model or person) and its correction. */
function Picture({ lang, p, rid, x, canWrite, act, reload }: { lang: Lang; p: PageText; rid: string; x: TaskPicture; canWrite: boolean; act: (fn: () => Promise<unknown>) => Promise<boolean>; reload: () => Promise<unknown> }) {
	const [text, setText] = useState(x.note?.text ?? "");
	const base = `/rooms/${rid}/images/${x.blockId}/${x.imageId}`;
	return (
		<li className="fp-pic">
			<img src={`/api${base}`} alt={x.note?.text ?? x.name} width={x.width} height={x.height} loading="lazy" />
			<div>
				<b>{x.name}</b> <span className="fp-meta">{x.width} × {x.height} · {Math.ceil(x.bytes / 1000)} kB</span>
				<p className="fp-meta">{x.note ? p.describedBy(x.note.by) : p.notDescribed}</p>
				{canWrite ? (
					<>
						<Area label={p.pictureNote} tip="picturenote" lang={lang} rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
						<div className="fp-row">
							<Act label={p.saveNote} tip="picturenote" lang={lang} disabled={!text.trim() || text === (x.note?.text ?? "")} onClick={() => void act(async () => { await api(`${base}/note`, { text }); await reload(); })} />
							<Act kind="danger" label={`${p.removePicture}: ${x.name}`} tip="pictures" lang={lang} onClick={() => void act(async () => { await api(`${base}/remove`, {}); await reload(); })}>{p.removePicture}</Act>
						</div>
					</>
				) : x.note ? <p>{x.note.text}</p> : null}
			</div>
		</li>
	);
}

type FolderIn = { workspace: string; path: string };
type LinkState = { agent: string; files: { tenant: string; host: string } | null; link: { read: FolderIn | null; project: FolderIn } | null };

/** The room's link to folders in spaces-files, for its owner (server/files.ts): the agent's name and the steps, the two
 *  folders, check, link and unlink. */
function RoomLinkForm({ lang, p, rid, act }: { lang: Lang; p: PageText; rid: string; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
	const [st, setSt] = useState<LinkState | null>(null);
	const [read, setRead] = useState<FolderIn>({ workspace: "", path: "" });
	const [project, setProject] = useState<FolderIn>({ workspace: "", path: "" });
	const [seen, setSeen] = useState<string[] | null>(null);
	const load = () => api<LinkState>(`/rooms/${rid}/link`).then((x) => {
		setSt(x);
		if (x.link) { setRead(x.link.read ?? { workspace: "", path: "" }); setProject(x.link.project); }
	}).catch(() => {});
	const body = () => ({ ...(read.workspace.trim() ? { read } : {}), ...(project.workspace.trim() ? { project } : {}) });
	const run = (action: "check" | "link" | "unlink") => act(async () => {
		const r = await api<{ check?: { workspaces: string[] }; link: LinkState["link"] }>(`/rooms/${rid}/link`, { action, ...(action === "unlink" ? {} : body()) });
		if (r.check) setSeen(r.check.workspaces);
		setSt((cur) => (cur ? { ...cur, link: r.link } : cur));
	});
	const name = (f: FolderIn) => (f.path ? `${f.workspace}/${f.path}` : f.workspace);
	const folder = (label: string, v: FolderIn, set: (f: FolderIn) => void) => (
		<fieldset className="fp-folder">
			<legend>{label}</legend>
			<div className="fp-row">
				<Field label={p.wsName} tip="folders" lang={lang} value={v.workspace} maxLength={120} list={`fp-ws-${rid}`} onChange={(e) => set({ ...v, workspace: e.target.value })} />
				<Field label={p.folderPath} tip="folders" lang={lang} value={v.path} maxLength={400} onChange={(e) => set({ ...v, path: e.target.value })} />
			</div>
		</fieldset>
	);
	return (
		<details className="fp-fold" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !st) void load(); }}>
			<summary>{p.workspace} <HelpTip id="roomlink" lang={lang} label={p.workspace} /></summary>
			{!st ? <Skeleton label={p.loading} /> : !st.files ? <p className="fp-empty">{p.noFiles}</p> : (
				<>
					<p className="fp-meta">{p.linkIntro}</p>
					<ol className="fp-meta fp-steps">{p.linkSteps(st.agent, st.files.host, st.files.tenant).map((x) => <li key={x}>{x}</li>)}</ol>
					{st.link ? <p role="status">{p.linked(st.link.read ? name(st.link.read) : null, name(st.link.project))}</p> : null}
					{folder(p.readFolder, read, setRead)}
					{folder(p.projectFolder, project, setProject)}
					<datalist id={`fp-ws-${rid}`}>{(seen ?? []).map((w) => <option key={w} value={w} />)}</datalist>
					{seen ? <p className="fp-meta" role="status">{p.sees(seen)}</p> : null}
					<p className="fp-meta">{p.excerpts}</p>
					<div className="fp-row">
						<Act label={p.check} tip="linkcheck" lang={lang} onClick={() => void run("check")} />
						<Act kind="primary" label={p.link} tip="roomlink" lang={lang} disabled={!project.workspace.trim()} onClick={() => void run("link")} />
						<Act kind="danger" label={p.unlink} tip="roomlink" lang={lang} disabled={!st.link} onClick={() => void run("unlink")} />
					</div>
				</>
			)}
		</details>
	);
}
