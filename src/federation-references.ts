// Check every implemented Root journal in the same Control transaction as removal.
import type {Tx} from '@earendil-works/pi-durable';
import {createHash} from 'node:crypto';

import {canonicalJson} from './canonical.ts';
import {FederationJournalLayout,parentJournalKey,validateJournalPartitions} from './federation-journals.ts';
import {FederationOperations} from './federated-space.ts';
import {RouterCommands, RouterJournal} from './router.ts';
import {spaceDoc} from './spaces.ts';

export async function memberReferencesIn(
    tx: Tx, o: {controlSpaceId: string; routerId : string; federationId : string}, memberId: string,
    spaceId: string): Promise<boolean> {
    const layout=await tx.doc(FederationJournalLayout,o.federationId,null),partitions=layout.partitions??1;
    validateJournalPartitions(partitions);
    if(layout.reconciliation) return true;
    if(layout.partitions!==null && (!layout.routerIds || layout.routerIds.length!==partitions || new Set(layout.routerIds).size!==partitions))
        throw new Error('incomplete journal topology');
    for(const routerId of new Set([o.routerId,...(layout.routerIds??[])])) {
    const index = await tx.doc(RouterJournal, routerId, null);
    for (const [id, ref] of Object.entries(index.refs)) {
        if ([ 'completed', 'failed' ].includes(ref.state) || ref.released)
            continue;
        const key = createHash('sha256').update(canonicalJson([ routerId, id ])).digest('hex'),
              command = (await tx.doc(RouterCommands, key, null)).command;
        if (!command)
            throw new Error('incomplete Router reference reconstruction');
        if (command.steps.some(s => s.target.spaceId === spaceId))
            return true;
    }
    }
    const operations:Record<string, import('./federated-space.ts').FederationOperation>={};
    for(let partition=0;partition<partitions;partition++)
        Object.assign(operations,(await tx.doc(FederationOperations,parentJournalKey(o.federationId,partitions,partition),null)).operations);
    for (const op of Object.values(operations)) {
        if (!op.members.includes(memberId))
            continue;
        if (op.phase !== 'done')
            return true;
        if (op.kind === 'txn' && (op.args as any).action === 'begin' &&
            !Object.values(operations)
                 .some(done => done.kind === 'txn' && done.phase === 'done' &&
                               (done.args as any).originId === op.id &&
                               [ 'commit', 'abort' ].includes((done.args as any).action)))
            return true;
    }
    const control = await spaceDoc(tx, o.controlSpaceId, Date.now());
    return control.entries.some(
        e => !['Command', 'Result', 'PeerKey', 'Enroll', 'RouterLease', 'Capability', 'MemberStatus'].includes(e.type) &&
             !['completed', 'failed', 'stopped', 'cancelled'].includes(String(e.fields.state)) &&
             (e.fields.memberId === memberId || e.fields.spaceId === spaceId ||
              Array.isArray(e.fields.members) && e.fields.members.includes(memberId)));
}
