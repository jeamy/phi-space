// The editor's draft (docs/zanzibar-agent-filesystem-plan.en.md, phase 4: "a version conflict preserves the user's
// draft"): pure state transitions, shared by the page (web/app.ts, served with its types stripped) and its test. A save
// never throws the draft away: a conflict keeps it and records the newer version, a refusal keeps it and says why,
// and only a committed save makes the draft the new base.

export type SaveOutcome = { version: number } | { error: string; message?: string; currentVersion?: number };

export type Draft = {
	workspace: string;
	path: string;
	/** The version the draft was edited from; 0 for a file that does not exist yet. */
	baseVersion: number;
	/** The text of that version. */
	baseText: string;
	/** What the user typed. */
	text: string;
	/** Set after a version conflict: someone saved this version first. */
	conflictVersion: number | null;
	/** A line for the user about the last save. */
	status: string;
	/** The operation ID and text of a save whose reply was lost; a retry with the same text sends the same ID again,
	 *  so the save applies once (`operationIdFor`). */
	pendingOperationId: string | null;
	pendingText: string | null;
};

export function openDraft(workspace: string, path: string, text: string, version: number): Draft {
	return { workspace, path, baseVersion: version, baseText: text, text, conflictVersion: null, status: "", pendingOperationId: null, pendingText: null };
}

export function edit(d: Draft, text: string): Draft {
	return { ...d, text };
}

export const dirty = (d: Draft) => d.text !== d.baseText;

/** The draft after a save attempt that was answered. */
export function afterSave(d: Draft, r: SaveOutcome): Draft {
	if ("version" in r) return { ...d, baseVersion: r.version, baseText: d.text, conflictVersion: null, pendingOperationId: null, pendingText: null, status: `Saved as version ${r.version}.` };
	const kept = { ...d, pendingOperationId: null, pendingText: null };
	switch (r.error) {
		case "versionConflict":
			return { ...kept, conflictVersion: r.currentVersion ?? null, status: `Someone saved version ${r.currentVersion} first. Your draft is kept: load their version to compare, then save over it.` };
		case "notFound":
			return { ...kept, status: "This file is gone or no longer visible to you. Your draft is kept; copy it before you leave." };
		case "permissionDenied":
			return { ...kept, status: "You may no longer edit this file. Your draft is kept; copy it before you leave." };
		case "unauthenticated":
			return { ...kept, status: "Your session has ended. Your draft is kept; sign in again in another tab, then save." };
		default:
			return { ...kept, status: `Not saved (${r.error}${r.message ? `: ${r.message}` : ""}). Your draft is kept.` };
	}
}

/** The draft after its save's reply was lost: the same operation ID goes out again with the next attempt. */
export function afterLostReply(d: Draft, operationId: string, sentText: string): Draft {
	return { ...d, pendingOperationId: operationId, pendingText: sentText, status: "No answer from the service. Save again: the save is applied once." };
}

/** The operation ID a save of the current text must carry: the lost one for the same text, else a fresh one. */
export function operationIdFor(d: Draft, fresh: () => Promise<string>): Promise<string> {
	return d.pendingOperationId !== null && d.pendingText === d.text ? Promise.resolve(d.pendingOperationId) : fresh();
}

/** Takes the newer version as the base after a conflict, keeping the user's text; the next save goes over it. */
export function rebase(d: Draft, text: string, version: number): Draft {
	return { ...d, baseText: text, baseVersion: version, conflictVersion: null, pendingOperationId: null, pendingText: null, status: `Now editing over version ${version}; your text is unchanged.` };
}
