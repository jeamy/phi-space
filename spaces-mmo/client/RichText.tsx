"use client";
// The texts of the world made readable, whatever wrote them: a command in „…“ stands out in the theme's colour and, where
// the page gives `onCommand`, a tap puts it into the command line (it never runs by itself); long help falls into points.
import { Fragment, type ReactNode } from "react";
import { sentences } from "./sentences.ts";
import { tr } from "./i18n/index.ts";

/** What in „…“ is a command to type: it starts in lower case ("help ackerbau", "gruppe lade <name>"); a quoted name is not. */
const isCommand = (s: string) => /^[a-zäöü][^\s]*(?:\s|$)/.test(s) && s.length <= 60;
/** The names of figures the page knows (the characters it sees, the islands' people): set in bold wherever a text names
 *  them (App.tsx keeps the list). */
let names: RegExp | null = null, nameKey = "";
export function setNames(list: Iterable<string>): void {
	const all = [...new Set([...list].filter((n) => n && n.length >= 2))].sort((a, b) => b.length - a.length);
	const key = all.join("\u0000");
	if (key === nameKey) return;
	nameKey = key;
	names = all.length ? new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${all.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}_-])`, "gu") : null;
}
/** A piece of text with what is marked **so** and the names of figures in bold. */
export function emphasized(text: string, key = 0): ReactNode[] {
	// keys of their own ("e<key>.<n>"): a command's button beside them is "c<n>", a duplicate key made React keep the old
	// element at every render of the log and add it again ("2× Münze" a hundred times)
	const out: ReactNode[] = [];
	let k = 0;
	const id = () => `e${key}.${k++}`;
	for (const [i, piece] of text.split(/\*\*(.+?)\*\*/su).entries()) {
		if (i % 2) { out.push(<strong key={id()}>{piece}</strong>); continue; }
		if (!names || !piece) { out.push(<Fragment key={id()}>{piece}</Fragment>); continue; }
		let at = 0;
		for (const m of piece.matchAll(names)) { out.push(<Fragment key={id()}>{piece.slice(at, m.index)}</Fragment>); out.push(<strong key={id()} className="who">{m[0]}</strong>); at = m.index + m[0].length; }
		out.push(<Fragment key={id()}>{piece.slice(at)}</Fragment>);
	}
	return out;
}

/** A text with its commands marked. The word before the placeholder in a command keeps its form: „pate <name>“. */
export function Rich({ text: german, onCommand }: { text: string; onCommand?: (command: string) => void }) {
	const text = tr(german), parts: ReactNode[] = [];
	let at = 0, k = 0;
	for (const m of text.matchAll(/„([^“]+)“/g)) {
		const c = m[1]!;
		if (!isCommand(c)) continue;
		parts.push(...emphasized(text.slice(at, m.index), k++));
		parts.push(onCommand ? <button key={`c${k++}`} type="button" className="cmd-word" onClick={() => onCommand(c.replace(/\s*<[^>]*>.*$/, "").trim())} title="In die Befehlszeile setzen">{c}</button> : <code key={`c${k++}`} className="cmd-word">{c}</code>);
		at = m.index + m[0].length;
	}
	parts.push(...emphasized(text.slice(at), k++));
	return <>{parts}</>;
}

/** A long text as points, a short one as it is. */
export function RichBlock({ text, onCommand }: { text: string; onCommand?: (command: string) => void }) {
	const all = sentences(tr(text));
	if (all.length < 3) return <p><Rich text={text} onCommand={onCommand} /></p>;
	return <ul className="rich-list">{all.map((s, i) => <li key={i}><Rich text={s} onCommand={onCommand} /></li>)}</ul>;
}
