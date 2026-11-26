import type { Metadata } from "next";
import { HelpApp } from "../../client/HelpApp.tsx";

export const metadata: Metadata = {
	title: "Help · PHI-SPACES / CODEMODE FORUM",
	description: "Help for the codemode forum: plan tasks and sources, runs and the two tables, discussion and ballots, comparison and export, the checking program, operations, safety and limits.",
};

export default function Page() {
	return <HelpApp />;
}
