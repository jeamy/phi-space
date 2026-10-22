// The invocation context of phi-spaces: an optional abort signal and immutable values passed explicitly through
// operations. phi-spaces' own type (docs/umstellung-u0-bestand.md, decision D1); it has the same shape as the
// context the pi-durable adapter still hands on, so a context made here passes through unchanged.

/** A typed key of a context value. */
export interface ContextKey<T> {
	readonly token: symbol;
	/** Type-only marker that keeps keys of different value types apart. */
	readonly valueType?: (value: T) => T;
}

/** Immutable invocation-scoped values; `abortSignal` cancels the work done under it. */
export interface Context {
	readonly abortSignal: AbortSignal | undefined;
	value<T>(key: ContextKey<T>): T | undefined;
	toString(): string;
}

const ABORT_SIGNAL: ContextKey<AbortSignal | undefined> = Object.freeze({ token: Symbol("phi-spaces.abortSignal") });

abstract class BaseContext implements Context {
	get abortSignal(): AbortSignal | undefined { return this.value(ABORT_SIGNAL); }
	abstract value<T>(key: ContextKey<T>): T | undefined;
	abstract toString(): string;
}

class EmptyContext extends BaseContext {
	readonly #name: string;
	constructor(name: string) { super(); this.#name = name; }
	value<T>(_key: ContextKey<T>): T | undefined { return undefined; }
	toString(): string { return this.#name; }
}

class ValueContext extends BaseContext {
	readonly #parent: Context;
	readonly #key: ContextKey<unknown>;
	readonly #value: unknown;
	constructor(parent: Context, key: ContextKey<unknown>, value: unknown) { super(); this.#parent = parent; this.#key = key; this.#value = value; }
	value<T>(key: ContextKey<T>): T | undefined { return key.token === this.#key.token ? (this.#value as T) : this.#parent.value(key); }
	toString(): string { return `${this.#parent}.WithValue(${this.#key.token.description ?? "anonymous"})`; }
}

/** The root context: no values, never cancelled. */
export const BACKGROUND_CONTEXT: Context = new EmptyContext("[Context BACKGROUND_CONTEXT]");

export function createContextKey<T>(description: string): ContextKey<T> { return Object.freeze({ token: Symbol(description) }); }

/** A context with one value added or replaced; the parent stays as it is. */
export function withContextValue<T>(key: ContextKey<T>, value: T, parent: Context): Context { return new ValueContext(parent, key as ContextKey<unknown>, value); }

/** A context cancelled by the parent's signal or by `signal`, whichever comes first. */
export function withAbortSignal(signal: AbortSignal, context: Context): Context {
	const parent = context.abortSignal;
	return withContextValue(ABORT_SIGNAL, parent === undefined ? signal : AbortSignal.any([parent, signal]), context);
}

/** A child context that can be cancelled on its own. */
export function withCancel(context: Context): { readonly context: Context; readonly cancel: (reason?: unknown) => void } {
	const controller = new AbortController();
	return { context: withAbortSignal(controller.signal, context), cancel: (reason) => controller.abort(reason) };
}

/** Waits for `promise` until it settles or the context is cancelled. Cancelling rejects only this wait; the promise
 *  itself goes on. */
export function awaitWithContext<T>(promise: Promise<T>, context: Context): Promise<T> {
	const signal = context.abortSignal;
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
	});
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
