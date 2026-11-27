import type { MetadataRoute } from "next";

/** So that the page can be put on a phone's home screen (docs/forum-seite-plan-2026-11-26.en.md, section 10). */
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "FORUM", short_name: "FORUM", description: "People and AI models work out a plan together.",
		start_url: "/", display: "standalone", background_color: "#0d151b", theme_color: "#0d151b",
		icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
	};
}
