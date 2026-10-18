// AP 2.3: authoritative policy, immutable placements and deterministic HRW.

import {canonicalJson,digestJson} from './canonical.ts';
import type {EntryDraft, Json, Template} from './core.ts';
import type {TargetBinding} from './router.ts';
import { jsonCopy } from './json.ts';

export type FederationRule =|{
    type: string;
    supertypes?: string[];
    mode: 'local';
    member: string
}
|{
    type: string;
    supertypes?: string[];
    mode: 'expand';
    members: string[];
    by: 'type'|{field : string}|'capacity'|'capability';
    capability?: string
}
|{
    type: string;
    supertypes?: string[];
    mode: 'sync';
    variant: 'primary';
    member: string;
    primaryReplica: string;
    replicaConfigVersion: number;
    durability: 'single'|'sync';
    standbyReplica?: string;
    backupReplica?: string
}
|{
    type: string;
    supertypes?: string[];
    mode: 'sync';
    variant: 'lww'|'set';
    members: string[];
    semantics: 'state'|'facts';
    keyFields?: string[]
};
export type FederationCompletionProfile = {
    taskType: string; resultTypes : string[]; equalFields : string[]; maxResultBytes : number;
    maxResultCount : number;
    maxLeaseMs : number;
    /** Tasks name their run in this field; a RunGate decides when they are takeable (run-controller.ts). */
    gateField?: string
};
export type FederationPolicy = {
    authorityId: string; policyVersion : number; rules : FederationRule[];
    completionProfiles : FederationCompletionProfile[];
    default : {mode : 'local'; member : string}
};
export type FederationMember = {
    id: string; target : TargetBinding;
    state : 'adding' | 'active' | 'draining' | 'removing' | 'detached' | 'recoveryBlocked';
    replication?: {
        primaryReplica : string; replicaConfigVersion : number; durability : 'single' | 'sync';
        standbyReplica?: string;
        backupReplica?: string;
        /** recovery/transition ID of the adopted ReplicaConfigNotice */
        recoveryId?: string
    };
    /** lww/set Member (docs/abnahme/ap3-replikation.md): its provisioned entry replication; merge rules must match it. */
    entryReplication?: {
        replicaId : string; incarnation : string;
        rules : Array<{type : string; variant : 'lww'; keyFields : string[]} | {type : string; variant : 'set'}>
    };
    capacity?: {free : number; at : number};
    capabilities?: {names : string[]; at : number}
};
export type RoutingState = {
    policy: FederationPolicy|null; members : Record<string, FederationMember>;
    /** Policy versions produced by adopted replica notices (newest 256); they change only the replica configuration. */
    noticePolicyVersions?: number[]
};
export class RoutingConflict extends Error {};
export class MigrationRequired extends Error {};
export class MemberDrained extends Error {};
export class NoCapableMember extends Error {};
export class CapacityUnavailable extends Error {};
const copy = jsonCopy;
const name = (n: string) => {
    if (typeof n !== 'string' || !n || n.length > 128 ||
        [ '__proto__', 'constructor', 'prototype' ].includes(n))
        throw new RoutingConflict('invalid policy identifier');
};
const members = (r: FederationRule): string[] => 'member' in r ? [ r.member ] : r.members;
const hash = (v: unknown) => digestJson(v as Json);
export function hrw(value: Json, ids: readonly string[]): string {
    if (!ids.length)
        throw new RoutingConflict('empty HRW set');
    return [...ids ].sort((a, b) => {
        const x = hash([ value, a ]), y = hash([ value, b ]);
        return y.localeCompare(x) || a.localeCompare(b);
    })[0]!;
}
function placement(r: FederationRule): Json {
    if (r.mode === 'local')
        return {mode : r.mode, member : r.member};
    if (r.mode === 'expand')
        return {
            mode : r.mode,
            by : r.by,
            members : [...r.members ].sort(),
            capability : r.capability ?? null
        };
    // The replica configuration of a primary Member changes through transitions; its placement is the Member alone.
    if (r.mode === 'sync' && r.variant === 'primary')
        return {mode : r.mode, variant : r.variant, member : r.member};
    return r as unknown as Json;
}
/** Members must already be registered; placement changes need an explicit proven removal. */
export function validateFederationPolicy(
    p: FederationPolicy, table: Record<string, FederationMember>, old?: FederationPolicy|null,
    allowRemoval: ReadonlySet < string >= new Set(), allowFutureModes = false): void {
    name(p.authorityId);
    if (!Number.isSafeInteger(p.policyVersion) || p.policyVersion < 1 || !Array.isArray(p.rules) ||
        p.rules.length > 128 || !Array.isArray(p.completionProfiles) ||
        p.completionProfiles.length > 32 || Buffer.byteLength(JSON.stringify(p)) > 65536)
        throw new RoutingConflict('policy exceeds schema/budget');
    if (p.default?.mode !== 'local')
        throw new RoutingConflict('default must name local member');
    name(p.default.member);
    if (!table[p.default.member] || table[p.default.member]!.state === 'detached')
        throw new RoutingConflict('default member is not registered');
    const types = new Set<string>(), primary = new Map<string, string>();
    for (const r of p.rules) {
        name(r.type);
        if ([r.type,...(r.supertypes??[])].some(t=>["Capability","MemberStatus"].includes(t))) throw new RoutingConflict("directory types are protected metadata");
        if (types.has(r.type))
            throw new RoutingConflict('one rule per type');
        types.add(r.type);
        if (r.supertypes) {
            if (!Array.isArray(r.supertypes) || r.supertypes.length > 16 ||
                new Set(r.supertypes).size !== r.supertypes.length || r.supertypes.includes(r.type))
                throw new RoutingConflict('invalid declared supertypes');
            r.supertypes.forEach(name);
        }
        const ids = members(r);
        if (!ids.length || ids.length > 128 || new Set(ids).size !== ids.length)
            throw new RoutingConflict('invalid member set');
        for (const id of ids) {
            name(id);
            if (!table[id] || table[id]!.state === 'detached')
                throw new RoutingConflict('unregistered rule member');
            if (table[id]!.target.authorityId !== p.authorityId)
                throw new RoutingConflict('member authority mismatch');
        }
        if (r.mode === 'expand') {
            if (typeof r.by === 'object') {
                name(r.by.field);
            } else if (!['type', 'capacity', 'capability'].includes(r.by))
                throw new RoutingConflict('invalid expand placement');
            if (r.by === 'capability' && !r.capability)
                throw new RoutingConflict('capability selector required');
        } else if (r.mode === 'sync' && r.variant === 'primary') {
            if (!r.primaryReplica || !Number.isSafeInteger(r.replicaConfigVersion) ||
                r.replicaConfigVersion < 1 || r.durability === 'sync' && !r.standbyReplica ||
                r.durability === 'single' && r.standbyReplica)
                throw new RoutingConflict('invalid primary replica configuration');
            const signature = hash({
                primaryReplica : r.primaryReplica,
                replicaConfigVersion : r.replicaConfigVersion,
                durability : r.durability,
                standbyReplica : r.standbyReplica ?? null,
                backupReplica : r.backupReplica ?? null
            });
            if (primary.has(r.member) && primary.get(r.member) !== signature)
                throw new RoutingConflict('one replica configuration per member');
            const rep = table[r.member]?.replication;
            if (rep && (rep.primaryReplica !== r.primaryReplica || rep.replicaConfigVersion !== r.replicaConfigVersion ||
                        rep.durability !== r.durability || (rep.standbyReplica ?? null) !== (r.standbyReplica ?? null) ||
                        (rep.backupReplica ?? null) !== (r.backupReplica ?? null)))
                throw new RoutingConflict('primary rule disagrees with the member replica configuration');
            primary.set(r.member, signature);
        } else if (r.mode === 'sync') {
            if (r.variant === 'lww' && (r.semantics !== 'state' || !r.keyFields?.length) ||
                r.variant === 'set' && r.semantics !== 'facts')
                throw new RoutingConflict('merge semantics must be explicit');
            // Every merge Member serves the type through its provisioned entry replication with the same rule.
            for (const id of r.members) {
                const er: {type : string; variant : string; keyFields?: string[]} | undefined = table[id]?.entryReplication?.rules.find(x => x.type === r.type);
                if (!er || er.variant !== r.variant ||
                    (r.variant === 'lww' && JSON.stringify(er.keyFields) !== JSON.stringify(r.keyFields)))
                    throw new RoutingConflict('merge member lacks a matching entry replication');
            }
        } else if (r.mode !== 'local')
            throw new RoutingConflict('unknown rule mode');
    }
    for (const r of p.rules)
        if ((r.mode === 'expand' || r.mode === 'sync' && r.variant !== 'primary') &&
            members(r).some(id => primary.has(id) || !!table[id]!.replication))
            throw new RoutingConflict('primary member cannot be expand or merge member');
    // primary/sync is served by hosts with a dedicated store (sync-spaces.ts) and needs the Member's replica
    // configuration; merge modes (lww/set) need a matching entry replication on every Member (checked above).
    if (!allowFutureModes && p.rules.some(r => r.mode === 'sync' && r.variant === 'primary' && !table[r.member]?.replication))
        throw new RoutingConflict('sync activation requires phase 3 implementation');
    for (const r of p.rules)
        if (declaredSupertypes(p, r.type).length > 15)
            throw new RoutingConflict('too many transitive supertypes');
    const profiles = new Set<string>();
    for (const f of p.completionProfiles) {
        name(f.taskType);
        if (profiles.has(f.taskType) || !f.resultTypes.length || !f.equalFields.length ||
            f.maxResultBytes < 1 || f.maxResultCount < 1 || f.maxLeaseMs < 1 ||
            ![f.maxResultBytes, f.maxResultCount, f.maxLeaseMs].every(Number.isSafeInteger) ||
            (f.gateField !== undefined && (typeof f.gateField !== 'string' || !f.equalFields.includes(f.gateField))))
            throw new RoutingConflict('invalid completion profile');
        profiles.add(f.taskType);
        f.resultTypes.forEach(name);
        f.equalFields.forEach(name);
    }
    if (!old && p.policyVersion !== 1)
        throw new RoutingConflict("initial policy version must be one");
    if (old) {
        for (const profile of old.completionProfiles)
            if (!same(profile,
                      p.completionProfiles.find(f => f.taskType === profile.taskType) ?? null))
                throw new MigrationRequired(
                    'existing completion profile changes require controlled transition');
        for (const profile of p.completionProfiles)
            if (!old.completionProfiles.some(f => f.taskType === profile.taskType) &&
                old.rules.some(r => r.type === profile.taskType))
                throw new MigrationRequired(
                    'adding a profile to an existing task type requires controlled transition');
        if (old.authorityId !== p.authorityId || p.policyVersion !== old.policyVersion + 1)
            throw new RoutingConflict('policy version must advance within authority');
        for (const r of old.rules) {
            const next = p.rules.find(n => n.type === r.type);
            if (!next) {
                if (!members(r).every(id => allowRemoval.has(id)))
                    throw new MigrationRequired(
                        'existing type rule may only disappear after proven removal');
                continue;
            }
            if (r.mode === 'expand' && (r.by === 'capacity' || r.by === 'capability') &&
                next.mode === 'expand' && same(r.by, next.by) && r.capability === next.capability) {
                if (r.members.some(id => !next.members.includes(id) && !allowRemoval.has(id)))
                    throw new MigrationRequired(
                        'selection search set cannot shrink without removal');
            } else if (hash(placement(r)) !== hash(placement(next)))
                throw new MigrationRequired('existing placement is immutable');
            if (!same(r.supertypes ?? [], next.supertypes ?? []))
                throw new MigrationRequired('existing type hierarchy is immutable');
        }
        if (old.default.member !== p.default.member && !allowRemoval.has(old.default.member))
            throw new MigrationRequired('default placement is immutable');
    }
}
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
export function declaredSupertypes(p: FederationPolicy, type: string,
                                   stack: string[] = []): string[] {
    if (stack.includes(type))
        throw new RoutingConflict('cyclic type hierarchy');
    const r = p.rules.find(r => r.type === type);
    const parents = r?.supertypes ?? [];
    return [
        ...new Set(parents.flatMap(
            parent => [parent, ...declaredSupertypes(p, parent, [...stack, type ])]))
    ].sort();
}
export function ruleFor(p: FederationPolicy, type: string): FederationRule {
    return p.rules.find(r => r.type === type) ?? {type, mode : 'local', member : p.default.member};
}
export function normalizeFederatedEntry(p: FederationPolicy, e: EntryDraft): EntryDraft {
    const r = ruleFor(p, e.type), parents = declaredSupertypes(p, e.type);
    if (e.types && e.types.some(t => t !== e.type && !parents.includes(t)))
        throw new RoutingConflict('entry supertypes must be declared by its rule');
    return {...copy(e), types : parents};
}
/** Placement value of a merge write: the canonical lww key, or for set the canonical fields. */
function mergeKey(r: Extract<FederationRule, {variant : 'lww'|'set'}>, fields: Record<string, Json>): string {
    if (r.variant === 'set')
        return canonicalJson(fields as Json);
    if (r.keyFields!.some(k => !Object.hasOwn(fields, k) || fields[k] === null))
        throw new RoutingConflict('lww key field missing');
    return canonicalJson([ r.type, ...r.keyFields!.map(k => fields[k]!) ] as Json);
}
/** True when the type is replicated by merge (lww/set): no exclusive allocation (v3 7.2). */
export function isMergeType(p: FederationPolicy, type: string | undefined): boolean {
    if (!type) return false;
    const r = p.rules.find(x => x.type === type);
    return !!r && r.mode === 'sync' && r.variant !== 'primary';
}
export function writeMember(p: FederationPolicy, table: Record<string, FederationMember>,
                            entry: EntryDraft, now: number, maxAgeMs = 60000): string {
    const r = ruleFor(p, entry.type);
    let id: string;
    if (r.mode === 'local' || r.mode === 'sync' && r.variant === 'primary')
        id = r.member;
    else if (r.mode === 'sync')
        id = hrw(mergeKey(r, entry.fields), r.members);
    else if (r.by === 'type')
        id = hrw(r.type, r.members);
    else if (typeof r.by === 'object') {
        if (!Object.hasOwn(entry.fields, r.by.field))
            throw new RoutingConflict('HRW key field missing');
        id = hrw(entry.fields[r.by.field]!, r.members);
    } else {
        const candidates = r.members.map(id => table[id]!).filter(m => m.state === 'active');
        if (r.by === 'capacity') {
            if (candidates.some(m => !m.capacity || !Number.isFinite(m.capacity.free) ||
                                     m.capacity.free < 0 || !Number.isSafeInteger(m.capacity.at) ||
                                     now - m.capacity.at > maxAgeMs || m.capacity.at > now + 2000))
                throw new CapacityUnavailable('capacity observations stale/missing');
            const free = candidates.filter(m => m.capacity!.free > 0)
                             .sort((a, b) => b.capacity!.free - a.capacity!.free ||
                                             a.id.localeCompare(b.id));
            if (!free.length)
                throw new CapacityUnavailable('no available capacity');
            id = free[0]!.id;
        } else {
            const capable =
                candidates
                    .filter(m => m.capabilities && now - m.capabilities.at <= maxAgeMs &&
                                 m.capabilities.at <= now + 2000 &&
                                 m.capabilities.names.includes(r.capability!))
                    .sort((a, b) => a.id.localeCompare(b.id));
            if (!capable.length)
                throw new NoCapableMember('no fresh capable member');
            id = capable[0]!.id;
        }
    }
    const m = table[id];
    if (!m || m.state === 'detached' || m.state === 'recoveryBlocked')
        throw new RoutingConflict('placement member unavailable');
    if (m.state !== 'active')
        throw new MemberDrained('placement member is not admitting new work');
    return id;
}
export function searchMembers(p: FederationPolicy, template: Template): string[] {
    if (!template?.type)
        return [...new Set([ p.default.member, ...p.rules.flatMap(members) ]) ].sort();
    const rules = p.rules.filter(r => r.type === template.type ||
                                      declaredSupertypes(p, r.type).includes(template.type!));
    if (!rules.some(r=>r.type===template.type))
        rules.push(ruleFor(p, template.type));
    const targets = rules.flatMap(r => {
        if (r.mode === 'local' || r.mode === 'sync' && r.variant === 'primary')
            return [ r.member ];
        if (r.mode === 'sync') {
            // Merge Members converge: one of them answers; by key when a lww template names the whole key.
            const keyed = r.variant === 'lww' && template.fields && r.keyFields!.every(k => Object.hasOwn(template.fields!, k));
            return [ hrw(keyed ? mergeKey(r, template.fields as Record<string, Json>) : r.type, r.members) ];
        }
        if (r.by === 'type')
            return [ hrw(r.type, r.members) ];
        if (typeof r.by === 'object' && template.fields &&
            Object.hasOwn(template.fields, r.by.field) && template.fields[r.by.field] !== null)
            return [ hrw(template.fields[r.by.field]!, r.members) ];
        return r.members;
    });
    return [...new Set(targets) ].sort();
}
