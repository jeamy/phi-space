// The two roots the repository-wide checks keep apart (docs/umstellung-verzeichnisse.en.md): the repository (the
// applications, docs/, the root .env) and the phi-spaces package (src/, test/, examples/, scripts/, agent/, its
// package.json with the exports) in spaces/ since phase 3.
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The phi-spaces package. */
export const PACKAGE = join(REPO, "spaces");
/** The package's path from the repository root ("spaces/"; "" if they were one). */
export const PACKAGE_PREFIX = relative(REPO, PACKAGE) ? `${relative(REPO, PACKAGE)}/` : "";
/** The applications built on phi-spaces. Every check that walks them fails when one of them is not found, so a move
 *  cannot leave one unchecked without a word. */
export const APPS = ["codemode-chat", "help-site", "spaces-mmo"];
