import type { Metadata, Viewport } from "next";
import "../client/styles.css";

export const metadata: Metadata = {
	title: "Leuchtfeuer · spaces-mmo",
	description: "Ein Mehrspieler-Rollenspiel, dessen ganze Welt in einem phi-space liegt.",
	applicationName: "spaces-mmo",
	appleWebApp: { capable: true, title: "Leuchtfeuer", statusBarStyle: "black-translucent" },
};

// the page reaches under a notch or the rounded corners (viewport-fit=cover); styles.css keeps its content out of
// them with the safe-area insets. Zooming the page stays allowed; the map takes pinches itself (touch-action: none).
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
	themeColor: [
		{ media: "(prefers-color-scheme: dark)", color: "#0e151b" },
		{ media: "(prefers-color-scheme: light)", color: "#ffffff" },
	],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="de">
			<body>{children}</body>
		</html>
	);
}
