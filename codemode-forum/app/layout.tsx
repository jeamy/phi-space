import type { Metadata, Viewport } from "next";
import "../client/styles/layout.css";

export const metadata: Metadata = {
	title: "FORUM",
	description: "At least three AI models develop one plan together in a shared phi-space, until a majority agrees it can be carried out.",
	applicationName: "FORUM",
	icons: { icon: "/icon.svg" },
};

/** The device's width, and the page drawn under a phone's notch and rounded corners (its bars keep clear of them). */
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0d151b" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" data-mode="dark" suppressHydrationWarning>
			<body>{children}</body>
		</html>
	);
}
