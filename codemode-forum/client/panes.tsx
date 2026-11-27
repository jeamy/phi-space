"use client";
// The panes the page and the expert view share: a table's document with its versions, differences, objections and
// the person's yes and no; the comparison of the two tables; the standings of the ways of working.
import { useEffect, useMemo, useState } from "react";
import { api } from "./lib/api.ts";
import { diffCount, diffText, withContext, type Line } from "./lib/diff.ts";
import { Act, Choice, Field } from "./forum/controls.tsx";
import type { Answer, Block, Message, Objection, Outcome, PlanView, RunInfo, Snapshot, Table, Talk } from "./lib/forum-types.ts";
import type { Lang } from "./lib/theme.ts";
import { renderSection } from "./lib/safe-markdown.ts";
import type { Named, Text } from "./lib/texts.ts";

/** One table's document: a version of it, optionally as the difference to another version, with the objections beside
 *  their sections, the checker's findings, and the person's yes and no. */
export function DocPane({ t, lang, locale, rid, block, table, head, titled, resultVersion, objections, docKey, name, act }: { t: Text; lang: Lang; locale: string; rid: string; block: Block; table: Table; head: number; titled: boolean; resultVersion: number; objections: Objection[]; docKey: string; name: Named; act: (fn: () => Promise<unknown>) => Promise<void> }) {
	const [version, setVersion] = useState<number | null>(null); // the version shown; null: the result, else the newest
	const [against, setAgainst] = useState<"" | "prev" | number>(""); // the version it is compared with
	const [view, setView] = useState<PlanView | null>(null);
	const [base, setBase] = useState<PlanView | null>(null);
	const [objSection, setObjSection] = useState("");
	const [objText, setObjText] = useState("");
	const want = version || resultVersion || 0;
	// the texts are fetched when the version asked for, the newest version or the state of the work changes
	useEffect(() => {
		if (!head) { setView(null); return; }
		let dead = false;
		api<PlanView>(`/rooms/${rid}/plan/${block.blockId}?table=${table}${want ? `&version=${want}` : ""}`).then((x) => { if (!dead) setView(x); }).catch(() => {});
		return () => { dead = true; };
	}, [rid, block.blockId, table, head, want, docKey]);
	const shownVersion = view?.doc.version ?? 0;
	const baseVersion = !shownVersion || against === "" ? 0 : against === "prev" ? shownVersion - 1 : against === shownVersion ? 0 : against;
	useEffect(() => {
		if (!baseVersion) { setBase(null); return; }
		let dead = false;
		api<PlanView>(`/rooms/${rid}/plan/${block.blockId}?table=${table}&version=${baseVersion}`).then((x) => { if (!dead) setBase(x); }).catch(() => {});
		return () => { dead = true; };
	}, [rid, block.blockId, table, baseVersion]);

	const sections = useMemo(() => (view?.doc.sections ?? []).map((s) => ({ ...s, html: renderSection(s.text) })), [view]);
	// the difference to the other version, section by section: what a section was there, and what is gone
	const delta = useMemo(() => {
		if (!view || !base || base.doc.version !== baseVersion) return null;
		const old = new Map(base.doc.sections.map((s) => [s.sectionId, s]));
		const by = new Map(view.doc.sections.map((s): [string, { kind: "new" | "same" | "changed"; lines: Line[] }] => {
			const was = old.get(s.sectionId);
			if (!was) return [s.sectionId, { kind: "new", lines: diffText("", s.text) }];
			if (was.hash === s.hash) return [s.sectionId, { kind: "same", lines: [] }];
			return [s.sectionId, { kind: "changed", lines: diffText(was.title === s.title ? was.text : `# ${was.title}\n${was.text}`, was.title === s.title ? s.text : `# ${s.title}\n${s.text}`) }];
		}));
		return { by, removed: base.doc.sections.filter((s) => !view.doc.sections.some((x) => x.sectionId === s.sectionId)) };
	}, [view, base, baseVersion]);

	const acceptNow = () => act(() => api(`/rooms/${rid}/accept`, { blockId: block.blockId, version: view?.doc.version, table }));
	const objectNow = () => act(async () => { await api(`/rooms/${rid}/objection`, { blockId: block.blockId, table, section: objSection || view?.doc.sections[0]?.sectionId, text: objText }); setObjText(""); });
	const standing = (o: Objection) => o.state === "open" || o.state === "declined";
	const isResultTable = (block.result?.table ?? block.table) === table;

	return (
		<div className="panel">
			<h2>{t.doc}{titled ? ` · ${t.tableName(table)}` : ""}{block.result?.table === table ? ` · ${t.isResult}` : ""}</h2>
			{head && view && view.blockId === block.blockId ? (
				<>
					<div className="runline">
						<Choice label={t.version} tip="version" lang={lang} value={version ?? ""} onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : null)}>
							<option value="">{resultVersion ? `${t.isResult} (${resultVersion})` : `${t.newest} (${head})`}</option>
							{[...view.versions].reverse().map((v) => <option key={v.version} value={v.version}>{v.version} · {name(v.model)}</option>)}
						</Choice>
						{view.versions.length > 1 ? (
							<>
								<Choice label={t.compareWith} tip="compare" lang={lang} value={against} onChange={(e) => setAgainst(e.target.value === "" ? "" : e.target.value === "prev" ? "prev" : Number(e.target.value))}>
									<option value="">{t.noCompare}</option>
									{shownVersion > 1 ? <option value="prev">{t.previous} ({shownVersion - 1})</option> : null}
									{[...view.versions].reverse().filter((v) => v.version !== shownVersion).map((v) => <option key={v.version} value={v.version}>{v.version} · {name(v.model)}</option>)}
								</Choice>
							</>
						) : null}
						<span className="pill">{(view.doc.bytes / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} kB</span>
						<span className={"chip " + (view.check ? (view.check.ok ? "chip--ok" : "chip--bad") : "chip--wait")}>{view.check ? (view.check.ok ? t.checkOk : t.checkBad(view.check.failures.length)) : t.unchecked}</span>
						{block.accepted && block.table === table ? <span className="chip chip--best">{t.acceptedBy(block.accepted.version, block.accepted.by === "person" ? t.byPerson(block.accepted.who ?? "") : t.byMajority(block.accepted.approvals.length, block.accepted.of))}</span> : null}
						{isResultTable ? <a className="toplink" href={`/api/plan/${rid}/${block.blockId}.md`} target="_blank" rel="noreferrer">{t.exportIt}</a> : null}
						<a className="toplink" href={`/api/rooms/${rid}/plan/${block.blockId}.md?table=${table}&version=${view.doc.version}&plain=1`} target="_blank" rel="noreferrer">{t.thisVersion}</a>
					</div>
					{view.check && !view.check.ok ? (
						<details className="findings" open>
							<summary>{t.found}</summary>
							<ul>{view.check.failures.map((f, i) => <li key={i}><b>{view.doc.sections.find((x) => x.sectionId === f.sectionId)?.title ?? t.whole}:</b> {f.text}</li>)}</ul>
						</details>
					) : null}
					<div className="row">
						<Act label={t.acceptIt} tip="accept" lang={lang} onClick={() => void acceptNow()} />
					</div>
					<div className="row">
						<Choice label={t.objSection} tip="object" lang={lang} value={objSection} onChange={(e) => setObjSection(e.target.value)}>{view.doc.sections.map((x) => <option key={x.sectionId} value={x.sectionId}>{x.title}</option>)}</Choice>
						<Field className="wide" label={t.objectPh} quiet tip="object" lang={lang} maxLength={600} placeholder={t.objectPh} value={objText} onChange={(e) => setObjText(e.target.value)} />
						<Act label={t.objectTo} tip="object" lang={lang} disabled={!objText.trim()} onClick={() => void objectNow()} />
					</div>
					<article className="doc">
						{sections.map((s) => {
							const d = delta?.by.get(s.sectionId), mine = objections.filter((o) => o.sectionId === s.sectionId), settled = mine.filter((o) => !standing(o) && o.state !== "note").length;
							const marked = d ? d.kind !== "same" : view.doc.changed.includes(s.sectionId), n = d ? diffCount(d.lines) : null;
							return (
								<section key={s.sectionId} className={marked ? "doc__section is-changed" : "doc__section"}>
									<h3>{s.title} <span className="muted">{t.rev} {s.rev} · {name(s.model)}{d ? ` · ${d.kind === "same" ? t.unchanged : d.kind === "new" ? t.newSection : t.linesChanged(n!.del, n!.add)}` : view.doc.changed.includes(s.sectionId) ? ` · ${t.changed}` : ""}</span></h3>
									{s.origin ? <p className="muted doc__origin">{t.origin} {s.origin}</p> : null}
									{mine.filter(standing).map((o) => <div key={o.objId} className="doc__objection"><span className={"chip " + (o.state === "open" ? "chip--wait" : "chip--bad")}>{t.objStates[o.state]}</span> <b>{o.model === "human" ? t.you : name(o.model)}</b> {o.defect} <span className="muted">{t.fix}: {o.fix}</span></div>)}
									{settled ? <div className="muted doc__settled">{t.settled(settled)}</div> : null}
									{d ? (d.kind === "same" ? null : <DiffLines t={t} lines={d.lines} />) : s.rev === 1 ? <p className="muted">{t.intent} {s.text}</p> : <div dangerouslySetInnerHTML={{ __html: s.html }} />}
								</section>
							);
						})}
						{(delta?.removed ?? []).map((s) => (
							<section key={s.sectionId} className="doc__section is-changed">
								<h3>{s.title} <span className="muted">{t.removedSection}</span></h3>
								<DiffLines t={t} lines={diffText(s.text, "")} />
							</section>
						))}
					</article>
				</>
			) : <div className="empty">{t.noDoc}</div>}
		</div>
	);
}

/** The lines of a difference: removed and added lines marked, the words that differ inside a changed line marked
 *  again, long unchanged stretches cut. The text is shown as text, never as HTML. */
export function DiffLines({ t, lines }: { t: Text; lines: Line[] }) {
	return (
		<pre className="diff">
			{withContext(lines).map((l, i) => (l.op === "gap" ? <span key={i} className="diff__gap">{t.gap(l.count)}{"\n"}</span> : (
				<span key={i} className={l.op === "same" ? "diff__same" : l.op === "del" ? "diff__del" : "diff__add"}>
					{l.op === "same" ? "  " : l.op === "del" ? "− " : "+ "}
					{l.words ? l.words.map((w, k) => (w.op === "same" ? w.text : <mark key={k}>{w.text}</mark>)) : l.text}{"\n"}
				</span>
			)))}
		</pre>
	);
}

/** How the run with both tables went: the result and why, each table in numbers, and every model's blind comparison. */
export function OutcomePanel({ t, locale, o, name }: { t: Text; locale: string; o: Outcome; name: Named }) {
	return (
		<div className="panel">
			<h2>{t.outcome}</h2>
			{o.chosen ? <div className="runline"><span className="pill pill--accent">{t.resultIs(o.chosen.table, o.chosen.version)}</span><span className="pill">{t.chosenHow[o.chosen.how]}</span></div> : null}
			{o.stat ? (
				<table className="stats">
					<thead><tr><th>{t.statTable}</th><th>{t.statRounds}</th><th>{t.statTokens}</th><th>{t.statCost}</th><th>{t.statAgreed}</th><th>{t.statApprovals}</th><th>{t.statBase}</th></tr></thead>
					<tbody>
						{(["A", "B"] as const).map((x) => { const s = o.stat!.tables[x]; return s ? <tr key={x}><td>{x}</td><td>{s.rounds}</td><td>{s.tokens.toLocaleString(locale)}</td><td>{s.costUsd ? `$${s.costUsd.toFixed(4)}` : "–"}</td><td>{s.accepted ? t.yes : t.no}</td><td>{s.approvals}</td><td>{o.stat!.base === x ? `✓${o.stat!.prefer ? ` (${o.stat!.prefer[x]} / ${o.stat!.prefer.A + o.stat!.prefer.B})` : ""}` : ""}</td></tr> : null; })}
					</tbody>
				</table>
			) : null}
			{o.stat?.final ? <div className="fieldlabel">{t.finalIs(o.stat.final.agreed, o.stat.final.points, o.stat.final.accepted)}</div> : null}
			{o.compares.map((c) => (
				<details key={c.model} className="compare">
					<summary><b>{name(c.model)}</b> {t.prefers(c.prefer)}</summary>
					<ul>
						{c.criteria.map((k) => <li key={k.n}><span className="chip">{k.n}: {t.tableName(k.prefer)}</span> {k.text}</li>)}
						{c.points.map((p, i) => <li key={`p${i}`}><span className="chip chip--ok">{t.better(p.table)}</span> {p.text} <span className="muted">„{p.fromTitle}“ → „{p.intoTitle}“</span></li>)}
					</ul>
				</details>
			))}
		</div>
	);
}

/** Over all runs with both tables: how often each way of working supplied the base of the result, and what it used. */
export function StandingsPanel({ t, locale, s }: { t: Text; locale: string; s: NonNullable<Snapshot["standings"]> }) {
	return (
		<div className="panel">
			<h2>{t.standingsTitle}</h2>
			<div className="fieldlabel">{t.standingsLead(s.runs)}</div>
			<table className="stats">
				<thead><tr><th>{t.way}</th><th>{t.timesBase}</th><th>{t.tokensAll}</th></tr></thead>
				<tbody>
					<tr><td>{t.wayA}</td><td>{s.A}</td><td>{(s.tokens?.A ?? 0).toLocaleString(locale)}</td></tr>
					<tr><td>{t.wayB}</td><td>{s.B}</td><td>{(s.tokens?.B ?? 0).toLocaleString(locale)}</td></tr>
				</tbody>
			</table>
		</div>
	);
}

/** The discussion at a table: its decisions, how the models understand the brief, the ballots, the objections and every
 *  thread, a question to the person with the field for the answer, and the field to say something to the table. */
export function TalkPane({ t, lang, block, said, docTables, shown, name, who, threads, send }: { t: Text; lang: Lang; block: Block; said: Talk | null; docTables: readonly Table[]; shown: Table; name: Named; who: (m: { model: string; author: string }) => string; threads: Message[]; send: (text: string, thread?: string) => Promise<boolean> }) {
	const [say, setSay] = useState("");
	const [drafts, setDrafts] = useState<Record<string, string>>({}); // drafts of answers, by the question's id
	const answer = async (thread?: string) => {
		if (!(await send(thread ? drafts[thread] ?? "" : say, thread))) return;
		if (thread) setDrafts((cur) => { const { [thread]: _sent, ...rest } = cur; return rest; }); else setSay("");
	};
	return (
		<div className="panel">
			<h2>{t.talk}{docTables.length === 2 ? ` · ${t.tableName(shown)}` : ""}</h2>
			{said && (said.messages.length || said.decisions.length || said.objections.length || said.ballots.length) ? (
				<div className="talk">
					{said.decisions.map((x) => <div key={x.thread} className="talk__decision"><b>{t.decided}</b> {x.text} <span className="muted">({t.agreed(x.agreed.length, x.of)})</span></div>)}
					{said.messages.some((m) => m.kind === "understanding") ? (
						<details>
							<summary>{t.understandings}</summary>
							{said.messages.filter((m) => m.kind === "understanding").map((m) => <div key={m.msgId} className="msg"><b>{who(m)}</b>{m.text}</div>)}
						</details>
					) : null}
					{said.ballots.length ? (
						<details open>
							<summary>{t.ballots}</summary>
							{[...new Set(said.ballots.map((b) => `${b.round}:${b.version}`))].map((rv) => { const n = Number(rv.split(":")[0]), v = Number(rv.split(":")[1]); return (
								<div key={rv} className="msg"><b>{t.roundN(n)} · {t.version} {v}</b>{said.ballots.filter((b) => b.round === n && b.version === v).map((b) => <span key={b.model} className={"chip " + (b.counts ? "chip--ok" : b.vote === "approve" ? "chip--wait" : "chip--bad")} title={b.why ?? ""}>{name(b.model)}: {b.vote === "approve" ? t.approve : t.reject}{b.vote === "approve" && !b.counts ? ` (${t.notCounted}${b.why ? `: ${b.why}` : ""})` : ""}</span>)}</div>
							); })}
							{(() => {
								const last = Math.max(...said.ballots.map((b) => b.round));
								return (
									<details className="ballots">
										<summary>{t.ballotDetails(last)}</summary>
										{said.ballots.filter((b) => b.round === last).map((b) => (
											<div key={b.model} className="msg"><b>{name(b.model)}</b>
												<ul>{b.criteria.map((c) => <li key={c.n}><span className={"chip " + (c.met ? (c.backed === false ? "chip--wait" : "chip--ok") : "chip--bad")}>{c.n}: {c.met ? t.met : t.notMet}{c.met && c.backed === false ? ` (${t.unbacked})` : ""}</span> <span className="muted">{c.text}</span></li>)}</ul>
											</div>
										))}
									</details>
								);
							})()}
						</details>
					) : null}
					{said.objections.length ? (
						<details open={said.objections.some((o) => o.state === "open")}>
							<summary>{t.objections} ({said.objections.length})</summary>
							{said.objections.map((o) => (
								<div key={o.objId} className="msg">
									<b>{name(o.model)}</b><span className={"chip " + (o.state === "open" ? "chip--wait" : o.state === "declined" ? "chip--bad" : "chip--ok")}>{t.objStates[o.state]}{o.revisedIn ? ` ${t.inVersion(o.revisedIn)}` : ""}</span>
									<i>{block.doc?.sections.find((x) => x.sectionId === o.sectionId)?.title ?? o.sectionId}:</i> {o.defect} <span className="muted">{t.fix}: {o.fix}</span>
								</div>
							))}
						</details>
					) : null}
					{threads.map((root) => {
						const replies = said.messages.filter((m) => m.thread === root.thread && m.msgId !== root.msgId);
						const open = root.kind === "question" && root.to === "person" && !replies.some((m) => m.model === "human");
						return (
							<div key={root.msgId} className={"talk__thread" + (open ? " is-open" : "")}>
								<div className="msg"><b>{who(root)}</b><span className="chip">{open ? t.forYou : t.kind[root.kind]}{root.to && !open ? ` ${t.to} ${root.to === "all" ? t.all : root.to === "person" ? t.person : name(root.to)}` : ""}</span> {root.text}</div>
								{replies.map((m) => <div key={m.msgId} className="msg talk__reply"><b>{who(m)}</b>{m.kind === "vote" ? <span className={"chip " + (m.stance === "agree" ? "chip--ok" : "chip--bad")}>{m.stance === "agree" ? t.agree : t.disagree}</span> : null} {m.text}</div>)}
								{open ? (
									<form className="row" onSubmit={(e) => { e.preventDefault(); void answer(root.msgId); }}>
										<Field className="wide" label={t.answerPh} quiet tip="answer" lang={lang} maxLength={2000} placeholder={t.answerPh} value={drafts[root.msgId] ?? ""} onChange={(e) => setDrafts((cur) => ({ ...cur, [root.msgId]: e.target.value }))} />
										<Act type="submit" kind="primary" label={t.send} tip="answer" lang={lang} disabled={!(drafts[root.msgId] ?? "").trim()} />
									</form>
								) : null}
							</div>
						);
					})}
				</div>
			) : <div className="empty">{t.noTalk}</div>}
			<form className="row" onSubmit={(e) => { e.preventDefault(); void answer(); }}>
				<Field className="wide" label={t.sayPh} quiet tip="say" lang={lang} maxLength={2000} placeholder={t.sayPh} value={say} onChange={(e) => setSay(e.target.value)} />
				<Act type="submit" label={t.send} tip="say" lang={lang} disabled={!say.trim()} />
			</form>
		</div>
	);
}

/** A run on the task shown: its state in numbers, the two tables of a run with both, and the roll call. */
export function RunPanel({ t, locale, runHere, table, answers }: { t: Text; locale: string; runHere: RunInfo; table: string[]; answers: Map<string, Answer> }) {
	return (
		<div className="panel">
			<h2>{t.run}</h2>
			<div className="runline">
				<span className={"pill" + (runHere.active ? " pill--accent" : "")}>{runHere.active ? t.active : t.ended}</span>
				{runHere.both ? null : <span className="pill">{t.tableName(runHere.table)}</span>}
				<span className="pill">{t.phase[runHere.phase]}{runHere.round ? ` · ${t.round(runHere.round, runHere.rounds ?? runHere.round)}` : ""}</span>
				{runHere.turn ? <span className="pill">{runHere.aliases[runHere.turn] ?? "?"} {t.hasTurn}</span> : null}
				{runHere.doc ? <span className="pill">{t.written(runHere.doc.written, runHere.doc.sections)}</span> : null}
				<span className="pill">{t.items(runHere.items.done, runHere.items.open)}</span>
				<span className="pill">{runHere.usage.tokens.toLocaleString(locale)}{runHere.budget.tokens ? ` / ${runHere.budget.tokens.toLocaleString(locale)}` : ""} Tokens{runHere.usage.costUsd ? ` · $${runHere.usage.costUsd.toFixed(4)}` : ""}{runHere.budget.usd ? ` / $${runHere.budget.usd}` : ""}</span>
				{runHere.ballots ? <span className="pill">{t.byMajority(runHere.ballots.approve, runHere.ballots.of)} {t.approve}</span> : null}
				{runHere.ended ? <span className="pill">{runHere.ended === "budget" ? t.budgetUsed : runHere.ended === "models" ? t.fewModels : runHere.ended === "rounds" ? t.noMajority : runHere.ended === "checks" ? t.failsChecks : t.stuckEnd}</span> : null}
			</div>
			{runHere.both ? (
				<div className="runline">
					{(["A", "B"] as const).map((x) => { const i = runHere.tables?.[x]; return i ? <span key={x} className={"pill" + (i.active ? " pill--accent" : "")}>{t.tableName(x)}: {i.accepted ? t.acceptedBy(i.accepted.version, t.byMajority(i.accepted.approvals, i.accepted.of)) : i.ended === "other" ? t.otherFirst : t.phase[i.phase]}{i.round && !i.accepted ? ` · ${t.round(i.round, i.rounds ?? i.round)}` : ""}{i.turn ? ` · ${runHere.aliases[i.turn] ?? "?"} ${t.hasTurn}` : ""} · {i.usage.tokens.toLocaleString(locale)} Tokens</span> : null; })}
					{runHere.base ? <span className="pill">{t.baseIs(runHere.base.table, runHere.base.how === "accepted" ? t.howAccepted : runHere.base.how === "only" ? t.howOnly : t.howCompared(runHere.base.prefer?.[runHere.base.table] ?? 0, (runHere.base.prefer?.A ?? 0) + (runHere.base.prefer?.B ?? 0)))}</span> : null}
					{runHere.final ? <span className="pill">{t.finalIs(runHere.final.agreed ?? 0, runHere.final.points, runHere.final.accepted)}</span> : null}
					{runHere.result ? <span className="pill pill--accent">{t.resultIs(runHere.result.table, runHere.result.version)}</span> : null}
				</div>
			) : null}
			{runHere.note ? <div className="notice">{runHere.note}</div> : null}
			<div className="fieldlabel">{t.table}</div>
			<div className="answers">
				{table.map((model) => {
					const a = answers.get(model);
					return (
						<div key={model} className={"answer" + (a ? "" : " answer--waiting")}>
							<div className="answer__who"><b>{runHere.aliases[model]}</b><span>{model}{runHere.writer === model ? ` · ${t.writer}` : ""}</span></div>
							<div>{a ? a.text : t.waiting}</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
