# Measurement 2026-10-29: vpsc as a machine for regions

Question: is it worth moving some of the regions to the server vpsc? The same test image (`dev-test`, state 12db21e plus
the `offer` fix) was measured on big and on vpsc at the same time, each in a disposable container without a network.

## Machines

| | big | vpsc |
| --- | --- | --- |
| CPU | AMD EPYC, 8 vCPU | AMD EPYC (KVM, "with IBPB"), 8 vCPU |
| RAM | 15.6 GiB | 23 GiB (15 GiB free) |
| Disk | – | 823 GB, 85 % used |
| Load before the measurement | Production of the four regions | 7 containers (asciisky), idle, steal 0 % |
| Ping to big | – | ≈ 10 ms (big ↔ nano: 0.9 ms) |
| Ping from nano | 0.9 ms | not reachable ("Network is unreachable") |

## Results

`tests/perf/space-cost.ts` (50 figures, 60 s, one world Space): CPU time of the Space process per player command.

| | big | vpsc |
| --- | --- | --- |
| Commands | 1,412 (19/s) | 1,388 (18.2/s) |
| Space CPU per command | 12.0 ms | 40.1 ms |
| Share of one core (Space) | 23 % | 73 % |
| Median / p95 | 20 / 40 ms | 76 / 366 ms |

`tests/perf/region-cost.ts` (200 figures, 60 s, four regions with a Space, world worker and NPC process per region):

| | big | vpsc |
| --- | --- | --- |
| Commands | 5,632 (74.7/s) | 5,480 (72.8/s) |
| Median / p95 | 21 / 60 ms | 100 / 418 ms |
| Space West / North / East / South (% of one core) | 27 / 27 / 36 / 19 | 69 / 72 / 83 / 55 |
| World worker (% of one core) | 4–7 | 13–17 |
| Web part (% of one core) | 14 | 37 |

## Assessment

- **A core on vpsc takes about 3.3 times as long as on big**, roughly like nano
  ([lasttest-2026-10-28.en.md](lasttest-2026-10-28.en.md)). The 8 cores help little: every region Space is one thread.
- **Network:** A region on vpsc adds two trips of about 10 ms to each of its commands (web on big → Space, change stream
  back), plus the handovers between regions on different machines. The Space sockets have no TLS: an SSH tunnel from big to
  vpsc would be needed (like `mmo-accounts-tunnel` to nano). A region's world worker, NPCs and model would run with its Space
  on vpsc (one command makes many calls to the Space).
- **Demand:** At 200 figures the region with the highest load needs a good third of a core on big. big has room.

**Result:** Do not move regions for now. vpsc becomes an option when big is full; then first a lightly visited region
(South, Krabbensand), where a slower core and 10 ms more go unnoticed.

## Measuring again

```sh
# on the machine, in the checkout (the image as in docs/betrieb.en.md):
docker build --network host --target dev-test -t phi-spaces-mmo:perf -f spaces-mmo/docker/Dockerfile .
docker run --rm --init --network none --tmpfs /tmp:exec phi-spaces-mmo:perf sh -c "cd spaces-mmo && \
  LOAD_BOTS=50 LOAD_SECONDS=60 node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/space-cost.ts && \
  LOAD_BOTS=200 LOAD_SECONDS=60 node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/region-cost.ts"
```
