// The same admission rules apply to local workers and network clients.
import {canonicalJson} from './canonical.ts';
import type {EntryDraft, EntryRec, Json, SpaceState, TxnRec} from './core.ts';
import {
    declaredSupertypes,
    type FederationPolicy,
    hrw,
    MemberDrained,
    RoutingConflict,
    ruleFor
} from './routing-semantics.ts';

export type MemberAdmission = {
    memberId: string; authorityId : string; policy : FederationPolicy | null;
    state : 'adding' | 'active' | 'draining' | 'removing' | 'detached' | 'recoveryBlocked';
    admissionVersion : number;
    transitionId : string;
    drainAt?: number;
    cutRevision?: number
};
export type CompletionAllowance = {
    admissionVersion: number; until : number; remainingBytes : number; remainingCount : number;
    preBoundary : boolean
};
const routerPermit = new WeakMap<object, boolean>();
export function permitRoutedWrite(s: SpaceState, proven: boolean) { routerPermit.set(s, proven); }
export function assertMemberAdmission(s: SpaceState, method: string) {
    if(s.adminMaintenance)throw new MemberDrained("Space has a pending administrative deletion");
    const a = s.membership;
    if (a && [ 'adding', 'removing', 'detached', 'recoveryBlocked' ].includes(a.state) &&
        !['ack', 'cancelOperation', 'txn.abort'].includes(method))
        throw new MemberDrained('Member admission is ' + a.state);
}
export function initializeMemberTxn(s: SpaceState, t: TxnRec, now: number) {
    const a = s.membership;
    if (!a)
        return;
    assertMemberAdmission(s, 'txn.begin');
    t.completion = {
        admissionVersion : a.admissionVersion,
        until : Math.min(t.expires, now + 60000),
        remainingBytes : 65536,
        remainingCount : 8,
        preBoundary : a.state === 'active'
    };
    if (a.state === 'draining')
        t.expires = Math.min(t.expires, t.completion.until);
}
export function assertMemberWrite(s: SpaceState, entry: EntryDraft, txn: string|null, now: number) {
    const a = s.membership;
    assertMemberAdmission(s, 'write');
    if (!a)
        return;
    if (!a.policy)
        throw new RoutingConflict('Member policy is not installed');
    const p = a.policy, r = ruleFor(p, entry.type), parents = declaredSupertypes(p, entry.type),
          actual = [...(entry.types ?? []) ].filter(t => t !== entry.type).sort();
    if (canonicalJson(actual) !== canonicalJson(parents))
        throw new RoutingConflict('managed writes need complete declared supertypes');
    let target: string|undefined;
    if (r.mode === 'local' || r.mode === 'sync' && r.variant === 'primary')
        target = r.member;
    else if (r.mode === 'expand' && r.by === 'type')
        target = hrw(r.type, r.members);
    else if (r.mode === 'expand' && typeof r.by === 'object') {
        if (!Object.hasOwn(entry.fields, r.by.field))
            throw new RoutingConflict('HRW field absent');
        target = hrw(entry.fields[r.by.field]!, r.members);
    } else if (r.mode === 'expand') {
        if (!r.members.includes(a.memberId) || !txn && !routerPermit.get(s))
            throw new RoutingConflict('selection write needs proven Router placement');
    } else
        throw new RoutingConflict('unsupported replicated mode');
    if (target && target !== a.memberId)
        throw new RoutingConflict('entry belongs to another Member');
    if (a.state === 'draining') {
        if (p.completionProfiles.some(f => f.taskType === entry.type))
            throw new MemberDrained('draining Member admits no new Task writes');
        const t = txn ? s.txns[txn] : undefined, c = t?.completion;
        if (!t || !c || now >= c.until || c.remainingCount < 1 ||
            Buffer.byteLength(JSON.stringify(entry)) > c.remainingBytes)
            throw new MemberDrained('no bounded completion allowance');
        if (!c.preBoundary) {
            const valid = p.completionProfiles.some(
                f => (t.takenTasks ?? [])
                         .some(task =>
                                   task.types.includes(f.taskType) &&
                                   f.resultTypes.includes(entry.type) &&
                                   f.equalFields.every(k => Object.hasOwn(task.fields, k) &&
                                                            Object.hasOwn(entry.fields, k) &&
                                                            canonicalJson(task.fields[k]!) ===
                                                                canonicalJson(entry.fields[k]!))));
            if (!valid)
                throw new MemberDrained('new draining transaction may write only bound results');
        }
    }
}
export function chargeMemberWrite(s: SpaceState, entry: EntryDraft, txn: string|null) {
    if (s.membership?.state === 'draining' && txn) {
        const c = s.txns[txn]?.completion;
        if (c) {
            c.remainingBytes -= Buffer.byteLength(JSON.stringify(entry));
            c.remainingCount--;
        }
    }
}
export function assertMemberTake(s: SpaceState, e: EntryRec, txn: string|null, now: number) {
    const a = s.membership;
    if (!a)
        return;
    assertMemberAdmission(s, 'take');
    if (a.state !== 'draining' || !txn)
        return;
    const t = s.txns[txn]!, c = t.completion;
    if (c?.preBoundary)
        return;
    const f = a.policy?.completionProfiles.find(f => e.types.includes(f.taskType));
    if (!f)
        throw new MemberDrained('draining task take has no completion profile');
    if (t.takenTasks?.length)
        throw new MemberDrained('one completion task per draining transaction');
    if (!c)
        throw new MemberDrained('transaction has no completion allowance');
    c.until = Math.min(c.until, now + f.maxLeaseMs);
    c.remainingBytes = Math.min(c.remainingBytes, f.maxResultBytes);
    c.remainingCount = Math.min(c.remainingCount, f.maxResultCount);
    t.expires = Math.min(t.expires, c.until);
}
export function assertMemberRenew(s: SpaceState, id: string, expires: number) {
    const a = s.membership;
    if (!a)
        return;
    assertMemberAdmission(s, 'lease.renew');
    if (a.state === 'draining') {
        const t = s.txns[id];
        if (!t?.completion || expires > t.completion.until)
            throw new MemberDrained('draining leases cannot extend completion boundary');
    }
}
