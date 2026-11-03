// A sleep that ends early when the signal aborts. The abort listener is removed when the timer runs out: a role or a
// worker that sleeps several times a second would otherwise pile up listeners on the one signal, and every
// addEventListener walks that list (the npc processes spent most of their CPU there).
export function abortableSleep(signal: AbortSignal, ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) { resolve(); return; }
		const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}
