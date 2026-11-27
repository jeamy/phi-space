"use client";
// The controls of the FORUM page (docs/forum-seite-plan-2026-11-26.en.md, sections 4, 10 and 11): every input, choice,
// text area, box and button has a name a screen reader says and a tip that links into the help. The page's files use
// these and nothing else (tests/page.test.ts); the label sits beside its tip, never around it, so that it names the
// field and not the tip's button.
import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { HelpTip } from "../HelpTip.tsx";
import type { TipId } from "../lib/tips.ts";
import type { Lang } from "../lib/theme.ts";

type Named = { label: string; tip: TipId; lang: Lang; /** the name is said, not shown (a field whose place says it) */ quiet?: boolean };

function Head({ id, label, tip, lang, quiet }: Named & { id: string }) {
	return (
		<span className={quiet ? "f__head f__head--quiet" : "f__head"}>
			<label htmlFor={id} className={quiet ? "sr" : "f__label"}>{label}</label>
			<HelpTip id={tip} lang={lang} label={label} />
		</span>
	);
}

/** A line of text, a number, a file. */
export function Field({ label, tip, lang, quiet, className, ...rest }: Named & InputHTMLAttributes<HTMLInputElement>) {
	const id = useId();
	return (
		<div className={"f" + (className ? ` ${className}` : "")}>
			<Head id={id} label={label} tip={tip} lang={lang} quiet={quiet} />
			<input id={id} {...rest} />
		</div>
	);
}

export function Area({ label, tip, lang, quiet, className, ...rest }: Named & TextareaHTMLAttributes<HTMLTextAreaElement>) {
	const id = useId();
	return (
		<div className={"f" + (className ? ` ${className}` : "")}>
			<Head id={id} label={label} tip={tip} lang={lang} quiet={quiet} />
			<textarea id={id} {...rest} />
		</div>
	);
}

export function Choice({ label, tip, lang, quiet, className, children, ...rest }: Named & SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
	const id = useId();
	return (
		<div className={"f" + (className ? ` ${className}` : "")}>
			<Head id={id} label={label} tip={tip} lang={lang} quiet={quiet} />
			<select id={id} {...rest}>{children}</select>
		</div>
	);
}

/** A box to tick, its name beside it. */
export function Tick({ label, tip, lang, className, ...rest }: Omit<Named, "quiet"> & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
	const id = useId();
	return (
		<span className={"tick" + (className ? ` ${className}` : "")}>
			<input id={id} type="checkbox" {...rest} />
			<label htmlFor={id}>{label}</label>
			<HelpTip id={tip} lang={lang} label={label} />
		</span>
	);
}

/** A button: `kind` primary for the one action a place is for, danger for what takes something away. */
export function Act({ label, tip, lang, kind, className, children, ...rest }: Omit<Named, "quiet"> & ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "danger" }) {
	return (
		<span className="act">
			<button type="button" className={"b" + (kind ? ` b--${kind}` : "") + (className ? ` ${className}` : "")} aria-label={children ? label : undefined} {...rest}>{children ?? label}</button>
			<HelpTip id={tip} lang={lang} label={label} />
		</span>
	);
}
