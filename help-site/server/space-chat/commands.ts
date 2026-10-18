// Transport-neutral command validation and defaults for HTTP and WebSocket.
import { randomUUID } from "node:crypto";
import type { SpaceChatEngine } from "../../examples/shared/chat-core.ts";

export async function dispatchChatCommand(engine: SpaceChatEngine, body: Record<string, unknown>): Promise<void> {
	const kind = String(body.kind ?? body.type ?? "");
	const text = (key: string, fallback: string, max = 128) => {
		const value = String(body[key] ?? fallback).trim();
		if (!value || value.length > max) throw new Error(`Invalid ${key}`);
		return value;
	};
	const requestId = text("requestId", randomUUID());
	const threadId = () => text("threadId", "thread-main");
	const author = () => text("author", "alice");
	switch (kind) {
		case "thread.create":
			await engine.createThread({ threadId: text("threadId", `thread-${requestId}`), title: text("title", "Neuer Thread"), createdBy: author(), requestId }); return;
		case "thread.fork":
			await engine.forkThread({ newThreadId: text("newThreadId", `fork-${requestId}`), parentThreadId: text("parentThreadId", "thread-main"), forkUpToSeq: Number(body.forkUpToSeq ?? 2), title: text("title", "Fork"), createdBy: author(), requestId }); return;
		case "message.submit":
			await engine.submitMessage({ threadId: threadId(), author: author(), text: text("text", "", 8_000), requestId }); return;
		case "alarm.schedule": {
			const delayMs = Number(body.delayMs ?? 3_000);
			if (!Number.isFinite(delayMs) || delayMs < 10 || delayMs > 86_400_000) throw new Error("Invalid alarm delay");
			await engine.scheduleReminder({ jobId: `alarm-${requestId}`, threadId: threadId(), instruction: text("instruction", "Geplanter Space-Check", 8_000), requestedBy: author(), delayMs, requestId }); return;
		}
		case "presence.join":
		case "participant.join":
		case "participant.heartbeat":
			if (body.status !== undefined && !["online", "typing", "idle"].includes(String(body.status))) throw new Error("Invalid presence status");
			await engine.joinOrRefreshPresence({ participantId: text("participantId", String(body.author ?? "guest")), username: text("username", String(body.author ?? "Guest")), activeThreadId: text("activeThreadId", "thread-main"), status: (body.status ?? "online") as "online" | "typing" | "idle", requestId }); return;
		default: throw new Error(`Unknown chat command: ${kind}`);
	}
}
