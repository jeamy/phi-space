"use client";
// The "Figur" panel: the player picks the look of their figure in 3D (server/engine/appearance.ts) and sees it turn in a
// small preview before it goes out as one `avatar` command (one command, not one per click: the command bucket).
import { useEffect, useRef, useState } from "react";
import { appearanceLine, COATS, DEFAULT_APPEARANCE, FIGURES, HAIRS, HATS, SKINS, type Appearance } from "../shared/appearance.ts";
import { makeFigure, animateFigure, type Figure } from "./figure3d.ts";

type T = typeof import("three");
type Preview = { t: T; renderer: import("three").WebGLRenderer; scene: import("three").Scene; camera: import("three").PerspectiveCamera; fig: Figure | null; frame: number };

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

export function AvatarPanel({ charId, look, send, onDone }: { charId: string; look: Appearance | undefined; send: (line: string, echo?: boolean) => void; onDone: () => void }) {
	const [a, setA] = useState<Appearance>(look ?? DEFAULT_APPEARANCE);
	const canvas = useRef<HTMLCanvasElement>(null), view = useRef<Preview | null>(null), [failed, setFailed] = useState(false);
	const set = <K extends keyof Appearance>(k: K, v: Appearance[K]) => setA((x) => ({ ...x, [k]: v }));

	useEffect(() => {
		let gone = false;
		void import("three").then((t) => {
			if (gone || !canvas.current) return;
			let renderer: import("three").WebGLRenderer;
			try { renderer = new t.WebGLRenderer({ canvas: canvas.current, antialias: true, alpha: true }); } catch { setFailed(true); return; }
			renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
			const scene = new t.Scene(), camera = new t.PerspectiveCamera(30, 1, 0.05, 20);
			scene.add(new t.HemisphereLight(0xfff4e0, 0x40382c, 1.6));
			const sun = new t.DirectionalLight(0xffffff, 2.2); sun.position.set(1.5, 3, 2.5); scene.add(sun);
			camera.position.set(0, 0.85, 3.1); camera.lookAt(0, 0.62, 0);
			const v: Preview = { t, renderer, scene, camera, fig: null, frame: 0 };
			view.current = v;
			let last = performance.now();
			const tick = (now: number) => {
				const c = canvas.current;
				if (!c || gone) return;
				const w = c.clientWidth, h = c.clientHeight;
				if (c.width !== Math.round(w * renderer.getPixelRatio()) || c.height !== Math.round(h * renderer.getPixelRatio())) { renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); }
				const dt = Math.min(0.1, (now - last) / 1000); last = now;
				if (v.fig) { animateFigure(v.fig, 0, 0, dt, now / 1000); v.fig.group.rotation.y = now / 2600; }
				renderer.render(scene, camera);
				v.frame = requestAnimationFrame(tick);
			};
			v.frame = requestAnimationFrame(tick);
			build(v, charId, a);
		}).catch(() => setFailed(true));
		return () => {
			gone = true;
			const v = view.current; view.current = null;
			if (!v) return;
			cancelAnimationFrame(v.frame);
			if (v.fig) drop(v.fig.group);
			v.renderer.dispose(); v.renderer.forceContextLoss();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	useEffect(() => { if (view.current) build(view.current, charId, a); }, [a, charId]);

	const row = (label: string, names: readonly string[], value: number, pick: (i: number) => void, colors?: readonly number[]) => (
		<div className="avatar-row">
			<span>{label}</span>
			<div className="avatar-choices" role="group" aria-label={label}>
				{names.map((n, i) => colors
					? <button key={n} type="button" className="avatar-swatch" aria-pressed={value === i} title={n} aria-label={n} style={{ background: hex(colors[i]!) }} onClick={() => pick(i)} />
					: <button key={n} type="button" aria-pressed={value === i} onClick={() => pick(i)}>{n}</button>)}
			</div>
		</div>
	);
	const toggle = (label: string, value: boolean, pick: (v: boolean) => void) => (
		<div className="avatar-row">
			<span>{label}</span>
			<div className="avatar-choices" role="group" aria-label={label}>
				<button type="button" aria-pressed={!value} onClick={() => pick(false)}>Ohne</button>
				<button type="button" aria-pressed={value} onClick={() => pick(true)}>Mit</button>
			</div>
		</div>
	);
	return (
		<div className="panel avatar">
			<h2>Deine Figur</h2>
			{failed ? <p className="muted" style={{ margin: 0, fontSize: "max(13px, var(--min-font))" }}>Die Vorschau braucht WebGL; die Wahl gilt trotzdem.</p> : <canvas ref={canvas} className="avatar-preview" aria-label="Vorschau der Figur" />}
			{row("Figur", FIGURES, a.body, (i) => set("body", i))}
			{row("Kleidung", COATS.map((c) => c.name), a.coat, (i) => set("coat", i), COATS.map((c) => c.color))}
			{row("Haarfarbe", HAIRS.map((c) => c.name), a.hair, (i) => set("hair", i), HAIRS.map((c) => c.color))}
			{row("Haut", SKINS.map((c) => c.name), a.skin, (i) => set("skin", i), SKINS.map((c) => c.color))}
			{row("Kopf", HATS.map((h, i) => (i === 0 ? "Ohne" : h)), a.hat, (i) => set("hat", i))}
			{toggle("Brille", a.glasses, (v) => set("glasses", v))}
			{toggle("Handschuhe", a.gloves, (v) => set("gloves", v))}
			<p className="muted" style={{ margin: 0, fontSize: "max(12px, var(--min-font))" }}>So sehen dich alle auf der 3D-Karte.</p>
			<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
				<button className="primary" onClick={() => { send(`avatar ${appearanceLine(a)}`, false); onDone(); }}>Übernehmen</button>
				{look && <button onClick={() => { send("avatar zurück", false); onDone(); }}>Wie zu Beginn</button>}
			</div>
		</div>
	);
}

function build(v: Preview, charId: string, a: Appearance): void {
	if (v.fig) { v.scene.remove(v.fig.group); drop(v.fig.group); }
	const fig = makeFigure(v.t, { id: charId, skin: 0, own: false, ai: false, style: a });
	// up close: the details the map shows only near (eyebrows, ears, buckle) are on here
	fig.group.traverse((o) => { if (o.userData.detailOnly) o.visible = true; });
	fig.group.children.filter((o) => (o as import("three").Mesh).isMesh && o !== fig.body).forEach((o) => { o.visible = false; }); // no shadow disc in the air
	v.scene.add(fig.group); v.fig = fig;
}

function drop(root: import("three").Object3D): void {
	root.traverse((o) => {
		const m = o as import("three").Mesh;
		if (m.geometry) m.geometry.dispose();
		for (const mat of m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : []) {
			const map = (mat as import("three").MeshBasicMaterial).map;
			if (map && !map.userData.shared) map.dispose();
			mat.dispose();
		}
	});
}
