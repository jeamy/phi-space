// The owner lock of a daemon home: one harness writer. A lock whose process is provably gone is cleared by the next
// daemon itself, so a killed or powered-off daemon restarts without an operator step.
import {readFileSync,renameSync,linkSync,unlinkSync} from 'node:fs';

export type OwnerLock = {pid: number; mode?: string; bootId?: string | null; startTime?: string | null};

/**
 * Field 22 of /proc/<pid>/stat (start time in clock ticks since boot); null when there is no such process, undefined
 * when it cannot be told (any other read error, an unexpected format).
 */
export function procStartTime(pid: number | 'self'): string | null | undefined {
	let stat: string;
	try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined; }
	const start = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
	return start && /^[0-9]+$/.test(start) ? start : undefined;
}

/**
 * Why the lock cannot belong to a live process, or null when it might (then only the operator may remove it).
 * - an earlier kernel boot: no process of it survives;
 * - the same boot: its PID now runs this process, or no process with that PID and the recorded start time exists
 *   (PIDs are reused, start times within one boot are not).
 * A lock without boot ID or start time (older format) is never cleared here.
 */
export function staleOwnerLock(old: OwnerLock, self: {bootId: string | null; pid: number; startTime: (pid: number) => string | null | undefined}): 'previousBoot' | 'processGone' | null {
	if (!self.bootId || !old.bootId) return null;
	if (old.bootId !== self.bootId) return 'previousBoot';
	if (!old.startTime || !Number.isSafeInteger(old.pid) || old.pid <= 0) return null;
	if (old.pid === self.pid) return 'processGone';
	const now = self.startTime(old.pid);
	// Unknown is not gone: a single-writer lock is kept unless the process is provably absent.
	return now === undefined || now === old.startTime ? null : 'processGone';
}

/**
 * Removes the lock file only if it still holds `judged` (the content found stale): it is moved aside atomically first,
 * so a lock another starting daemon wrote in between is put back, never removed.
 */
export function clearStaleOwnerLock(lock: string, judged: string): boolean {
	const aside = `${lock}.stale-${process.pid}`;
	try { renameSync(lock, aside); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
	if (readFileSync(aside, 'utf8') !== judged) {
		try { linkSync(aside, lock); } catch {}
		unlinkSync(aside);
		return false;
	}
	unlinkSync(aside);
	return true;
}
