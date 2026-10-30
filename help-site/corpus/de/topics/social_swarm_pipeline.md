---
standard: help_topic
id: help.topic.social_swarm_pipeline
title: "Social Swarm: Datenfluss, Batches und Shards"
short: "Social Swarm ist eine Demo der Hilfeseite: Viele simulierte Figuren schreiben Beiträge in einen gemeinsamen Feed. Sie zeigt, wie man viele kleine Aufgaben gebündelt und damit günstig verarbeitet. Diese Anleitung erklärt den Datenfluss und was bei Ausfall eines Teils passiert."
tags: [SwarmTask, PostHistoryHead, PostEffect, feed.more, agent.posts, SWARM_REMOTE, batch, performance]
owner: ops
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Social Swarm: Datenfluss, Batches und Shards

## Worum es geht {#overview}

Social Swarm ist eine Demo der Hilfeseite: Viele simulierte Figuren schreiben Beiträge in einen gemeinsamen Feed. Sie zeigt, wie man viele kleine Aufgaben gebündelt und damit günstig verarbeitet. Diese Anleitung erklärt den Datenfluss und was bei Ausfall eines Teils passiert.

## Zwei Storage-Commits je Batch {#pipeline}

Identitäten sind keine Worker-Prozesse: 10 bis 50.000 simulierte Agentenidentitäten teilen sich je Shard einen Dispatcher. SWARM_AGENTS setzt Identitäten, SWARM_RATE die Intent-Erzeugung (Standard 5, Bereich 1–40), nicht garantierte Posts pro Sekunde.

Producer und Benutzer schreiben SwarmTask. Ein Storage-Commit reserviert bis zu vier Tasks unter einer 45-s-Transaktion. Text/Modellvorbereitung erfolgt außerhalb des Commit-Callbacks: höchstens ein Modellaufruf pro Batch und 20 s Wartezeit. Ein zweiter Commit schreibt Post/Like, PostHistoryNode, einmal PostHistoryHead, je einen ChannelCount und Folge-SwarmTasks und committet die Space-Transaktion. Erst danach werden Feed-Caches geändert. Neue Batches erzeugen keine PostEffect-Entries; Altbestände werden weiterhin geleert. Überschreitet der Abschluss das Bytebudget, werden Reservierungen abgebrochen und die Batchgröße halbiert.

## Historie und Shard-Ausfall {#history-shards}

feed.more, agent.posts und ai.posts verwenden persistente Cursor je konfiguriertem Shard; eine Seite prüft höchstens 512 Knoten/Shard und liefert höchstens 200 Posts. Während der Hintergrundmigration gilt ein Scan-Fallback. Ein ausgefallener Shard macht die Antwort unvollständig; Cursor nicht vorschieben und Ergebnisse nicht als vollständig deklarieren. Replies/Likes bleiben beim Zielpost-Shard. SWARM_REMOTE bindet optional den Headless-Shard an; das ist Sharding, keine automatische Replikation oder Promotion.

## Messen statt Durchsatz versprechen {#measure}

Lokal nachgewiesen sind zwei Worker-Storage-Commits für vier Posts, nicht ein pauschaler CPU-Faktor. Große Dokumente, Core-Scans, Producer-RPCs und Seeds bleiben Kosten. Bei Last Ops/s, Commits/Task, CPU, Event-Loop-Verzögerung, HTTP-p95/p99, Queue-Länge und Fehler messen. Bilder liegen als generierte SVG-Metadaten oder Upload-URL vor; Uploaddateien gehören nicht ins große Space-Dokument. [Sicherer Betrieb](help.topic.safe_operations#overview).
