"use client";
// The small "?" next to a field: a click opens a short description with a link to the full help section. The popup is
// placed at the button and kept inside the window (on a phone it spans the width); a click outside, Escape or a
// second click closes it.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { TIPS, type TipId } from "./lib/tips.ts";
import type { Lang } from "./lib/theme.ts";

const MORE = { de: "Mehr in der Hilfe →", en: "More in the help →" } as const;
const LABEL = { de: "Hilfe zu", en: "Help on" } as const;

export function HelpTip({ id, lang, label }: { id: TipId; lang: Lang; label: string }) {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
	const btn = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null);
	const popId = useId();
	const tip = TIPS[id];

	const place = () => {
		const b = btn.current?.getBoundingClientRect();
		if (!b) return;
		const vw = document.documentElement.clientWidth, vh = window.innerHeight, gutter = 12;
		const width = Math.min(300, vw - 2 * gutter);
		const left = Math.min(Math.max(gutter, b.left + b.width / 2 - width / 2), vw - width - gutter);
		const h = pop.current?.offsetHeight ?? 0;
		const below = b.bottom + 6, above = b.top - 6 - h;
		setPos({ left, width, top: below + h > vh - gutter && above > gutter ? above : below });
	};
	useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (!open) return;
		const away = (e: PointerEvent) => { const n = e.target as Node; if (!btn.current?.contains(n) && !pop.current?.contains(n)) setOpen(false); };
		const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
		const move = () => place();
		document.addEventListener("pointerdown", away);
		document.addEventListener("keydown", key);
		window.addEventListener("scroll", move, true);
		window.addEventListener("resize", move);
		return () => {
			document.removeEventListener("pointerdown", away);
			document.removeEventListener("keydown", key);
			window.removeEventListener("scroll", move, true);
			window.removeEventListener("resize", move);
		};
	}, [open]); // eslint-disable-line react-hooks/exhaustive-deps

	return (
		<>
			<button ref={btn} type="button" className={"tip" + (open ? " is-open" : "")} aria-label={`${LABEL[lang]} ${label}`} aria-expanded={open} aria-controls={open ? popId : undefined}
				onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}>?</button>
			{open ? (
				<div ref={pop} id={popId} role="note" className="tip__pop" style={pos ? { left: pos.left, top: pos.top, width: pos.width } : { visibility: "hidden" }}>
					<b className="tip__title">{label}</b>
					<p>{tip.text[lang]}</p>
					<a href={`/help?lang=${lang}&article=${tip.article}#${tip.anchor}`}>{MORE[lang]}</a>
				</div>
			) : null}
		</>
	);
}
