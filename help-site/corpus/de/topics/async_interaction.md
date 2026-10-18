---
standard: help_topic
id: help.topic.async_interaction
title: "Asynchronität, Waiter und Agent-Turns"
short: "PiSpaces und RemoteSpace liefern Promises; zusätzlich gibt es persistente Waiter und Notify-Registrierungen. JavaSpaces ist die semantische Grundlage, nicht die Laufzeit- oder Transportimplementierung."
tags: [async, promise, await, wait, notify, event-loop, turn]
owner: client
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Asynchronität, Waiter und Agent-Turns

## Was konkret implementiert ist {#overview}

PiSpaces und RemoteSpace liefern Promises; zusätzlich gibt es persistente Waiter und Notify-Registrierungen. JavaSpaces ist die semantische Grundlage, nicht die Laufzeit- oder Transportimplementierung.

## Worauf ein Aufruf wartet {#completion}

write bestätigt seinen Storage-Schritt, nicht die Verarbeitung durch einen Worker. await read/take wartet auf Treffer oder Timeout und hält den aufrufenden Ablauf an, nicht während des reinen Wartens den ganzen Event-Loop. NO_WAIT verhindert nur das Warten auf zukünftige Treffer; Storage-/Scan-Latenz bleibt. CPU-Arbeit und Serialisierung können den Event-Loop trotzdem belegen.

## Welcher Mechanismus wann? {#turns}

Für einen einmaligen unmittelbaren Versuch read/take mit NO_WAIT nutzen. Für ein kurzes Ergebnisfenster einen begrenzten Timeout verwenden. Für einen späteren Agent-Turn space_wait registrieren: der Aufruf liefert die Wait-ID, das Ereignis kommt später. Die Tools space_read/space_take halten den Turn bis zu 60 Sekunden; space_wait erlaubt lange Wartezeiten. notify abonniert passende Writes, reserviert aber keine Arbeit und ist kein lückenloses Auditlog.

## Identität und Zustellung {#delivery}

Lokal ist target eine Conversation-ID (string/number), kein Principal-Objekt. Für eine Consumer-Mailbox muss PiSpaces mit options.consumer konfiguriert sein. Remote wird der Consumer aus der authentifizierten Verbindung abgeleitet: remote.events(options), remote.ack(epoch, sequence). Lokal dagegen space.events(principal, options), space.ack(principal, epoch, sequence). startService betreibt lokale Wartung/Zustellung; ohne Hintergrunddienst wird Ablauf bei Operationen abgeglichen, nicht aber automatisch jede Conversation benachrichtigt. [Mailbox-Vertrag](help.topic.durable_mailboxes_and_ack#overview).
