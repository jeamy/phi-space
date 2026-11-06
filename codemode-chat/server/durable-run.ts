// Durable runs (docs/codemode-anwendungen.en.md, D): a script that survives the judge running it. It runs with
// pi-codemode's `start()`: the VM is deterministic given its start time, seed and the answers to its calls in their
// order, so every answer is written to a log (CodeCall entries in the space, judge-host.ts) BEFORE the VM gets it. A
// judge that takes the candidate over after a crash starts the same script with the same seed and start time and hands
// it the logged answers in their logged order; once the log is used up it goes on live. A call that was on its way
// when the judge died is sent again with the same key (the VM's own call id), and the other side answers it from what
// it remembers instead of carrying it out twice (the arena does, spaces-mmo/server/arena.ts).
//
// The VM's clock reads the `now` of each answer: live answers carry the wall clock minus the time the run was down,
// so the script's own time (and its time limit) counts only the time it ran.
import type { Codemode } from "./judge.ts";

export type Outcome = { ok: true; value: unknown } | { ok: false; message: string };
export type LoggedCall = { seq: number; id: number; name: string; args: unknown; now: number; outcome: Outcome };
export type RunHead = { seed: number; startedAt: number; fingerprint: string; world: string };
/** Where a run keeps its log; the judge writes it outside its transaction, so it outlives the judge. */
export interface CallLog {
	head(): Promise<RunHead | null>;
	/** In `seq` order. */
	calls(): Promise<LoggedCall[]>;
	begin(h: RunHead): Promise<void>;
	append(c: LoggedCall): Promise<void>;
	clear(): Promise<void>;
}

/** The most an answer may take as JSON; a larger one is logged and delivered as an error instead. */
export const MAX_ANSWER_BYTES = 32_000;

/** The log could not be read or written (the space's trouble, not the bot's): the judge gives the candidate back, as
 *  for an arena that is down. */
export class LogDown extends Error {}

/** The run diverged from its log (another script, another VM, another answer order): it must start afresh. */
export class Diverged extends Error {}

type StartRun = {
	result: Promise<{ ok: boolean; value?: unknown; error?: { message: string; kind?: string } }>;
	deliver(seq: number, now: number, id: number, outcome: Outcome): void;
	finished: boolean;
};
type StartSandbox = {
	start(code: string, o: {
		startedAt: number; seed: number; tools: Array<{ name: string; description?: string }>; timeoutMs?: number; signal?: AbortSignal;
		onStarted?(fingerprint: string): void; onCall(call: { id: number; target: "tool" | "global"; name: string; args: unknown }): void;
	}): StartRun;
	close(): Promise<void>;
};

const canon = (v: unknown): string => JSON.stringify(v) ?? "undefined";

/**
 * Runs `code` durably. `head` is the run's head when it resumes (its log in `logged`), or null for a fresh run, whose
 * head is written once the VM is up. `call` answers a live call; `key` is stable across replays. Throws Diverged when
 * the run does not match its log, and whatever `call` throws for trouble that is not the script's (the caller gives the
 * candidate back; the log stays).
 */
export async function runDurable(cm: Codemode, o: {
	code: string; tools: Array<{ name: string; description?: string }>; limitMs: number;
	log: CallLog; head: RunHead | null; logged: LoggedCall[]; world: string;
	call(name: string, args: unknown, key: string): Promise<Outcome>;
	/** Counts every call, replayed or live (the meter of the verdict). */
	seen?(name: string, args: unknown): void;
}): Promise<{ ok: boolean; value?: unknown; error?: string; replayed: number; live: number }> {
	const sandbox = new (cm as unknown as { CodemodeSandbox: new (o: { timeoutMs: number; tools: never[]; memoryLimitBytes?: number }) => StartSandbox }).CodemodeSandbox({ timeoutMs: o.limitMs, tools: [], memoryLimitBytes: 64 * 1024 * 1024 });
	const fresh = !o.head;
	const head: Omit<RunHead, "fingerprint"> & { fingerprint?: string } = o.head ?? { seed: Math.floor(Math.random() * 0xffffffff) >>> 0, startedAt: Date.now(), world: o.world };
	const replay = [...o.logged].sort((a, b) => a.seq - b.seq);
	const lastNow = replay.length ? replay[replay.length - 1]!.now : head.startedAt;
	// the run's clock goes on where the log ends: the time it was down does not count
	const offset = fresh ? 0 : Date.now() - lastNow;
	const used = lastNow - head.startedAt;
	const stop = new AbortController();
	const bad: { e: Error | null } = { e: null };
	const fail = (e: Error) => { if (!bad.e) bad.e = e; stop.abort(); };
	// every log write and every delivery go through this chain, in order: an answer is logged before the VM has it
	let chain: Promise<void> = Promise.resolve();
	const later = (f: () => Promise<void> | void) => { chain = chain.then(f).catch((e) => fail(e as Error)); };
	let seq = replay.length ? replay[replay.length - 1]!.seq : 0, r = 0, live = 0;
	const issued = new Map<number, { id: number; name: string; args: unknown }>(), started = new Set<number>();
	let run: StartRun;

	const goLive = (c: { id: number; name: string; args: unknown }) => {
		started.add(c.id); live++;
		o.seen?.(c.name, c.args);
		void o.call(c.name, c.args, `${head.seed}:${c.id}`).then((out) => {
			const json = canon(out);
			const outcome: Outcome = Buffer.byteLength(json) > MAX_ANSWER_BYTES ? { ok: false, message: `the answer took more than ${MAX_ANSWER_BYTES} bytes` } : JSON.parse(json) as Outcome;
			later(async () => {
				if (bad.e || run.finished) return;
				const s = ++seq, now = Math.max(lastNow, Date.now() - offset);
				await o.log.append({ seq: s, id: c.id, name: c.name, args: c.args, now, outcome }).catch((e) => { throw new LogDown(`the run's log could not be written: ${(e as Error).message}`); });
				run.deliver(s, now, c.id, outcome);
			});
		}, (e) => fail(e as Error));
	};
	const pump = () => {
		while (r < replay.length && issued.has(replay[r]!.id)) {
			const L = replay[r]!, c = issued.get(L.id)!;
			if (c.name !== L.name || canon(c.args) !== canon(L.args)) return fail(new Diverged(`call ${L.id} is ${c.name}(${canon(c.args).slice(0, 80)}), the log has ${L.name}(${canon(L.args).slice(0, 80)})`));
			o.seen?.(c.name, c.args);
			issued.delete(L.id); r++;
			run.deliver(L.seq, L.now, L.id, L.outcome);
		}
		if (r < replay.length) return;
		for (const c of issued.values()) if (!started.has(c.id)) goLive(c);
	};

	try {
		run = sandbox.start(o.code, {
			startedAt: head.startedAt, seed: head.seed, tools: o.tools, signal: stop.signal,
			timeoutMs: Math.max(1000, o.limitMs - used),
			onStarted: (fp) => {
				if (o.head && o.head.fingerprint !== fp) return fail(new Diverged("the VM is not the one the run started on"));
				if (fresh) later(() => o.log.begin({ ...head, fingerprint: fp }).catch((e) => { throw new LogDown(`the run's log could not be written: ${(e as Error).message}`); }));
			},
			onCall: (c) => {
				if (c.target !== "tool") return;
				issued.set(c.id, c);
				// the head is written before any answer: a call waits behind it in the chain
				later(() => pump());
			},
		});
		const res = await run.result;
		await chain;
		if (bad.e) throw bad.e;
		return res.ok ? { ok: true, value: res.value, replayed: r, live } : { ok: false, error: res.error?.message ?? "failed", replayed: r, live };
	} finally {
		stop.abort();
		await sandbox.close().catch(() => {});
	}
}
