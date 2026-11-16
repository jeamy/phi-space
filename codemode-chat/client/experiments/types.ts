export type PublicationId = "planning" | "jev" | "article";
export type PublicationBody = { title: string; html: string; toc: Array<{ id: string; title: string; level: number }> };
export type Publication = { id: PublicationId; bodies: { en: PublicationBody; de?: PublicationBody } };
