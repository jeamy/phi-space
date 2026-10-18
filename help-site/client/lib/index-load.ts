// Index failures must be actionable, and stale/retried fetches must not win.
export function startIndexLoad(callbacks: { content: (data: any) => void; error: (error: unknown) => void }, fetcher: typeof fetch = fetch): () => void {
	const controller = new AbortController();
	void fetcher("/help/index.json", { signal: controller.signal })
		.then(async response => {
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data = await response.json();
			if (data?.schema !== "phi-spaces-help-site-index-v1" || !Array.isArray(data.articles) || !Array.isArray(data.areas)) throw new Error("Invalid help index");
			if (!controller.signal.aborted) callbacks.content(data);
		})
		.catch(error => { if (!controller.signal.aborted) callbacks.error(error); });
	return () => controller.abort();
}
