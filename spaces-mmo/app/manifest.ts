import type { MetadataRoute } from "next";

// Added to the home screen, the game opens without the browser's bars (a phone or a tablet).
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Leuchtfeuer · spaces-mmo",
		short_name: "Leuchtfeuer",
		description: "Ein Mehrspieler-Rollenspiel, dessen ganze Welt in einem phi-space liegt.",
		lang: "de",
		start_url: "/",
		display: "fullscreen",
		orientation: "any",
		background_color: "#0e151b",
		theme_color: "#0e151b",
		icons: [
			{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
			{ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
			{ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
			{ src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
