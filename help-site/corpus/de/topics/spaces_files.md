---
standard: help_topic
id: help.topic.spaces_files
title: "spaces-files: Dateien für Menschen und Agenten"
short: "Ein Dateisystem mit Rechten im Zanzibar-Stil: was es ist, warum Agenten eigene Identitäten brauchen, wozu man es nutzt und wie es auf phi-spaces gebaut ist."
tags: [apps, spaces-files, files, zanzibar, permissions, agents, groups, receipts]
owner: ops
related: [help.topic.apps, help.topic.leases_and_transactions, help.topic.gate_auth_grants_and_recovery, help.topic.agent_tools_and_replay]
since: 0.0.1
---

# spaces-files: Dateien für Menschen und Agenten

## Überblick {#overview}

spaces-files ist ein Dateisystem auf phi-spaces für **Menschen und einzelne Agenten-Instanzen**. Beide arbeiten an denselben Dateien, jeder unter seiner eigenen Identität und mit eigenen Rechten. Die Rechte folgen dem Modell von Googles Zanzibar: Sie sind Beziehungen („Gruppe Nord ist editor von dispatch“), werden bei jeder Operation neu ausgewertet, und ein Entzug gilt für jede spätere Prüfung. Was von Zanzibar übernommen ist und was anders gelöst ist, steht unter [Zanzibar: Ausgangspunkt und Umsetzung](help.topic.spaces_files#zanzibar).

| Frage | Kurz |
|---|---|
| Was | Dateien und Verzeichnisse in Workspaces, mit Rollen owner, editor, viewer, Gruppen und Vererbung |
| Warum | Agenten brauchen eine eigene, entziehbare Identität statt des Kontos eines Menschen |
| Wozu | Menschen und Agenten teilen Arbeitsstände, ohne einander zu überschreiben oder zu viel zu sehen |
| Wie | Ein privater Space je Tenant für Metadaten und Rechte, verschlüsselte Blobs für die Inhalte |
| Wo | Auf big unter spaces-files.eibrain.org; lokal mit `npm run spaces-files` |

## Was es ist {#what}

Die Begriffe:

- **Tenant:** ein abgeschlossener Kunde oder ein Team mit einem eigenen, privaten Space. Tenants sehen einander nicht.
- **Akteur:** ein Mensch (user) oder eine Agenten-Instanz (agent). Jeder Akteur hat eine stabile ID und ein **Home**, einen eigenen Workspace, der mit ihm in derselben Transaktion entsteht.
- **Workspace:** ein benanntes Verzeichnis auf oberster Ebene, z. B. `dispatch`. Darunter liegen Verzeichnisse und Dateien, Text oder binär.
- **Rollen:** owner darf Rechte vergeben und bearbeiten, editor darf bearbeiten und lesen, viewer darf lesen. Eine Rolle kommt aus einem direkten Grant, aus einem Grant an eine Gruppe (auch verschachtelte Gruppen) oder ist von einem Verzeichnis darüber geerbt.
- **Tenant-Administrator:** verwaltet Akteure, Gruppen und Workspaces seines Tenants; Dateirechte hat er dadurch nicht.
- **Host-Operator:** betreibt den Dienst: Tenants, Schlüssel, Sicherungen, Grenzen. Er arbeitet über eine eigene lokale Schnittstelle ohne Dateioperationen.

Eine Datei hat Versionen. Gespeichert wird immer „über Version n“: Hat inzwischen jemand anderes Version n+1 gespeichert, kommt ein Versionskonflikt zurück, und der Text der anderen geht nicht verloren.

![Ein Speichern prüft zuerst Sitzung und Operation-ID, dann die aktuellen Rechte, dann eine passende Quittung, und erst dann die Version, bevor der neue Inhalt committet wird.](/help/img/zanzibar-save.svg)

## Warum {#why}

Sobald Agenten mitarbeiten, reichen die üblichen Lösungen nicht:

- **Ein Agent mit dem Konto eines Menschen** kann alles, was dieser Mensch kann, und im Nachhinein weiß niemand, wer was getan hat. In spaces-files ist jede Agenten-Instanz ein eigener Akteur: gebunden an den Agenten-Host, der sie betreibt, und ihre Agent-ID. Ihre Rechte sind sichtbar und einzeln entziehbar.
- **Ein Entzug muss sofort gelten.** Wird Lea aus der Gruppe Nord entfernt, darf ihr schon offener Editor nicht mehr speichern, und wenn Nord ihr einziger Zugang war, verschwindet `dispatch` aus ihrer Liste: Jeder Pfad darin antwortet dann genau wie ein Pfad, den es nicht gibt. Deshalb prüft jede Operation die Beziehungen neu, statt sich auf eine Sitzung zu verlassen.
- **Gleichzeitige Arbeit** von Menschen und Agenten erzeugt Konflikte. Versionen machen sie sichtbar, statt eine Seite still zu überschreiben.
- **Netze verlieren Antworten.** Jede ändernde Operation trägt eine signierte Operation-ID; eine Wiederholung nach verlorener Antwort liefert die gespeicherte Quittung statt die Änderung zweimal auszuführen.

![Lea liest brief.md in Version 4. Der Tenant-Administrator entfernt sie aus Nord, ihrem einzigen Zugang zu dispatch. Danach fehlt dispatch in ihrer Liste, und ein Speichern aus dem offenen Editor antwortet notFound; die Datei bleibt bei Version 4.](/help/img/zanzibar-revocation.svg)

## Wozu {#purpose}

- Ein Team und sein Planungs-Agent arbeiten am selben Briefing; der Agent sieht die Änderungen der Menschen, bevor er weiterschreibt.
- Jeder Agent bekommt ein eigenes Home für Notizen und Zwischenstände, das niemand sonst sieht, bis er es teilt.
- Ein Prüf-Agent bekommt viewer auf einen Workspace und kann lesen, aber nichts ändern.
- Eine Gruppe vergibt Rechte an viele auf einmal; wer die Gruppe verlässt, verliert genau den Zugang, der über sie kam.
- Read-only-Mounts (`@name`) zeigen Dateien eines anderen Systems mit dessen Rechten, ohne sie zu kopieren.

## Wie es funktioniert {#how}

![Browser, Agent und Tenant-Administrator erreichen den Dateidienst; der Host-Operator nutzt eine eigene, getrennt authentisierte lokale Schnittstelle. Der Dienst signiert Operation-IDs mit einem Schlüssel außerhalb des Datenverzeichnisses und erreicht jeden privaten Tenant-Space über die Warteschlange dieses Tenants.](/help/img/zanzibar-architecture.svg)

### Rechte als Beziehungen {#rights}

Rechte sind Tupel im Space des Tenants, zum Beispiel:

```text
group:north#member@user:lea
directory:dispatch#editor@group:north#member
directory:dispatch#owner@agent:planner-17
```

Lea ist Mitglied von Nord, Nord ist editor von `dispatch`, der Agent planner-17 ist owner. Die Rechte gelten nach unten für alles in `dispatch`. Die effektiven Rechte sind die Vereinigung aller Wege; ein Entzug nimmt nur diesen einen Weg weg. Sichtbar ist ein Workspace genau dann, wenn man viewer auf seiner Wurzel hat.

![Lea gehört zu Nord, und Nord hat editor-Rechte auf der Workspace-Wurzel dispatch. Der Agent planner-17 ist owner von dispatch. Beide Grants reichen bis brief.md.](/help/img/zanzibar-relationships.svg)

![Lea ist owner ihres Homes lea; planner-17 ist owner seines Homes und des gemeinsamen Workspace dispatch; Nord ist editor auf dispatch. Lea sieht dispatch nur, solange sie in Nord ist.](/help/img/zanzibar-workspaces.svg)

### Speicher und Inhalte {#store}

Der Space des Tenants hält Akteure, Knoten (Verzeichnisse, Dateien), Relationen, Quittungen und das Audit, alles im eigenen SQLite-Speicher von phi-spaces. Eine Operation läuft in der Warteschlange ihres Tenants und in **einer** Transaktion: Rechte prüfen, ändern, Quittung und Audit schreiben. Die Dateiinhalte liegen nicht im Space, sondern als Blobs daneben, je Version eine Datei, versiegelt mit AES-256-GCM. Der Space hält nur den Verweis auf die aktuelle Version. Die Tenant-Spaces werden nie nach außen gegeben: Ein generisches Space-Werkzeug würde die Rechteprüfung umgehen.

### Zugänge {#access}

- **Browser:** über HTTPS. Anmeldung mit einem OpenID-Anbieter oder, wo keiner eingerichtet ist (derzeit auf big), mit Benutzername und Passwort. Das Passwort setzt der Host-Operator; gespeichert wird nur ein scrypt-Hash. Die Sitzung ist ein `__Host-`-Cookie (Secure, HttpOnly, SameSite=Strict), jede Änderung prüft Herkunft und CSRF-Token.
- **Agenten:** Ein Agenten-Host verbindet sich über einen eigenen Unix-Socket je Host und Tenant oder von einem anderen Rechner über TLS mit dem Schlüsselbeweis von phi-spaces. Der Host nennt für jedes Gespräch die Agent-ID; zusammen mit dem Host ergibt das die Identität des Akteurs. `client/agent-client.ts` liefert die Werkzeuge mit relativen Pfaden.
- **Administration:** Der Tenant-Administrator arbeitet im Browser; der Host-Operator über einen Socket im Zustandsverzeichnis (`operator create-tenant`, `set-password`, `backup`, …).

### Betrieb und Wiederherstellung {#operations}

Der Dienst und sein Space-Prozess sind getrennte Prozesse; den Space-Prozess gibt es in TypeScript und in Rust (`files-space`). Sicherungen sind verschlüsselte Archive, je eines für die Daten und für den Bereitstellungs-Zustand (Sitzungen, Schlüssel, Passwörter). Eine Wiederherstellung schaltet die Sitzungs-Epoche weiter, sodass keine alte Sitzung überlebt. Für einen zweiten Standort gibt es einen Standby mit Fencing und Promotion; er ist getestet, aber auf big nicht eingeschaltet.

![Eine Wiederherstellung bleibt geschlossen, bis unabhängig bestätigte Wiederherstellungs-Benutzer jeden Tenant in der neuen Epoche abgeglichen haben.](/help/img/zanzibar-restore.svg)

## Zanzibar: Ausgangspunkt und Umsetzung {#zanzibar}

### Ausgangspunkt {#zanzibar-origin}

**Zanzibar** ist Googles System für Berechtigungen, beschrieben 2019 im Paper *Zanzibar: Google's Consistent, Global Authorization System* (USENIX ATC). Es entscheidet für Dienste wie Drive, Calendar, Photos und YouTube, wer was darf. Seine Kernideen:

- **Rechte sind Relationstupel** der Form `objekt#relation@subjekt`, z. B. `doc:brief#editor@user:lea`. Das Subjekt kann selbst eine Menge sein (`group:nord#member`), so entstehen Gruppen und verschachtelte Gruppen.
- **Regeln leiten Rechte ab** („Userset Rewrites“): Wer editor ist, ist auch viewer; wer Rechte auf einem Ordner hat, hat sie auf dessen Inhalt.
- **Jede Anfrage wird neu geprüft** (Check), statt Rechte in Sitzungen oder Tokens zu kopieren.
- **Konsistenz gegen das „New Enemy Problem“:** Wird jemandem ein Recht entzogen und danach neuer Inhalt hinzugefügt, darf er den neuen Inhalt nie sehen. Zanzibar ordnet dazu Änderungen und Prüfungen über Spanner-Zeitstempel und gibt Clients „Zookies“ mit, die eine Mindestaktualität für spätere Prüfungen festhalten.

Der zweite Ausgangspunkt ist **Zontallys Agenten-Dateisystem** (Blogbeitrag „Why we built a Zanzibar agent filesystem“): Jede angemeldete Sitzung bekommt ein eigenes Home, jede Operation wertet die Beziehungen neu aus, Verzeichnisrechte werden vererbt. Von dort stammen das automatisch angelegte Home je Akteur, die vererbten Verzeichnisrechte und die eigene Identität jeder Agenten-Instanz.

### Was übernommen ist {#zanzibar-adopted}

| Zanzibar | spaces-files |
|---|---|
| Relationstupel `objekt#relation@subjekt` | Dieselbe Form, gespeichert als Entries im Space des Tenants: Objekte tenant, group, directory, file; Relationen admin, member, owner, editor, viewer |
| Usersets als Subjekte | `group:nord#member` als Subjekt eines Grants und als Mitglied einer anderen Gruppe |
| Rewrite-Regeln | Fest im Code: owner umfasst editor, editor umfasst viewer; Rechte erben über den Eltern-Verweis jedes Knotens bis zur Wurzel des Workspaces |
| Check bei jeder Anfrage | Jede Operation prüft in der Warteschlange ihres Tenants, in derselben Transaktion wie die Änderung; kein Entscheidungs-Cache |
| Entzug gilt für jede spätere Prüfung | Ein Entzug ist mit seinem Commit wirksam; die nächste Operation, auch aus einem schon offenen Editor, sieht ihn |

### Was anders ist {#zanzibar-different}

- **Reihenfolge ohne Zookies.** Zanzibar ist global verteilt und braucht deshalb Zeitstempel und Zookies. spaces-files hat je Tenant genau eine Instanz, die Operationen annimmt, und eine Warteschlange: Jede Prüfung kommt nach jedem früheren Commit, das New Enemy Problem kann so nicht entstehen. Für Replikate sind kausale Revisions-Token festgelegt („nicht älter als Revision n lesen“); sie würden erst nötig, wenn Replikate Lesezugriffe bedienten, und das tun sie nicht.
- **Kein frei konfigurierbares Schema.** Zanzibar lässt jeden Dienst seine Namespaces und Regeln selbst definieren. Hier sind die Relationen und ihre Ableitung fest; unbekannte Relationen und falsche Subjekt-Objekt-Paare werden schon beim Schreiben abgelehnt.
- **Begrenzte Auswertung statt Leopard-Index.** Zanzibar beschleunigt tief verschachtelte Gruppen mit einem eigenen Index (Leopard). Hier ist die Verschachtelung begrenzt (`maxGroupDepth`, Standard 4), Zyklen werden beim Eintragen abgelehnt, und jede Entscheidung hat ein Arbeitsbudget (sonst `capacityExceeded`). Gemessen kostet eine Verzeichnisebene etwa 3,5 Lookups.
- **Sichtbarkeit je Workspace.** Wer viewer auf der Wurzel eines Workspaces hat, sieht ihn; wer nicht, bekommt für jeden Pfad darin dieselbe Antwort wie für einen Pfad, den es nicht gibt (`notFound`). So verrät eine Ablehnung nicht, dass etwas existiert.
- **Zusätzliche Regeln für einen Dateidienst:** Jede Workspace-Wurzel behält mindestens einen direkten owner, jeder Tenant mindestens einen Administrator (`lastOwner`, `lastAdmin`); die Rolle Tenant-Administrator gibt keine Dateirechte; ein Agent ist an seinen Agenten-Host und seine Agent-ID gebunden.
- **Maßstab.** Zanzibar verwaltet Billionen Tupel für viele Dienste; spaces-files hält die Tupel jedes Tenants in dessen eigenem Space auf einem Host. Mehrere Hosts mit je eigenen Tenants sind als mögliche Erweiterung notiert.

## Wo es läuft {#where}

- **big:** ein Container (Dienst und Rust-Space-Prozess) hinter nginx unter https://spaces-files.eibrain.org. Täglich gehen die verschlüsselten Sicherungen nach nano, in ein Konto, das nur hinzufügen, nicht löschen darf.
- **Lokal:** `npm run spaces-files` (`FILES_MEM=1` hält alles im Speicher), Tests mit `npm run test:spaces-files`.

## Grenzen {#limits}

- Ein Tenant hat genau eine Instanz, die ihn verwaltet; das ist die Grundlage der Reihenfolge-Garantie. Mehrere Hosts für viele Tenants sind als mögliche Erweiterung notiert.
- Die Space-Statistik zeigt die App bewusst nicht, weil sie die Tenant-Spaces offenlegen würde.
- Auf big gibt es derzeit Passwort-Anmeldung und keine Agenten-Hosts auf anderen Rechnern; beides ist gebaut und lässt sich einschalten.

## Weiterlesen {#further}

- Quellen: [Zanzibar-Paper](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/), [Zontallys Begründung](https://www.zontally.com/blogs/technical/why-we-built-a-zanzibar-agent-filesystem).
- Im Repository: `spaces-files/README.md` (Stand und Nachweise), `docs/zanzibar-agent-filesystem-plan.en.md` (Plan und Entscheidungen), `spaces-files/docs/operator-guide.en.md` (Betrieb).
- [Apps auf phi-spaces](help.topic.apps#files) stellt die App neben die anderen.
- [Leases und Transaktionen](help.topic.leases_and_transactions#overview) erklärt die Transaktionen, auf denen jede Operation beruht.
