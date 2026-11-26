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

spaces-files ist ein Dateisystem auf phi-spaces für **Menschen und einzelne Agenten-Instanzen**. Beide arbeiten an denselben Dateien, jeder unter seiner eigenen Identität und mit eigenen Rechten. Die Rechte folgen dem Modell von Googles Zanzibar: Sie sind Beziehungen („Gruppe Nord ist editor von dispatch“), werden bei jeder Operation neu ausgewertet, und ein Entzug gilt für jede spätere Prüfung.

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

## Warum {#why}

Sobald Agenten mitarbeiten, reichen die üblichen Lösungen nicht:

- **Ein Agent mit dem Konto eines Menschen** kann alles, was dieser Mensch kann, und im Nachhinein weiß niemand, wer was getan hat. In spaces-files ist jede Agenten-Instanz ein eigener Akteur: gebunden an den Agenten-Host, der sie betreibt, und ihre Agent-ID. Ihre Rechte sind sichtbar und einzeln entziehbar.
- **Ein Entzug muss sofort gelten.** Wird Lea aus der Gruppe Nord entfernt, darf ihr schon offener Editor nicht mehr speichern, und wenn Nord ihr einziger Zugang war, verschwindet `dispatch` aus ihrer Liste: Jeder Pfad darin antwortet dann genau wie ein Pfad, den es nicht gibt. Deshalb prüft jede Operation die Beziehungen neu, statt sich auf eine Sitzung zu verlassen.
- **Gleichzeitige Arbeit** von Menschen und Agenten erzeugt Konflikte. Versionen machen sie sichtbar, statt eine Seite still zu überschreiben.
- **Netze verlieren Antworten.** Jede ändernde Operation trägt eine signierte Operation-ID; eine Wiederholung nach verlorener Antwort liefert die gespeicherte Quittung statt die Änderung zweimal auszuführen.

## Wozu {#purpose}

- Ein Team und sein Planungs-Agent arbeiten am selben Briefing; der Agent sieht die Änderungen der Menschen, bevor er weiterschreibt.
- Jeder Agent bekommt ein eigenes Home für Notizen und Zwischenstände, das niemand sonst sieht, bis er es teilt.
- Ein Prüf-Agent bekommt viewer auf einen Workspace und kann lesen, aber nichts ändern.
- Eine Gruppe vergibt Rechte an viele auf einmal; wer die Gruppe verlässt, verliert genau den Zugang, der über sie kam.
- Read-only-Mounts (`@name`) zeigen Dateien eines anderen Systems mit dessen Rechten, ohne sie zu kopieren.

## Wie es funktioniert {#how}

### Rechte als Beziehungen {#rights}

Rechte sind Tupel im Space des Tenants, zum Beispiel:

```text
group:north#member@user:lea
directory:dispatch#editor@group:north#member
directory:dispatch#owner@agent:planner-17
```

Lea ist Mitglied von Nord, Nord ist editor von `dispatch`, der Agent planner-17 ist owner. Die Rechte gelten nach unten für alles in `dispatch`. Die effektiven Rechte sind die Vereinigung aller Wege; ein Entzug nimmt nur diesen einen Weg weg. Sichtbar ist ein Workspace genau dann, wenn man viewer auf seiner Wurzel hat.

### Speicher und Inhalte {#store}

Der Space des Tenants hält Akteure, Knoten (Verzeichnisse, Dateien), Relationen, Quittungen und das Audit, alles im eigenen SQLite-Speicher von phi-spaces. Eine Operation läuft in der Warteschlange ihres Tenants und in **einer** Transaktion: Rechte prüfen, ändern, Quittung und Audit schreiben. Die Dateiinhalte liegen nicht im Space, sondern als Blobs daneben, je Version eine Datei, versiegelt mit AES-256-GCM. Der Space hält nur den Verweis auf die aktuelle Version. Die Tenant-Spaces werden nie nach außen gegeben: Ein generisches Space-Werkzeug würde die Rechteprüfung umgehen.

### Zugänge {#access}

- **Browser:** über HTTPS. Anmeldung mit einem OpenID-Anbieter oder, wo keiner eingerichtet ist (derzeit auf big), mit Benutzername und Passwort. Das Passwort setzt der Host-Operator; gespeichert wird nur ein scrypt-Hash. Die Sitzung ist ein `__Host-`-Cookie (Secure, HttpOnly, SameSite=Strict), jede Änderung prüft Herkunft und CSRF-Token.
- **Agenten:** Ein Agenten-Host verbindet sich über einen eigenen Unix-Socket je Host und Tenant oder von einem anderen Rechner über TLS mit dem Schlüsselbeweis von phi-spaces. Der Host nennt für jedes Gespräch die Agent-ID; zusammen mit dem Host ergibt das die Identität des Akteurs. `client/agent-client.ts` liefert die Werkzeuge mit relativen Pfaden.
- **Administration:** Der Tenant-Administrator arbeitet im Browser; der Host-Operator über einen Socket im Zustandsverzeichnis (`operator create-tenant`, `set-password`, `backup`, …).

### Betrieb und Wiederherstellung {#operations}

Der Dienst und sein Space-Prozess sind getrennte Prozesse; den Space-Prozess gibt es in TypeScript und in Rust (`files-space`). Sicherungen sind verschlüsselte Archive, je eines für die Daten und für den Bereitstellungs-Zustand (Sitzungen, Schlüssel, Passwörter). Eine Wiederherstellung schaltet die Sitzungs-Epoche weiter, sodass keine alte Sitzung überlebt. Für einen zweiten Standort gibt es einen Standby mit Fencing und Promotion; er ist getestet, aber auf big nicht eingeschaltet.

## Wo es läuft {#where}

- **big:** ein Container (Dienst und Rust-Space-Prozess) hinter nginx unter https://spaces-files.eibrain.org. Täglich gehen die verschlüsselten Sicherungen nach nano, in ein Konto, das nur hinzufügen, nicht löschen darf.
- **Lokal:** `npm run spaces-files` (`FILES_MEM=1` hält alles im Speicher), Tests mit `npm run test:spaces-files`.

## Grenzen {#limits}

- Ein Tenant hat genau eine Instanz, die ihn verwaltet; das ist die Grundlage der Reihenfolge-Garantie. Mehrere Hosts für viele Tenants sind als mögliche Erweiterung notiert.
- Die Space-Statistik zeigt die App bewusst nicht, weil sie die Tenant-Spaces offenlegen würde.
- Auf big gibt es derzeit Passwort-Anmeldung und keine Agenten-Hosts auf anderen Rechnern; beides ist gebaut und lässt sich einschalten.

## Weiterlesen {#further}

- Im Repository: `spaces-files/README.md` (Stand und Nachweise), `docs/zanzibar-agent-filesystem-plan.en.md` (Plan und Entscheidungen), `spaces-files/docs/operator-guide.en.md` (Betrieb).
- [Apps auf phi-spaces](help.topic.apps#files) stellt die App neben die anderen.
- [Leases und Transaktionen](help.topic.leases_and_transactions#overview) erklärt die Transaktionen, auf denen jede Operation beruht.
