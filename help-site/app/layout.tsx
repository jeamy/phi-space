import type { Metadata } from "next";
import "../client/styles/layout.css";

export const metadata: Metadata = {
	metadataBase: new URL("https://spaces.eibrain.org"),
	title: "PI-SPACES / HELP — Technical Reference & Multiplayer Space-Chat (spaces.eibrain.org)",
	description:
		"Bilingual high-end technical product reference, step-by-step guide (v1–v6), Multiplayer Space-Chat workbench, and AdminSpaces control center for pi-spaces.",
	applicationName: "PI-SPACES Help",
	openGraph: {
		title: "PI-SPACES / HELP",
		description: "Spaces. Precisely coordinated. The bilingual high-end pi-spaces reference & Multiplayer Space-Chat.",
		url: "https://spaces.eibrain.org",
		type: "website",
	},
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="en" data-mode="dark" data-palette="spaces_default" suppressHydrationWarning>
			<body>{children}</body>
		</html>
	);
}
