"use client";
// The back gesture of a phone closes the topmost layer (a sheet, the help, a menu) instead of leaving the game. While any
// layer is open, ONE entry of ours stands on top of the browser's history: the gesture pops it and closes the topmost
// layer (and puts the entry back while others are still open); the last layer closed some other way takes it out again.
//
// One entry for all layers, not one per layer: closing a layer takes its entry out with history.back(), which runs later.
// A layer opened in that moment (a menu entry that opens a panel) pushed its own entry first, and the late back() then
// took that one, so the next close went back one entry too far, out of the game. The browser's "back" after picking an
// entry of the map's menu was that.
import { useEffect, useRef } from "react";
import { isTouch } from "./useShell.ts";

const layers: Array<{ close: () => void }> = [];
/** history.back() calls of our own still to arrive: their popstate is no gesture. */
let own = 0;
/** Whether our entry is on top of the history now. */
let guarded = false;
let listening = false;

const guard = () => {
	if (guarded || !layers.length) return;
	history.pushState({ mmoLayer: true }, "");
	guarded = true;
};
const onPop = () => {
	if (own > 0) {
		own--;
		// a layer opened while our back() was on its way: its entry, now that the old one is gone
		if (!own) guard();
		return;
	}
	guarded = false; // the gesture popped our entry
	layers.pop()?.close();
	guard();
};

/** Opens a layer: `close` runs when the back gesture takes it. The function returned takes it out another way. */
export function openLayer(close: () => void): () => void {
	// with a mouse there is no back gesture to catch: the browser's history stays the user's (its back button, a mouse's
	// rocker gesture, a history.back() of ours arriving late must never take the player out of the game)
	if (!isTouch()) return () => {};
	if (!listening) { window.addEventListener("popstate", onPop); listening = true; }
	const layer = { close };
	layers.push(layer);
	if (!own) guard(); // else onPop puts it there once our back() has arrived
	return () => {
		const i = layers.indexOf(layer);
		if (i < 0) return; // the gesture took it
		layers.splice(i, 1);
		if (layers.length || !guarded) return;
		guarded = false;
		own++;
		history.back();
	};
}

export function useBack(open: boolean, close: () => void): void {
	const latest = useRef(close);
	latest.current = close;
	useEffect(() => open ? openLayer(() => latest.current()) : undefined, [open]);
}
