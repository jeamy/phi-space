"use client";
// Language (DE/EN), mode (dark/light) and palette: the controls on the right of the top bar, like in the help system.
import { PALETTES } from "./lib/palettes.ts";
import type { Lang, Mode } from "./lib/theme.ts";

export function ThemeControls({ lang, setLang, mode, changeMode, palette, changePalette }: { lang: Lang; setLang: (l: Lang) => void; mode: Mode; changeMode: (m: Mode) => void; palette: string; changePalette: (p: string) => void }) {
	return (
		<div className="theme-controls">
			<div className="locale-switch" role="group" aria-label="Language">
				<button type="button" className={lang === "de" ? "is-active" : ""} onClick={() => setLang("de")}>DE</button>
				<button type="button" className={lang === "en" ? "is-active" : ""} onClick={() => setLang("en")}>EN</button>
			</div>
			<div className="mode-switch" role="group" aria-label="Mode">
				<button type="button" className={mode === "dark" ? "is-active" : ""} onClick={() => changeMode("dark")} title="Dark Mode">☾</button>
				<button type="button" className={mode === "light" ? "is-active" : ""} onClick={() => changeMode("light")} title="Light Mode">☀</button>
			</div>
			<div className="theme-picker">
				<select className="theme-picker__select" value={palette} onChange={(e) => changePalette(e.target.value)} aria-label="Color Palette">
					{PALETTES.map((p) => <option key={p.id} value={p.id}>{p.label[lang]}</option>)}
				</select>
			</div>
		</div>
	);
}
