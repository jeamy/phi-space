import assert from 'node:assert/strict';
import test from 'node:test';

import {generateKey} from './src/auth.ts';
import {
    CapacityUnavailable,
    type FederationMember,
    type FederationPolicy,
    FederationPolicyAuthority,
    FederationRouting,
    hrw,
    MemberDrained,
    MigrationRequired,
    NoCapableMember,
    normalizeFederatedEntry,
    RoutingConflict,
    searchMembers,
    validateFederationPolicy,
    verifyFederationPolicy,
    writeMember
} from './src/federation-policy.ts';
import {createSpace} from './src/spaces.ts';
import {BACKENDS, ctx, PersistentHome} from './test/support/persistent.ts';

const table = (): Record<string, FederationMember >=>Object.fromEntries(
    [ 'a', 'b', 'c' ].map(id => [id, {
                              id,
                              state : 'active',
                              target : {
                                  hostId : id,
                                  spaceId : 'space-' + id,
                                  authorityId : 'auth',
                                  dataIncarnation : 'inc-' + id,
                                  primaryEpoch : 1
                              }
                          }]));
const policy = (): FederationPolicy => ({
    authorityId : 'auth',
    policyVersion : 1,
    rules : [
        {type : 'Task', mode : 'expand', members : [ 'a', 'b', 'c' ], by : {field : 'taskId'}},
        {type : 'Result', mode : 'expand', members : [ 'a', 'b', 'c' ], by : {field : 'taskId'}}
    ],
    completionProfiles : [],
    default : {mode : 'local', member : 'a'}
});
test('HRW uses field value and member set only; tasks and results colocate', () => {
    const p = policy(), t = table();
    validateFederationPolicy(p, t);
    for (let n = 0; n < 100; n++) {
        const task = {type : 'Task', fields : {taskId : {b : 2, a : n}}},
              result = {type : 'Result', fields : {taskId : {a : n, b : 2}}};
        assert.equal(writeMember(p, t, task, 1), writeMember(p, t, result, 1));
        assert.equal(hrw(task.fields.taskId, [ 'a', 'b', 'c' ]),
                     hrw(result.fields.taskId, [ 'c', 'a', 'b' ]));
    }
    assert.deepEqual(searchMembers(p, {type : 'Task', fields : {taskId : 7}}),
                     [ hrw(7, [ 'a', 'b', 'c' ]) ]);
    assert.deepEqual(searchMembers(p, {type : 'Task'}), [ 'a', 'b', 'c' ]);
});
test('supertypes are complete, declared and acyclic', () => {
    const p = policy();
    p.rules = [
        {type : 'Base', mode : 'local', member : 'a'},
        {type : 'Mid', supertypes : [ 'Base' ], mode : 'local', member : 'b'},
        {type : 'Sub', supertypes : [ 'Mid' ], mode : 'local', member : 'c'}
    ];
    validateFederationPolicy(p, table());
    assert.deepEqual(searchMembers(p, {type : 'Base'}), [ 'a', 'b', 'c' ]);
    assert.deepEqual(normalizeFederatedEntry(p, {type : 'Sub', fields : {}}).types,
                     [ 'Base', 'Mid' ]);
    assert.throws(
        () => normalizeFederatedEntry(p, {type : 'Sub', types : [ 'Undeclared' ], fields : {}}),
        RoutingConflict);
    p.rules[0]!.supertypes = [ 'Sub' ];
    assert.throws(() => validateFederationPolicy(p, table()), /cyclic/);
});
test('existing HRW/fixed/default placement changes require migration', () => {
    const p = policy();
    for (const mutate
             of [(n: FederationPolicy) => {(n.rules[0] as any).members = [ 'a', 'b' ]},
                     (n: FederationPolicy) => {(n.rules[0] as any).by = { field: 'other' }},
                     (n: FederationPolicy) => {n.default.member = 'b'},
                     (n: FederationPolicy) => {n.rules = n.rules.slice(1)}]) {
        const n = structuredClone(p);
        n.policyVersion = 2;
        mutate(n);
        assert.throws(() => validateFederationPolicy(n, table(), p), MigrationRequired);
    }
});
test('capacity/capability selection is fresh, deterministic and keeps previous search members',
     () => {
         const t = table();
         t.a!.capacity = {free : 3, at : 1};
         t.b!.capacity = {free : 5, at : 1};
         t.c!.capacity = {free : 5, at : 1};
         const p = policy();
         p.rules = [ {type : 'Task', mode : 'expand', members : [ 'a', 'b' ], by : 'capacity'} ];
         assert.equal(writeMember(p, t, {type : 'Task', fields : {}}, 10), 'b');
         t.b!.capacity!.at = -100000;
         assert.throws(() => writeMember(p, t, {type : 'Task', fields : {}}, 10),
                       CapacityUnavailable);
         const n = structuredClone(p);
         n.policyVersion = 2;
         (n.rules[0] as any).members = [ 'a', 'b', 'c' ];
         validateFederationPolicy(n, t, p);
         assert.deepEqual(searchMembers(n, {type : 'Task'}), [ 'a', 'b', 'c' ]);
         const shrink = structuredClone(n);
         shrink.policyVersion = 3;
         (shrink.rules[0] as any).members = [ 'a', 'c' ];
         assert.throws(() => validateFederationPolicy(shrink, t, n), MigrationRequired);
         p.rules = [ {
             type : 'Task',
             mode : 'expand',
             members : [ 'a', 'b', 'c' ],
             by : 'capability',
             capability : 'gpu'
         } ];
         assert.throws(() => writeMember(p, t, {type : 'Task', fields : {}}, 10), NoCapableMember);
         t.c!.capabilities = {names : [ 'gpu' ], at : 1};
         assert.equal(writeMember(p, t, {type : 'Task', fields : {}}, 10), 'c');
         t.c!.state = 'draining';
         assert.throws(() => writeMember(p, t, {type : 'Task', fields : {}}, 10), NoCapableMember);
     });
test('drain never reroutes an HRW key', () => {
    const p = policy(), t = table(), e = {type : 'Task', fields : {taskId : 9}};
    const id = writeMember(p, t, e, 1);
    t[id]!.state = 'draining';
    assert.throws(() => writeMember(p, t, e, 1), MemberDrained);
    assert.deepEqual(searchMembers(p, {type : 'Task', fields : {taskId : 9}}), [ id ]);
});
test('primary/expand mixing and undeclared merge semantics are rejected', () => {
    const t = table(), p = policy();
    p.rules.push({
        type : 'State',
        mode : 'sync',
        variant : 'primary',
        member : 'a',
        primaryReplica : 'p',
        replicaConfigVersion : 1,
        durability : 'single'
    });
    assert.throws(() => validateFederationPolicy(p, t, null, new Set(), true), /primary member/);
    p.rules = [ {
        type : 'State',
        mode : 'sync',
        variant : 'lww',
        members : [ 'a' ],
        keyFields : [ 'id' ],
        semantics : 'facts' as any
    } ];
    assert.throws(() => validateFederationPolicy(p, t, null, new Set(), true), /semantics/);
});
for (const backend of BACKENDS)
    test(`${backend}: policy persists atomically, is signed and survives reopen`, async () => {
        const home = new PersistentHome(backend);
        try {
            let h = await home.open();
            const controlId =
                (await h.commit(tx => createSpace(tx, 'control', Date.now()), ctx)).spaceId;
            const key = generateKey('ed25519', 'supervisor'), o = {
                host : h,
                ctx,
                controlSpaceId : controlId,
                authorityId : 'auth',
                peerId : 'supervisor',
                signer : key.signer,
                assertAuthority : async () => {}
            };
            await h.commit(async tx => {
                (await tx.doc(FederationRouting, controlId, null)).members = table();
            }, ctx);
            let authority = new FederationPolicyAuthority(o);
            const signed = await authority.install(policy(), 0, async () => {});
            assert.deepEqual(verifyFederationPolicy(signed, {
                                 authorityId : 'auth',
                                 peerId : 'supervisor',
                                 algorithm : 'ed25519',
                                 publicKey : key.publicKey
                             }),
                             policy());
            home.crash(h);
            h = await home.open();
            authority = new FederationPolicyAuthority({...o, host : h});
            assert.deepEqual((await authority.state()).policy, policy());
            const altered = structuredClone(signed);
            altered.policy.default.member = 'b';
            assert.throws(() => verifyFederationPolicy(altered, {
                              authorityId : 'auth',
                              peerId : 'supervisor',
                              algorithm : 'ed25519',
                              publicKey : key.publicKey
                          }),
                          RoutingConflict);
            await assert.rejects(
                authority.install({...policy(), policyVersion : 2}, 0, async () => {}), /stale/);
        } finally {
            await home.dispose();
        }
    });

test('supertype search also covers unruled direct instances at the default Member',()=>{const p=policy();p.rules=[{type:'Sub',supertypes:['Base'],mode:'local',member:'b'}];assert.deepEqual(searchMembers(p,{type:'Base'}),[p.default.member,'b'].sort());});
