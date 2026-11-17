// Shared source links for the experiment readers and the site headers.
export const PHI_SPACES_GITHUB = "https://github.com/jeamy/phi-space";
export const EXPERIMENT_FILES = {
 planning: { en: "codemode-planning-summary.en.md" },
 jev: { en: "codemode-jev-player.en.md" },
 article: { en: "codemode-planning-article.en.md", de: "de-docs/codemode-planning-article.md" },
 plan: { en: "codemode-planung.en.md" },
} as const;

export function experimentSourceUrl(id: string, lang = "en"): string | null {
 if (!Object.hasOwn(EXPERIMENT_FILES, id)) return null;
 const choices = EXPERIMENT_FILES[id as keyof typeof EXPERIMENT_FILES] as { en: string; de?: string };
 const path = lang === "de" && choices.de ? choices.de : choices.en;
 return `${PHI_SPACES_GITHUB}/blob/master/codemode-chat/docs/${path}`;
}
