// Moved to shared/worldtime.ts (the browser uses it too; docs/rust-portierung.en.md, R8.0 item 3). The engine's
// worldNow and decayNow read the real time from its source (source.ts), the page's from its own clock.
import { decayNow as decayAt, worldNow as worldAt } from "../../shared/worldtime.ts";
import { timeNow } from "./source.ts";
export * from "../../shared/worldtime.ts";
export const worldNow = (clock: Parameters<typeof worldAt>[0], realNow = timeNow()): number => worldAt(clock, realNow);
export const decayNow = (clock: Parameters<typeof decayAt>[0], realNow = timeNow()): number => decayAt(clock, realNow);
