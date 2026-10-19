import type { Metadata } from "next";
import { HelpApp } from "../../client/HelpApp.tsx";

export const metadata: Metadata = {
	title: "Help · PHI-SPACES / CODEMODE CHAT",
	description: "Help for the codemode chat: tasks and blocks, runs, judging, big and nano, configuration, safety and limits.",
};

export default function Page() {
	return <HelpApp />;
}
