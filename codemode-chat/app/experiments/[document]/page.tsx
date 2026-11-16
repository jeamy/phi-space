import { notFound } from "next/navigation";
import { ExperimentReader } from "../../../client/experiments/Experiments.tsx";
import { experimentPublication } from "../../../server/experiments-content.ts";

export const dynamicParams = false;
export function generateStaticParams() { return ["planning", "jev", "article"].map((document) => ({ document })); }
export async function generateMetadata({ params }: { params: Promise<{ document: string }> }) {
	const publication = experimentPublication((await params).document);
	return { title: `${publication?.bodies.en.title ?? "Experiments"} · Codemode` };
}
export default async function Page({ params }: { params: Promise<{ document: string }> }) {
	const publication = experimentPublication((await params).document);
	if (!publication) notFound();
	return <ExperimentReader publication={publication} />;
}
