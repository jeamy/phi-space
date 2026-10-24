import type { Metadata } from "next";
import "../client/styles.css";

export const metadata: Metadata = {
	title: "Leuchtfeuer · spaces-mmo",
	description: "Ein Mehrspieler-Rollenspiel, dessen ganze Welt in einem phi-space liegt.",
	applicationName: "spaces-mmo",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="de">
			<body>{children}</body>
		</html>
	);
}
