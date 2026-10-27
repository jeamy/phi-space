"use client";
// Light/dark mode and color palette, as in the help system and codemode-chat: stored in the browser, applied to the
// document (data-mode and the palette's colors as CSS variables, client/lib/palettes.ts).
import { useEffect, useState } from "react";
import { applyThemeToDocument, PALETTES } from "./palettes.ts";

export type Mode = "dark" | "light";

const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } };

export function useTheme() {
	const [mode, setMode] = useState<Mode>("dark");
	const [palette, setPalette] = useState<string>(PALETTES[0]!.id);
	useEffect(() => {
		const m = read("mmo.mode");
		setMode(m === "dark" || m === "light" ? m : window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
		const p = read("mmo.palette"); if (p && PALETTES.some((x) => x.id === p)) setPalette(p);
	}, []);
	useEffect(() => { applyThemeToDocument(mode, palette); }, [mode, palette]);
	return {
		mode, palette,
		changeMode: (m: Mode) => { setMode(m); write("mmo.mode", m); },
		changePalette: (p: string) => { setPalette(p); write("mmo.palette", p); },
	};
}
