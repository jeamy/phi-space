"use client";
// The sheet: its handle pulls it to any height and, where it is narrower than the page, to any place left or right, and it stays
// there (`height`, `place`, kept by the caller). A tap on the handle opens and closes it, so it needs no swipe. Closed it shows the tabs and a line; a talk takes the whole height for the keyboard ("full").
import { useRef, useState, type ReactNode } from "react";
import { useBack } from "./useBack.ts";
import { isShort } from "./useShell.ts";

export type Detent = "peek" | "half" | "full";
/** The height of a detent in the space of `room` px; the peek shows the tabs and one line, on a phone on its side the tabs. */
export const detentPx = (d: Detent, room: number) => (d === "peek" ? (isShort() ? 64 : 116) : d === "half" ? Math.round(room * (isShort() ? 0.64 : 0.52)) : room);

export function Sheet({ detent, setDetent, height, setHeight, place, setPlace, children }: { detent: Detent; setDetent: (d: Detent) => void; /** The height it was pulled to, null: the default. */ height: number | null; setHeight: (h: number) => void;
	/** Where it stands between the page's left (0) and right edge (1), null: the default. A share, so it holds when the page changes size. */ place: number | null; setPlace: (x: number) => void; children: ReactNode }) {
	const box = useRef<HTMLElement>(null);
	const [drag, setDrag] = useState<number | null>(null);
	const [dragX, setDragX] = useState<number | null>(null);
	const start = useRef<{ x: number; y: number; h: number; place: number; movedX: boolean; movedY: boolean } | null>(null);
	useBack(detent !== "peek", () => setDetent("peek"));
	const room = () => box.current?.parentElement?.clientHeight ?? 700;
	/** How many px of the page's width it can move over. */
	const spare = () => (box.current?.parentElement?.clientWidth ?? 0) - (box.current?.offsetWidth ?? 0);
	const placeNow = () => { const b = box.current; return b && spare() > 0 ? b.offsetLeft / spare() : place ?? 0.5; };
	return (
		<section ref={box} className={`sheet sheet-${detent}`} style={{ ...(drag !== null ? { height: drag, transition: "none" } : detent === "half" && height ? { height } : {}), ...(dragX ?? place) !== null ? { "--sheet-x": dragX ?? place, ...(dragX !== null ? { transition: "none" } : {}) } as React.CSSProperties : {} }} aria-label="Tasche, Ereignisse und Chats">
			<button type="button" className="sheet-grab" aria-label={detent === "peek" ? "Blatt öffnen" : "Blatt schließen"}
				onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); start.current = { x: e.clientX, y: e.clientY, h: box.current?.offsetHeight ?? 0, place: placeNow(), movedX: false, movedY: false }; }}
				onPointerMove={(e) => { const s = start.current; if (!s) return;
					const dy = s.y - e.clientY, dx = e.clientX - s.x, span = spare();
					if (Math.abs(dy) > 6) s.movedY = true;
					if (Math.abs(dx) > 6 && span > 0) s.movedX = true;
					if (s.movedY) setDrag(Math.max(detentPx("peek", room()), Math.min(room(), s.h + dy)));
					if (s.movedX) setDragX(Math.max(0, Math.min(1, s.place + dx / span)));
				}}
				onPointerUp={(e) => {
					const s = start.current; start.current = null;
					if (!s) return;
					setDrag(null); setDragX(null);
					if (s.movedX) setPlace(Math.max(0, Math.min(1, s.place + (e.clientX - s.x) / Math.max(1, spare()))));
					if (s.movedX && !s.movedY) return;
					if (!s.movedY) { setDetent(detent === "peek" ? "half" : detent === "half" ? "peek" : "half"); return; }
					const peek = detentPx("peek", room()), h = Math.max(peek, Math.min(room(), s.h + s.y - e.clientY));
					// pulled down to the tabs it is closed; anywhere else it stays where the finger left it
					if (h <= peek + 24) { setDetent("peek"); return; }
					setHeight(h); setDetent("half");
				}}
				onPointerCancel={() => { start.current = null; setDrag(null); setDragX(null); }} />
			{children}
		</section>
	);
}
