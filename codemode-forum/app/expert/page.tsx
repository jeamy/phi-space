import type { Metadata } from "next";
import { CodemodeForum } from "../../client/App.tsx";

export const metadata: Metadata = { title: "Expert view · FORUM" };

/** The page the forum had before FORUM (docs/forum-seite-plan-2026-11-26.en.md, section 4): the standings and the view
 *  of both tables; a room is the address's hash. */
export default function Page() {
	return <CodemodeForum />;
}
