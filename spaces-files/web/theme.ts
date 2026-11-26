/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The theme of every page of spaces-files (the signed-in page, the recovery page and the pages server/http.ts renders):
// the PHI-SPACES palettes of the other projects (palettes.ts, a checked copy) in dark or light mode, remembered in this
// browser; without a choice the mode follows prefers-color-scheme. Each `.theme-controls` element on the page gets the
// mode switch and the palette select, as in the dashboard and the projects.
import { applyThemeToDocument, PALETTES } from "./palettes.ts";

const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } };

let mode = read("files.mode") ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
if (mode !== "dark" && mode !== "light") mode = "dark";
let palette = read("files.palette") ?? PALETTES[0]!.id;
if (!PALETTES.some((p) => p.id === palette)) palette = PALETTES[0]!.id;
const lang = document.documentElement.lang === "de" ? "de" : "en";

function apply(): void {
	applyThemeToDocument(mode as "dark" | "light", palette);
	for (const b of document.querySelectorAll<HTMLButtonElement>(".mode-switch button")) {
		const on = b.dataset.mode === mode;
		b.classList.toggle("is-active", on);
		b.setAttribute("aria-pressed", String(on));
	}
	for (const s of document.querySelectorAll<HTMLSelectElement>(".theme-picker__select")) s.value = palette;
}

for (const host of document.querySelectorAll<HTMLElement>(".theme-controls")) {
	const sw = document.createElement("div");
	sw.className = "mode-switch";
	sw.setAttribute("role", "group");
	sw.setAttribute("aria-label", "Mode");
	for (const [m, icon, title] of [["dark", "☾", "Dark mode"], ["light", "☀", "Light mode"]] as const) {
		const b = document.createElement("button");
		b.type = "button";
		b.dataset.mode = m;
		b.title = title;
		b.textContent = icon;
		b.onclick = () => { mode = m; write("files.mode", m); apply(); };
		sw.append(b);
	}
	const sel = document.createElement("select");
	sel.className = "theme-picker__select";
	sel.setAttribute("aria-label", "Color palette");
	for (const p of PALETTES) {
		const o = document.createElement("option");
		o.value = p.id;
		o.textContent = p.label[lang];
		sel.append(o);
	}
	sel.onchange = () => { palette = sel.value; write("files.palette", palette); apply(); };
	host.replaceChildren(sw, sel);
}
apply();
