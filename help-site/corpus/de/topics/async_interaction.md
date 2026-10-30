---
standard: help_topic
id: help.topic.async_interaction
title: "Asynchronität, Waiter und Agent-Turns"
short: "Aufrufe an einen Space liefern ein Promise, dein Programm kann also währenddessen anderes tun. Manche Aufrufe warten auf einen Eintrag, andere melden sich später von selbst. Diese Anleitung erklärt, worauf ein Aufruf wartet und welchen Weg du wann nimmst."
tags: [async, promise, await, wait, notify, event-loop, turn]
owner: client
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Asynchronität, Waiter und Agent-Turns

## Worum es geht {#overview}

Aufrufe an einen Space liefern ein Promise, dein Programm kann also währenddessen anderes tun. Manche Aufrufe warten auf einen Eintrag, andere melden sich später von selbst. Diese Anleitung erklärt, worauf ein Aufruf wartet und welchen Weg du wann nimmst.

## Worauf ein Aufruf wartet {#completion}

PhiSpaces und RemoteSpace liefern Promises; zusätzlich gibt es persistente Waiter und Notify-Registrierungen. JavaSpaces ist die semantische Grundlage, nicht die Laufzeit- oder Transportimplementierung.

write bestätigt seinen Storage-Schritt, nicht die Verarbeitung durch einen Worker. await read/take wartet auf Treffer oder Timeout und hält den aufrufenden Ablauf an, nicht während des reinen Wartens den ganzen Event-Loop. NO_WAIT verhindert nur das Warten auf zukünftige Treffer; Storage-/Scan-Latenz bleibt. CPU-Arbeit und Serialisierung können den Event-Loop trotzdem belegen.

Wie oft ein wartender Aufruf nachschaut: Lokal weckt ihn eine Änderung, er schaut nach 20 bis 40 ms erneut. Über den Dienst wiederholt der Client ein `read`/`take` per Long Poll; der Dienst schaut alle 50 ms nach. Mit der Option `wakeOnCommit` schaut er beim ersten Commit und dann höchstens alle 25 ms. Die Option ist standardmäßig aus.

## Welcher Mechanismus wann? {#turns}

Für einen einmaligen unmittelbaren Versuch read/take mit NO_WAIT nutzen. Für ein kurzes Ergebnisfenster einen begrenzten Timeout verwenden. Für einen späteren Agent-Turn space_wait registrieren: der Aufruf liefert die Wait-ID, das Ereignis kommt später. Die Tools space_read/space_take halten den Turn bis zu 60 Sekunden; space_wait erlaubt lange Wartezeiten. notify abonniert passende Writes, reserviert aber keine Arbeit und ist kein lückenloses Auditlog. Das Tool space_notify meldet höchstens einmal pro Sekunde und bündelt Writes dazwischen.

## Identität und Zustellung {#delivery}

Lokal ist target eine Conversation-ID (string/number), kein Principal-Objekt. Für eine Consumer-Mailbox muss PhiSpaces mit options.consumer konfiguriert sein. Remote wird der Consumer aus der authentifizierten Verbindung abgeleitet, Ziel ist target: "self": remote.events(options), remote.ack(epoch, sequence). Lokal dagegen space.events(principal, options), space.ack(principal, epoch, sequence). startService betreibt lokale Wartung/Zustellung; ohne Hintergrunddienst wird Ablauf bei Operationen abgeglichen, nicht aber automatisch jede Conversation benachrichtigt. [Mailbox-Vertrag](help.topic.durable_mailboxes_and_ack#overview).
