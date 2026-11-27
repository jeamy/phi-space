import type { Metadata } from "next";
import { HelpApp } from "../../client/HelpApp.tsx";

export const metadata: Metadata = {
	title: "Help · FORUM",
	description: "Help for FORUM: rooms, the table, the plan, signing in, on the phone, and for the operator.",
};

export default function Page() {
	return <HelpApp />;
}
