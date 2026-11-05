// The FPS measurement of the 3D map (MapView3D measures, the top bar's button starts it and shows the result): two window
// events, so that the bar need not reach into the renderer.
export type FpsState = { running: true; remaining: number } | { running: false; fps: number | null; note?: string };
const START = "mmo-fps-start", STATE = "mmo-fps-state";

export const startFps = () => window.dispatchEvent(new Event(START));
export const sayFps = (s: FpsState) => window.dispatchEvent(new CustomEvent<FpsState>(STATE, { detail: s }));
export function onFpsStart(f: () => void): () => void { window.addEventListener(START, f); return () => window.removeEventListener(START, f); }
export function onFps(f: (s: FpsState) => void): () => void {
	const h = (e: Event) => f((e as CustomEvent<FpsState>).detail);
	window.addEventListener(STATE, h); return () => window.removeEventListener(STATE, h);
}
