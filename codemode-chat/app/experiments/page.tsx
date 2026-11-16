import type { Metadata } from "next";
import { ExperimentsIndex } from "../../client/experiments/Experiments.tsx";

export const metadata: Metadata = {
	title: "Planning experiments · Codemode",
	description: "Experimental designs, results and papers comparing JEPA planning, code-generating agents and Jev workflows.",
};
export default function Page() { return <ExperimentsIndex />; }
