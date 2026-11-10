"use client";
// The sheet: its handle pulls it to any height and, where it is narrower than the page, to any place left or right, and it stays
// there (`height`, `place`, kept by the caller). A tap on the handle opens it to its last height and closes it, so it needs no swipe. Closed it shows the tabs and a line; a talk takes the whole height for the keyboard ("full").
// Its top edge glides to a new height by a transform the compositor runs (the Web Animations API), not by a transition of
// the height: the 3D map draws every frame on the main thread, and a height transition moves only as often as the map lets
// a frame through (on a tablet it stuttered). Growing, the sheet takes its new height and content at once and slides up from
// where its edge stood; shrinking, it keeps its old height and content, slides down to the new edge, and only then takes
// them, so the map never shows under it on the way. The edge moves as the transition moved it: 0.22 s, ease.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useBack } from "./useBack.ts";
import { isShort } from "./useShell.ts";

export type Detent = "peek" | "half" | "full";
/** The height of a detent in the space of `room` px (styles.css has the same numbers); the peek shows the handle and one line,
 *  on a phone on its side the open sheet stands beside the map over the whole height. */
export const detentPx = (d: Detent, room: number) => (d === "peek" ? (isShort() ? 40 : 58) : d === "half" ? Math.round(room * (isShort() ? 1 : 0.52)) : room);

const GLIDE: KeyframeAnimationOptions = { duration: 220, easing: "ease" };
/** How far a finger may wander on a tap, in px (a phone reports a few px of wobble). */
const SLOP = 12;
/** What the sheet showed after a commit: its height and, for a slide down, what it showed at that height. */
type Shown = { h: number; detent: Detent; children: ReactNode };
/** Sliding down: the old height and content stay until the edge is at `to` px lower; `from` px is where it starts (an edge
 *  still rising when it turned). `detent`/`height` are the caller's wish it slides towards. */
type Held = Shown & { from: number; to: number; want: { detent: Detent; height: number | null } };

export function Sheet({ detent, setDetent, height, setHeight, place, setPlace, children }: { detent: Detent; setDetent: (d: Detent) => void; /** The height it was pulled to, null: the default. */ height: number | null; setHeight: (h: number) => void;
	/** Where it stands between the page's left (0) and right edge (1), null: the default. A share, so it holds when the page changes size. */ place: number | null; setPlace: (x: number) => void; children: ReactNode }) {
	const box = useRef<HTMLElement>(null);
	const [drag, setDrag] = useState<number | null>(null);
	const [dragX, setDragX] = useState<number | null>(null);
	const start = useRef<{ x: number; y: number; h: number; place: number; peek: number; room: number; movedX: boolean; movedY: boolean } | null>(null);
	useBack(detent !== "peek", () => setDetent("peek"));
	const room = () => box.current?.parentElement?.clientHeight ?? 700;
	/** How many px of the page's width it can move over. */
	const spare = () => (box.current?.parentElement?.clientWidth ?? 0) - (box.current?.offsetWidth ?? 0);
	const placeNow = () => { const b = box.current; return b && spare() > 0 ? b.offsetLeft / spare() : place ?? 0.5; };

	// a pull sets its height once a frame, not for every move of the finger (a tablet reports 120 a second)
	const pending = useRef<{ y: number | null; x: number | null; frame: number }>({ y: null, x: null, frame: 0 });
	const soon = (y: number | null, x: number | null) => {
		const p = pending.current;
		if (y !== null) p.y = y;
		if (x !== null) p.x = x;
		if (!p.frame) p.frame = requestAnimationFrame(() => { p.frame = 0; if (p.y !== null) setDrag(p.y); if (p.x !== null) setDragX(p.x); p.y = p.x = null; });
	};
	const unsoon = () => { const p = pending.current; if (p.frame) cancelAnimationFrame(p.frame); p.frame = 0; p.y = p.x = null; };

	const shown = useRef<Shown | null>(null);
	const [held, setHeld] = useState<Held | null>(null);
	const motion = useRef<{ a: Animation; held: Held | null } | null>(null);
	/** How far the edge stands below its place now (a slide on the way), in px. */
	const offset = () => { const b = box.current; return b && motion.current ? new DOMMatrixReadOnly(getComputedStyle(b).transform).m42 : 0; };
	const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
	useLayoutEffect(() => {
		const b = box.current;
		if (!b) return;
		if (held) {
			// the caller wants something else while it slides down: from where the edge is now, there
			if (held.want.detent !== detent || held.want.height !== height || drag !== null) {
				const at = offset();
				motion.current?.a.cancel(); motion.current = null;
				shown.current = { h: held.h - at, detent: held.detent, children: held.children };
				setHeld(null);
				return;
			}
			if (motion.current?.held !== held) {
				const a = b.animate([{ transform: `translateY(${held.from}px)` }, { transform: `translateY(${held.to}px)` }], { ...GLIDE, fill: "forwards" });
				motion.current = { a, held };
				// arrived: the new height and content, the edge where the slide left it
				a.onfinish = () => { if (motion.current?.a === a) { shown.current = null; setHeld(null); } };
			}
			return;
		}
		const was = shown.current, h = b.offsetHeight;
		// the same height (new content, the page's next frame): a slide on the way goes on
		if (was && Math.abs(h - was.h) <= 1) { shown.current = { h: was.h, detent, children }; return; }
		const at = was ? offset() : 0;
		motion.current?.a.cancel(); motion.current = null;
		shown.current = { h, detent, children };
		if (!was || drag !== null || still()) return;
		const edge = was.h - at; // where the edge stood on the screen
		if (h > edge + 1) {
			const a = b.animate([{ transform: `translateY(${h - edge}px)` }, { transform: "translateY(0px)" }], GLIDE);
			motion.current = { a, held: null };
			a.onfinish = () => { if (motion.current?.a === a) motion.current = null; };
		} else if (h < edge - 1) {
			// keep the old height and content for the way down
			shown.current = was;
			setHeld({ h: was.h, detent: was.detent, children: was.children, from: at, to: was.h - h, want: { detent, height } });
		}
	});

	const showDetent = held?.detent ?? detent;
	const size = held ? { height: held.h } : drag !== null ? { height: drag } : detent === "half" && height ? { height } : {};
	return (
		<section ref={box} className={`sheet sheet-${showDetent}`} style={{ ...size, ...(dragX ?? place) !== null ? { "--sheet-x": dragX ?? place } as React.CSSProperties : {} }} aria-label="Tasche, Ereignisse und Chats">
			<button type="button" className="sheet-grab" aria-label={detent === "peek" ? "Blatt öffnen" : "Blatt schließen"}
				onPointerDown={(e) => {
					e.currentTarget.setPointerCapture(e.pointerId);
					// a slide on the way ends where the finger takes it
					const h = (held ? held.h : box.current?.offsetHeight ?? 0) - offset(), r = room();
					start.current = { x: e.clientX, y: e.clientY, h, place: placeNow(), peek: detentPx("peek", r), room: r, movedX: false, movedY: false };
				}}
				onPointerMove={(e) => { const s = start.current; if (!s) return;
					const dy = s.y - e.clientY, dx = e.clientX - s.x, span = spare();
					if (Math.abs(dy) > SLOP) s.movedY = true; // a finger wobbles on a tap: only a move past SLOP is a pull
					if (Math.abs(dx) > SLOP && span > 0) s.movedX = true;
					soon(s.movedY ? Math.max(s.peek, Math.min(s.room, s.h + dy)) : null, s.movedX ? Math.max(0, Math.min(1, s.place + dx / span)) : null);
				}}
				onPointerUp={(e) => {
					const s = start.current; start.current = null;
					if (!s) return;
					unsoon(); setDrag(null); setDragX(null);
					if (s.movedX) setPlace(Math.max(0, Math.min(1, s.place + (e.clientX - s.x) / Math.max(1, spare()))));
					if (s.movedX && !s.movedY) return;
					// a tap: closed it opens to the height it was last pulled to (kept by the caller, also over a reload), the whole height
					// before it was ever pulled; open it closes
					if (!s.movedY) { if (detent === "peek") { if (height === null) setHeight(s.room); setDetent("half"); } else setDetent("peek"); return; }
					const h = Math.max(s.peek, Math.min(s.room, s.h + s.y - e.clientY));
					// pulled down to the tabs it is closed; anywhere else it stays where the finger left it
					if (h <= s.peek + 24) { setDetent("peek"); return; }
					setHeight(h); setDetent("half");
				}}
				onPointerCancel={() => { start.current = null; unsoon(); setDrag(null); setDragX(null); }}
				// a browser that takes the capture away without an up or cancel leaves no pull hanging
				onLostPointerCapture={() => { if (start.current) { start.current = null; unsoon(); setDrag(null); setDragX(null); } }} />
			{held ? held.children : children}
		</section>
	);
}
