/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The page in English and German: elements name their texts by key (data-t: text, data-ph: placeholder, data-tip-k: the
// tip help.ts shows, data-aria: aria-label); the detailed help has one body per language (.help-body[lang]). The choice
// is kept per browser (files.lang); without one the browser's language decides. The HTML carries the English texts, so
// the page reads without this script too.

export type Lang = "en" | "de";

const T: Record<string, [en: string, de: string]> = {
	// header
	"admin": ["Administration", "Verwaltung"],
	"switch": ["Switch tenant", "Tenant wechseln"],
	"logout": ["Sign out", "Abmelden"],
	"help": ["Help", "Hilfe"],
	"tip.who": ["You (your actor ID) in the tenant you are signed in to", "Du (deine Akteur-ID) in dem Tenant, in dem du angemeldet bist"],
	"tip.admin": ["Manage the actors, groups and workspaces of this tenant (tenant administrators only)", "Akteure, Gruppen und Workspaces dieses Tenants verwalten (nur für Tenant-Administratoren)"],
	"tip.switch": ["Sign in again and choose another tenant you belong to", "Neu anmelden und einen anderen Tenant wählen, zu dem du gehörst"],
	"tip.logout": ["End this session on this device", "Diese Sitzung auf diesem Gerät beenden"],
	"tip.help": ["What every field means", "Was jedes Feld bedeutet"],
	"tip.lang": ["Language of the page", "Sprache der Seite"],
	"cancel": ["Cancel", "Abbrechen"],
	"signin.title": ["Sign in", "Anmelden"],
	"signin.text": ["Your files, your workspaces and what others share with you.", "Deine Dateien, deine Workspaces und was andere mit dir teilen."],
	// browsing
	"workspaces": ["Workspaces", "Workspaces"],
	"name": ["name", "Name"],
	"newFile": ["New file", "Neue Datei"],
	"newDir": ["New directory", "Neues Verzeichnis"],
	"tip.createName": ["Name of a new file or directory in the directory shown above. Case-sensitive; no slash, not . or ..; needs editor here", "Name einer neuen Datei oder eines neuen Verzeichnisses im oben gezeigten Verzeichnis. Groß-/Kleinschreibung zählt; kein Schrägstrich, nicht . oder ..; braucht hier editor"],
	"tip.newFile": ["Create an empty file with this name here", "Hier eine leere Datei mit diesem Namen anlegen"],
	"tip.newDir": ["Create a directory with this name here", "Hier ein Verzeichnis mit diesem Namen anlegen"],
	"grants": ["Grants on this directory", "Rechte auf diesem Verzeichnis"],
	"tip.grants": ["Who holds which role on this directory; only an owner sees the list and changes it", "Wer welche Rolle auf diesem Verzeichnis hat; nur ein owner sieht und ändert die Liste"],
	"tip.relation": ["The role: viewer reads, editor also writes and creates, owner also manages grants. It applies to everything below", "Die Rolle: viewer liest, editor schreibt und legt an, owner vergibt zusätzlich Rechte. Sie gilt für alles darunter"],
	"tip.grantKind": ["Who receives it: a user, an agent instance, or every member of a group", "Wer sie bekommt: ein Benutzer, eine Agenten-Instanz oder jedes Mitglied einer Gruppe"],
	"subjectId": ["actor ID / group", "Akteur-ID / Gruppe"],
	"tip.grantId": ["The actor ID as in the tenant's actor list (for user and agent), or the group's name; the list offers the known ones", "Die Akteur-ID wie in der Akteur-Liste des Tenants (bei user und agent) oder der Name der Gruppe; die Liste schlägt die bekannten vor"],
	"grant": ["Grant", "Vergeben"],
	"revoke": ["Revoke", "Entziehen"],
	"tip.grant": ["Give this role on this directory", "Diese Rolle auf diesem Verzeichnis vergeben"],
	"tip.revoke": ["Take back exactly this grant; access through other grants or groups stays", "Genau dieses Recht zurücknehmen; Zugang über andere Rechte oder Gruppen bleibt"],
	"restrict": ["Restrict", "Einschränken"],
	"unrestrict": ["Unrestrict", "Freigeben"],
	"tip.restrict": ["Stop inheritance here: only the owners above and those with a grant on this directory keep it", "Vererbung hier stoppen: nur die owner darüber und wer ein Recht auf diesem Verzeichnis hat, behalten es"],
	"tip.unrestrict": ["Let the roles from above pass into this directory again", "Die Rollen von oben wieder in dieses Verzeichnis durchlassen"],
	// editor
	"save": ["Save", "Speichern"],
	"theirs": ["Load their version", "Deren Version laden"],
	"close": ["Close", "Schließen"],
	"removeFile": ["Remove file", "Datei löschen"],
	"tip.save": ["Save over the version you opened. If someone saved in between, you get a conflict and keep your text", "Über die geöffnete Version speichern. Hat inzwischen jemand gespeichert, kommt ein Konflikt und dein Text bleibt"],
	"tip.theirs": ["Show the newer saved version and decide whether to save your text over it", "Die neuere gespeicherte Version zeigen und entscheiden, ob dein Text darüber gespeichert wird"],
	"tip.close": ["Close the file; asks first if you have unsaved changes", "Die Datei schließen; fragt vorher, wenn Änderungen nicht gespeichert sind"],
	"tip.removeFile": ["Delete this file; refused if someone saved a newer version", "Diese Datei löschen; abgelehnt, wenn jemand eine neuere Version gespeichert hat"],
	// administration
	"adminTitle": ["Tenant administration", "Tenant-Verwaltung"],
	"register": ["Register an actor", "Akteur anlegen"],
	"actorId": ["actor ID", "Akteur-ID"],
	"homeName": ["home name", "Home-Name"],
	"regA": ["issuer / host peer ID", "Issuer / Host-Peer-ID"],
	"regB": ["subject / agent ID", "Subject / Agent-ID"],
	"registerBtn": ["Register", "Anlegen"],
	"generate": ["Generate", "Erzeugen"],
	"tip.regKind": ["user: a person signing in in the browser. agent: an agent instance that works through an agent host", "user: eine Person, die sich im Browser anmeldet. agent: eine Agenten-Instanz, die über einen Agenten-Host arbeitet"],
	"tip.regId": ["The new actor's ID in this tenant, used in grants and groups: 1 to 128 of A-Z a-z 0-9 _ . : -; never reused", "Die ID des neuen Akteurs in diesem Tenant, benutzt in Rechten und Gruppen: 1 bis 128 Zeichen aus A-Z a-z 0-9 _ . : -; wird nie wiederverwendet"],
	"tip.genId": ["Fill in an ID: the username or agent ID if one is entered, otherwise a new random one", "Eine ID eintragen: den Benutzernamen bzw. die Agent-ID, wenn eingetragen, sonst eine neue zufällige"],
	"tip.regHome": ["Name of the actor's own workspace, created with it; follows the actor ID until you change it", "Name des eigenen Workspace des Akteurs, wird mit ihm angelegt; folgt der Akteur-ID, bis du ihn änderst"],
	"tip.regA.user": ["The issuer of the sign-in: local for username and password (offered in the list), or the OpenID provider's issuer URL", "Der Issuer der Anmeldung: local für Benutzername und Passwort (in der Liste), oder die Issuer-URL des OpenID-Anbieters"],
	"tip.regA.agent": ["The peer ID of the agent host the agent runs on; the list offers the hosts enrolled for this tenant", "Die Peer-ID des Agenten-Hosts, auf dem der Agent läuft; die Liste zeigt die für diesen Tenant eingeschriebenen Hosts"],
	"tip.regB.user": ["The subject: with password sign-in the username (lower case); the password is set by the host operator", "Das Subject: bei Passwort-Anmeldung der Benutzername (klein geschrieben); das Passwort setzt der Host-Operator"],
	"tip.regB.agent": ["The agent ID its host gives the agent; Generate makes a new one, which the host must then use", "Die Agent-ID, die sein Host dem Agenten gibt; Erzeugen macht eine neue, die der Host dann verwenden muss"],
	"tip.genAgent": ["A new random agent ID (only for an agent)", "Eine neue zufällige Agent-ID (nur bei agent)"],
	"tip.registerBtn": ["Create the actor and its home in one step", "Den Akteur und sein Home in einem Schritt anlegen"],
	"member": ["Group membership", "Gruppenmitgliedschaft"],
	"group": ["group", "Gruppe"],
	"add": ["Add", "Hinzufügen"],
	"remove": ["Remove", "Entfernen"],
	"tip.memGroup": ["The group's name; a new name makes a new group. The list offers the existing ones", "Der Name der Gruppe; ein neuer Name ergibt eine neue Gruppe. Die Liste zeigt die vorhandenen"],
	"tip.memKind": ["Who joins: a user, an agent, or every member of another group (nested up to 4 levels)", "Wer beitritt: ein Benutzer, ein Agent oder jedes Mitglied einer anderen Gruppe (bis 4 Ebenen verschachtelt)"],
	"tip.memId": ["The actor ID, or the other group's name; the list offers the known ones", "Die Akteur-ID oder der Name der anderen Gruppe; die Liste schlägt die bekannten vor"],
	"tip.add": ["Add to the group: the member gets every role the group holds", "Zur Gruppe hinzufügen: das Mitglied bekommt jede Rolle der Gruppe"],
	"tip.remove": ["Remove from the group: the access that came through it ends at once", "Aus der Gruppe entfernen: der Zugang über sie endet sofort"],
	"workspace": ["Create a workspace", "Workspace anlegen"],
	"ownerId": ["owner's actor ID", "Akteur-ID des Owners"],
	"create": ["Create", "Anlegen"],
	"tip.wsName": ["Name of the new shared workspace (a top-level directory); names starting with @ are reserved", "Name des neuen gemeinsamen Workspace (ein Verzeichnis ganz oben); Namen mit @ am Anfang sind reserviert"],
	"tip.wsKind": ["Whether the first owner is a user or an agent", "Ob der erste owner ein Benutzer oder ein Agent ist"],
	"tip.wsOwner": ["Actor ID of the first owner, who then gives further grants; the list offers the actors", "Akteur-ID des ersten Owners, der dann weitere Rechte vergibt; die Liste zeigt die Akteure"],
	"tip.create": ["Create the workspace with this owner", "Den Workspace mit diesem Owner anlegen"],
	"actors": ["Actors", "Akteure"],
	"groups": ["Groups", "Gruppen"],
	"tip.actors": ["Every user and agent of this tenant and its state", "Jeder Benutzer und Agent dieses Tenants und sein Zustand"],
	"tip.groups": ["Every group that has members or grants", "Jede Gruppe, die Mitglieder oder Rechte hat"],
	// messages of app.ts
	"msg.discard": ["Discard your unsaved draft?", "Ungespeicherten Entwurf verwerfen?"],
	"msg.discardYes": ["Discard", "Verwerfen"],
	"msg.notFound": ["Not found.", "Nicht gefunden."],
	"msg.ownerOnly": ["Only an owner sees the grants.", "Nur ein owner sieht die Rechte."],
	"msg.adminOnly": ["Only a tenant administrator manages the tenant.", "Nur ein Tenant-Administrator verwaltet den Tenant."],
	"msg.keepMine": ["Keep my text", "Meinen Text behalten"],
	"msg.theirsSaved": ["Version {v} is saved. Keep your text and save over this version?", "Version {v} ist gespeichert. Deinen Text behalten und über diese Version speichern?"],
	"msg.removeAsk": ["Remove {p} (version {v})? This cannot be undone.", "{p} (Version {v}) löschen? Das lässt sich nicht rückgängig machen."],
	"msg.removeYes": ["Remove", "Löschen"],
	"msg.newer": ["Someone saved a newer version: load it before removing.", "Jemand hat eine neuere Version gespeichert: lade sie vor dem Löschen."],
	"msg.done": ["{op}: done", "{op}: erledigt"],
};

const KEY = "files.lang";
const stored = (): Lang | null => { try { const v = localStorage.getItem(KEY); return v === "de" || v === "en" ? v : null; } catch { return null; } };
let current: Lang = stored() ?? (navigator.language?.toLowerCase().startsWith("de") ? "de" : "en");
const listeners: Array<(l: Lang) => void> = [];

export const lang = (): Lang => current;

/** The text of `key` in the current language, with {name} filled from `vars`. */
export function t(key: string, vars: Record<string, string | number> = {}): string {
	const pair = T[key];
	const s = pair ? pair[current === "de" ? 1 : 0] : key;
	return s.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? `{${k}}`));
}

/** Calls `f` now and after every change of language. */
export function onLang(f: (l: Lang) => void): void { listeners.push(f); f(current); }

export function setLang(l: Lang): void {
	current = l;
	try { localStorage.setItem(KEY, l); } catch { /* private mode: for this page only */ }
	apply();
}

function apply(): void {
	document.documentElement.lang = current;
	for (const el of document.querySelectorAll<HTMLElement>("[data-t]")) el.textContent = t(el.dataset.t!);
	for (const el of document.querySelectorAll<HTMLInputElement>("[data-ph]")) el.placeholder = t(el.dataset.ph!);
	for (const el of document.querySelectorAll<HTMLElement>("[data-tip-k]")) el.dataset.tip = t(el.dataset.tipK!);
	for (const el of document.querySelectorAll<HTMLElement>("[data-aria]")) el.setAttribute("aria-label", t(el.dataset.aria!));
	for (const el of document.querySelectorAll<HTMLElement>(".help-body[lang]")) el.hidden = el.lang !== current;
	for (const b of document.querySelectorAll<HTMLButtonElement>(".lang-switch button")) {
		b.classList.toggle("is-active", b.dataset.lang === current);
		b.setAttribute("aria-pressed", String(b.dataset.lang === current));
	}
	for (const f of listeners) f(current);
}

document.addEventListener("click", (e) => {
	const b = (e.target as Element | null)?.closest<HTMLButtonElement>(".lang-switch button");
	if (b?.dataset.lang === "de" || b?.dataset.lang === "en") setLang(b.dataset.lang);
});
apply();
