// Saving a room's documents into its project folder (server/hub.ts `save`, docs/forum-seite-plan-2026-11-26.en.md,
// section 6): one task's document or all of them, each a file of its own. A file changed in the workspace since the
// last save is never overwritten: both texts are shown side by side, and the person saves under another name.
"use client";
import { useState } from "react";
import { authHeaders } from "../lib/me.ts";
import { diffText } from "../lib/diff.ts";
import type { Block } from "../lib/forum-types.ts";
import type { Text } from "../lib/texts.ts";
import type { Lang } from "../lib/theme.ts";
import { DiffLines } from "../panes.tsx";
import { firstLine } from "../lib/api.ts";
import { Act, Field } from "./controls.tsx";
import { HelpTip } from "../HelpTip.tsx";
import type { PageText } from "./texts.ts";

type Saved = { path: string; fileVersion: number; docVersion: number };
type Conflict = { path: string; version: number; text: string | null; mine: string; gone?: true; tooLarge?: true };
type Outcome = { blockId: string; saved?: Saved; conflict?: Conflict; error?: string };

/** One save: the ID is drawn once, so a try after a lost reply is the same save. */
async function saveOne(rid: string, blockId: string, name?: string): Promise<Outcome> {
	const id = `s${crypto.getRandomValues(new Uint32Array(3)).reduce((s, n) => s + n.toString(36), "")}`.slice(0, 24).padEnd(12, "0");
	for (let attempt = 0; ; attempt++) {
		try {
			const r = await fetch(`/api/rooms/${rid}/save/${blockId}`, { method: "POST", headers: { "content-type": "application/json", "x-forum-admin": "1", ...authHeaders() }, body: JSON.stringify({ id, ...(name ? { name } : {}) }) });
			const data = (await r.json().catch(() => ({}))) as { error?: string; save?: Saved; conflict?: Conflict };
			if (r.status === 409 && data.conflict) return { blockId, conflict: data.conflict };
			if (!r.ok) return { blockId, error: data.error || r.statusText };
			return { blockId, saved: data.save! };
		} catch (e) {
			if (attempt >= 2) return { blockId, error: (e as Error).message };
			await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1)));
		}
	}
}

export function SaveDocs({ lang, p, t, rid, blocks, block, folder }: { lang: Lang; p: PageText; t: Text; rid: string; blocks: Block[]; block: Block; folder: string }) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [out, setOut] = useState<Outcome[]>([]);
	const withDoc = blocks.filter((b) => b.doc);
	const run = async (which: Block[], named?: string, all = false) => {
		setBusy(true);
		try {
			const got: Outcome[] = [];
			for (const b of which) got.push(await saveOne(rid, b.blockId, named));
			// all of them: the register of sources as well (server/register.ts), as sources.md beside the documents
			if (all) got.push(await saveOne(rid, "register"));
			setOut(got);
		} finally { setBusy(false); }
	};
	const title = (id: string) => id === "register" ? p.registerFile : firstLine(blocks.find((b) => b.blockId === id)?.brief ?? id, 50);
	const here = out.find((o) => o.blockId === block.blockId && o.conflict);
	return (
		<details className="fp-fold fp-save" open={!!here}>
			<summary>{p.saveTitle} <HelpTip id="save" lang={lang} label={p.saveTitle} /></summary>
			<p className="fp-meta">{block.saved ? p.savedAs(block.saved.path, block.saved.fileVersion, block.saved.docVersion) : p.notSaved(folder)}</p>
			<Field label={p.fileName} tip="savename" lang={lang} value={name} placeholder={block.saved?.path.split("/").at(-1) ?? p.saveNameDefault} maxLength={120} onChange={(e) => setName(e.target.value)} />
			<div className="fp-row">
				<Act label={p.saveOne} tip="save" lang={lang} kind="primary" disabled={busy || !block.doc} onClick={() => void run([block], name.trim() || undefined)} />
				{withDoc.length ? <Act label={p.saveAll(withDoc.length)} tip="saveall" lang={lang} disabled={busy} onClick={() => void run(withDoc, undefined, true)} /> : null}
			</div>
			{busy ? <p className="fp-meta">{p.saving}</p> : null}
			{out.length ? (
				<ul className="fp-files">
					{out.map((o) => (
						<li key={o.blockId}>
							<b>{title(o.blockId)}</b>
							<span className={o.saved ? "fp-meta" : "fp-error"}>{o.saved ? p.savedAs(o.saved.path, o.saved.fileVersion, o.saved.docVersion) : o.conflict ? (o.conflict.gone ? p.conflictGone(o.conflict.path) : p.conflictChanged(o.conflict.path, o.conflict.version)) : o.error}</span>
						</li>
					))}
				</ul>
			) : null}
			{here?.conflict ? (
				<div className="fp-conflict" role="region" aria-label={p.conflictTitle}>
					<h3>{p.conflictTitle} <HelpTip id="conflict" lang={lang} label={p.conflictTitle} /></h3>
					<p className="fp-meta">{here.conflict.gone ? p.conflictGoneHow : here.conflict.tooLarge ? p.conflictTooLarge : p.conflictHow}</p>
					{here.conflict.text !== null ? (
						<>
							<p className="fp-meta"><span className="diff__del">{p.conflictTheirs}</span> · <span className="diff__add">{p.conflictMine}</span></p>
							<DiffLines t={t} lines={diffText(here.conflict.text, here.conflict.mine)} />
						</>
					) : null}
					<p className="fp-meta">{p.conflictNext}</p>
				</div>
			) : null}
		</details>
	);
}
