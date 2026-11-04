import type { MapMode } from "./MapRenderer.tsx";

export const START_VIEW = { zoom: 1.4, angle: Math.PI / 2, tilt: 15 } as const;

export function readMapMode(storage?: Pick<Storage, "getItem">): MapMode {
	try {
		const s = storage ?? globalThis.localStorage, saved = s?.getItem("mmo.renderer");
		return saved === "text" || saved === "2d" || saved === "3d" ? saved : s?.getItem("mmo.textOnly") === "1" ? "text" : "3d";
	} catch { return "3d"; }
}

export function resetStartView(storage?: Pick<Storage, "setItem">): void {
	try {
		const s = storage ?? globalThis.localStorage;
		s?.setItem("mmo.renderer", "3d"); s?.setItem("mmo.textOnly", "0");
		s?.setItem("mmo.3d.zoom", String(START_VIEW.zoom)); s?.setItem("mmo.3d.angle", String(START_VIEW.angle)); s?.setItem("mmo.3d.tilt", String(START_VIEW.tilt));
	} catch {}
}
