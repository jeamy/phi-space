"use client";
// A room's data for a page: the snapshot over the WebSocket (reconnecting with a backoff), the task shown, the tables
// with a document, the discussion of each table shown and the outcome of a run with both tables, refetched whenever the
// work goes on; the models and the system's processes every 15 seconds. Shared by the page and the expert view.
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Models, Outcome, Snapshot, System, Table, Talk } from "./forum-types.ts";
import type { Text } from "./texts.ts";

export function useRoom(room: string, ready: boolean, t: Text) {
	const rid = encodeURIComponent(room);
	const [snap, setSnap] = useState<Snapshot | null>(null);
	const [live, setLive] = useState(false);
	const [models, setModels] = useState<Models | null>(null);
	const [system, setSystem] = useState<System | null>(null);
	const [focus, setFocus] = useState<string | null>(null); // the block shown; null: the newest
	const [tableSel, setTableSel] = useState<Table | "side" | null>(null); // the table shown; null: the block's; "side": both
	const [talks, setTalks] = useState<{ blockId: string; by: Partial<Record<Table, Talk>> } | null>(null);
	const [outcome, setOutcome] = useState<(Outcome & { blockId: string }) | null>(null);

	useEffect(() => {
		if (!ready) return;
		let dead = false, ws: WebSocket | null = null, retry = 0, timer: ReturnType<typeof setTimeout> | undefined;
		setSnap(null); setFocus(null); setTableSel(null);
		const connect = () => {
			ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/" + rid);
			ws.onopen = () => setLive(true);
			// the backoff resets only once a snapshot arrived: a socket the server drops right after opening backs off too
			ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type === "snapshot") { retry = 0; setSnap(d); } };
			ws.onclose = () => { setLive(false); if (!dead) timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++)); };
		};
		connect();
		return () => { dead = true; clearTimeout(timer); ws?.close(); };
	}, [rid, ready]);

	const loadModels = () => { api<Models>("/models").then(setModels).catch(() => {}); };
	useEffect(() => {
		let dead = false;
		const load = () => {
			api<Models>("/models").then((x) => { if (!dead) setModels(x); }).catch(() => {});
			api<System>("/system").then((x) => { if (!dead) setSystem(x); }).catch(() => {});
		};
		if (!ready) return;
		load();
		const timer = setInterval(load, 15_000);
		return () => { dead = true; clearInterval(timer); };
	}, [ready]);

	const blocks = snap?.blocks ?? [];
	const block = blocks.find((b) => b.blockId === focus) ?? blocks.at(-1) ?? null;
	// the tables that have a document on this block, and the one shown (both: side by side)
	const docTables = (["A", "B"] as const).filter((x) => block?.heads[x]);
	const sideBySide = tableSel === "side" && docTables.length === 2;
	const shown: Table = tableSel && tableSel !== "side" && block?.heads[tableSel] ? tableSel : block?.table ?? "A";
	// what changes whenever the work on the block goes on: the discussion, the documents and the outcome follow it
	const r_ = snap?.run;
	const bump = block ? `${block.blockId}:${block.table}:${block.talk.messages}:${block.talk.decisions}:${block.heads.A ?? 0}:${block.heads.B ?? 0}:${block.accepted?.version ?? 0}:${block.result?.version ?? 0}:${block.doc?.check?.ok ?? ""}:${r_?.phase ?? ""}:${r_?.active ?? ""}:${r_?.items.done ?? 0}:${r_?.objections?.raised ?? 0}:${r_?.objections?.open ?? 0}:${snap?.lines.at(-1)?.ts ?? 0}` : "";
	// what changes a document as it is shown without a new version: its check, its acceptance, the run's phase
	const docKey = block ? `${block.doc?.check?.ok ?? ""}:${block.doc?.check?.failures.length ?? 0}:${block.accepted?.version ?? 0}:${r_?.phase ?? ""}:${r_?.active ?? ""}` : "";
	// the discussion of each table that is shown (its messages, decisions, objections and ballots)
	const wanted = block ? (sideBySide ? docTables : [shown]).join("") : "";
	useEffect(() => {
		if (!block) { setTalks(null); return; }
		let dead = false;
		Promise.all([...wanted].map(async (x) => [x, { blockId: block.blockId, ...(await api<Omit<Talk, "blockId">>(`/rooms/${rid}/talk/${block.blockId}?table=${x}`)) }] as const))
			.then((got) => { if (!dead) setTalks({ blockId: block.blockId, by: Object.fromEntries(got) }); }).catch(() => {});
		return () => { dead = true; };
	}, [rid, bump, wanted]); // eslint-disable-line react-hooks/exhaustive-deps
	// how the run with both tables went (the comparison, the numbers of each table), once there is something to show
	const hasOutcome = !!block && (!!block.result || (r_?.blockId === block.blockId && !!r_.base));
	useEffect(() => {
		if (!block || !hasOutcome) { setOutcome(null); return; }
		let dead = false;
		api<Outcome>(`/rooms/${rid}/outcome/${block.blockId}`).then((x) => { if (!dead) setOutcome({ blockId: block.blockId, ...x }); }).catch(() => {});
		return () => { dead = true; };
	}, [rid, bump, hasOutcome]); // eslint-disable-line react-hooks/exhaustive-deps

	const available = models?.enabled && models.on ? models.models : [];
	const limits = snap?.limits ?? { minModels: 3, maxModels: 5, maxPerModel: 3, visitorTokens: 0 };
	const run = snap?.run ?? null;
	const answers = new Map((snap?.rollcall ?? []).map((a) => [a.model, a]));
	const table = run ? [...run.models].sort((a, b) => (run.aliases[a] ?? "").localeCompare(run.aliases[b] ?? "")) : [];
	const runHere = run && block && run.blockId === block.blockId ? run : null;
	const talkOf = (x: Table) => (talks && block && talks.blockId === block.blockId ? talks.by[x] ?? null : null);
	const said = talkOf(shown);
	const result = outcome && block && outcome.blockId === block.blockId ? outcome : null;
	// a run with both tables may end with an older version as its result (a final round that did not agree)
	const resultOf = (x: Table) => (block?.result && block.result.table === x && !snap?.run?.active ? block.result.version : 0);
	const name = (model: string) => (model === "table" ? t.theTable : model === "human" ? t.you : runHere?.aliases[model] ? `${runHere.aliases[model]} · ${model}` : model);
	const who = (m: { model: string; author: string }) => (m.model === "human" ? `${t.you} (${m.author})` : name(m.model));
	const threads = (said?.messages ?? []).filter((m) => m.thread === m.msgId && m.kind !== "understanding");

	return {
		rid, snap, live, models, system, loadModels, blocks, block, focus, setFocus, tableSel, setTableSel, docTables, sideBySide, shown,
		docKey, talkOf, said, result, resultOf, available, limits, run, runHere, answers, table, name, who, threads,
	};
}
