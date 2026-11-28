// The room's register of sources (server/register.ts, docs/forum-seite-plan-2026-11-26.en.md, section 6): every source
// a task read, and those a person added; each with its state, where it is cited, and a member's word on it.
"use client";
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { Lang } from "../lib/theme.ts";
import { Act, Area, Field } from "./controls.tsx";
import { HelpTip } from "../HelpTip.tsx";
import type { PageText } from "./texts.ts";

export type Ref = { refId: string; kind: "repo" | "files" | "docs" | "room" | "link"; address: string; title: string; licence?: string; note?: string; by: string; state: "proposed" | "accepted" | "declined"; reason?: string; decidedBy?: string; cites: Array<{ blockId: string; doc: string; section: string }> };

export function Register({ lang, p, rid, canWrite, act, stamp }: { lang: Lang; p: PageText; rid: string; canWrite: boolean; act: (fn: () => Promise<unknown>) => Promise<boolean>; stamp: string }) {
	const [refs, setRefs] = useState<Ref[] | null>(null);
	const [address, setAddress] = useState("");
	const [title, setTitle] = useState("");
	const [note, setNote] = useState("");
	const load = () => api<{ refs: Ref[] }>(`/rooms/${rid}/register`).then((x) => setRefs(x.refs)).catch(() => setRefs([]));
	// the room's lines change with every word on a source: the register is read again then
	useEffect(() => { void load(); }, [rid, stamp]);
	const add = () => act(async () => { await api(`/rooms/${rid}/register`, { op: "add", address: address.trim(), title, note }); setAddress(""); setTitle(""); setNote(""); await load(); });
	const counts = refs ? { accepted: refs.filter((r) => r.state === "accepted").length, proposed: refs.filter((r) => r.state === "proposed").length } : null;
	return (
		<details className="fp-fold fp-register">
			<summary>{p.register}{refs?.length ? ` (${refs.length})` : ""} <HelpTip id="register" lang={lang} label={p.register} /></summary>
			{counts && refs!.length ? <p className="fp-meta">{p.registerCounts(counts.accepted, counts.proposed, refs!.length - counts.accepted - counts.proposed)}</p> : null}
			{refs === null ? null : refs.length ? (
				<ul className="fp-refs">{refs.map((r) => <RefRow key={r.refId + r.state + (r.reason ?? "")} lang={lang} p={p} rid={rid} r={r} canWrite={canWrite} act={act} reload={load} />)}</ul>
			) : <p className="fp-empty">{p.registerEmpty}</p>}
			{canWrite ? (
				<div className="fp-refadd">
					<Field label={p.refAddress} tip="refadd" lang={lang} type="url" value={address} maxLength={500} placeholder="https://…" onChange={(e) => setAddress(e.target.value)} />
					<Field label={p.refTitle} tip="refadd" lang={lang} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
					<Area label={p.refNote} tip="refadd" lang={lang} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
					<Act label={p.refAdd} tip="refadd" lang={lang} disabled={!/^https?:\/\/\S+$/.test(address.trim())} onClick={() => void add()} />
				</div>
			) : null}
		</details>
	);
}

function RefRow({ lang, p, rid, r, canWrite, act, reload }: { lang: Lang; p: PageText; rid: string; r: Ref; canWrite: boolean; act: (fn: () => Promise<unknown>) => Promise<boolean>; reload: () => Promise<unknown> }) {
	const [reason, setReason] = useState("");
	const [licence, setLicence] = useState(r.licence ?? "");
	const decide = (state: Ref["state"]) => act(async () => { await api(`/rooms/${rid}/register`, { op: "decide", refId: r.refId, state, ...(state === "declined" ? { reason } : {}), licence }); await reload(); });
	const where = [...new Set(r.cites.map((c) => `${c.doc}: ${c.section}`))];
	return (
		<li className={`fp-ref fp-ref--${r.state}`}>
			<div>
				<span className={"chip " + (r.state === "accepted" ? "chip--ok" : r.state === "declined" ? "chip--bad" : "chip--wait")}>{p.refStates[r.state]}</span>{" "}
				<b>{r.kind === "link" ? <a href={r.address} target="_blank" rel="noreferrer noopener">{r.title}</a> : r.title}</b>{" "}
				<span className="fp-meta">{p.refKinds[r.kind]} · {p.refBy(r.by)}{r.licence ? ` · ${p.refLicence}: ${r.licence}` : ""}{r.decidedBy ? ` · ${p.refDecided(r.decidedBy)}` : ""}</span>
			</div>
			{r.reason ? <p className="fp-meta">{p.refReason}: {r.reason}</p> : null}
			{r.note ? <p className="fp-meta">{r.note}</p> : null}
			<p className="fp-meta">{where.length ? `${p.refCited}: ${where.join("; ")}` : p.refNotCited}</p>
			{canWrite ? (
				<div className="fp-row">
					<Field label={p.refLicence} tip="refdecide" lang={lang} value={licence} maxLength={120} onChange={(e) => setLicence(e.target.value)} />
					{r.state !== "accepted" ? <Act label={p.refAccept} tip="refdecide" lang={lang} onClick={() => void decide("accepted")} /> : null}
					<Field label={p.refReason} tip="refdecide" lang={lang} value={reason} maxLength={600} onChange={(e) => setReason(e.target.value)} />
					{r.state !== "declined" ? <Act kind="danger" label={`${p.refDecline}: ${r.title}`} tip="refdecide" lang={lang} disabled={!reason.trim()} onClick={() => void decide("declined")}>{p.refDecline}</Act> : null}
					{r.state !== "proposed" ? <Act label={p.refReopen} tip="refdecide" lang={lang} onClick={() => void decide("proposed")} /> : null}
				</div>
			) : null}
		</li>
	);
}
