// What the page and the server both show of loads (engine/pack.ts), without imports: the page bundles it.

/** 31.5 as "31½". */
export const fmtLoad = (n: number): string => { const whole = Math.floor(n + 1e-9), half = n - whole >= 0.5 - 1e-9; return whole === 0 && half ? "½" : `${whole}${half ? "½" : ""}`; };

/** The order in which one's chests are numbered (the command's list and the page's choice): by place, then by id. */
export const chestOrder = (a: { roomName: string; buildId: string }, b: { roomName: string; buildId: string }): number => a.roomName.localeCompare(b.roomName, "de") || (a.buildId < b.buildId ? -1 : a.buildId > b.buildId ? 1 : 0);
