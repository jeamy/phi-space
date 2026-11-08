"use client";
// The overview of the world, top left over the map (docs/architektur.en.md, "Übersichtskarte"): every room of the islands
// at its place, one pixel per cell, drawn once on a plain 2D canvas; on top what changes: fog, burning fires, people
// (light dots) and NPCs (dark dots), the ferries as dashed lines, the own room outlined. A tap enlarges it; the
// button folds it away (remembered per browser; on a phone it starts folded). It shows the world, it never changes it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AtlasState, AtlasView } from "../shared/frames.ts";
import { alongWay, seaWays, shipState, type Timetable } from "../shared/liner.ts";
import { tr } from "./i18n/index.ts";

const W = 24, H = 16;
const COLORS: Record<string, string> = { "~": "#1b3a52", ".": "#cdb57e", ",": "#4d7a3c", ":": "#8b8f95" };
const SEA = "#12283a";

/** The marks of what the player owns, and their words below the map. */
const MINE: Record<AtlasState["mine"][number]["kind"], { color: string; label: string }> = {
	building: { color: "#7fd4ff", label: "Bau" }, site: { color: "#ffb02e", label: "Baustelle" }, bed: { color: "#ff7fb5", label: "Beet" }, field: { color: "#ffe066", label: "Acker" }, ruin: { color: "#b8bec6", label: "Ruine" },
};

/** The round marks of the map, with the colours they are drawn in (below). */
const DOTS = [["#AED83C", "Du"], ["#ffb02e", "Feuer brennt"], ["#5a3b2a", "Feuer aus"], ["#fff7e0", "Personen"], ["#2c2f36", "NPCs"]] as const;

/** What the colours on the map mean: the round marks (the player, the fires, who is in a room) and the squares of the
 *  player's own things, each kind with how many it has (dimmed the kinds it has none of yet). */
function Legend({ mine }: { mine: AtlasState["mine"] }) {
	return (
		<div className="atlas-legend" aria-label="Legende">
			{DOTS.map(([color, label]) => <span key={label}><i className="dot" style={{ background: color }} />{label}</span>)}
			{(Object.keys(MINE) as Array<keyof typeof MINE>).map((k) => { const n = mine.filter((m) => m.kind === k).length; return <span key={k} className={n ? "" : "none"}><i style={{ background: MINE[k].color }} />{MINE[k].label}{n ? ` (${n})` : null}</span>; })}
		</div>
	);
}

const stored = (key: string, fallback: boolean) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === "1"; } catch { return fallback; } };
const store = (key: string, v: boolean) => { try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* private window */ } };

export function Atlas({ atlas, state, ship = null, page = false, me = null, onBeam }: { atlas: AtlasView; state: AtlasState | null; /** The large ship's timetable and the world time now: its route and where it is on it. */ ship?: { t: Timetable; now: () => number } | null; /** Where the player stands in their room: the mark on the map. */ me?: { x: number; y: number } | null; /** A page of its own on a phone: it scrolls, and a tap names a room (there is no pointer to hover with). */ page?: boolean; /** Beam to the fire of a room (the page sends `beam`; the server says what it costs and whether it may). */ onBeam?: (room: string) => void }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const pin = useRef<{ x: number; y: number } | null>(null);
	const scroller = useRef<HTMLDivElement>(null);
	// on a phone it starts folded (it would cover much of the small map), until the player opens it
	const [open, setOpen] = useState(() => page || stored("mmo.atlas", typeof window === "undefined" || !window.matchMedia("(max-width: 760px)").matches));
	const [picked, setPicked] = useState<string | null>(null);
	const [big, setBig] = useState(false);
	const [hover, setHover] = useState<string | null>(null);
	// the ship moves on the map: redrawn every few seconds
	const [shipTick, setShipTick] = useState(0);
	useEffect(() => { if (!ship || !open) return; const id = setInterval(() => setShipTick((n) => n + 1), 3000); return () => clearInterval(id); }, [!!ship, open]);
	const box = useMemo(() => {
		const xs = atlas.rooms.map((r) => r.x), ys = atlas.rooms.map((r) => r.y);
		return { x0: Math.min(...xs), y0: Math.min(...ys), cols: Math.max(...xs) - Math.min(...xs) + 1, rows: Math.max(...ys) - Math.min(...ys) + 1 };
	}, [atlas]);
	const at = (r: { x: number; y: number }) => ({ px: (r.x - box.x0) * W, py: (r.y - box.y0) * H });
	// the ground, drawn once into an offscreen canvas
	const ground = useMemo(() => {
		if (typeof document === "undefined") return null;
		const c = document.createElement("canvas");
		c.width = box.cols * W; c.height = box.rows * H;
		const g = c.getContext("2d")!;
		g.fillStyle = SEA; g.fillRect(0, 0, c.width, c.height);
		for (const r of atlas.rooms) {
			const { px, py } = at(r);
			r.ground.forEach((row, y) => [...row].forEach((t, x) => { g.fillStyle = COLORS[t] ?? "#555"; g.fillRect(px + x, py + y, 1, 1); }));
		}
		return c;
	}, [atlas, box]);
	// the ship's way over the water, leg by leg (a pixel per cell, as the ground): not over the islands
	const ways = useMemo(() => {
		if (!ship) return null;
		const wet = new Uint8Array(box.cols * W * box.rows * H).fill(1);
		for (const r of atlas.rooms) {
			const { px, py } = at(r);
			r.ground.forEach((row, y) => [...row].forEach((t, x) => { if (px + x < box.cols * W && py + y < box.rows * H) wet[(py + y) * box.cols * W + px + x] = t === "~" ? 1 : 0; }));
		}
		return seaWays(ship.t, box.cols * W, box.rows * H, (x, y) => wet[y * box.cols * W + x] === 1, (st) => ({ x: (st.x - box.x0 + 0.5) * W, y: (st.y - box.y0 + 0.5) * H }));
	}, [atlas, box, ship?.t]);

	useEffect(() => {
		const c = canvas.current, src = ground;
		if (!c || !src || !open) return;
		const s = 3; // drawing scale: one cell is 3×3 pixels, sharp at any CSS size
		c.width = src.width * s; c.height = src.height * s;
		const g = c.getContext("2d")!;
		g.imageSmoothingEnabled = false;
		g.drawImage(src, 0, 0, c.width, c.height);
		const byId = new Map(atlas.rooms.map((r) => [r.roomId, r]));
		let here: { x: number; y: number } | null = null;
		// ferries: links between rooms that are not side by side
		g.save(); g.setLineDash([6, 5]); g.strokeStyle = "rgba(230,230,240,0.55)"; g.lineWidth = 2;
		for (const [a, b] of atlas.links) {
			const ra = byId.get(a), rb = byId.get(b);
			if (!ra || !rb || Math.abs(ra.x - rb.x) + Math.abs(ra.y - rb.y) === 1) continue;
			const pa = at(ra), pb = at(rb);
			g.beginPath(); g.moveTo((pa.px + W / 2) * s, (pa.py + H / 2) * s); g.lineTo((pb.px + W / 2) * s, (pb.py + H / 2) * s); g.stroke();
		}
		g.restore();
		// the large ship's route, a loop over the bays, and the ship on it (engine/liner.ts: a function of the world time)
		if (ship) {
			// a point of a way (fine cells) on the canvas
			const c = (p: { x: number; y: number }) => ({ x: (p.x + 0.5) * s, y: (p.y + 0.5) * s });
			g.save(); g.setLineDash([3, 7]); g.strokeStyle = "rgba(255,224,150,0.5)"; g.lineWidth = 2; g.beginPath();
			for (const way of ways ?? []) way.forEach((p, i) => { const q = c(p); if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); });
			g.stroke(); g.restore();
			// lying in a bay it waits at the start of its next leg, sailing it is that far along its way
			const st = shipState(ship.t, ship.now()), on = alongWay(ways![st.from]!, st.lies !== null ? 0 : st.f), q = c(on), bow = c(on.ahead);
			const ang = Math.atan2(bow.y - q.y, bow.x - q.x);
			g.save(); g.translate(q.x, q.y); g.rotate(st.lies !== null ? 0 : ang);
			g.fillStyle = "#2a2f38"; g.strokeStyle = "#ece6d6"; g.lineWidth = 3;
			g.beginPath(); g.moveTo(16, 0); g.lineTo(6, -8); g.lineTo(-14, -8); g.lineTo(-14, 8); g.lineTo(6, 8); g.closePath(); g.fill(); g.stroke();
			g.fillStyle = "#ece6d6"; g.fillRect(-6, -4, 8, 8);
			g.restore();
		}
		for (const r of atlas.rooms) {
			const { px, py } = at(r);
			const fog = state?.fog[r.roomId] ?? 0;
			if (fog) { g.fillStyle = `rgba(205,210,220,${0.16 * fog})`; g.fillRect(px * s, py * s, W * s, H * s); }
			const lit = state?.lit.includes(r.roomId);
			for (const f of r.fires) {
				g.beginPath(); g.arc((px + f.x + 0.5) * s, (py + f.y + 0.5) * s, lit ? 7 : 4, 0, Math.PI * 2);
				g.fillStyle = lit ? DOTS[1][0] : DOTS[2][0]; g.fill();
				if (lit) { g.beginPath(); g.arc((px + f.x + 0.5) * s, (py + f.y + 0.5) * s, 14, 0, Math.PI * 2); g.fillStyle = "rgba(255,176,46,0.25)"; g.fill(); }
			}
			const [humans = 0, npcs = 0] = state?.people[r.roomId] ?? [];
			const dots = [...Array(Math.min(humans, 6)).fill(DOTS[3][0]), ...Array(Math.min(npcs, 6)).fill(DOTS[4][0])];
			dots.forEach((color, i) => { g.beginPath(); g.arc((px + 3 + i * 2.6) * s, (py + H - 3) * s, 3.2, 0, Math.PI * 2); g.fillStyle = color; g.fill(); });
			if (r.roomId === state?.here) {
				g.strokeStyle = "#ffffff"; g.lineWidth = page ? 6 : 3; g.strokeRect(px * s + 1.5, py * s + 1.5, W * s - 3, H * s - 3);
				here = { x: (px + (me?.x ?? W / 2)) * s, y: (py + (me?.y ?? H / 2)) * s };
			}
		}
		// what the player owns: a small square each, on its cell, without a frame (many side by side stay apart)
		for (const m of state?.mine ?? []) {
			const r = byId.get(m.room);
			if (!r) continue;
			const { px, py } = at(r);
			g.fillStyle = MINE[m.kind].color;
			g.fillRect((px + m.x) * s - 5, (py + m.y) * s - 5, 10, 10);
		}
		// the picked target: outlined, and a dashed line to it from where the player stands (beaming goes this way)
		const target = picked ? byId.get(picked) : null;
		if (target && target.roomId !== state?.here) {
			const { px, py } = at(target), lit = !!state?.lit.includes(target.roomId);
			g.strokeStyle = lit ? "#AED83C" : "#ff8a6a"; g.lineWidth = page ? 6 : 3; g.strokeRect(px * s + 1.5, py * s + 1.5, W * s - 3, H * s - 3);
			if (here) {
				g.save(); g.setLineDash([14, 10]); g.lineWidth = page ? 6 : 4; g.beginPath(); g.moveTo(here.x, here.y); g.lineTo((px + W / 2) * s, (py + H / 2) * s); g.stroke(); g.restore();
			}
		}
		// the player: a mark big enough for a small screen, on top of everything but the names
		if (here) {
			g.beginPath(); g.arc(here.x, here.y, 16, 0, Math.PI * 2); g.fillStyle = "rgba(174,216,60,0.3)"; g.fill();
			g.beginPath(); g.arc(here.x, here.y, 8, 0, Math.PI * 2); g.fillStyle = DOTS[0][0]; g.fill();
			pin.current = here;
		}
		// the islands' names, above each island
		g.font = "bold 16px system-ui, sans-serif"; g.textAlign = "center";
		const islands = new Map<string, { x0: number; x1: number; y0: number }>();
		for (const r of atlas.rooms) { const i = islands.get(r.island); const { px, py } = at(r); islands.set(r.island, i ? { x0: Math.min(i.x0, px), x1: Math.max(i.x1, px + W), y0: Math.min(i.y0, py) } : { x0: px, x1: px + W, y0: py }); }
		for (const [name, b] of islands) {
			if (!name) continue;
			const x = ((b.x0 + b.x1) / 2) * s, y = b.y0 * s + 14;
			g.lineWidth = 3; g.strokeStyle = "rgba(0,0,0,0.75)"; const shown = tr(name); g.strokeText(shown, x, y); g.fillStyle = "#f2efe6"; g.fillText(shown, x, y);
		}
	}, [ground, state, open, atlas, me?.x, me?.y, picked, ship?.t, shipTick, ways]);
	// the page opens on the player
	useEffect(() => {
		const b = scroller.current, c = canvas.current, p = pin.current;
		if (!page || !b || !c || !p) return;
		const k = c.getBoundingClientRect().width / c.width;
		b.scrollTo({ left: p.x * k - b.clientWidth / 2, top: p.y * k - b.clientHeight / 2 });
	}, [page, big, !!state]);

	/** The room under the pointer, for the label below the map. */
	const roomAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const rect = e.currentTarget.getBoundingClientRect();
		const cx = ((e.clientX - rect.left) / rect.width) * box.cols, cy = ((e.clientY - rect.top) / rect.height) * box.rows;
		return atlas.rooms.find((r) => r.x - box.x0 === Math.floor(cx) && r.y - box.y0 === Math.floor(cy)) ?? null;
	};
	const toggle = () => { setOpen((o) => { store("mmo.atlas", !o); return !o; }); };
	const here = atlas.rooms.find((r) => r.roomId === state?.here);
	const label = hover ? atlas.rooms.find((r) => r.roomId === hover) : here;
	/** What beaming to `room` costs from where the player stands: the fields between the two rooms on the map, at least one, at the admin's price. */
	const beamCoins = (room: { x: number; y: number }) => (here ? Math.max(1, Math.abs(room.x - here.x) + Math.abs(room.y - here.y)) : 1) * (state?.beamCost ?? 1);
	const beamButton = (room: { roomId: string; x: number; y: number }) => {
		if (!onBeam || room.roomId === state?.here || !state?.lit.includes(room.roomId)) return null;
		const n = beamCoins(room);
		return <button className="primary" onClick={() => { onBeam(room.roomId); setPicked(null); if (!page) setBig(false); }}>Hierher beamen · {n} {n === 1 ? "Münze" : "Münzen"}</button>;
	};

	if (page) {
		const shown = atlas.rooms.find((r) => r.roomId === picked) ?? here;
		const [humans = 0, npcs = 0] = (shown && state?.people[shown.roomId]) || [];
		const mine = state?.mine ?? [], inRoom = mine.filter((m) => m.room === shown?.roomId);
		return (
			<div className="atlas-page">
				<div className="atlas-scroll" ref={scroller}>
					<canvas ref={canvas} className={big ? "big" : ""} role="img" aria-label={`Übersichtskarte${here ? `, du bist in ${here.name} (${here.island})` : ""}`} onClick={(e) => setPicked(roomAt(e as unknown as React.PointerEvent<HTMLCanvasElement>)?.roomId ?? null)} />
				</div>
				<div className="atlas-info">
					<div><b>{shown ? `${shown.name} · ${shown.island}` : ""}</b>
						<small>{shown?.roomId === state?.here ? "Du bist hier · " : ""}{shown && state?.lit.includes(shown.roomId) ? "Feuer brennt · " : ""}{humans} Personen, {npcs} NPCs</small>
						{inRoom.length > 0 && <small>Deins hier: {inRoom.map((m) => m.name).join(", ")}</small>}</div>
					<button onClick={() => setBig((b) => !b)}>{big ? "Kleiner" : "Größer"}</button>
					{shown && beamButton(shown)}
				</div>
				<Legend mine={mine} />
			</div>
		);
	}

	return (
		<div className={`atlas${big ? " big" : ""}${open ? "" : " folded"}`}>
			<button className="atlas-toggle" onClick={toggle} aria-expanded={open} title={open ? "Übersichtskarte einklappen" : "Übersichtskarte zeigen"}>{open ? "▾" : "▸"} Karte</button>
			{open && <>
				<canvas ref={canvas} aria-label={`Übersichtskarte${here ? `, du bist in ${here.name} (${here.island})` : ""}`} role="img"
					onClick={(e) => { if (!big) setBig(true); else setPicked(roomAt(e as unknown as React.PointerEvent<HTMLCanvasElement>)?.roomId ?? null); }}
					onPointerMove={(e) => setHover(roomAt(e)?.roomId ?? null)} onPointerLeave={() => setHover(null)} />
				{label && !(big && picked) && <div className="atlas-label">{label.name} · {label.island}</div>}
				{(big || (state?.mine.length ?? 0) > 0) && <Legend mine={state?.mine ?? []} />}
				{big && picked && (() => { const r = atlas.rooms.find((x) => x.roomId === picked); return r ? <div className="atlas-info"><div><b>{r.name} · {r.island}</b><small>{state?.lit.includes(r.roomId) ? "Feuer brennt" : "Das Feuer ist aus"}</small></div>{beamButton(r)}<button onClick={() => setBig(false)}>Kleiner</button></div> : null; })()}
			</>}
		</div>
	);
}
