"use client";
// The game's own question before something that cannot be undone (giving up a bed or a field): a small dialog in the
// theme instead of the browser's confirm(), which some browsers block or show in their own grey (and a blocked one
// answers „no“ without asking). `ask(text)` resolves true for „Ja“, false for „Abbrechen“, Escape or a tap beside it.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

type Asked = { text: string; answer: (ok: boolean) => void };
let asked: Asked | null = null;
const listeners = new Set<() => void>();
const tell = () => { for (const l of listeners) l(); };

/** Asks `text`; a question still open is answered „no“ first. */
export function ask(text: string): Promise<boolean> {
	asked?.answer(false);
	return new Promise((resolve) => {
		const me: Asked = { text, answer: (ok) => { if (asked === me) { asked = null; tell(); } resolve(ok); } };
		asked = me;
		tell();
	});
}

/** Mounted once: shows the open question over everything. */
export function AskHost() {
	const q = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => asked, () => null);
	const yes = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!q) return;
		yes.current?.focus();
		const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); q.answer(false); } };
		window.addEventListener("keydown", key, true);
		return () => window.removeEventListener("keydown", key, true);
	}, [q]);
	if (!q || typeof document === "undefined") return null;
	return createPortal(
		<div className="ask-veil" onPointerDown={(e) => { if (e.target === e.currentTarget) q.answer(false); }}>
			<div className="ask" role="alertdialog" aria-modal="true" aria-labelledby="ask-text">
				<p id="ask-text">{q.text}</p>
				<div className="ask-do">
					<button type="button" onClick={() => q.answer(false)}>Abbrechen</button>
					<button type="button" ref={yes} className="ask-yes" onClick={() => q.answer(true)}>Ja</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
