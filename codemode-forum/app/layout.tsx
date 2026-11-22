import type { Metadata } from "next";
import "../client/styles/layout.css";

export const metadata: Metadata = {
	title: "PHI-SPACES / CODEMODE FORUM",
	description: "At least three AI models develop one plan together in a shared phi-space, until a majority agrees it can be carried out.",
	applicationName: "PHI-SPACES Codemode Forum",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" data-mode="dark" suppressHydrationWarning>
			<body>{children}</body>
		</html>
	);
}
