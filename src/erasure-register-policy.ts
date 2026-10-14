// Cross-record deletion constraints run inside the register's SQLite write transaction.
// Operator permission does not permit lowering a floor or reintroducing retired archives.
import type {ErasureBarrier} from './erasure-barrier.ts';
import type {ErasureArchive} from './erasure-archives.ts';

type Catalog = {spaceId: string; artifacts: ErasureArchive[]};
type Reject = (message: string) => never;
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function barrier(value: any, spaceId: string, reject: Reject): asserts value is ErasureBarrier {
    if (!value || value.spaceId !== spaceId || !Number.isSafeInteger(value.epoch) || value.epoch < 1 ||
        !['pending', 'sealed'].includes(value.state) || !digest(value.commandHash) ||
        !Number.isSafeInteger(value.archiveDeadline) || value.archiveDeadline < 0 ||
        typeof value.archivesPending !== 'boolean') reject('invalid independent erasure barrier');
}
function catalog(value: any, spaceId: string, reject: Reject): asserts value is Catalog {
    if (!value || value.spaceId !== spaceId || !Array.isArray(value.artifacts) || value.artifacts.length > 128)
        reject('invalid erasure archive catalog');
    const ids = new Set<string>();
    for (const a of value.artifacts) {
        if (!a || typeof a.id !== 'string' || !a.id || a.id.length > 128 || ids.has(a.id) ||
            !digest(a.sha256) || !Number.isSafeInteger(a.epoch) || a.epoch < 0 ||
            !['backup', 'backend-history'].includes(a.kind) ||
            !['retained', 'quarantined', 'destroyed'].includes(a.state) ||
            (a.deleteBefore !== undefined && (!Number.isSafeInteger(a.deleteBefore) || a.deleteBefore < 0)))
            reject('invalid erasure archive binding');
        ids.add(a.id);
    }
}
export function validateErasureRegisterUpdate(key: string, next: any, prior: any,
    read: (key: string) => any, reject: Reject): void {
    if (key.startsWith('erasure:')) {
        const spaceId = key.slice('erasure:'.length);
        if (!spaceId || spaceId.length > 128) reject('invalid erasure space');
        barrier(next, spaceId, reject);
        if (prior) {
            barrier(prior, spaceId, reject);
            if (next.epoch === prior.epoch) {
                if (next.commandHash !== prior.commandHash || next.archiveDeadline !== prior.archiveDeadline ||
                    (prior.state === 'sealed' && next.state !== 'sealed') ||
                    (!prior.archivesPending && next.archivesPending))
                    reject('erasure barrier cannot regress or change its binding');
            } else if (next.epoch !== prior.epoch + 1 || prior.state !== 'sealed' || prior.archivesPending ||
                next.state !== 'pending' || !next.archivesPending || next.commandHash === prior.commandHash) {
                reject('erasure epoch requires completed preceding deletion and archives');
            }
        } else if (next.epoch !== 1 || next.state !== 'pending' || !next.archivesPending) {
            reject('first erasure epoch must start pending at one');
        }
        const artifacts = read('erasure-archives:' + spaceId);
        if (artifacts) catalog(artifacts, spaceId, reject);
        const remaining = (artifacts?.artifacts ?? []).filter((a: ErasureArchive) => a.epoch < next.epoch && a.state !== 'destroyed');
        if (next.state === 'sealed' && (remaining.some((a: ErasureArchive) => a.state !== 'quarantined') ||
            next.archivesPending !== (remaining.length > 0))) reject('erasure seal does not match archive retirement');
        if (next.state === 'pending' && !next.archivesPending) reject('pending erasure must retain archive barrier');
    } else if (key.startsWith('erasure-archives:')) {
        const spaceId = key.slice('erasure-archives:'.length);
        if (!spaceId || spaceId.length > 128) reject('invalid erasure space');
        catalog(next, spaceId, reject);
        if (prior) catalog(prior, spaceId, reject);
        const floor = read('erasure:' + spaceId);
        if (floor) barrier(floor, spaceId, reject);
        const previous = new Map<string, ErasureArchive>((prior?.artifacts ?? []).map((a: ErasureArchive) => [a.id, a]));
        for (const a of next.artifacts) {
            const old = previous.get(a.id);
            if (!old) {
                if (a.state !== 'retained' || a.deleteBefore !== undefined ||
                    (floor ? floor.state !== 'sealed' || a.epoch !== floor.epoch : a.epoch !== 0))
                    reject('new archive must match completed deletion epoch');
            } else {
                previous.delete(a.id);
                const rank = {retained: 0, quarantined: 1, destroyed: 2};
                if (old.sha256 !== a.sha256 || old.epoch !== a.epoch || old.kind !== a.kind ||
                    rank[a.state] < rank[old.state] ||
                    (old.deleteBefore !== undefined && a.deleteBefore !== old.deleteBefore))
                    reject('archive binding or retirement cannot regress');
                if (a.state === 'quarantined' && (!floor || a.epoch >= floor.epoch || a.deleteBefore !== floor.archiveDeadline))
                    reject('archive quarantine requires current deletion deadline');
            }
        }
        if (previous.size) reject('archive retirement records cannot be removed');
    }
}
