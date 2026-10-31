"use client";
// The back gesture of a phone closes the topmost layer (a sheet, the help, a menu) instead of leaving the game. Every open
// layer is one entry in the browser's history; a layer closed some other way takes its entry back out.
import { useEffect, useRef } from "react";

const layers: Array<{ close: () => void }> = [];
/** history.back() calls of our own, whose popstate is no gesture. */
let own = 0;
let listening = false;
const onPop = () => {
	if (own > 0) { own--; return; }
	layers.pop()?.close();
};

export function useBack(open: boolean, close: () => void): void {
	const latest = useRef(close);
	latest.current = close;
	useEffect(() => {
		if (!open) return;
		if (!listening) { window.addEventListener("popstate", onPop); listening = true; }
		const layer = { close: () => latest.current() };
		layers.push(layer);
		history.pushState({ mmoLayer: layers.length }, "");
		return () => {
			const i = layers.indexOf(layer);
			if (i < 0) return; // the gesture took it
			layers.splice(i, 1);
			own++;
			history.back();
		};
	}, [open]);
}
