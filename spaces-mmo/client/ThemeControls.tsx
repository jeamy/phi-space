"use client";
// Mode (dark/light) and palette: the controls of the help system's top bar (the game's texts are German; its help has its
// own language switch).
import { PALETTES } from "./lib/palettes.ts";
import type { Mode } from "./lib/theme.ts";

export function ThemeControls({ mode, changeMode, palette, changePalette }: { mode: Mode; changeMode: (m: Mode) => void; palette: string; changePalette: (p: string) => void }) {
	return (
		<div className="theme-controls">
			<div className="mode-switch" role="group" aria-label="Hell oder dunkel">
				<button type="button" className={mode === "dark" ? "is-active" : ""} onClick={() => changeMode("dark")} title="Dunkel">☾</button>
				<button type="button" className={mode === "light" ? "is-active" : ""} onClick={() => changeMode("light")} title="Hell">☀</button>
			</div>
			<select className="theme-picker__select" value={palette} onChange={(e) => changePalette(e.target.value)} aria-label="Farbpalette">
				{PALETTES.map((p) => <option key={p.id} value={p.id}>{p.label.de}</option>)}
			</select>
		</div>
	);
}
