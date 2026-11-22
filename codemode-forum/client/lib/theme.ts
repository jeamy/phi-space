"use client";
// Language, light/dark mode and color palette: stored in the browser, applied to the document (same palettes as the
// help system). Taken over from codemode-chat.
import { useCallback, useEffect, useState } from "react";
import { applyThemeToDocument, PALETTES } from "./palettes.ts";

export type Lang = "de" | "en";
export type Mode = "dark" | "light";

const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } };

export function useTheme(initialLang?: Lang) {
	const [lang, setLangState] = useState<Lang>(initialLang ?? "en");
	const [mode, setMode] = useState<Mode>("dark");
	const [palette, setPalette] = useState<string>(PALETTES[0]!.id);
	useEffect(() => {
		if (!initialLang) { const l = read("forum.lang"); setLangState(l === "de" || l === "en" ? l : navigator.language.startsWith("de") ? "de" : "en"); }
		const m = read("forum.mode"); if (m === "dark" || m === "light") setMode(m);
		const p = read("forum.palette"); if (p && PALETTES.some((x) => x.id === p)) setPalette(p);
	}, [initialLang]);
	useEffect(() => { applyThemeToDocument(mode, palette); }, [mode, palette]);
	const setLang = useCallback((l: Lang) => { setLangState(l); write("forum.lang", l); document.documentElement.lang = l; }, []);
	return {
		lang, setLang, mode, palette,
		changeMode: (m: Mode) => { setMode(m); write("forum.mode", m); },
		changePalette: (p: string) => { setPalette(p); write("forum.palette", p); },
	};
}
