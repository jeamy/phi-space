"use client";
// The overview of the world, top left over the map (docs/architektur.en.md, "Übersichtskarte"): every room of the islands
// at its place, one pixel per cell, drawn once on a plain 2D canvas; on top what changes: fog, burning fires, people
// (light dots) and NPCs (dark dots), the ferries as dashed lines, the own room outlined. A tap enlarges it; the
// button folds it away (remembered per browser; on a phone it starts folded). It shows the world, it never changes it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AtlasState, AtlasView } from "../server/gateway.ts";
import { tr } from "./i18n/index.ts";

const W = 24, H = 16;
const COLORS: Record<string, string> = { "~": "#1b3a52", ".": "#cdb57e", ",": "#4d7a3c", ":": "#8b8f95" };
const SEA = "#12283a";

/** The marks of what the player owns, and their words below the map. */
const MINE: Record<AtlasState["mine"][number]["kind"], { color: string; label: string }> = {
	building: { color: "#7fd4ff", label: "Bau" }, site: { color: "#ffb02e", label: "Baustelle" }, bed: { color: "#ff7fb5", label: "Beet" }, field: { color: "#ffe066", label: "Acker" }, ruin: { color: "#b8bec6", label: "Ruine" },
};

const stored = (key: string, fallback: boolean) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === "1"; } catch { return fallback; } };
const store = (key: string, v: boolean) => { try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* private window */ } };

export function Atlas({ atlas, state, page = false, me = null, onBeam }: { atlas: AtlasView; state: AtlasState | null; /** Where the player stands in their room: the mark on the map. */ me?: { x: number; y: number } | null; /** A page of its own on a phone: it scrolls, and a tap names a room (there is no pointer to hover with). */ page?: boolean; /** Beam to the fire of a room (the page sends `beam`; the server says what it costs and whether it may). */ onBeam?: (room: string) => void }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const pin = useRef<{ x: number; y: number } | null>(null);
	const scroller = useRef<HTMLDivElement>(null);
	// on a phone it starts folded (it would cover much of the small map), until the player opens it
	const [open, setOpen] = useState(() => page || stored("mmo.atlas", typeof window === "undefined" || !window.matchMedia("(max-width: 760px)").matches));
	const [picked, setPicked] = useState<string | null>(null);
	const [big, setBig] = useState(false);
	const [hover, setHover] = useState<string | null>(null);
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
		for (const r of atlas.rooms) {
			const { px, py } = at(r);
			const fog = state?.fog[r.roomId] ?? 0;
			if (fog) { g.fillStyle = `rgba(205,210,220,${0.16 * fog})`; g.fillRect(px * s, py * s, W * s, H * s); }
			const lit = state?.lit.includes(r.roomId);
			for (const f of r.fires) {
				g.beginPath(); g.arc((px + f.x + 0.5) * s, (py + f.y + 0.5) * s, lit ? 7 : 4, 0, Math.PI * 2);
				g.fillStyle = lit ? "#ffb02e" : "#5a3b2a"; g.fill();
				if (lit) { g.beginPath(); g.arc((px + f.x + 0.5) * s, (py + f.y + 0.5) * s, 14, 0, Math.PI * 2); g.fillStyle = "rgba(255,176,46,0.25)"; g.fill(); }
			}
			const [humans = 0, npcs = 0] = state?.people[r.roomId] ?? [];
			const dots = [...Array(Math.min(humans, 6)).fill("#fff7e0"), ...Array(Math.min(npcs, 6)).fill("#2c2f36")];
			dots.forEach((color, i) => { g.beginPath(); g.arc((px + 3 + i * 2.6) * s, (py + H - 3) * s, 3.2, 0, Math.PI * 2); g.fillStyle = color; g.fill(); g.strokeStyle = "rgba(0,0,0,0.5)"; g.lineWidth = 1; g.stroke(); });
			if (r.roomId === state?.here) {
				g.strokeStyle = "#ffffff"; g.lineWidth = page ? 6 : 3; g.strokeRect(px * s + 1.5, py * s + 1.5, W * s - 3, H * s - 3);
				here = { x: (px + (me?.x ?? W / 2)) * s, y: (py + (me?.y ?? H / 2)) * s };
			}
		}
		// what the player owns: a square each, on its cell
		for (const m of state?.mine ?? []) {
			const r = byId.get(m.room);
			if (!r) continue;
			const { px, py } = at(r);
			g.fillStyle = MINE[m.kind].color; g.strokeStyle = "#101010"; g.lineWidth = 3;
			g.fillRect((px + m.x) * s - 9, (py + m.y) * s - 9, 18, 18); g.strokeRect((px + m.x) * s - 9, (py + m.y) * s - 9, 18, 18);
		}
		// the player: a mark big enough for a small screen, on top of everything but the names
		if (here) {
			g.beginPath(); g.arc(here.x, here.y, 26, 0, Math.PI * 2); g.fillStyle = "rgba(174,216,60,0.3)"; g.fill();
			g.beginPath(); g.arc(here.x, here.y, 13, 0, Math.PI * 2); g.fillStyle = "#AED83C"; g.fill(); g.lineWidth = 4; g.strokeStyle = "#101010"; g.stroke();
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
	}, [ground, state, open, atlas, me?.x, me?.y]);
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

	if (page) {
		const shown = atlas.rooms.find((r) => r.roomId === picked) ?? here;
		const [humans = 0, npcs = 0] = (shown && state?.people[shown.roomId]) || [];
		const mine = state?.mine ?? [], inRoom = mine.filter((m) => m.room === shown?.roomId), kinds = (Object.keys(MINE) as Array<keyof typeof MINE>).filter((k) => mine.some((m) => m.kind === k));
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
					{onBeam && shown && shown.roomId !== state?.here && state?.lit.includes(shown.roomId) && <button className="primary" onClick={() => onBeam(shown.roomId)}>Hierher beamen</button>}
				</div>
				{kinds.length > 0 && <div className="atlas-legend">{kinds.map((k) => <span key={k}><i style={{ background: MINE[k].color }} />{MINE[k].label}</span>)}</div>}
			</div>
		);
	}

	return (
		<div className={`atlas${big ? " big" : ""}${open ? "" : " folded"}`}>
			<button className="atlas-toggle" onClick={toggle} aria-expanded={open} title={open ? "Übersichtskarte einklappen" : "Übersichtskarte zeigen"}>{open ? "▾" : "▸"} Karte</button>
			{open && <>
				<canvas ref={canvas} aria-label={`Übersichtskarte${here ? `, du bist in ${here.name} (${here.island})` : ""}`} role="img"
					onClick={() => setBig((b) => !b)}
					onPointerMove={(e) => setHover(roomAt(e)?.roomId ?? null)} onPointerLeave={() => setHover(null)} />
				{label && <div className="atlas-label">{label.name} · {label.island}</div>}
			</>}
		</div>
	);
}
