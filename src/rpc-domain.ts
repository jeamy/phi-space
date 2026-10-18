// Domain normalization shared by signed delegation and RPC-claim verification.
import type {Principal} from "./claims.ts";
import {FOREVER, type Json} from "./core.ts";
import {principalId} from "./mailbox.ts";
import type {Call} from "./service.ts";

const duration = (v: Json|undefined, d: number): number => v === undefined   ? d
                                                           : v === null      ? -1
                                                           : v === "forever" ? FOREVER
                                                                             : v as number;
export function rpcDomain(call: Call, principal: Principal): {method: string; args : Json} {
    const a = call.args ?? {}, txn = a.txn ?? null;
    switch (call.method) {
    case "write":
        return {method : "write", args : {entry : a.entry!, txn, lease : duration(a.leaseMs, -1), ...(a.unique === undefined ? {} : {unique: a.unique})}};
    case "read":
    case "take":
        return {
            method : call.method + (a.ifExists === true ? "IfExists" : ""),
            args : {
                tmpl : a.template ?? null,
                timeout : duration(a.timeoutMs, 0),
                deadline : a.deadline ?? null,
                txn
            }
        };
    case "txn":
        return a.action === "begin"
                   ? {method : "txn.begin", args : {lease : duration(a.leaseMs, -1)}}
                   : {method : "txn." + a.action, args : {txn : a.id!}};
    case "lease":
        return a.action === "renew"
                   ? {method : "lease.renew", args : {leaseId : a.id!, ms : duration(a.ms, -1)}}
                   : {method : "lease.cancel", args : {leaseId : a.id!}};
    case "cancelOperation":
        return {
            method : call.method,
            args : {
                target : {
                    generation : (a.targetRequest as any).generation,
                    requestId : (a.targetRequest as any).requestId,
                    principal
                } as unknown as Json
            }
        };
    case "notify":
        return {
            method : call.method,
            args : {
                tmpl : a.template ?? null,
                txn,
                lease : duration(a.leaseMs, -1),
                handback : a.handback ?? null,
                target : principalId(principal)
            }
        };
    case "wait":
        return {
            method : call.method,
            args : {
                template : a.template ?? null,
                ...(a.deadline === undefined ? {} : {deadline : a.deadline}),
                take : a.take !== false,
                target : principalId(principal),
                timeout : duration(a.timeoutMs, 0),
                txnLeaseMs : duration(a.txnLeaseMs, -1),
                handback : a.handback ?? null
            }
        };
    case "ack":
        return {
            method : call.method,
            args : {
                mailboxEpoch : a.mailboxEpoch!,
                upTo : a.upTo!,
                principal : principal as unknown as Json
            }
        };
    default:
        return {method : call.method, args : a};
    }
}
