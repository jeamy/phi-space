"use client";
// The arrow keys and the space bar for a touch screen: a cross over the map that walks while a direction is held, and the
// action in its middle. Shown only where the main pointer is a finger (styles.css, `.touchpad`); a tap on a cell still
// walks there, the cross is for walking step by step.

type Dir = [number, number];
const DIRS: Array<{ d: Dir; label: string; glyph: string; area: string }> = [
	{ d: [0, -1], label: "Nach oben gehen", glyph: "▲", area: "up" },
	{ d: [-1, 0], label: "Nach links gehen", glyph: "◀", area: "left" },
	{ d: [1, 0], label: "Nach rechts gehen", glyph: "▶", area: "right" },
	{ d: [0, 1], label: "Nach unten gehen", glyph: "▼", area: "down" },
];

export function TouchPad({ hold, release, action }: { hold: (d: Dir) => void; release: (d?: Dir) => void; action: () => void }) {
	return (
		<div className="touchpad" role="group" aria-label="Steuerkreuz">
			{DIRS.map(({ d, label, glyph, area }) => (
				<button key={area} type="button" style={{ gridArea: area }} aria-label={label}
					onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); hold(d); }}
					onPointerUp={() => release(d)} onPointerCancel={() => release(d)} onLostPointerCapture={() => release(d)}
					onContextMenu={(e) => e.preventDefault()}>{glyph}</button>
			))}
			<button type="button" className="touchpad-act" style={{ gridArea: "act" }} aria-label="Aufheben oder nachlegen (Leertaste)"
				onPointerDown={(e) => { e.preventDefault(); action(); }} onContextMenu={(e) => e.preventDefault()}>✋</button>
		</div>
	);
}
