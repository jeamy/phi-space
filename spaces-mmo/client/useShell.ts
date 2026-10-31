"use client";
// What the page has to know of the screen: the game is one frame everywhere, the map over the whole page and the rest in a sheet.
import { useEffect } from "react";

/** A phone on its side: the sheet's lowest height is its tabs alone (styles.css has the same query). */
const SHORT = "(max-height: 500px) and (orientation: landscape)";
export const isShort = () => typeof window !== "undefined" && matchMedia(SHORT).matches;

/** The visible part of the page as `--vv-top` and `--vv-h`: the frame follows it. On an iPhone the keyboard and Safari's bars
 *  change neither the layout viewport nor dvh, and a focused field pushes the page up; Android does the same to the visual
 *  viewport, so this is one way for both. */
export function useKeyboardInset(): void {
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const root = document.documentElement.style;
		const on = () => { root.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`); root.setProperty("--vv-h", `${Math.round(vv.height)}px`); };
		// the keyboard gone, Safari leaves the page scrolled
		const back = () => { setTimeout(() => { window.scrollTo(0, 0); on(); }, 60); };
		on();
		vv.addEventListener("resize", on); vv.addEventListener("scroll", on); window.addEventListener("focusout", back);
		return () => { vv.removeEventListener("resize", on); vv.removeEventListener("scroll", on); window.removeEventListener("focusout", back); root.removeProperty("--vv-top"); root.removeProperty("--vv-h"); };
	}, []);
}

/** A game on a phone's page holds still: no rubber band, no zoom of the page by a pinch (Safari ignores the viewport's and,
 *  on what is not the map, touch-action), no double-tap zoom. */
export function usePageHeld(on: boolean): void {
	useEffect(() => {
		if (!on) return;
		const stop = (e: Event) => e.preventDefault();
		document.documentElement.classList.add("page-held");
		document.addEventListener("gesturestart", stop);
		return () => { document.documentElement.classList.remove("page-held"); document.removeEventListener("gesturestart", stop); };
	}, [on]);
}

/** The page without the browser's bars. iPhones have no such thing: there only "Zum Home-Bildschirm" does it. */
/** A phone's browser, not the game opened from the home screen: how to put it there, in the words of that phone. */
export function homeSteps(): { first: string; then: string } | null {
	if (typeof navigator === "undefined") return null;
	const home = (navigator as Navigator & { standalone?: boolean }).standalone || matchMedia("(display-mode: standalone)").matches || (matchMedia("(display-mode: fullscreen)").matches && !document.fullscreenElement);
	if (home) return null;
	return /iPhone|iPod/.test(navigator.userAgent) ? { first: "Teilen", then: "Zum Home-Bildschirm" } : /Android/.test(navigator.userAgent) ? { first: "Browser-Menü ⋮", then: "Zum Startbildschirm hinzufügen" } : null;
}
export const canFullscreen = () => typeof document !== "undefined" && !!document.documentElement.requestFullscreen;
export const enterFullscreen = () => { if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {}); };

/** A phone on its side goes to full screen at the next touch (a browser allows it only inside a touch), unless switched off. */
export function useLandscapeFullscreen(on: boolean): void {
	useEffect(() => {
		if (!on) return;
		const touch = () => { if (isShort()) enterFullscreen(); };
		window.addEventListener("pointerup", touch, true);
		return () => window.removeEventListener("pointerup", touch, true);
	}, [on]);
}

export const isTouch = () => typeof window !== "undefined" && matchMedia("(pointer: coarse)").matches;
