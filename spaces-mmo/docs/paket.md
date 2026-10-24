# Vorarbeit: phi-spaces als Paket (Phase P)

Entscheidung: Bevor spaces-mmo beginnt, wird phi-spaces ein richtiges Paket. Alle Projekte, die auf phi-spaces
aufbauen (codemode-chat, help-site, spaces-mmo, künftige), importieren `phi-spaces` statt relativer Pfade in `src/`.
Die Referenz für Unterpfade und Regeln steht in `docs/api.md`, Abschnitt „Paket und Unterpfade“.

Stand 2026-10-24: umgesetzt, noch nicht committet (siehe [Stand](#stand)).

## Ausgangslage

- Verbraucher importierten relativ: `../../src/index.ts`, `../../src/context.ts`, dazu einzelne Importe von `core.ts`,
  `remote.ts`, `store/host.ts`, `store/sqlite.ts`, `store/documents.ts`.
- help-site-Beispiel `examples/v5-federated-cluster` und `agent/` greifen auf Föderations-Interna zu (`router.ts`,
  `federated-space.ts`, `entry-replication.ts`, `federation-journals.ts`, `routing-semantics.ts`).
- Root-`package.json`: kein `exports`; `main`/`types` zeigten auf `dist/`, das gitignored ist und lokal veraltet
  herumliegen kann.
- `@earendil-works/pi-codemode` war Laufzeitabhängigkeit des Roots, wird aber von `src/` nicht importiert.

## Umsetzung

### `exports` direkt auf die Quellen

```jsonc
"main": "./src/index.ts",
"exports": {
  ".":                 "./src/index.ts",
  "./context":         "./src/context.ts",
  "./core":            "./src/core.ts",
  "./store/host":      "./src/store/host.ts",
  "./store/sqlite":    "./src/store/sqlite.ts",
  "./store/documents": "./src/store/documents.ts",
  "./package.json":    "./package.json"
}
```

**Abweichung vom ersten Entwurf:** Geplant war eine Bedingung `source` → `src/*.ts` mit `default` → `dist/*.js`.
Verworfen, weil:

- `dist/` gitignored ist, lokal aber veraltet existiert: Jeder Aufruf ohne `--conditions=source` hätte **still alten
  Code** geladen.
- Die Bedingung hätte in jedes npm-Skript, in die expliziten Argumente von `spawn` (`codemode-chat/server/launch.ts`),
  in jedes Dockerfile-`CMD` und in jeden Test, der Prozesse startet, gemusst; eine vergessene Stelle reicht.

Kein `types`-Feld auf `dist/*.d.ts` aus demselben Grund. Soll das Paket später veröffentlicht werden, kommt dafür ein
eigener Schritt (z. B. `prepack`, das `exports` auf `dist/` umschreibt, oder eine opt-in-Bedingung `dist`).

### Einbindung

- `"phi-spaces": "file:.."` in den `dependencies` von codemode-chat und help-site; npm legt
  `node_modules/phi-spaces -> ../..` an. Lockfiles änderten sich nur um den Link-Eintrag.
- **Geprüft:** Node 22 (lokal v22.23.1) löst über den Symlink auf den echten Pfad `…/phi-spaces/src/index.ts` auf
  und entfernt dort die Typen (keine `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Probelauf mit `import.meta.resolve`
  im Scratchpad.
- TypeScript: codemode-chat und help-site haben `moduleResolution: "bundler"` und `allowImportingTsExtensions`; das
  löst die `exports` ohne weitere Einstellungen auf.
- Next.js: Nur Serverprozesse importieren den Kern, kein Seiten- oder Clientcode; `transpilePackages` ist nicht
  nötig.
- Docker: Build-Kontext ist schon der Root (`context: ../..`), das Root-`package.json` liegt beim `npm ci` des
  Projekts an seinem Platz; `COPY node_modules` übernimmt den Symlink.

### Abhängigkeiten

- `@earendil-works/pi-codemode` steht jetzt in den `devDependencies` des Roots. codemode-chat führt es selbst und lädt
  es aus seinem eigenen `node_modules` (`loadCodemode` in `codemode-chat/server/judge.ts`); die Root-Installation in
  den Dockerfiles läuft ohne `--omit=dev`.
- `files` enthält jetzt `src` (die exports zeigen dorthin).

### Prüfskript

`scripts/package-imports.mjs --check` (`npm run check:package`, in `npm test` eingehängt) prüft jedes Projekt mit
eigenem `package.json` außer `agent/`:

- keine relativen Importe nach `src/` (statisch, dynamisch, Re-Export);
- nur exportierte Unterpfade von `phi-spaces`;
- jedes Export-Ziel existiert;
- ein verlinktes `node_modules/phi-spaces` zeigt auf diesen Checkout.

Ausnahmen, einzeln begründet: `help-site/examples/v5-federated-cluster/run.ts` (Föderations-Interna) und
`help-site/scripts/check-corpus-examples.ts` (schreibt Importpfade für eine virtuelle Datei als Text). spaces-mmo wird
automatisch geprüft, sobald es ein `package.json` hat.

### `agent/`

Bleibt bei relativen Importen. Seine tiefen Importe sind Föderations-Interna, die sich noch ändern; als
`exports`-Unterpfad würden sie zum Vertrag, den jedes Projekt sieht. Erst wenn `agent/` eigenständig veröffentlicht
werden soll, bekommen die gebrauchten Teile einen Unterpfad.

## Stand

| Schritt | Stand |
| --- | --- |
| `exports`, `pi-codemode` → `devDependencies`, `files` | erledigt |
| Probelauf Auflösung + Typstripping über Symlink | erledigt, grün |
| codemode-chat und help-site umgestellt (40 Dateien, nur Importzeilen) | erledigt |
| `check:package` + Einhängen in `npm test` | erledigt, Gegenprobe schlägt an |
| `docs/api.md`, `AGENTS.md` | erledigt |
| Typecheck Root, codemode-chat, help-site | grün |
| Testsuiten Root (575/576, 1 übersprungen), codemode-chat (113/113), help-site (54/55, Next-Produktionstest übersprungen wie bisher) | grün |
| `docker:test` codemode-chat (Image-Bau inkl. Typecheck und `next build`, 113/113) und help-site (55/55) | grün |
| Produktions-Images (`docker:prod:*`) gestartet | nicht geprüft |
