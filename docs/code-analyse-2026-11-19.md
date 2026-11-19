# Code-Analyse: Logikfehler, Duplikate, Toter Code & Optimierungsmöglichkeiten

**Datum:** 2026-11-19  
**Umfang:** `spaces-mmo/client/` (3D-Rendering), `spaces/rust/` (Rust-Core), `spaces-mmo/rust/` (`mmo-engine`, `mmo-web`, `mmo-space`), `codemode-chat/rust/` (`codemode-space`), `help-site/rust/` (`help-space`).  
**Schwerpunkt:** `spaces-mmo` 3D-Rendering sowie Rust-Implementierungen (bevorzugt gegenüber TypeScript-Äquivalenten).

---

## Inhaltsverzeichnis

1. [Priorisierte Übersicht (Top-Hebel)](#1-priorisierte-übersicht-top-hebel)
2. [`spaces-mmo` 3D-Rendering (`spaces-mmo/client/`)](#2-spaces-mmo-3d-rendering-spaces-mmoclient)
   - [2.1 Optimierungsmöglichkeiten (GPU, Draw-Calls, Shader, CPU)](#21-optimierungsmöglichkeiten-gpu-draw-calls-shader-cpu)
   - [2.2 Logikfehler & visuelle Bugs](#22-logikfehler--visuelle-bugs)
   - [2.3 WebGL-Ressourcenlecks](#23-webgl-ressourcenlecks)
   - [2.4 Doppelter Code](#24-doppelter-code)
   - [2.5 Toter Code](#25-toter-code)
3. [Rust-Core (`spaces/rust/`)](#3-rust-core-spacesrust)
   - [3.1 Logikfehler](#31-logikfehler)
   - [3.2 Optimierungsmöglichkeiten](#32-optimierungsmöglichkeiten)
   - [3.3 Doppelter Code](#33-doppelter-code)
   - [3.4 Toter Code](#34-toter-code)
4. [`spaces-mmo` Rust-Backend (`spaces-mmo/rust/`)](#4-spaces-mmo-rust-backend-spaces-mmorust)
   - [4.1 Logikfehler](#41-logikfehler)
   - [4.2 Optimierungsmöglichkeiten](#42-optimierungsmöglichkeiten)
   - [4.3 Doppelter Code](#43-doppelter-code)
   - [4.4 Toter Code](#44-toter-code)
5. [Anwendungs-Space-Server (`mmo-space`, `codemode-space`, `help-space`, `phi-space-server`)](#5-anwendungs-space-server-mmo-space-codemode-space-help-space-phi-space-server)
   - [5.1 Logikfehler](#51-logikfehler)
   - [5.2 Optimierungsmöglichkeiten](#52-optimierungsmöglichkeiten)
   - [5.3 Doppelter Code](#53-doppelter-code)
   - [5.4 Toter Code](#54-toter-code)
6. [Empfohlener Umsetzungsplan](#6-empfohlener-umsetzungsplan)

---

## 1. Priorisierte Übersicht (Top-Hebel)

| Priorität | Bereich | Fund | Impact | Aufwand |
| :--- | :--- | :--- | :--- | :--- |
| **P0** | 3D-Rendering | `animateFigure` überschreibt `body.scale.y` (`FIGURE_SCALE * build.tall`) auf `~1.0` & `f.phase * 0` | Hoch (visueller Bug) | Sehr gering |
| **P0** | Rust-Core | `O_NOFOLLOW` auf Linux `aarch64` falsch (`0o400_000` = `O_DIRECT`) | Hoch (Sicherheit/Crash) | Sehr gering |
| **P0** | 3D-Rendering | WebGL-Leaks pro Raumwechsel (`waterMaterial` + `DataTexture`, `earth`, `BoxGeometry`) | Hoch (VRAM-Leak) | Gering |
| **P0** | Rust-Core | Unbegrenzte Reply-Queue in `phi-wire/src/texts.rs` & fehlende Read/Write-Timeouts in `replica_transport.rs` | Hoch (DoS/OOM) | Gering |
| **P0** | `phi-space-server` | Veraltete `authorityId` nach Control-Restore in `root_of` & `sync_context` | Hoch (Protokollbug) | Gering |
| **P0** | `mmo-web` | Unvollständiger Single-Region-Reset (`site_orders`, `winds`, `char_region`) & verwaiste `herds` | Hoch (State-Drift) | Gering |
| **P1** | 3D-Rendering | Draw-Call-Reduktion: Pflanzenschatten instanziieren, Wildblumen via `setColorAt`, `track()` mergen, Fische instanziieren | Sehr hoch (FPS) | Mittel |
| **P1** | 3D-Rendering | Shadow-Map `4096→2048`, Post-Processing-Passes & `surfaces3d.ts` Triplanar-Fetches reduzieren | Sehr hoch (GPU) | Mittel |
| **P1** | `mmo-engine` | `spatial_world` mit `Rc<Json>` statt Deep-Clone pro Command; `Mirror::count` ohne Clone; statische Command-Tables | Hoch (CPU/Latenz) | Mittel |
| **P1** | `help-space` | `help::purge` blockiert Single-Threaded-Event-Loop + `NaN`-Sort-Panic | Hoch (Stabilität/Latenz) | Gering |

---

## 2. `spaces-mmo` 3D-Rendering (`spaces-mmo/client/`)

### 2.1 Optimierungsmöglichkeiten (GPU, Draw-Calls, Shader, CPU)

#### A. Draw-Call-Reduktion, Instancing & Geometry-Merging

1. **Uninstanziierte Pflanzenschatten (`buildPlants`) — Impact: Hoch**
   - **Ort:** [`MapView3D.tsx:390`](../spaces-mmo/client/MapView3D.tsx#L390), [`MapView3D.tsx:399`](../spaces-mmo/client/MapView3D.tsx#L399)
   - **Problem:** Bäume, Nadelbäume, Büsche und Palmen sind bereits instanziiert, aber für jede einzelne Pflanze wird ein eigenes `propShadow(t, ...)`-`THREE.Mesh` zur Szene hinzugefügt. In einem bewaldeten Raum (50–150+ Pflanzen) entstehen dadurch 50–150 unnötige Draw-Calls nur für runde Schatten-Quads.
   - **Lösung:** Alle Pflanzenschatten eines Raums in ein einziges `THREE.InstancedMesh` mit skalierter Einheits-Schattengeometrie zusammenfassen → **1 Draw-Call**.

2. **Überfragmentiertes `InstancedMesh`-Bucketing für Pflanzen & Wildblumen (`buildPlants`) — Impact: Hoch**
   - **Ort:** [`MapView3D.tsx:363`](../spaces-mmo/client/MapView3D.tsx#L363), [`MapView3D.tsx:376-391`](../spaces-mmo/client/MapView3D.tsx#L376-L391)
   - **Problem:**
     - Dekor-Modelle (Z. 363) bucketen nach 4×4-Zellen-Chunks (`${d.model}:${look.variant}:${d.tint ?? ""}:${Math.floor(x / 4)},${Math.floor(y / 4)}`). Ein 24×24-Raum zerfällt so in bis zu 36 Chunks × 3 Varianten = 108 `InstancedMesh`es pro Modelltyp.
     - Wildblumen (Z. 376–391) bucketen nach `${sort}:${colour}:${variant}` (3 Sorten × 12 `BLOOM`-Farben × 3 Varianten = bis zu 108 separate `InstancedMesh`es).
   - **Lösung:** Chunking für Dekor vergrößern oder pro Raum zusammenfassen (Frustum-Culling lohnt sich bei 4×4-Chunks nicht gegenüber dem Draw-Call-Overhead); bei Wildblumen neutrale weiße Blüten-Vertex-Farben verwenden und die Farbe über `InstancedMesh.setColorAt()` setzen (reduziert Blumen-Draw-Calls um bis zu **12×**).

3. **Unmerged Gleise & Planungsmarkierungen (`track`, `road`) — Impact: Hoch**
   - **Ort:** [`MapView3D.tsx:572-593`](../spaces-mmo/client/MapView3D.tsx#L572-L593), [`MapView3D.tsx:609`](../spaces-mmo/client/MapView3D.tsx#L609)
   - **Problem:** `track()` erzeugt für jede Schwelle und jedes Schienensegment ein eigenes `THREE.Mesh` (~80–160 Draw-Calls für eine 20-Zellen-Strecke). `road()` nutzt zwar `merge()`, aber geplante Straßenmarkierungen in Z. 609 fügen weiterhin 1 `Mesh` pro Zelle hinzu.
   - **Lösung:** Schwellen und Schienen in `track()` über `merge()` (analog zu `road()`) in 1 Mesh zusammenführen; Planungsmarkierungen in `road()` ebenfalls mergen oder instanziieren.

4. **Unmerged Multi-Mesh-Weltobjekte (`object`) — Impact: Mittel–Hoch**
   - **Ort:** [`MapView3D.tsx:618-717`](../spaces-mmo/client/MapView3D.tsx#L618-L717)
   - **Problem:**
     - `train` (Z. 629–650): 19 separate Meshes + 4 ungeteilte Materialien.
     - `cart` (Z. 618–628): 5 separate Meshes + 2 ungeteilte Materialien.
     - `bed` (Z. 664–680): Boden + 1–2 Meshes pro Nicht-Modell-Pflanze + 3 Unkrautkegel + `new MeshStandardMaterial` pro Pflanze innerhalb der Schleife (Z. 673, 675, 676).
     - `tree` (Z. 688–691): 7 separate Frucht-Meshes bei reifem Baum.
     - `field` (Z. 709–715): `2 * rows` separate Meshes, allokiert `new t.BoxGeometry(...)` in jeder Schleifeniteration.
     - Alle durchlaufen danach `prepareModelDetails()` ([`MapView3D.tsx:529`](../spaces-mmo/client/MapView3D.tsx#L529)), das jedes Kind-Mesh einzeln konvertiert.
   - **Lösung:** Statische Teilgeometrien per `merge()` in jeweils ein Mesh mit `propMaterial(t)` überführen und Materialien cachen.

5. **Uninstanziierte schwimmende Fische (2 Meshes pro Fisch) — Impact: Mittel–Hoch**
   - **Ort:** [`block3d.ts:177-198`](../spaces-mmo/client/block3d.ts#L177-L198), [`fish3d.ts:76-81`](../spaces-mmo/client/fish3d.ts#L76-L81), [`MapView3D.tsx:186`](../spaces-mmo/client/MapView3D.tsx#L186)
   - **Problem:** Jeder Fisch besteht aus 2 separaten `THREE.Mesh`es (`body` + `tail`). Bei bis zu 8 Schwärmen à bis zu 7 Heringen entstehen ~100 Draw-Calls für Unterwasserfische. Bei Insel-Zoom (`s.zoom <= 0.3`) wird zwar `swimFish()` übersprungen, aber die Meshes werden nicht ausgeblendet (`visible = false`).
   - **Lösung:** Fische nach Art instanziieren (Schwanz-Wackeln im Vertex-Shader über `uWaterTime` + Instanz-Phase oder per Instanz-Matrix) und bei `s.zoom <= 0.3` ausblenden.

6. **Multi-Group-Terrassen-Meshes — Impact: Niedrig–Mittel**
   - **Ort:** [`terraces3d.ts:30`](../spaces-mmo/client/terraces3d.ts#L30), [`ground3d.ts:93`](../spaces-mmo/client/ground3d.ts#L93)
   - **Problem:** Jede Bodenart nutzt 3 Material-Gruppen `[top, flank, wall]` (3 Draw-Calls pro Art), obwohl sich `top` und `flank` in `ground3d.ts:93` nur durch den Helligkeitsfaktor `0.88` unterscheiden.
   - **Lösung:** Den `0.88`-Faktor über Vertex-Farben oder ein Attribut abbilden und `top` + `flank` zu einem Draw-Call vereinen.

#### B. Post-Processing, Schatten & Shader-Komplexität

7. **4096×4096 Shadow-Map bei jedem Bewegungs-Frame — Impact: Hoch**
   - **Ort:** [`MapView3D.tsx:165`](../spaces-mmo/client/MapView3D.tsx#L165), [`MapView3D.tsx:191`](../spaces-mmo/client/MapView3D.tsx#L191)
   - **Problem:** `sun.shadow.mapSize.set(4096, 4096)` mit `PCFShadowMap` (`radius = 2.5`) rendert 16,7 Mio. Texel neu, sobald sich irgendeine Figur oder ein Tier bewegt (`moved || now - s.shadowAt >= SHADOW_EVERY_MS`).
   - **Lösung:** Auf `2048×2048` reduzieren (4× weniger Fillrate & VRAM bei raumgroßem orthografischem Frustum) und optional die Shadow-Update-Rate auf z. B. 30 Hz drosseln oder dynamisch an `sharp` (FPS-Adaption) koppeln.

8. **Bis zu 4× vollständiges Szenen-Rendering pro Frame im Post-Processing — Impact: Hoch**
   - **Ort:** [`post3d.ts:17-75`](../spaces-mmo/client/post3d.ts#L17-L75)
   - **Problem:**
     - Rendert in `HalfFloatType` mit 4× MSAA (`samples: 4`), gefolgt von `GTAOPass` (16 Samples + eigener Szenen-Depth/Normal-Pass), `UnrealBloomPass` (5 Mip-Passes), `BokehPass` (ab `zoom > 2` weiterer Szenen-Depth-Pass), `OutputPass` und Layer-1-Pass.
     - Bei `zoom > 2` wird die Szenengeometrie **4× pro Frame** gerendert (Shadow + Main + GTAO-Depth/Normal + Bokeh-Depth).
     - `hide()` (Z. 37–42) traversiert bei jedem Frame für GTAO und erneut für Bokeh den gesamten Szenengraphen inkl. unsichtbarer Gruppen (`island`, `cards`).
   - **Lösung:**
     - Depth-Buffer aus dem Main-Pass (DepthTexture) oder GTAO-Pass für Bokeh wiederverwenden statt eines zusätzlichen Szenen-Passes.
     - In `hide()` eine rekursive Traversal nutzen, die bei `!o.visible` sofort abbricht (statt `scene.traverse`, das trotzdem alle Kinder besucht), oder die zu versteckenden Objekte beim Hinzufügen zur Szene in einer Liste pflegen.
     - `GTAOPass`-Samples von 16 auf 8–12 reduzieren oder an die adaptive Qualitätsstufe (`sharp`) koppeln.

9. **Schwerer Modell-Fragment-Shader (unbedingte 6× `sampler2DArray` + 32× 3D-Noise-Hashes) — Impact: Hoch**
   - **Ort:** [`surfaces3d.ts:95-112`](../spaces-mmo/client/surfaces3d.ts#L95-L112), [`props3d.ts:116-129`](../spaces-mmo/client/props3d.ts#L116-L129)
   - **Problem:** Jedes Fragment jedes Modells, Baums und Blatts führt **6 Triplanar-`sampler2DArray`-Fetches** aus, auch wenn `vSurface == 0`, `vSurface == LEAF_LAYER` oder `uSurfaceOn == 0`. Zusätzlich laufen 2× `modelGrain()` (4 Oktaven 3D-Value-Noise = 32 Hash-Berechnungen) sowie `dFdx`/`dFdy`-Bump-Mapping auf jedem Pixel (inkl. weit entfernter Modelle, bei denen der Bump-Faktor `smoothstep(34.0, 5.0, length(vViewPosition))` bereits `0` ist).
   - **Lösung:**
     - Laub/untexturierte Geometrien (`vSurface == 0` / `LEAF_LAYER`) auf eine leichtgewichtige Material-Variante ohne `sampler2DArray`-Fetches legen oder bei `uSurfaceOn < 0.5` Uniform-Branching nutzen (uniformer Branch ist auf GPUs kohärent und beeinträchtigt Mipmap-Derivate nicht).
     - Den zweiten `modelGrain()`-Aufruf (`fine` in Z. 123) nur berechnen, wenn `dist < 34.0` (oder auf 1 Oktave reduzieren).

10. **Wasser-Fragment-Shader: 28 Noise-Hashes + 9 `sin` pro Pixel — Impact: Mittel**
    - **Ort:** [`water3d.ts:44-67`](../spaces-mmo/client/water3d.ts#L44-L67)
    - **Problem:** `waterHeight()` (3× `sin` + 2 Oktaven 2D-Noise = 8 Hashes) wird 3× pro Wasserpixel für Finite-Differenzen-Normalen ausgewertet, plus ein weiteres `waterNoise()` in `COLOUR`.
    - **Lösung:** Analytische Ableitungen für die 3 Sinuswellen nutzen oder eine kleine vorab generierte kachelbare Normal-Map (`DataTexture`) 2× mit unterschiedlichem UV-Scroll samplen (2 Textur-Lookups statt 28 prozeduraler Hashes).

#### C. CPU-Hitches, Per-Frame-Allokationen & React-Overhead

11. **Geometrie-Allokation + `dispose()` bei jedem Cache-Hit in `figure3d.ts` — Impact: Mittel**
    - **Ort:** [`figure3d.ts:63-69`](../spaces-mmo/client/figure3d.ts#L63-L69), [`figure3d.ts:81-87`](../spaces-mmo/client/figure3d.ts#L81-L87)
    - **Problem:** Z. 65 ruft `s.g()` auf (erzeugt eine komplette `BufferGeometry`), serialisiert `g.parameters` per `JSON.stringify` und verwirft sie sofort per `g.dispose()`, nur um den Cache-Key zu ermitteln — selbst bei Cache-Hits. Bei Cache-Miss wird `s.g()` ein zweites Mal aufgerufen. Außerdem erzeugen Z. 81–87 pro Figur neue `CircleGeometry`/`RingGeometry` + `MeshBasicMaterial`.
    - **Lösung:** Geometrie-Typ und Parameter direkt als Datenstruktur beschreiben (z. B. `["capsule", 0.052, 0.27, 4, 8]`) und `BufferGeometry` erst bei Cache-Miss erzeugen; Schatten- und Ring-Geometrie/-Material einmalig teilen.

12. **`creaseNormals` blockiert Main-Thread mit String-Keys — Impact: Mittel–Hoch**
    - **Ort:** [`props3d.ts:74-89`](../spaces-mmo/client/props3d.ts#L74-L89)
    - **Problem:** Läuft synchron beim `merge()`, auch beim Lazy-Build von `"near"`-LODs für Bäume/Nadelbäume mit tausenden Blatt-Quads. Erzeugt pro Vertex einen String-Key `${Math.round(...)}` und prüft per `list.includes(f)`.
    - **Lösung:** Für flache/unverbundene Blatt-Quads (`m: "leaf"`) `creaseNormals` komplett überspringen (Flächennormale direkt nutzen); für verbundene Meshes numerische Hash-Keys statt Strings verwenden.

13. **`updateModelDetails` traversiert alle 150 ms die komplette Szene mit Allokationen — Impact: Mittel**
    - **Ort:** [`modelDetail3d.ts:53-85`](../spaces-mmo/client/modelDetail3d.ts#L53-L85), [`MapView3D.tsx:188`](../spaces-mmo/client/MapView3D.tsx#L188)
    - **Problem:** Allokiert `new t.Vector3()`, `candidates`-Array, ruft `root.updateMatrixWorld()` redundant auf, besucht versteckte Subtrees und allokiert pro `modelVariant`-Mesh einen neuen `Vector3`.
    - **Lösung:** Modul-weite Scratch-`Vector3` wiederverwenden und nur registrierte LOD-Objekte in einer flachen Liste statt voller Szenen-Traversierung prüfen.

14. **`sync()`-Overhead bei jedem einzelnen Schritt — Impact: Mittel**
    - **Ort:** [`MapView3D.tsx:496-547`](../spaces-mmo/client/MapView3D.tsx#L496-L547)
    - **Problem:** Bei jeder Änderung von `props.chars`/`props.objs` (auch einem einzelnen Bewegungsschritt) wird `s.raised = new Map()` neu aufgebaut, `objs` 3× iteriert, `covered`/`free` sortiert zu Strings gejoint, `JSON.stringify(c.look)` pro Charakter ausgeführt und `new Vector3` pro Charakter/Objekt allokiert.
    - **Lösung:** `covered`/`free`/`raised` nur neu berechnen, wenn sich `props.objs` tatsächlich geändert hat (nicht bei reinen `chars`-Updates); Look-Vergleich über Referenz oder flachen Feldvergleich statt `JSON.stringify`.

15. **Synchrone `localStorage.setItem` × 3 & `JSON.stringify` bei jedem Kamera-Zoom/Drag — Impact: Mittel**
    - **Ort:** [`MapView3D.tsx:252-253`](../spaces-mmo/client/MapView3D.tsx#L252-L253), [`MapView3D.tsx:267-270`](../spaces-mmo/client/MapView3D.tsx#L267-L270), [`MapView3D.tsx:1158`](../spaces-mmo/client/MapView3D.tsx#L1158)
    - **Problem:** Pinch/Wheel/Button-Zoom triggert React-State-Updates (`setAngle`/`setZoom`/`setTilt`) → Re-Render von `MapView3D` → `JSON.stringify(props.atlasState.fog/people)` + 3 synchrone `localStorage`-Writes.
    - **Lösung:** `localStorage`-Persistenz debouncen (z. B. 300 ms) und Kamera-State während aktivem Drag/Zoom im Mutable-Ref belassen.

16. **14 sequenzielle `<canvas>`-Allokationen beim Textur-Laden — Impact: Mittel**
    - **Ort:** [`surfaces3d.ts:54-71`](../spaces-mmo/client/surfaces3d.ts#L54-L71)
    - **Problem:** Erzeugt 14 separate 512×512-Canvases und liest 14 MB synchron über `getImageData`.
    - **Lösung:** Ein einzelnes 512×512-Canvas wiederverwenden.

17. **Blockierendes `await loadTileLooks()` bei jedem Raumwechsel — Impact: Mittel**
    - **Ort:** [`MapView3D.tsx:230`](../spaces-mmo/client/MapView3D.tsx#L230), [`tiles3d.ts:27-64`](../spaces-mmo/client/tiles3d.ts#L27-L64)
    - **Problem:** Wartet vor dem Terrain-Aufbau auf das Laden/Slicen alter Tile-Sprites (inkl. Wasser-Frames), obwohl Wasser immer `water3d.ts` und alle 5 Standard-Böden (`.`, `,`, `:`, `_`, `#`) immer `ground3d.ts` nutzen.
    - **Lösung:** `loadTileLooks` nur laden, wenn im Raum tatsächlich nicht-`GROUND`/nicht-Wasser-Tiles vorkommen.

18. **Kleinere Per-Frame-/Event-Ineffizienzen — Impact: Niedrig**
    - [`MapView3D.tsx:433`](../spaces-mmo/client/MapView3D.tsx#L433): `e.obj.getObjectByName("body")` jeden Frame pro Tier statt einmalig auf `Entry` zu cachen.
    - [`MapView3D.tsx:957`](../spaces-mmo/client/MapView3D.tsx#L957), [`MapView3D.tsx:961`](../spaces-mmo/client/MapView3D.tsx#L961): Allokiert `new s.t.Color(...)` bei jedem `daylight`-Update.
    - [`MapView3D.tsx:1069`](../spaces-mmo/client/MapView3D.tsx#L1069): Volle `s.scene.traverse` bei jedem `pointerdown`/`contextmenu` für `userData.deck`.
    - [`MapView3D.tsx:221-244`](../spaces-mmo/client/MapView3D.tsx#L221-L244): Room-`useEffect` hängt an Objekt-Referenzen `[ready, props.room, props.world]` statt an `props.room.roomId` (unnötiger Full-Rebuild bei neuer Referenz für denselben Raum).

---

### 2.2 Logikfehler & visuelle Bugs

1. **`animateFigure` überschreibt Körpergröße (`FIGURE_SCALE * build.tall`) — Impact: Hoch**
   - **Ort:** [`figure3d.ts:89`](../spaces-mmo/client/figure3d.ts#L89), [`figure3d.ts:179`](../spaces-mmo/client/figure3d.ts#L179)
   - **Ursache:** `makeFigure` setzt `body.scale.set(FIGURE_SCALE * build.wide, FIGURE_SCALE * build.tall, FIGURE_SCALE * build.wide)` (`scale.y` = `1.235..1.43`). `animateFigure` überschreibt es im ersten Frame mit `f.body.scale.y = 1 + Math.sin(time * 1.8 + f.phase * 0) * 0.008 * idle`.
   - **Folge:** Alle Figuren werden vertikal um ~23 % gestaucht, verlieren ihre Statur-Höhenunterschiede, und `f.phase * 0` macht alle Figuren exakt synchron atmend.
   - **Fix:** `baseTall = FIGURE_SCALE * build.tall` auf `Figure` speichern und `f.body.scale.y = f.baseTall * (1 + Math.sin(time * 1.8 + f.phase) * 0.008 * idle)` setzen.

2. **Veraltete `s.bubbles`-Referenzen nach Raum- oder Look-Wechsel — Impact: Mittel**
   - **Ort:** [`MapView3D.tsx:227`](../spaces-mmo/client/MapView3D.tsx#L227), [`MapView3D.tsx:509`](../spaces-mmo/client/MapView3D.tsx#L509), [`MapView3D.tsx:869-870`](../spaces-mmo/client/MapView3D.tsx#L869-L870), [`MapView3D.tsx:1210`](../spaces-mmo/client/MapView3D.tsx#L1210)
   - **Ursache:** `remove(s, s.chars, id)` disposed `e.obj` (inkl. Sprechblase), löscht `id` aber nicht aus `s.bubbles`. `speak()` prüft `had.key === key` und überspringt das Neu-Anhängen.
   - **Fix:** In `remove()` (oder beim Raumwechsel) zugehörige Einträge aus `s.bubbles` entfernen.

3. **Async-Race beim Raumwechsel zwischen `s.room` und `s.ground` — Impact: Mittel**
   - **Ort:** [`MapView3D.tsx:226-246`](../spaces-mmo/client/MapView3D.tsx#L226-L246), [`MapView3D.tsx:497`](../spaces-mmo/client/MapView3D.tsx#L497)
   - **Ursache:** `s.room` wird synchron aktualisiert, `s.ground` aber erst nach `await`. Da `s.ground` während des `await` noch auf den alten Raum zeigt (`!== null`), spawnt `sync()` neue Figuren/Objekte auf dem alten Terrain.
   - **Fix:** `s.ground` vor dem `await` auf `null` setzen (nach Disposal) oder eine Generation-ID gegen veraltete `sync()`-Aufrufe prüfen.

4. **`detailGeometry` verwirft `source`, hält es aber in `modelVariant`-Closure — Impact: Mittel**
   - **Ort:** [`props3d.ts:146-151`](../spaces-mmo/client/props3d.ts#L146-L151), [`props3d.ts:153-158`](../spaces-mmo/client/props3d.ts#L153-L158)
   - **Ursache:** `cached(..., () => merge(t, [{ g: source.clone(), ... }]))` speichert `source` in der Closure für spätere LOD-Wechsel (`"near"`/`"far"`), ruft aber in Z. 150 sofort `source.dispose()` auf. Zudem wird bei geteilten Geometrien (`track`, reife `tree`) dieselbe `source` mehrfach disposed.
   - **Fix:** `source` erst nach einem `clone()`-Template freigeben oder die Parameter zum Neu-Erzeugen statt einer `source`-Referenz speichern.

5. **Kapellendach am Kirchenschiff vorbei platziert — Impact: Mittel**
   - **Ort:** [`buildings3d.ts:137-138`](../spaces-mmo/client/buildings3d.ts#L137-L138)
   - **Ursache:** Das Kirchenschiff ist um `cx = -w * 0.12` versetzt, `gable(...)` zentriert das Dach aber immer auf `x = 0` (verschiebt es in den Glockenturm).

6. **Doppelter Firstbalken (Z-Fighting) im Gewächshaus — Impact: Niedrig**
   - **Ort:** [`buildings3d.ts:343-344`](../spaces-mmo/client/buildings3d.ts#L343-L344)
   - **Ursache:** Der Firstbalken wird innerhalb von `for (const side of [-1, 1])` zweimal identisch hinzugefügt.

7. **Geräucherte Scholle hat ungeräucherten Schwanzstiel — Impact: Niedrig**
   - **Ort:** [`fish3d.ts:65`](../spaces-mmo/client/fish3d.ts#L65)
   - **Ursache:** `c: kind === "scholle" ? f.back : (smoked ? SMOKED.back : f.back)` ignoriert `smoked` bei `"scholle"`.

8. **Unabgesicherte Division durch 0 in `waterMaterial` — Impact: Niedrig**
   - **Ort:** [`water3d.ts:83`](../spaces-mmo/client/water3d.ts#L83)
   - **Ursache:** `uRoom` fehlt `Math.max(1, w)` / `Math.max(1, h)` (anders als [`ground3d.ts:67`](../spaces-mmo/client/ground3d.ts#L67)) → `NaN`/`Inf`-UVs bei leerem `ground`.

9. **Nicht gecancelter Long-Press-Timer bei Unmount — Impact: Niedrig–Mittel**
   - **Ort:** [`MapView3D.tsx:1137`](../spaces-mmo/client/MapView3D.tsx#L1137), [`MapView3D.tsx:1193`](../spaces-mmo/client/MapView3D.tsx#L1193)
   - **Ursache:** `mapCleanup` ruft `clearTimeout(down?.timer)` nicht auf. (Z. 1135 legt bei Mittelklick zudem ein Dummy-`setTimeout(() => {}, 0)` an.)

10. **`post3d.ts` `hide()` prüft bei Multi-Material-Meshes nur `material[0]` — Impact: Niedrig**
    - **Ort:** [`post3d.ts:39`](../spaces-mmo/client/post3d.ts#L39)

11. **`barrel(t)` überschreibt `modelVariant` im Cache — Impact: Niedrig**
    - **Ort:** [`props3d.ts:460-484`](../spaces-mmo/client/props3d.ts#L460-L484)

---

### 2.3 WebGL-Ressourcenlecks

1. **Ungebundene Materialien, Geometrien & `DataTexture`s bei jedem Raumwechsel — Impact: Hoch**
   - [`MapView3D.tsx:301`](../spaces-mmo/client/MapView3D.tsx#L301): `earth`-Material wird immer erzeugt, aber nie angehängt/disposed, wenn alle Tiles in `GROUND` liegen (Standardfall).
   - [`MapView3D.tsx:318`](../spaces-mmo/client/MapView3D.tsx#L318): `waterMaterial(...)` (inkl. GPU-`DataTexture` `shore`) wird auch in **komplett trockenen Räumen** (`wet.size === 0`) erzeugt und geleakt.
   - [`MapView3D.tsx:331`](../spaces-mmo/client/MapView3D.tsx#L331): `BoxGeometry(1, 1, 1)` wird auch bei `wet.size <= 1` erzeugt und geleakt.
   - [`ground3d.ts:88`](../spaces-mmo/client/ground3d.ts#L88): `wall` + `near`-Texture leaken, wenn ein Raum keine Tiles aus `GROUND` enthält.
   - [`MapView3D.tsx:601`](../spaces-mmo/client/MapView3D.tsx#L601) (`road`): `mark`/`markGeo` leaken bei fertig gebauten Straßen.
   - [`MapView3D.tsx:669`](../spaces-mmo/client/MapView3D.tsx#L669) (`bed`): `stem` leakt, wenn alle Pflanzen Modelle sind und `!obj.weedy`.
2. **Doppelter, nicht entfernter `contextmenu`-Listener** — [`MapView3D.tsx:153`](../spaces-mmo/client/MapView3D.tsx#L153), [`MapView3D.tsx:1192-1193`](../spaces-mmo/client/MapView3D.tsx#L1192-L1193).
3. **Async-Textur-Callbacks mutieren bereits disposed Materialien** — [`ground3d.ts:81-85`](../spaces-mmo/client/ground3d.ts#L81-L85), [`block3d.ts:46-50`](../spaces-mmo/client/block3d.ts#L46-L50).
4. **`fadeOut`-RAF-Loop nicht bei Unmount gecancelt** — [`MapView3D.tsx:1195-1204`](../spaces-mmo/client/MapView3D.tsx#L1195-L1204).

---

### 2.4 Doppelter Code (3D)

- **Identisches GLSL-2D-Hash & Value-Noise:** [`water3d.ts:39-43`](../spaces-mmo/client/water3d.ts#L39-L43) vs. [`ground3d.ts:50-54`](../spaces-mmo/client/ground3d.ts#L50-L54).
- **3× Radial-Gradient-Schattentextur:** [`block3d.ts:54-63`](../spaces-mmo/client/block3d.ts#L54-L63), [`figure3d.ts:38-47`](../spaces-mmo/client/figure3d.ts#L38-L47), [`props3d.ts:965-976`](../spaces-mmo/client/props3d.ts#L965-L976).
- **3× Giebeldach-Builder:** [`props3d.ts:431-441`](../spaces-mmo/client/props3d.ts#L431-L441) (`hut`), [`buildings3d.ts:19-33`](../spaces-mmo/client/buildings3d.ts#L19-L33) (`gable`), [`buildings3d.ts:425-429`](../spaces-mmo/client/buildings3d.ts#L425-L429) (`station`, verpasst dadurch `"near"`-LOD-Latten).
- **Xorshift32-PRNG:** [`props3d.ts:33-36`](../spaces-mmo/client/props3d.ts#L33-L36) vs. [`block3d.ts:179-180`](../spaces-mmo/client/block3d.ts#L179-L180).
- **Smoothstep/Ease & LOD-Hysterese:** [`camera3d.ts:41`](../spaces-mmo/client/camera3d.ts#L41), [`camera3d.ts:71`](../spaces-mmo/client/camera3d.ts#L71), [`closeup3d.ts:1-6`](../spaces-mmo/client/closeup3d.ts#L1-L6), [`modelDetail3d.ts:50`](../spaces-mmo/client/modelDetail3d.ts#L50).
- **Doppelte `InstancedMesh`-Aufbauschleife:** [`MapView3D.tsx:383-391`](../spaces-mmo/client/MapView3D.tsx#L383-L391) vs. [`MapView3D.tsx:392-400`](../spaces-mmo/client/MapView3D.tsx#L392-L400).

---

### 2.5 Toter Code (3D)

- **Unerreichbares `pavingDetail` (trotzdem jeden Frame aufgerufen):** [`MapView3D.tsx:467-494`](../spaces-mmo/client/MapView3D.tsx#L467-L494) bricht bei `GROUND[":"]` sofort ab, was in [`ground3d.ts:19`](../spaces-mmo/client/ground3d.ts#L19) immer definiert ist. `s.paving`, `s.pavingFor` und der `edgeSides`-Import sind tot.
- **Ungenutztes `TileLook.frameMs` & Wasser-Frame-Slicing:** [`tiles3d.ts:8`](../spaces-mmo/client/tiles3d.ts#L8), [`tiles3d.ts:57-60`](../spaces-mmo/client/tiles3d.ts#L57-L60).
- **Ungenutzte Felder/Parameter:** `Figure.last` ([`figure3d.ts:35`](../spaces-mmo/client/figure3d.ts#L35)), `plan` in `siteGeometry` ([`props3d.ts:897-924`](../spaces-mmo/client/props3d.ts#L897-L924) — `void plan`, fragmentiert aber den Cache-Key!), `void r` in `hut` ([`props3d.ts:425`](../spaces-mmo/client/props3d.ts#L425)), `void top` in `townHall`/`glassworks` ([`buildings3d.ts:167`](../spaces-mmo/client/buildings3d.ts#L167), [`buildings3d.ts:308`](../spaces-mmo/client/buildings3d.ts#L308)), redundante Zuweisung `top = [bend, high, 0]` in der Schleife ([`props3d.ts:256`](../spaces-mmo/client/props3d.ts#L256)).
- **Write-only `userData`-Flags & Mess-Arrays:** `userData.owned`, `userData.block`, `userData.terrace`, `s.measurement.zooms`.
- **Nur in Tests genutzte Exporte:** `nearDetail`, `detailCells` ([`closeup3d.ts:6-14`](../spaces-mmo/client/closeup3d.ts#L6-L14)), `terrainHeight` ([`terrain3d.ts:36-42`](../spaces-mmo/client/terrain3d.ts#L36-L42)), `ZoomLevel`/`levelAt` ([`camera3d.ts:26-29`](../spaces-mmo/client/camera3d.ts#L26-L29)).

---

## 3. Rust-Core (`spaces/rust/`)

### 3.1 Logikfehler

1. **Architektur-Bug bei `O_NOFOLLOW` auf Linux `aarch64`** — [`tls.rs:28-31`](../spaces/rust/phi-host/src/tls.rs#L28-L31)
   - Hardcodiert `const O_NOFOLLOW: i32 = 0o400_000;`. Auf Linux `x86_64` ist das `O_NOFOLLOW`, auf `aarch64` jedoch `O_DIRECT` (dort ist `O_NOFOLLOW = 0o100_000`). Folge: kein Symlink-Schutz beim Öffnen + `EINVAL` bei unaligned `read_to_end`.
   - **Fix:** `libc::O_NOFOLLOW` oder `#[cfg(target_arch = "aarch64")]` verwenden.

2. **Unbegrenzte Reply-Queue im Text-Frame-Server** — [`texts.rs:80-115`](../spaces/rust/phi-wire/src/texts.rs#L80-L115)
   - `mpsc::unbounded_channel` erlaubt einem nicht-lesenden Client, durch Senden über `max_inflight` beliebig viele `ResourceExhausted`-Antworten im RAM anzuhäufen (anders als `MAX_HELD_REPLIES` in [`lib.rs:320-331`](../spaces/rust/phi-wire/src/lib.rs#L320-L331)).

3. **Korrupte `format_version` still akzeptiert** — [`files.rs:79-118`](../spaces/rust/phi-store/src/files.rs#L79-L118)
   - `.parse::<f64>().unwrap_or(f64::NAN)`: Bei `NaN` sind `v > FORMAT_VERSION as f64` und `v < 2.0` beide `false`, sodass `Some(NaN)` in `Some(_) => {}` fällt statt `StoreError::Unavailable` zu liefern.

4. **Fehlende Timeouts & Busy-Spin im Replica-/Register-Listener** — [`replica_transport.rs:280-317`](../spaces/rust/phi-host/src/replica_transport.rs#L280-L317), [`register.rs:370`](../spaces/rust/phi-host/src/register.rs#L370)
   - `serve_replica` spinnt ohne Backoff bei `accept()`-Fehlern (`EMFILE`/`ENFILE`) und hat keinen Timeout für `read_exact(&mut body)` (bis 1 MiB) oder `write_all(&out)` (bei nur `MAX_CONNECTIONS = 4`).
   - `serve_register` propagiert jeden transienten `accept()`-Fehler mit `?` und beendet den gesamten TLS-Register-Server.

5. **Falsches `None` bei Lock-Contention in `SyncSpace::sealed`** — [`sync_space.rs:197-208`](../spaces/rust/phi-host/src/sync_space.rs#L197-L208)
   - `self.journal.try_lock().ok()?` gibt bei belegtem Mutex still `None` zurück statt zu blockieren oder einen Fehler zu melden.

6. **Single-Address DNS Connect (IPv4/IPv6 Dual-Stack)** — [`socket.rs:244`](../spaces/rust/phi-spaces-client/src/socket.rs#L244), [`remote.rs:52`](../spaces/rust/phi-host/src/remote.rs#L52), [`replica_transport.rs:202`](../spaces/rust/phi-host/src/replica_transport.rs#L202)
   - Alle drei nehmen nur `.next()` von `lookup_host(...)`. Wenn `localhost` zuerst `::1` auflöst, der Server aber auf `127.0.0.1` lauscht, schlägt der Connect fehl.

7. **Panic auf nicht-finites JSON im Journal** — [`sync.rs:34-37`](../spaces/rust/phi-store/src/sync.rs#L34-L37), [`sync.rs:94`](../spaces/rust/phi-store/src/sync.rs#L94)
   - `marker_of` verwendet `num_or_nan`, was bei fehlender/nicht-numerischer `revision` `f64::NAN` einfügt → `canonical(&marker_of(i))` panickt mit `.expect("journal values are parsed JSON, so finite")`.

8. **Ungeprüfte `u32` Call-ID-Inkremente** — [`remote.rs:81-124`](../spaces/rust/phi-host/src/remote.rs#L81-L124) (kein Wrap auf `1` bei `u32::MAX`, anders als `phi-spaces-client` und `replica_transport`).

9. **`write_private` setzt bei Überschreiben bestehender Dateien kein `0o600`** — [`tls.rs:19-25`](../spaces/rust/phi-host/src/tls.rs#L19-L25) (`OpenOptions::mode` greift nur bei Neuanlage).

10. **Ein persistenter `/dev/urandom`-FD pro Space** — [`store.rs:24-31`](../spaces/rust/phi-store/src/store.rs#L24-L31): Hält pro `SpaceHost` eine offene `File` statt `getrandom::getrandom` (bereits Workspace-Dependency).

---

### 3.2 Optimierungsmöglichkeiten (Core)

1. **JSON-Serialisierung nur für `.len()` statt `Json::json_bytes()`**
   - Hot-Path: [`lib.rs:931`](../spaces/rust/phi-service/src/lib.rs#L931) (`begin_operation`), [`ops.rs:38`](../spaces/rust/phi-store/src/ops.rs#L38) (`delta_bytes`), [`member.rs:138`](../spaces/rust/phi-core/src/member.rs#L138), [`entry.rs:65`](../spaces/rust/phi-service/src/entry.rs#L65), sowie 8 weitere Stellen in `phi-store`/`phi-core`/`phi-host`.
2. **Hot-Path-Allokationen & Index-Invalidierung in `phi-core`**
   - [`state.rs:238`](../spaces/rust/phi-core/src/state.rs#L238): `of_type_field` allokiert 2 `String`s pro Lookup.
   - [`state.rs:258`](../spaces/rust/phi-core/src/state.rs#L258): `Entries::push` verwirft den `m.types`-Cache statt inkrementell zu aktualisieren.
   - [`state.rs:293`](../spaces/rust/phi-core/src/state.rs#L293) & [`state.rs:188`](../spaces/rust/phi-core/src/state.rs#L188): `Entries::remove` invalidiert `m.bytes` (O(N)-Rebuild) statt `record_bytes(&e)` abzuziehen; `record_bytes` klont `e.fields` komplett.
   - [`claims.rs:82-90`](../spaces/rust/phi-core/src/claims.rs#L82-L90), [`claims.rs:152`](../spaces/rust/phi-core/src/claims.rs#L152) & [`lib.rs:654`](../spaces/rust/phi-service/src/lib.rs#L654): Deep-Clone von `args` bei jedem mutierenden Aufruf nur zum Hashen.
3. **`phi-json` Quoting & Canonicalization** — [`lib.rs:311-327`](../spaces/rust/phi-json/src/lib.rs#L311-L327) (`quote` Zeichen-für-Zeichen statt Slice-Copy), [`lib.rs:421-452`](../spaces/rust/phi-json/src/lib.rs#L421-L452) (`String::new()` ohne Kapazität; `Vec`-Allokation auch für 0/1-Key-Objekte).
4. **Redundantes Serialize+Reparse (`copy`) in `phi-store`** — [`sync.rs:37`](../spaces/rust/phi-store/src/sync.rs#L37), [`sync_store.rs:84-85`](../spaces/rust/phi-store/src/sync_store.rs#L84-L85), [`primary.rs:140-149`](../spaces/rust/phi-store/src/primary.rs#L140-L149).
5. **Lock-Contention in `PrimaryGate::admit`** — [`primary.rs:54-67`](../spaces/rust/phi-store/src/primary.rs#L54-L67): Hält beide Mutexe über `delta_bytes(ops)`.
6. **SQLite: Uncached Statements, dynamische SQL-Strings & N+1** — [`sync.rs:194-243`](../spaces/rust/phi-store/src/sync.rs#L194-L243) (`head_revision` berechnet zudem `config_hash` umsonst), [`disk.rs:56-73`](../spaces/rust/phi-store/src/disk.rs#L56-L73), [`register.rs:165-205`](../spaces/rust/phi-host/src/register.rs#L165-L205) (`get_many` macht N Einzel-Queries).
7. **Wiederholtes Disk-I/O & TLS-Config-Rebuild pro Register-RPC** — [`register.rs:259`](../spaces/rust/phi-host/src/register.rs#L259).
8. **OS-Thread + Tokio-Runtime pro Reconnect** — [`replica_transport.rs:196-217`](../spaces/rust/phi-host/src/replica_transport.rs#L196-L217).
9. **Per-Call-Clones in `Service::handle` & Per-Frame-Buffer in `phi-wire`** — [`lib.rs:539-546`](../spaces/rust/phi-service/src/lib.rs#L539-L546), [`texts.rs:84-86`](../spaces/rust/phi-wire/src/texts.rs#L84-L86).

---

### 3.3 Doppelter Code (Core)

- **Wire-Framing (`HEADER = 8`, encode/decode):** verteilt über [`socket.rs:17-153`](../spaces/rust/phi-spaces-client/src/socket.rs#L17-L153), [`lib.rs:28-365`](../spaces/rust/phi-wire/src/lib.rs#L28-L365), [`texts.rs:93-101`](../spaces/rust/phi-wire/src/texts.rs#L93-L101), [`replica_transport.rs:20-306`](../spaces/rust/phi-host/src/replica_transport.rs#L20-L306).
- **`wall_ms`-Duplikate:** neben [`lib.rs:405`](../spaces/rust/phi-json/src/lib.rs#L405) in `phi-service` und 3× in `phi-space-server`.
- **JSON- & Sign/Verify-Helfer:** `js_string` ([`space.rs:69`](../spaces/rust/phi-core/src/space.rs#L69) vs. [`entry.rs:91`](../spaces/rust/phi-service/src/entry.rs#L91)), `put`/`hex` in `entry.rs`, 8× lokale `canonical`-Wrapper, doppelte SQL-Strings in [`sync_store.rs:57-58`](../spaces/rust/phi-store/src/sync_store.rs#L57-L58), identische Sign/Verify-Wrapper in [`space_lifecycle.rs:28-36`](../spaces/rust/phi-host/src/space_lifecycle.rs#L28-L36) und [`run_member.rs:23-31`](../spaces/rust/phi-host/src/run_member.rs#L23-L31).

### 3.4 Toter Code (Core)

- `phi_spaces_client::socket::frame` ([`socket.rs:28-34`](../spaces/rust/phi-spaces-client/src/socket.rs#L28-L34)) — 0 Aufrufer.
- `SpaceHost::watch()` / `WatchSlot` ([`host.rs:75-88`](../spaces/rust/phi-store/src/host.rs#L75-L88)) — nur in `phi-store`-Unit-Tests verwendet, nie in Produktion.

---

## 4. `spaces-mmo` Rust-Backend (`spaces-mmo/rust/`)

### 4.1 Logikfehler

1. **Unvollständiger Single-Region-Reset & verwaiste `herds`** — [`gateway.rs:648-655`](../spaces-mmo/rust/mmo-web/src/gateway.rs#L648-L655), [`gateway.rs:947-957`](../spaces-mmo/rust/mmo-web/src/gateway.rs#L947-L957): `reset()` lässt bei 1 Region `st.site_orders`, `st.winds` und `st.char_region` stehen; `del()` löscht `oid` nicht aus `st.herds`.
2. **Unescaped NPC-Namen in Regexes** — [`requests.rs:19`](../spaces-mmo/rust/mmo-engine/src/npc/requests.rs#L19), [`requests.rs:33`](../spaces-mmo/rust/mmo-engine/src/npc/requests.rs#L33), [`scripts.rs:68`](../spaces-mmo/rust/mmo-engine/src/npc/scripts.rs#L68).
3. **Substring-Replace korrumpiert IDs mit `"null"`** — [`gateway.rs:595`](../spaces-mmo/rust/mmo-web/src/gateway.rs#L595) (`.replace("null", "undefined")` statt `is_null()`).
4. **Race in `StatsCache::get`** — [`stats.rs:182-190`](../spaces-mmo/rust/mmo-web/src/stats.rs#L182-L190): Fehlende `Rc::ptr_eq`-Prüfung kann ein neueres `OnceCell` überschreiben.
5. **Unbegrenzter HTTP-Header-Read ohne Timeout** — [`head.rs:23-33`](../spaces-mmo/rust/mmo-web/src/head.rs#L23-L33).
6. **Pointer-Adresse als permanenter Cache-Key (ABA-Problem)** — [`space.rs:85`](../spaces-mmo/rust/mmo-engine/src/space.rs#L85) in `CACHE` ([`settings.rs:50`](../spaces-mmo/rust/mmo-engine/src/settings.rs#L50)) und `JETTIES_MOVED` ([`build.rs:1202`](../spaces-mmo/rust/mmo-engine/src/commands/build.rs#L1202)).
7. **Mismatched Quote-Stripping in `.env`-Parser** — [`world_host.rs:45-46`](../spaces-mmo/rust/mmo-engine/src/world_host.rs#L45-L46).
8. **Mögliche Division durch 0 bei leerem `regions_of`** — [`regions.rs:49-52`](../spaces-mmo/rust/mmo-web/src/regions.rs#L49-L52).
9. **Mögliche Panic in `weighted` bei leerer/0-Gewicht-Liste** — [`fire.rs:308-313`](../spaces-mmo/rust/mmo-engine/src/fire.rs#L308-L313).

### 4.2 Optimierungsmöglichkeiten (`mmo-engine` / `mmo-web`)

1. **Deep-Clone der gesamten World-JSON bei jedem Command & jeder NPC-Runde** — [`room_growth.rs:89-119`](../spaces-mmo/rust/mmo-engine/src/room_growth.rs#L89-L119) (`spatial_world` → `Rc<Json>` + Caching nach Growth-Revision).
2. **`Mirror::count` klont alle Entries; `seq_of` allokiert im Sort-Komparator** — [`mirror.rs:108-111`](../spaces-mmo/rust/mmo-engine/src/mirror.rs#L108-L111), [`mirror.rs:235`](../spaces-mmo/rust/mmo-engine/src/mirror.rs#L235); außerdem verwirft `Copy::invalidate_type` ([`mirror.rs:44-47`](../spaces-mmo/rust/mmo-engine/src/mirror.rs#L44-L47)) bei jedem Write alle Feld-Indizes des Typs.
3. **O(N²)-Command-Table-Merge pro Nicht-Step-Command** — [`mod.rs:85-128`](../spaces-mmo/rust/mmo-engine/src/commands/mod.rs#L85-L128) (~250+ Befehle pro Aufruf neu gemerged → einmalig pro Rolle in `HashMap` vorbauen).
4. **Regex-Kompilierung pro Aufruf / in Schleifen** — [`accounts.rs:40`](../spaces-mmo/rust/mmo-web/src/accounts.rs#L40), [`requests.rs:27`](../spaces-mmo/rust/mmo-engine/src/npc/requests.rs#L27), [`execute.rs:38`](../spaces-mmo/rust/mmo-engine/src/execute.rs#L38), [`world_host.rs:426`](../spaces-mmo/rust/mmo-engine/src/world_host.rs#L426), [`scripts.rs:68`](../spaces-mmo/rust/mmo-engine/src/npc/scripts.rs#L68).
5. **WebSocket-Fan-out serialisiert pro Client statt einmal** — [`gateway.rs:634`](../spaces-mmo/rust/mmo-web/src/gateway.rs#L634) (Fog), [`gateway.rs:861-862`](../spaces-mmo/rust/mmo-web/src/gateway.rs#L861-L862) (Wind), [`gateway.rs:1138-1156`](../spaces-mmo/rust/mmo-web/src/gateway.rs#L1138-L1156) (Atlas).
6. **Hot-Path Linear-Scans & String-Keys** — `free_ground` ([`settlers.rs:79-89`](../spaces-mmo/rust/mmo-engine/src/npc/settlers.rs#L79-L89)), `walkable`/`find_path` ([`world.rs:21-63`](../spaces-mmo/rust/mmo-engine/src/world.rs#L21-L63)), `avoid`-Vec ([`accounts.rs:367`](../spaces-mmo/rust/mmo-web/src/accounts.rs#L367)), `name_of`/`in_own_chest` ([`gateway.rs:211-222`](../spaces-mmo/rust/mmo-web/src/gateway.rs#L211-L222), [`gateway.rs:1179`](../spaces-mmo/rust/mmo-web/src/gateway.rs#L1179)), `settings_of` klont ganze `HashMap` für 1 `f64` ([`settings.rs:54-64`](../spaces-mmo/rust/mmo-engine/src/settings.rs#L54-L64)), `no_trips()`-Allokation ([`stats.rs:129`](../spaces-mmo/rust/mmo-web/src/stats.rs#L129)).

### 4.3 Doppelter Code (`mmo-engine` / `mmo-web`)

- `in_txn` ([`build.rs:1188`](../spaces-mmo/rust/mmo-engine/src/commands/build.rs#L1188) vs. [`sweep.rs:19`](../spaces-mmo/rust/mmo-engine/src/sweep.rs#L19)).
- 3× `js_string` in `mmo-web` (`admin.rs:60`, `chat.rs:575`, `stats.rs:176`).
- `cookie_of`/`cookie_of_parts` in [`lib.rs:103-350`](../spaces-mmo/rust/mmo-web/src/lib.rs#L103-L350) (Header wird in `api()` zudem mehrfach geparst).
- `SPACES_MMO_REGIONS`-Parsing (`world_host.rs:271` vs. `regions.rs:15`).
- `unique_or` / `"unique entry already exists"` über Commands & Chat.
- `deep_equal`/Template-Matching in [`mirror.rs:89-106`](../spaces-mmo/rust/mmo-engine/src/mirror.rs#L89-L106) vs. `phi_core`.
- Identische `main()`-Shutdown-Boilerplate in `mmo-world`, `mmo-npc` und `mmo-web`.

### 4.4 Toter Code (`mmo-engine` / `mmo-web`)

- `Merge::Replace`/`Merge::Remove` ([`mod.rs:79-92`](../spaces-mmo/rust/mmo-engine/src/commands/mod.rs#L79-L92)).
- `Chat::state_of` ([`chat.rs:160`](../spaces-mmo/rust/mmo-web/src/chat.rs#L160)), `OMap::len` ([`omap.rs:32`](../spaces-mmo/rust/mmo-web/src/omap.rs#L32)), `Space::read` ([`space.rs:127`](../spaces-mmo/rust/mmo-engine/src/space.rs#L127)), `j::find` ([`j.rs:73`](../spaces-mmo/rust/mmo-engine/src/j.rs#L73)).
- Redundanter Branch in [`chat.rs:46`](../spaces-mmo/rust/mmo-web/src/chat.rs#L46), trivialer Wrapper `txt_of` ([`chat.rs:578`](../spaces-mmo/rust/mmo-web/src/chat.rs#L578)), ungenutzter Parameter `n` in `mind` ([`scripts.rs:76-78`](../spaces-mmo/rust/mmo-engine/src/npc/scripts.rs#L76-L78)).

---

## 5. Anwendungs-Space-Server (`mmo-space`, `codemode-space`, `help-space`, `phi-space-server`)

### 5.1 Logikfehler

1. **Veraltete `authorityId` nach Control-Restore (`phi-space-server`)** — [`control_host.rs:260`](../spaces/rust/phi-space-server/src/control_host.rs#L260), [`member.rs:236`](../spaces/rust/phi-space-server/src/member.rs#L236): Lesen `field(c, "authorityId")` statt `followed_authority(&c).0` → Mismatch zum aktualisierten `control_key`.
2. **Nicht-transitiver `NaN`-Comparator in `sort_by` (`help-space`)** — [`help.rs:124`](../help-site/rust/help-space/src/help.rs#L124): `partial_cmp().unwrap_or(Equal)` verletzt Strict-Weak-Ordering bei `NaN` → potenzielle Panic in Rust 1.81+ Driftsort (`f64::total_cmp` nutzen).
3. **Fehlende `postId` kollabiert auf `""` (`help-space`)** — [`help.rs:108-123`](../help-site/rust/help-space/src/help.rs#L108-L123): Verhindert das Aufräumen verwaister `Like`s ohne `postId`.
4. **`positive()` akzeptiert `Infinity` & trimmt nicht (`mmo-space`)** — [`main.rs:8`](../spaces-mmo/rust/mmo-space/src/main.rs#L8): Fehlendes `.is_finite()` und `.trim()`.
5. **`Json::Null` als gesetzt gewertet in `recovery_only` (`phi-space-server`)** — [`recovery.rs:184`](../spaces/rust/phi-space-server/src/recovery.rs#L184).
6. **Fragiler CLI-Flag-Scanner (`phi-space-server`)** — [`main.rs:32`](../spaces/rust/phi-space-server/src/main.rs#L32): Durchsucht `argv[0]` mit und unterscheidet Flag-Namen nicht von Flag-Werten.

### 5.2 Optimierungsmöglichkeiten

1. **`help::purge` blockiert Single-Threaded-Event-Loop (`help-space`)** — [`help.rs:81-243`](../help-site/rust/help-space/src/help.rs#L81-L243): Läuft ohne Yield durch alle Batches (anders als TS mit 25 ms Pause), scannt Entries doppelt, sucht `O(BATCH × N)` linear beim Relink (Z. 218) und klont `fields` zum Byte-Zählen (Z. 223).
2. **Startup-Redundanz in `phi-space-server`** — Liest `keyFile` 6+× von Disk, öffnet `SqliteRegister` 4–5× und erzeugt in `member::run` ([`member.rs:275-300`](../spaces/rust/phi-space-server/src/member.rs#L275-L300)) bis zu 3 Tokio-Runtimes nacheinander.
3. **Startup-Lock-Commits & Compaction-Thread-Spawn (`phi-space-host`)** — [`lib.rs:175-185`](../spaces/rust/phi-space-host/src/lib.rs#L175-L185) (separate `Synchronous::Full`-Commits pro Lock) & [`lib.rs:209-216`](../spaces/rust/phi-space-host/src/lib.rs#L209-L216) (neuer OS-Thread pro Compaction-Tick nur für `println!`).

### 5.3 Doppelter Code & 5.4 Toter Code

- **Duplikate:** `phi-space-server/tests/process.rs` dupliziert `phi-space-host/src/testing.rs`; identische `main()`- und Store-Setup-Boilerplate in `codemode-space`, `help-space` und `mmo-space`; 3× `now()`/`clock()` und wiederholtes Key-/Register-Parsing in `phi-space-server`; manueller Tokio-Runtime-Builder statt `stopping::runtime()`.
- **Toter Code:** Dummy-`ServeOptions` sofort gecleared in [`member.rs:206-207`](../spaces/rust/phi-space-server/src/member.rs#L206-L207) & [`main.rs:58-64`](../spaces/rust/phi-space-server/src/main.rs#L58-L64); doppelte Algorithmus-Prüfung in [`member.rs:291-294`](../spaces/rust/phi-space-server/src/member.rs#L291-L294); leeres `const REFUSED` in [`control_host.rs:26`](../spaces/rust/phi-space-server/src/control_host.rs#L26).

---

## 6. Empfohlener Umsetzungsplan

- **Phase 1 — Kritische Bugfixes & Leaks (geringer Aufwand, hoher Sicherheits-/Stabilitätsgewinn):**
  - 3D: `figure3d.ts` (`baseTall` & `f.phase`), Raumwechsel-Leaks (`waterMaterial`/`earth`/`BoxGeometry`), `s.bubbles`-Cleanup, Async-Race in `MapView3D.tsx`.
  - Rust: `O_NOFOLLOW` für `aarch64`, `texts.rs` bounded channel, `files.rs` `NaN`-Check, `replica_transport.rs` Timeouts & Accept-Backoff, `Gateway::reset`/`del`, `followed_authority` in `phi-space-server`, `f64::total_cmp` in `help-space`.
- **Phase 2 — `spaces-mmo` 3D-Rendering-Performance (größter FPS-Hebel):**
  - Pflanzenschatten instanziieren + Wildblumen via `setColorAt` + `track()` mergen + Fische instanziieren & bei Insel-Zoom ausblenden.
  - Shadow-Map `2048×2048`, `surfaces3d.ts` Triplanar-Fetches für nicht-texturierte/Laub-Meshes einsparen, `hide()` mit Short-Circuit-Traversal, `figure3d.ts` Cache-Key ohne Geometrie-Allokation.
- **Phase 3 — Rust-Backend-Durchsatz:**
  - `spatial_world` mit `Rc<Json>`, `Mirror::count` ohne Clone, `seq_of` allokationsfrei, statische Command-Tables in `mmo-engine`, `json_bytes()` statt `to_json_text().len()` in `phi-service`/`phi-store`, `prepare_cached` in `phi-store`, WebSocket-Fan-out einmalig serialisieren.
- **Phase 4 — Bereinigung (Duplikate & Toter Code):**
  - `pavingDetail` entfernen, GLSL-Noise & Schatten-Canvas deduplizieren, Wire-Framing & `wall_ms` in `spaces/rust/` vereinheitlichen, `phi-space-server` Startup-I/O bündeln.
