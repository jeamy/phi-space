"use client";
// The texts of the world made readable, whatever wrote them: a command in „…“ stands out in the theme's colour and, where
// the page gives `onCommand`, a tap puts it into the command line (it never runs by itself); long help falls into points.
import type { ReactNode } from "react";
import { sentences } from "./sentences.ts";
import { tr } from "./i18n/index.ts";

/** What in „…“ is a command to type: it starts in lower case ("help ackerbau", "gruppe lade <name>"); a quoted name is not. */
const isCommand = (s: string) => /^[a-zäöü][^\s]*(?:\s|$)/.test(s) && s.length <= 60;
/** A text with its commands marked. The word before the placeholder in a command keeps its form: „pate <name>“. */
export function Rich({ text: german, onCommand }: { text: string; onCommand?: (command: string) => void }) {
	const text = tr(german), parts: ReactNode[] = [];
	let at = 0, k = 0;
	for (const m of text.matchAll(/„([^“]+)“/g)) {
		const c = m[1]!;
		if (!isCommand(c)) continue;
		parts.push(text.slice(at, m.index));
		parts.push(onCommand ? <button key={k++} type="button" className="cmd-word" onClick={() => onCommand(c.replace(/\s*<[^>]*>.*$/, "").trim())} title="In die Befehlszeile setzen">{c}</button> : <code key={k++} className="cmd-word">{c}</code>);
		at = m.index + m[0].length;
	}
	parts.push(text.slice(at));
	return <>{parts}</>;
}

/** A long text as points, a short one as it is. */
export function RichBlock({ text, onCommand }: { text: string; onCommand?: (command: string) => void }) {
	const all = sentences(tr(text));
	if (all.length < 3) return <p><Rich text={text} onCommand={onCommand} /></p>;
	return <ul className="rich-list">{all.map((s, i) => <li key={i}><Rich text={s} onCommand={onCommand} /></li>)}</ul>;
}
