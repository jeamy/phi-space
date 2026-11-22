// A section's text comes from a model (and later from sources the models quote): untrusted. The shared Markdown
// renderer escapes HTML but writes any link target into href, so a target that is not a plain web address is taken out
// before rendering: the link's text stays, a `javascript:` or `data:` address does not.
import { renderMarkdownToHtml } from "./markdown.ts";

const SAFE = /^(https?:\/\/|mailto:)[^\s"'<>`]+$/i;

/** The Markdown with every link whose target is not http(s) or mailto reduced to its text. */
export const safeLinks = (markdown: string): string => markdown.replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_m, label: string, href: string) => (SAFE.test(href.trim()) ? `[${label}](${href.trim()})` : label));

/** A section's text as HTML. */
export const renderSection = (markdown: string): string => renderMarkdownToHtml(safeLinks(markdown));
