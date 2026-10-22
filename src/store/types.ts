// phi-spaces' own storage boundary (docs/umstellung-ohne-pi-durable.md, U1): document definitions, the transaction a
// commit callback gets, and the host that runs commits, reads committed documents and watches them. Nothing here
// names pi-durable; during the move the host behind it is still pi-durable (store/legacy.ts), later the own store.
import type { Context } from "../context.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** What a document definition needs to know about its stored value: its kind and schema version, how a new one looks,
 *  how an older version is brought up to date, and (for documents that grow) when the store may compact its history. */
type DocCommon<T> = {
	readonly kind: string;
	readonly version: number;
	readonly migrate?: (value: T & Record<string, any>, fromVersion: number) => T & Record<string, any>;
	readonly checkpointWhen?: (value: Readonly<T>, ops: readonly unknown[], info: { deltasSinceBase: number }) => boolean;
};

/** The same definition in the shape the transitional pi-durable host reads (session scope). It goes once the own
 *  store serves every host (U2/U3). */
type HostDefinition<T> = {
	readonly kind: string;
	readonly version: number;
	readonly scope: "session";
	initial(): T;
	migrate?(value: any, fromVersion: number): T;
	checkpointWhen?(value: Readonly<T>, ops: readonly any[], info: { deltasSinceBase: number }): boolean;
};
type HostFamilyDefinition<T, I> = Omit<HostDefinition<T>, "initial"> & { readonly family: true; initial(seed: I): T };

/** One document of a kind per store. */
export type DocDef<T> = DocCommon<T> & { readonly family?: false; readonly initial: () => T; readonly definition: HostDefinition<T> };
/** Many documents of a kind, each under its key; `seed` makes a new one. */
export type DocFamilyDef<T, I> = DocCommon<T> & { readonly family: true; readonly initial: (seed: I) => T; readonly definition: HostFamilyDefinition<T, I> };

/** The transaction of one commit: every document it reads is the same draft for the whole callback; the changes are
 *  stored together or not at all. */
export interface StoreTx {
	doc<T>(def: DocDef<T>): Promise<T>;
	doc<T, I>(def: DocFamilyDef<T, I>, key: string, seed: I): Promise<T>;
	retireDoc<T>(def: DocDef<T>): Promise<void>;
	retireDoc<T, I>(def: DocFamilyDef<T, I>, key: string): Promise<void>;
}

/** Why a watch ended: cancelled by its context, its document retired, the host closed, stopped by its owner, or its
 *  listener threw. */
export type WatchEnd = { readonly reason: "cancelled" | "retired" | "session_closed" | "stopped" } | { readonly reason: "listener_error"; readonly error: Error };
/** A watch of one committed document: `value` is the revision it started with, the listener gets every later one. */
export interface DocWatch<T> {
	readonly value: Readonly<T> | null;
	start(listener: (value: Readonly<T> | null, ops: readonly unknown[], context: Context) => void | Promise<void>): void;
	stop(): Promise<WatchEnd>;
	readonly closed: Promise<WatchEnd>;
}

/** The store as phi-spaces uses it: atomic commits over any documents, committed reads and watches. */
export interface StoreHost {
	commit<T>(change: (tx: StoreTx) => T | Promise<T>, context: Context): Promise<T>;
	snapshot<T>(def: DocDef<T>, context: Context): Promise<Readonly<T> | undefined>;
	snapshot<T, I>(def: DocFamilyDef<T, I>, key: string, context: Context): Promise<Readonly<T> | undefined>;
	watchDoc<T>(def: DocDef<T>, context: Context): Promise<DocWatch<T> | undefined>;
	watchDoc<T, I>(def: DocFamilyDef<T, I>, key: string, context: Context): Promise<DocWatch<T> | undefined>;
}

/** A store host that can be closed (admission sealed, admitted commits settled, storage closed). */
export interface ClosableStoreHost extends StoreHost {
	close(context: Context): Promise<void>;
}
