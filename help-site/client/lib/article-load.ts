/** The returned cleanup invalidates every completion, even if a fetch implementation ignores abort. */
export function startArticleLoad(path: string, callbacks: {
	content: (text: string, signal: AbortSignal) => void;
	error: (error: unknown) => void;
	done: () => void;
}, fetcher: typeof fetch = fetch): () => void {
	const controller = new AbortController();
	void fetcher(path, { signal: controller.signal })
		.then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
		.then(text => { if (!controller.signal.aborted) callbacks.content(text, controller.signal); })
		.catch(e => { if (!controller.signal.aborted) callbacks.error(e); })
		.finally(() => { if (!controller.signal.aborted) callbacks.done(); });
	return () => controller.abort();
}
