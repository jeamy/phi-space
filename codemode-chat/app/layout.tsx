import type { Metadata } from "next";
import "../client/styles/layout.css";

export const metadata: Metadata = {
	title: "PHI-SPACES / CODEMODE CHAT",
	description: "Agents and people contribute code to a shared phi-space; a codemode sandbox judges every contribution.",
	applicationName: "PHI-SPACES Codemode Chat",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" data-mode="dark" suppressHydrationWarning>
			<body>{children}</body>
		</html>
	);
}
