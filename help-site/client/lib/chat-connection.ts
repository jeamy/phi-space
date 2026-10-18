export type ChatSocket = {
	readyState: number;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onerror: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	send(text: string): void;
	close(): void;
};

/** One lifecycle per session/participant/thread. Heartbeats refresh metadata, polling bridges disconnects. */
export function startChatConnection(o: {
	participant: string; threadId: string;
	connect: () => ChatSocket;
	snapshot: (data: any) => void;
	poll: () => Promise<void>;
	presenceFallback: (data: Record<string, unknown>) => Promise<unknown>;
}): () => void {
	let stopped = false, ws: ChatSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined;
	const join = () => {
		const data = { type: "participant.join", participantId: o.participant, username: o.participant.toUpperCase(), activeThreadId: o.threadId, requestId: crypto.randomUUID() };
		if (ws?.readyState === 1) ws.send(JSON.stringify(data));
		else void o.presenceFallback(data).catch(() => {});
	};
	const connect = () => {
		if (stopped) return;
		try {
			ws = o.connect();
			ws.onopen = join;
			ws.onmessage = ev => { if (!stopped) { try { const data = JSON.parse(String(ev.data)); if (data.type === "session.snapshot") o.snapshot(data); } catch {} } };
			ws.onclose = () => { if (!stopped) retry = setTimeout(connect, 1500); };
			ws.onerror = () => ws?.close();
		} catch { retry = setTimeout(connect, 1500); }
	};
	void o.poll().catch(() => {});
	connect();
	const heartbeat = setInterval(join, 10_000);
	const poll = setInterval(() => { if (ws?.readyState !== 1) void o.poll().catch(() => {}); }, 1500);
	return () => { stopped = true; clearTimeout(retry); clearInterval(heartbeat); clearInterval(poll); ws?.close(); };
}
