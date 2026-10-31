# Messung 2026-10-29: vpsc als Rechner für Regionen

Frage: Lohnt es sich, einen Teil der Regionen auf den Server vpsc auszulagern? Gemessen wurde dasselbe Test-Image
(`dev-test`, Stand 12db21e plus der `offer`-Fix) auf big und auf vpsc, zur selben Zeit, jeweils in einem Wegwerf-Container
ohne Netz.

## Rechner

| | big | vpsc |
| --- | --- | --- |
| CPU | AMD EPYC, 8 vCPU | AMD EPYC (KVM, „with IBPB“), 8 vCPU |
| RAM | 15,6 GiB | 23 GiB (15 GiB frei) |
| Platte | – | 823 GB, 85 % belegt |
| Last vor der Messung | Produktion der vier Regionen | 7 Container (asciisky), im Leerlauf, Steal 0 % |
| Ping zu big | – | ≈ 10 ms (big ↔ nano: 0,9 ms) |
| Ping von nano | 0,9 ms | nicht erreichbar („Network is unreachable“) |

## Ergebnisse

`tests/perf/space-cost.ts` (50 Figuren, 60 s, ein Welt-Space): CPU-Zeit des Space-Prozesses je Spielerbefehl.

| | big | vpsc |
| --- | --- | --- |
| Befehle | 1.412 (19/s) | 1.388 (18,2/s) |
| Space-CPU je Befehl | 12,0 ms | 40,1 ms |
| Anteil eines Kerns (Space) | 23 % | 73 % |
| Median / p95 | 20 / 40 ms | 76 / 366 ms |

`tests/perf/region-cost.ts` (200 Figuren, 60 s, vier Regionen mit Space, Welt-Worker und NPC-Prozess je Region):

| | big | vpsc |
| --- | --- | --- |
| Befehle | 5.632 (74,7/s) | 5.480 (72,8/s) |
| Median / p95 | 21 / 60 ms | 100 / 418 ms |
| Space West / Nord / Ost / Süd (% eines Kerns) | 27 / 27 / 36 / 19 | 69 / 72 / 83 / 55 |
| Welt-Worker (% eines Kerns) | 4–7 | 13–17 |
| Web-Teil (% eines Kerns) | 14 | 37 |

## Bewertung

- **Ein Kern auf vpsc rechnet etwa 3,3-mal so lange wie auf big**, ungefähr wie nano
  ([lasttest-2026-10-28.md](../lasttest-2026-10-28.en.md)). Die 8 Kerne helfen wenig: jeder Region-Space ist ein Thread.
- **Netz:** Eine Region auf vpsc bringt jedem ihrer Befehle zwei Wege über rund 10 ms (Web auf big → Space, Änderungsstrom
  zurück), dazu die Übergaben zwischen Regionen auf verschiedenen Rechnern. Die Space-Sockets haben kein TLS: nötig wäre
  ein SSH-Tunnel von big nach vpsc (wie `mmo-accounts-tunnel` nach nano). Der Welt-Worker, die NPCs und das Modell einer
  Region liefen mit ihrem Space auf vpsc (ein Befehl macht viele Aufrufe an den Space).
- **Bedarf:** Bei 200 Figuren braucht die Region mit der höchsten Last auf big gut ein Drittel eines Kerns. big hat Luft.

**Ergebnis:** Derzeit nicht auslagern. vpsc kommt in Frage, wenn big voll ist; dann zuerst eine schwach besuchte Region
(Süd, Krabbensand), bei der ein langsamerer Kern und 10 ms mehr nicht auffallen.

## Nachmessen

```sh
# auf dem Rechner, im Checkout (das Image wie in docs/betrieb.en.md):
docker build --network host --target dev-test -t phi-spaces-mmo:perf -f spaces-mmo/docker/Dockerfile .
docker run --rm --init --network none --tmpfs /tmp:exec phi-spaces-mmo:perf sh -c "cd spaces-mmo && \
  LOAD_BOTS=50 LOAD_SECONDS=60 node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/space-cost.ts && \
  LOAD_BOTS=200 LOAD_SECONDS=60 node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/region-cost.ts"
```
