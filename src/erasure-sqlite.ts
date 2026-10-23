// Maintenance of an exclusively owned, stopped SQLite store after an erasure: the own store's (store/erasure-own.ts).
// A pi-durable store is refused like any file that is not a phi-spaces store (decision D6, docs/umstellung-u0-bestand.md).
export { compactErasedOwnStore as compactErasedSqlite } from "./store/erasure-own.ts";
