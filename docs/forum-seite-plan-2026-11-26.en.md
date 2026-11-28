# FORUM: people and models turn a folder into a plan and its documents, on one page (plan, 2026-11-26)

Status: phase 0 done on 2026-11-26 (`idp/`, the two changes in spaces-files); phase 1 done on 2026-11-26 (sign-in, people and rooms in codemode-forum, the help's base); phase 2 done on 2026-11-27 (the page); phase 3 done on 2026-11-27 (on the servers); phase 4 done on 2026-11-27 (models and providers from the page); phase 5 done on 2026-11-27 (the files connection, reading); phases 6 to 13 open. Proposed on 2026-11-26; second version of the same day, after the person's word on the name,
binary files, the servers, the example brief, sources and scripts (section 2). The decisions of section 2 are open until confirmed.
Starting point: `codemode-forum/` (phases 0 to 11 of `docs/gemeinsame-planung-plan-2026-11-22.en.md`) and
`spaces-files/` (phases 1 to 5 of `docs/zanzibar-agent-filesystem-plan.en.md` and what followed) as of commit
`20ec683` on master.

## 1. Goal

One page on which people and models together turn the material in a folder into a plan and the documents that
belong to it, and get them back as files in the same workspace. The page is called **FORUM**.

1. A person signs in once.
2. They open a room and link it to folders of a spaces-files workspace: one to read from, and the project folder,
   into which uploads and results go.
3. They bring material: documents, photos, sketches, links. They write a brief, choose models and a budget, and
   start.
4. The models read the material, look things up, ask, propose, object and vote. People answer questions, write
   sections themselves, and may accept or object at any time.
5. The plan, its further documents and the register of sources are saved as files in the project folder, with
   versions, the workspace's rights and its audit.
6. People edit the files with their own rights. The next run reads them again.

**The brief this plan is measured against** (the person's example, 2026-11-26): "Create an app that shows the
starry sky at a given time and place, with the positions of comets and asteroids, the constellations and the Messier
objects." A room for it ends with a project folder that holds:

| File | What it is | Who brings it |
|---|---|---|
| `material/` | what people put in: a sketch of the screen as a photo, a list of wishes, an existing catalogue file | people, by upload or in spaces-files |
| `plan.md` | the plan: steps, order, checks, risks, open decisions | the models at the table, people's sections and objections |
| `requirements.md`, `architecture.md`, … | further documents the plan needs, each a task of its own in the room | models and people |
| `scripts/` | small scripts the table ran to check something: a position computed from orbital elements, the rows of a catalogue counted, a format verified | models and people, run in the sandbox |
| `sources.md` | the register of sources: every catalogue, data service and reference used (star catalogue, orbital elements of comets and asteroids, constellation lines, the Messier list), with its address, its licence as far as found, who brought it and where it is cited | models through research, people by hand |

The app's source code is not written here (the person's word, 2026-11-26): the room ends with documents, the
register and the scripts that back them.

![The six steps as a cycle: material in a workspace folder, the brief, the table where the models discuss, the plan and its documents with their versions, the files in the project folder, people editing them, and the next run reading it again. The person answers questions at the table and accepts or objects to the plan.](img/forum-journey.svg)

The page must work on a phone as well as on a desk, everything a person or an administrator sets must be settable on
the page, and the help is part of every phase, written for people who know neither application.

## 2. What is given and what is to be decided

**Given by the person (2026-11-26):**

| Wish | Where this plan answers it |
|---|---|
| One use case that joins codemode-forum and spaces-files, presented as one package | sections 1 and 4 |
| A modern page on which everything comes together and can be configured | sections 4 and 9 |
| Phones and tablets from the start | section 10 |
| The providers' sign-in and the choice of models controlled from the page | section 8 |
| Pi (the `@earendil-works` packages) in the background | section 8, *Pi in the background* |
| Help from the start, well structured, for laypeople, English and German, with diagrams | section 11 |
| The forum acts in spaces-files as an agent with rights a person grants (agreed in the conversation) | section 6 |
| The page is called FORUM | everywhere; the directory `codemode-forum/` and the prefix `FORUM_` stay |
| Binary files must be allowed, photos for example | section 6, *Files that are not text* |
| It may be tested on big and nano where that makes sense | section 13 and phase 3; containers of other applications there are still asked about first |
| `codeforum.eibrain.org`, origin address `2a0a:4cc0:c0:62f2:8000::1002`, behind nginx like the other sites | section 13 |
| The example brief (the sky app); people and agents produce a plan, documents and sources | section 1 and section 6, *A room is a project* |
| Sources are discussed at the table | section 6, *The register of sources* |
| Scripts are allowed (codemode, as codemode-chat runs them); the app's source code is not written | section 6, *Scripts* |
| Running scripts can be moved out to external sandboxes, as files are kept outside | section 6, *Scripts*; decision 2 |
| `id.eibrain.org` is the identity provider's name; so far only the name exists. It and `codeforum.eibrain.org` go behind the proxy like the other sites | section 13 |

**Decisions, with a recommendation each.** Those the person has taken are marked. Open are 5 to 10, 13 and 14; none of them holds up phases 0 to 3.

| # | Question | Recommendation |
|---|---|---|
| 1 | Where does the page live: inside `codemode-forum/` or in a sixth application? | Inside `codemode-forum/`. The page's server must follow the forum's Space (`server/hub.ts`) anyway; a separate application would build that hub a second time. The present page stays reachable as the expert view (`/expert`). **Decided: yes (2026-11-26).** |
| 2 | Where does the sandbox for scripts (and for taking the text out of PDFs) run? | As a role of its own, `sandbox`, that talks only through the forum's Space like every other role, in a container without network, with a read-only file system and bounded memory and time, on nano beside the checker. Because it is only a client of the Space it can run on any machine, and a sandbox someone else operates can take the same requests later. Not inside web, agents, model or sources. **Decided: yes (2026-11-26).** |
| 3 | Which identity provider | Keycloak in Docker, one realm for both applications, issuer on a host name of its own, fixed before the first account. NetBird's built-in provider cannot register a further client and is not used. **Decided: Keycloak (2026-11-26).** |
| 4 | "Sign-in of the providers": this plan reads it as the credentials of the **model** providers (API keys, OAuth logins). | As read. The identity provider itself is the root of trust and stays in the operator's environment; the page shows it and cannot change it. **Decided: as read (2026-11-26).** |
| 5 | OAuth logins of personal subscriptions (a chat subscription used as a model account) on a deployment several people use | Off unless the operator sets `FORUM_SUBSCRIPTION_LOGIN=1`. Such subscriptions are sold for their holder's own use; whether a provider's terms allow more is for the operator to check. API keys are always offered. |
| 6 | Who creates the room's agent in spaces-files (only a tenant administrator may register an actor today) | First the tenant administrator, on the spaces-files page, with no change there (phases 5 to 8). A consent page in spaces-files with a narrow new operation follows as phase 11 and is decided then. Asked back by the person ("what makes sense?", 2026-11-26): this, because today the person who links rooms is the tenant's administrator; the consent page pays off with the first person who is not, and it changes the application that guards the files, so it should not be built on a guess. |
| 7 | Is workspace material read live during a run, or copied when a task is created? | Copied. spaces-files keeps no old versions, and the forum's checks quote lines that must not move under them. |
| 8 | Is the plan saved by a person's click or by itself? | By a click. Saving on acceptance becomes a room setting in phase 7, off by default. |
| 9 | The accounts on big when spaces-files changes from password sign-in to the provider | An operator command that rebinds an actor to a new issuer and subject, audited. Decided before phase 12, not needed locally. |
| 10 | Does the forum get the durable agent (pi-durable) with this work? | No. Nothing here needs it; the forum plan's own condition (its section 14) stays. |
| 11 | The sandbox needs pi-codemode (the QuickJS sandbox codemode-chat's judge uses). It is in the repository at 1.5.2 (`spaces/`, `codemode-chat/`) but would be new in `codemode-forum/package.json`. | Add it there at the same version, loaded by the sandbox process alone. **Decided: yes where it is needed (2026-11-26). The registry has 1.6.1 since 2026-11-25; decision 14 says when the repository moves.** |
| 12 | How do models read a PDF or an office file? | PDF: read (section 6, *Files that are not text*), with pdfjs-dist as a new package of `codemode-forum/` (6.5.438 today, Apache-2.0, no dependency of its own that it needs; its optional canvas package is for drawing pages and is left out). **Decided: PDFs are read, the package may be added (2026-11-26).** Office files stay as before: kept, shown and named with a person's note. |
| 13 | May the models search the web for sources? | Yes, switched on by an administrator, as codemode-chat's research agents do (`server/search.ts`: result lists only, no page is fetched). The sky brief cannot be answered well without it. |
| 14 | Pi 1.6.1 is out (2026-11-25); the repository pins 1.5.2 in `spaces/agent/`, `spaces/` and `codemode-chat/` (`AGENTS.md`). When does it move? | As a step of its own before phase 4, for all packages at once and with every suite that loads them: phase 4 builds on pi-ai's login interface and phase 10 on pi-codemode, and both should be written against the version that stays. Not mixed: no application on 1.6 while the agent package is on 1.5. **Decided: before phase 4 (2026-11-27); done the same day, all packages at 1.6.1.** |

## 3. Where both applications stand

What this plan builds on, and what it must add. Verified in the code on 2026-11-26.

| | codemode-forum | spaces-files |
|---|---|---|
| Deployed | never; this machine only | on big, public, behind nginx |
| Who a person is | nobody: only an admin password (`FORUM_ADMIN_PASSWORD`); anyone who reaches the page can start or stop a run and accept a version | a user actor bound to (issuer, subject); on big a username under the issuer `local` with a password, elsewhere OpenID Connect (`server/oidc.ts`) |
| Rights | none per room | owner, editor, viewer on nodes, inherited, groups; granted by an owner |
| Agents of other programs | none | agent actors bound to (enrolled host, agent ID), one unix socket per host and tenant, or TLS (`server/agent-net.ts`); an agent host cannot create actors |
| Page | Next.js and React, WebSocket snapshots, English and German, a help reader with eight articles, phone rules below 760 px | no framework, strict content security policy, English and German, field tips and a help dialog, one column below 760 px |
| Models | pi-ai 1.5.2 through `spaces/agent/src/live-models.ts`; credentials from environment keys and a read-only `~/.pi/agent/auth.json`; an admin panel that chooses the allowed models | none |

Four findings that shape the plan:

- **The browser cannot join the two.** spaces-files accepts only its own `__Host-files` cookie, checks that the
  `Origin` is its own and sends no CORS header. The forum's page can therefore never call spaces-files as the person.
  The join is made on the server, with rights of its own that a person grants (section 6).
- **`FILES_AGENT_NET` is documented but not started.** `spaces-files/server/launch.ts` imports `serveAgentNet` and
  never calls it. Agent hosts over TLS work only in the tests. Phase 12 needs it; phases 5 to 8 use the unix socket.
- **Refreshed model logins are lost.** `authJsonStore` in `live-models.ts` changes only its copy in memory, so an OAuth
  token refreshed by the model process is gone after a restart. Section 8 replaces it.
- **A live run costs money.** Three models, both tables, three rounds: $3.88, $4.84 and $4.57 in the three runs of
  `codemode-forum/docs/live-runs-2026-11-23.en.md`. Budgets per room and per person are part of the first version.

## 4. The page

Four places, the same on every device:

| Place | What it holds |
|---|---|
| **Rooms** | the rooms a person owns or was invited to, each with its state (idle, running, waiting for you, plan ready); create a room |
| **Room** | three panes: **Files** (the linked folders and what is in them), **Table** (the discussion, the run, the questions to the person), **Plan** (the document, its versions, objections, ballots, save) |
| **Settings** | for everyone: language, theme. For a room's owner: members, linked folders, default models, budget, answer time. For an administrator: model providers, allowed models, limits, the files connection, the system's processes |
| **Help** | the reader with its articles and search; every control also carries a tip that links into it |

```
desk (three panes)                                      phone (one pane, tabs below)
┌ FORUM › Sky app ────────────────── ? ─ ☰ ┐            ┌ Sky app ───────── ? ☰ ┐
│ FILES            │ TABLE        │ PLAN    │            │ M2  proposal: …        │
│ ▸ material/ read │ M1 question… │ 1 Goal  │            │ You  answer #12: …     │
│   needs.md       │ M2 proposal… │ 2 Scope │            │ ✔ Decision #4          │
│ ▸ plans/  write  │ ✔ Decision 4 │ 3 Risks │            │ ● M1 asks you — 1:40   │
│   plan.md  v7    │ [message … ] │ [Save]  │            │ [ message …         ➤ ]│
│ budget ▓▓▓░ 62 % │ round 2 of 5 │ v3 of 3 │            ├ Files │ Table • │ Plan ┤
└──────────────────┴──────────────┴─────────┘            └────────────────────────┘
```

**What "modern" means here**, so that it can be checked:

- one set of design tokens, derived from the shared palettes as the dashboard and spaces-files do (`color-mix` on
  `--color-a/b/c`), the fourteen palettes, light and dark, the Geist font stack;
- every state has a face: loading (a skeleton, never an empty pane), empty (the next step, said in one sentence with
  its button), failed (what happened, what to do), and waiting for the person (visible in the room list too);
- nothing depends on hover; every control has a name a screen reader says, and is reachable by keyboard;
- motion respects `prefers-reduced-motion`;
- no new package: React and CSS as the forum has them.

**Routes.** A room gets a path, `/r/<room>`, so that a link to it can be sent (today the room is the URL's hash).
`/`, `/r/<room>`, `/settings`, `/help`, `/expert` (the present page, unchanged, for the standings and the two-table
view). The WebSocket stays `/ws/<room>`.

## 5. Identity and access in the forum

Without this section a linked room would show a workspace's text to anyone who reaches the page.

**Sign-in.** `FORUM_LOGIN=oidc` with `FORUM_OIDC_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_CA`. The client is
`codemode-forum/server/oidc.ts`, a copy of `spaces-files/server/oidc.ts` (it needs only node's own modules), held
equal by `checks/shared-copies.test.mjs`. The same rules as there: discovery, the code flow with PKCE (S256), state
and nonce, the ID token verified on the server, the identity is the pair (issuer, subject) and nothing else from the
token.

- A session is a `UserSession` entry (the handle hashed, one hour idle, twelve hours at most, as in spaces-files) and
  a cookie `__Host-forum` (`Secure`, `HttpOnly`, `SameSite=Strict`). Every request that changes something carries a
  CSRF header; the WebSocket upgrade checks the cookie and the `Origin`.
- Signing out ends the session and then sends the browser to the provider's `end_session_endpoint`, so that the next
  "sign in" asks again. The same step is added to spaces-files (section 7).
- A second factor is the provider's matter and is required there for everyone.
- Without `FORUM_LOGIN` the forum behaves as today, for play on one machine. It then refuses to link a room to a
  workspace and to take provider credentials from the page.

**People and rooms.**

| Entry | Content |
|---|---|
| `ForumUser` | issuer, subject, a display name the person chooses, first and last sign-in |
| `UserSession` | hash of the handle, user, expiry; leased |
| `RoomAccess` | room, owner, members and viewers by user, created |

| Role | May |
|---|---|
| owner | everything in the room: members, linked folders, settings, delete |
| member | create tasks, start and stop runs within the room's budget, write to the table, accept, object, save the plan |
| viewer | read |
| administrator | the administrator's settings; no room they were not invited to |

Administrators are named by the operator (`FORUM_ADMINS`, pairs of issuer and subject). The admin password stays for
scripts and tests (`x-admin-token`) and is refused for a browser when `FORUM_LOGIN=oidc`.

Every route of `server/index.ts` and the WebSocket check the role; today six `POST` routes check nothing. What a
person writes to the table is signed with their user, no longer with a free text `by`. Limits per IP address become
limits per person (`FORUM_TOKENS_PER_USER_DAY`); the limits per address stay for requests before sign-in.

## 6. The join with spaces-files

![Who may see what: the folder owner in spaces-files grants the room's agent viewer on a folder that is only read and editor on the project folder and can revoke both at any time. The agent reads both and writes uploads, the plan and the documents into the project folder; everything else in the workspace is never visible to the room. A copy of the text is taken when a task is created; room members see it, and excerpts of it go to the model providers in prompts.](img/forum-access.svg)

**The room's agent.** The forum is one enrolled agent host of spaces-files (`operator enroll-host`). Each linked
room is one agent actor there: host peer of the forum, agent ID `room-<id>`. The agent has only what an owner in
spaces-files grants it: `viewer` on a folder to read from, `editor` on the project folder, into which uploads and
results go and which is read as well. That grant is the consent. It is in spaces-files' audit and can be revoked there at any time.

Why one actor per room and not one for the whole forum: with a single actor, a task in one room could name a folder
that was granted for another. The forum cannot ask spaces-files what a person may see, so the rights must already be
separate where spaces-files checks them.

**Linking a room** (phases 5 to 8, no change to spaces-files):

1. The room's owner chooses "link a workspace". The page shows the agent's ID and the three steps.
2. A tenant administrator registers that agent on the spaces-files page, with the forum's host peer and the agent's
   ID (the page offers the peer as a choice once the host is enrolled with a key; with a unix socket alone it is
   typed in).
3. An owner of the folders grants `viewer` and `editor` there. spaces-files takes `viewer` only on a workspace's root
   or on a restricted folder, and an actor sees a folder only through a role on its workspace's root: a folder that
   is only read is in practice a workspace of its own (or a restricted folder in one), and the project folder lies in
   a workspace the agent has a role on. The room reads only the folders it was linked to, whatever else the role
   shows it (found in phase 5).
4. Back in the room, "check" lists what the agent now sees. The owner marks the project folder and, if there is
   one, a folder that is only read.

The link is refused when the agent turns out to be owner of a folder (`listGrants` answers instead of refusing): an
owner could grant on, and a room must never be able to.

**Only the sources process talks to spaces-files.** It already is the one process that sees repositories; it now
also holds the host key (a file of its own, mode 600). The client is a copy of `spaces-files/client/agent-client.ts`
and, for phase 12, of `client/agent-net-client.ts`, registered as shared copies. The web process asks through entries,
as it does for repositories:

| Entry | Content |
|---|---|
| `RoomLink` | room, tenant, agent ID, the folder that is only read, the project folder, who linked it |
| `FilesRequest` | room, one of `check`, `list`, `preview`, `snapshot`, `upload`, `save`, `load`; for `upload` and `save` the operation ID once it is issued |
| `FilesResult` | the answer, or the refusal with spaces-files' own code |

**Reading: a third kind of source.** `PlanSource.kind` gets `files` beside `docs` and `repo`. When a task is
created, the sources process walks the linked folders with `listPage`. Every file enters the task's index with its
path, size, version and kind, whatever it contains; only the names the repository pack already refuses stay out
(`.env*`, `*.pem`, `*.key`, `auth.json`, …). Text files (valid UTF-8, up to 200 kB each) are copied into the Space in
the form uploaded documents already have (`SourceFile`, `SourceIndex`). The three reading calls (`list`, `read`,
`search`) then work on that copy as on any pack; `list` names the other files too, with their kind and size.

- Proposed limits, each a variable: 400 files in the index, 4 MB of text together, eight levels deep. A folder beyond
  them is refused with the number that was exceeded, never cut silently.
- The page says, where the folder is chosen, that excerpts go to the model providers.
- A revocation in spaces-files stops every later listing, copy and save. A copy already taken stays with its task
  until the task or the room is deleted. The help says this in plain words.

**Files that are not text.** spaces-files stores bytes of any kind up to 16 MiB a file; the forum reads only text
today. What changes:

- **Bringing them.** The Files pane takes uploads: from a phone the camera or the photo library, on a desk a drop
  onto the pane. The room's agent writes the file into `material/` of the project folder; the room's log says which
  person sent it. A file is judged by its first bytes, not by its name. (The spaces-files page itself has no upload
  today; a file can also be put there by an agent or a mount.)
- **Seeing them.** Pictures (JPEG, PNG, WebP, GIF) are shown in the pane and beside the sections that cite them.
  SVG is shown as a picture only, never placed into the page. Everything else is listed with its kind and size and a
  link that opens it in spaces-files.
- **Pictures for the models.** A member adds a picture to a task. The browser then makes a reduced copy (the longer
  side at most 1568 pixels, JPEG; the re-encoding drops the camera's metadata, the place it was taken included) and
  the copy is kept in the Space with the task, as byte pages. Proposed limits: twelve pictures a task, 400 kB each.
  Nothing on the server decodes a picture, so no package is needed for it.
- **One description for the whole table.** Not every model accepts pictures (pi-ai marks those that do: `input`
  includes `image`). Before the kickoff, one model that does describes each picture once (`ImageNote`): what it shows,
  the text in it, what it may mean for the brief. Every model gets the description; those that accept pictures get
  the picture as well. A run on a task with pictures needs at least one such model at the table and is refused with
  that reason otherwise. A person can correct a description, and the corrected one counts.
- **PDF** (decision 12). A PDF's text is taken out when a task is created and copied into the Space like a text
  file, with a mark at every page, so that `read` and `search` work on it and a section can cite "needs.pdf, page
  12". The page shows the PDF in the browser's own viewer. A PDF is hostile input until proven otherwise, so it is
  never opened by a process that holds a key: the sources process fetches the bytes, and the `sandbox` role
  (no network, no files, bounded time and memory for the reader) runs the extraction and hands back text. The
  sandbox process reaches the Space, so the reader is a child apart from it: in user namespaces of its own, or in
  Docker the pdf worker's container without a network beside it (phase 6). Proposed limits: 300
  pages and 2 MB of text a file; a file beyond them is refused with the number. A scanned PDF has no text to take:
  the task says so, names the file like any other binary, and its pages can be added as pictures by a person.
  Reading text out of pictures (OCR) is not part of this plan.
- **Other files** (office files, archives, sound, video): the models learn their name, kind and size and the note a
  person writes about them ("the tender as a spreadsheet, the deadlines are on the second sheet").
- The page says, where a picture is added, that it goes to the model providers.

**A room is a project.** A room already holds up to thirty tasks, each with a document of its own. That becomes the
project's set of documents:

- A task gets a **kind**: *plan* (the seven criteria and the checks of the forum's plan) or *document* (requirements,
  an architecture, a comparison: the person's own criteria and the checks that fit any document).
- A task may name the room's other documents as a source (a fourth kind, `room`): the accepted version, or the
  newest draft marked as such. So the architecture is written against the accepted requirements.
- **People write too.** A member can write or change a section on the page. It becomes a revision like a model's,
  with the person as author, under the same rule: who builds on an older revision is told the newer text.
- **The register of sources.** Every source a task used is an entry of the room (`SourceRef`: kind, address or path,
  title, licence as far as found, who brought it, the sections that cite it). A person adds one by hand with a link
  and a note. A source is discussed like anything else at the table: a new one is a proposal, a model or a person
  may question it (is it current, may it be used, does it say what is claimed), and the vote sets its state:
  proposed, accepted, declined with the reason. Only accepted sources may carry a claim of an accepted document; the
  checker reports the others. The register is saved as `sources.md` with every state.

**Research** (decision 13). When an administrator has switched it on and the room's owner allows it for the room, a
model may ask for a fourth call beside the three reading calls: `web <query>`. It is answered as in codemode-chat
(`server/search.ts`, copied): the titles, addresses and snippets of a result list, at most five; no page is fetched,
so the process cannot be pointed at an internal address. Results are untrusted data in the prompt, each one a model
cites becomes a `SourceRef`, and the searches of a day are bounded for all processes together
(`FORUM_SEARCH_PER_DAY`). A model that names a source it only knows by heart must say so in the register; a person
can open and confirm it.

**Scripts** (decisions 2 and 11). The forum's rule so far was that nothing in it runs code from an entry. That rule
stays for its processes; scripts run elsewhere.

- **What a script is.** A short JavaScript program in the sandbox codemode-chat's judge uses (pi-codemode: QuickJS,
  deterministic, no tool it is not handed). It computes and answers with a value. It is for checking and working out:
  "is this formula for a comet's position right for these elements", "how many rows of the catalogue are brighter
  than magnitude 6", "does this file parse". It is not the app: no script is a module of the product, and no document
  of the room is source code.
- **Who runs one.** A model asks for it in a work item, as it asks for a reading call: `run` with the script's text.
  A member can write and run one on the page. Either way the text is data and never runs in web, agents, model or
  sources.
- **Where it runs.** The agents process writes a `ScriptRequest`; a `sandbox` process takes it, runs it and writes
  the `ScriptResult`: the value or the error, the time used, what it read. The sandbox reaches no network and no
  file. The one thing it is handed is `read(path)` on the task's copied text, so a script can work on the material
  and on nothing else.
- **Outside, like files.** The sandbox is a client of the Space and nothing more, so it is a container of its own
  today and can be a machine of its own or a service someone else runs tomorrow, behind the same two entries. A
  killed sandbox gives its request back when its lease lapses; a script that never ends is cut at its limit.
- **Limits**, proposed, each a variable: two seconds and 32 MB a run, 16 kB of result, three runs a work item, a
  day's bound for all rooms together.
- **What becomes of it.** A run is an entry of the room (`ScriptRun`: text, result, who asked) and shows beside the
  message or section that cites it, with a button to run it again. Scripts cited by an accepted document are saved to
  `scripts/` of the project folder beside the documents.

**Writing: save to the workspace.** A member chooses "save" on a document, or "save all". The sources process writes
each document's Markdown (the export of `server/export.ts`) to `<project folder>/<name>.md` and the register to
`sources.md`.

- A first save uses `expectedVersion` 0, a later one the version the last save returned (`PlanSave`: block, document
  version, path, file version, who).
- If someone changed the file meanwhile, spaces-files answers `versionConflict` and nothing is overwritten. The page
  shows both texts side by side (`client/lib/diff.ts`) and offers: save under a new name, or take the workspace's
  text into the room (the way back, below).
- The operation ID is written into the `FilesRequest` before the call. A sources process that takes the request over
  after a crash sends the same ID, and spaces-files answers from its receipt: one save, one version.

**The way back.** "Load from the workspace" reads a saved document's file. If its version is newer than the last
save, its text becomes a new version of the document, cut into sections at its headings, the generated appendix
removed, the person as author. A run on that block then goes on from the person's text.

## 7. Changes to spaces-files

Kept small, each with its own tests in `spaces-files/tests/`. None changes a stored format.

| Change | Why | Phase |
|---|---|---|
| Signing out also ends the provider's session (`end_session_endpoint` from the discovery document) | "sign out, sign in" must ask again on a shared device | 0 |
| The recovery sign-in demands a fresh login (`max_age=0` with `prompt=login`, `auth_time` checked) | the strongest authority should not ride on an old session | 0 |
| `launch.ts` starts the TLS listener when `FILES_AGENT_NET` is set | documented, never started | 12 |
| A consent page `/link` and an operation by which a person creates an agent that can never hold more than they grant it | linking without a tenant administrator; decision 6 | 11 |
| An operator command that rebinds an actor to a new issuer and subject | big's accounts when it leaves password sign-in; decision 9 | 12 |

Not changed: the browser API, the cookies, the origin check, the rule that no tenant Space is exposed.

## 8. Models and their providers, from the page

**Pi in the background.** Every model call of the forum already goes through pi-ai (`completeSimple`, loaded by the
model process through `spaces/agent/src/live-models.ts`, version 1.6.1 since 2026-11-27). pi-ai also brings what this section needs:
the list of 43 providers, the state of each one's credentials (`checkAuth`), and the login flows
(`Models.login(provider, "api_key" | "oauth", interaction)`), nine of them OAuth. Nothing is added to the
dependencies. pi-durable stays out (decision 10): a work item that reads in steps already survives a crash through its
`ReadStep` entries.

**Where credentials live.** Only in the model process, as today. New is a store of its own:
`fileCredentialStore(path)` in `spaces/agent/src/live-models.ts` implements pi-ai's `CredentialStore` on one file
(`FORUM_AUTH_FILE`, mode 600, in a directory of mode 700, written to a temporary file and renamed; the writes of one
provider serialized). A refreshed token is written back. Environment keys go on working. `~/.pi/agent/auth.json`
(`FORUM_AUTH_SEED`) is read once to fill a store that does not exist yet and never written. In Docker the file is in
the volume `forum-auth`. The providers are loaded whether `FORUM_LLM` is on or not: a login calls no model; the test
call does and needs it.

**A login from the page.** The web process never holds a credential at rest and the Space never holds one in the
clear.

1. An administrator chooses a provider and "add key" or "sign in". The web process writes a `ProviderJob` addressed
   to one model process.
2. The model process takes it, writes the login's state as a `ProviderLogin` it renews while the flow runs (a process
   that dies lets it lapse; the job is gone, so the login is never run again; the page cancels by taking it), starts
   pi-ai's flow and writes what the flow asks or says as `ProviderPrompt` entries:
   a link to open, a device code to type in, a field for a key or for a code to paste. Each prompt that expects a
   secret carries a public key the model process made for this login only.
3. The page shows the prompt. The administrator's answer goes to the web process over HTTPS, is sealed there to that
   public key (X25519, HKDF, AES-256-GCM, all from `node:crypto`; the login, the prompt and the model process as
   additional data, so an answer opens for its own prompt alone) and written as a `ProviderAnswer` with a lease of
   one minute.
4. The model process opens it, hands it to the flow, removes the entry, stores the credential and publishes the
   provider's new state. The private key never leaves its memory. A flow's error message is scrubbed of everything
   typed into the login before it is written back.

A login that needs a browser on the model's own machine falls back to the flow's "paste the code" form, so it works
from a phone. With several model processes a login is addressed to one of them; the page lists each.

| Entry | Content |
|---|---|
| `ProviderInfo` | per model process: each provider, which kinds of login it offers, whether credentials are there and of which kind, never the credential |
| `ProviderJob` | a login, a removal or a test call asked of one model process; taken by it |
| `ProviderLogin`, `ProviderPrompt`, `ProviderAnswer` | one login in progress, as above; leased, gone when it ends (the login's end kept ten minutes) |
| `ProviderResult` | what a removal or a test call came to |
| `AdminAudit` | who did what, when: logins, removals, tests, limits; never a secret |
| `ForumSetting` | one setting an administrator or a room's owner made on the page |

**What the page sets.**

| Who | Setting |
|---|---|
| administrator | credentials per provider (add, replace, remove, **test**: one call of a few tokens that says whether the account answers; the live runs found a dead account only mid-run); the allowed models; calls per minute and day; the budget a person may spend per day; the largest budget of a run |
| room owner | the room's default models (three to five), agents per model, rounds, one table or both, the run budget, how long the table waits for the person |
| member | the models and the budget of one run, within the room's |

**The operator's environment is the ceiling.** A value from the page is used only where it is at or below the
variable the operator set (`FORUM_LLM_PER_DAY`, `FORUM_RUN_BUDGET_TOKENS`, …). The page shows the ceiling beside each
field. What stays in the environment alone: the identity provider, the administrators, the repositories a source may
name, the files connection's address and key.

## 9. What is configurable, and where it is kept

| Kept in | What | Changed by |
|---|---|---|
| the browser (`localStorage`) | language, light or dark, palette, which pane was open | the person |
| `ForumUser` | display name | the person |
| `RoomAccess`, `RoomLink`, `ForumSetting` of a room | members, folders, defaults, budget, answer time, save on acceptance | the room's owner |
| `ForumSetting`, `ForumAdmin` | allowed models, limits within the ceilings | an administrator |
| the model process's credential file | provider credentials | an administrator, through a login |
| the environment | everything that decides whom the system trusts | the operator |

Every change of a setting writes a line a later reader can follow: who, what, when (`ForumLine` of the room, or an
`AdminAudit` entry for the administrator's).

## 10. Phones and tablets

Planned in from the first screen, not fitted afterwards.

| Width | Layout |
|---|---|
| below 760 px | one pane, a bar with Files, Table, Plan at the bottom; the document's sections and the settings' groups open as drawers |
| 760 to 1100 px | two panes: Table and Plan, Files as a drawer |
| above 1100 px | three panes |

- `app/layout.tsx` exports a `viewport` (the device's width, `viewport-fit: cover`); bars keep clear of
  `env(safe-area-inset-*)`.
- The message field stays above the on-screen keyboard (the visual viewport, as `spaces-mmo/client/useShell.ts`
  tracks it).
- Inputs are 16 px so that a phone does not zoom; every target is at least 44 px where the pointer is coarse.
- Tips open on a tap and close on the next; nothing is shown on hover alone.
- A table that is too wide scrolls inside itself; the page never scrolls sideways.
- **The person's turn.** A question to the person holds the run for `FORUM_PERSON_WAIT_S`, 120 seconds by default,
  which someone with a phone in a pocket will miss. The answer time becomes a room setting (up to the operator's
  ceiling), the room list and the tab's title show "waiting for you", and the page asks for the browser's permission
  to notify while it is open. Notifications to a closed page (Web Push) are not part of this plan.
- **Bringing material from a phone.** The upload field opens the camera or the photo library; a photo is reduced in
  the browser before it is added to a task, so a slow connection carries a few hundred kilobytes, not the original
  twice.
- A web app manifest and icons, so the page can be put on the home screen. No offline mode.

**How it is checked.** In the browser at 360, 390, 768 and 1280 px, in both languages and both modes, by a list of
tasks (sign in, link, upload a photo, start, answer a question, write a section, save, resolve a conflict), with screenshots in
`codemode-forum/docs/` (no device data in them); from phase 3 on also on phones against `codeforum.eibrain.org`. What can fail mechanically is tested: every control has a name and a
tip, and no component's style sets a width in pixels above 360.

## 11. Help, from the first phase

Three layers. Each phase delivers its part in both languages in the same commit, and its tests fail otherwise.

**1. Tips on every control.** A "?" beside a field, or a tap on its label, opens two sentences and a link to the
article that explains it. Taken over from codemode-chat (`client/HelpTip.tsx`, `client/lib/tips.ts`); the forum has
none today. A test fails when an input, select or button of the new page has no tip, when a tip lacks a language, or
when its link names no article anchor.

**2. The reader in the page** (`client/HelpApp.tsx`, `client/help/articles.ts`, both exist). New articles, in the
order a newcomer needs them:

| Section | Article | Answers |
|---|---|---|
| Start | What is FORUM? | what it is for, in one screen, with the cycle diagram |
| Start | Your first plan in six steps | the journey of section 1 with the sky app as the example, one step per heading, with what the screen shows |
| Start | Words used here | room, workspace, folder, table, model, brief, version, objection, budget, grant: one sentence each |
| Use | Material: folders and files | what the room reads, what it never sees, what a copy is |
| Use | Photos and other files | taking a photo into a room, what the models make of it, what they cannot read |
| Use | Documents of a project | plan and further documents, writing a section yourself, the project folder |
| Use | Scripts: letting the table check something | what a script is and is not, reading its result, running one yourself |
| Use | Sources and research | the register, adding a source by hand, what a model looked up and what it only claims |
| Use | The table: how models work it out | questions, proposals, votes, what you can say and when you are asked |
| Use | The plan: versions, accept, save | reading a version, objecting, saving, what a conflict is and what to do |
| Use | On the phone | the three tabs, answering in time, the home screen |
| Understand | Who sees what | the access diagram in words; revoking |
| Understand | What leaves this system | excerpts and prompts to model providers; what is stored where |
| Understand | How it hangs together | the overview diagram, for the curious |
| Configure | Signing in | one account, signing out, a second factor |
| Configure | Models and providers | adding a key, signing in, testing, choosing models |
| Configure | Budgets and limits | what a run costs, the ceilings, per room and per person |
| Operate | For the operator | processes, variables, the files connection, backups |

Rules for the text, checked in review, the first two by a test:

- both languages, the same headings and anchors (the test of `tests/help.test.ts`, extended);
- no word from "Words used here" before its entry is linked once in the article;
- every article opens with what the reader can do afterwards, and is no longer than two screens on a phone;
- one idea per paragraph, the person addressed directly, no name of a file, process or entry outside *Operate* and
  *How it hangs together*.

**3. The help site.** FORUM becomes an entry of `help-site/` like the six applications there (the pattern of
commit `415a817`): an introduction, an article `help.topic.forum_page` in both languages in the corpus seeds, the
catalogue entry and the counts in `tests/help-consistency.test.ts`.

**Diagrams.** Drawn as the repository's are: Graphviz sources in `docs/img/src/` with the shared `style.inc`, rendered
to SVG by hand with the command in that file (Graphviz is a program on the developer's machine, not a dependency).

| Diagram | Shows | Exists |
|---|---|---|
| `forum-journey` | the six steps as a cycle | drawn with this plan |
| `forum-access` | who may see what; the grant and the copy | drawn with this plan |
| `forum-overview` | what runs where | drawn with this plan |
| `forum-table` | how the models reach a decision: kickoff, drafts, review, votes, acceptance | phase 2 |
| `forum-signin` | one account, two applications | phase 1 |
| `forum-conflict` | two people changed the same file: what happens, what to choose | phase 7 |

- Each diagram in English and German (`<name>.svg`, `<name>-de.svg`), from one source with its labels in a file per
  language.
- In the page they are served from `codemode-forum/public/help/img/`, copies held equal to `docs/img/` by
  `checks/shared-copies.test.mjs`, like the six of spaces-files in the help site. The forum's renderer already turns
  an image line into a figure; its style sheet gets the rule that puts a figure on a light card in both modes.
- A diagram never carries what the text does not also say; its alternative text is the caption in that language.

## 12. Safety

| Danger | What is done |
|---|---|
| A room shows a workspace's text to someone who should not see it | linked rooms need sign-in and are private; one agent per room; the folder owner's grant is explicit and revocable; a room whose agent is owner of a folder is refused |
| The forum is used to reach folders nobody granted | spaces-files decides on every call; the forum holds no right of its own beyond its rooms' grants |
| A provider's key leaks through the Space, a backup or a log | sealed to a key that lives only in the model process's memory; a one-minute lease; a test searches the store's file for the key's bytes |
| Text from a file or a model steers the page or the models | marked as data in every prompt; the page escapes it (`client/lib/safe-markdown.ts`) |
| Material reaches a model provider unnoticed | said where a folder is chosen and in the help; only an owner can grant; the page lists the providers of the room's models before a run |
| A file is not what its name says, or a picture carries more than it shows | kinds are judged by content; SVG is never placed into the page; nothing on the server decodes a picture; the copy for the models is re-encoded in the browser and carries no camera metadata |
| A search is used to reach an internal address, or its results steer the models | only the result list of one search address is read, no page is fetched; results are data in the prompt; searches are bounded per day and switched on by an administrator |
| A script from a model or a person does harm | it runs only in the sandbox: QuickJS without tools, no network, no file, read-only container, bounded time and memory; its result is data; the other processes cannot load the sandbox |
| A saved plan overwrites a person's work | `expectedVersion` on every save; a conflict writes nothing |
| A stolen session | `__Host-` cookie, `Strict`, CSRF header, one hour idle; the provider's second factor |
| A personal subscription serves strangers | decision 5: off unless the operator turns it on |
| Money | a budget for every run, per room and per person a day, under the operator's ceilings; a provider can be tested before a run |
| The copied files drift from their originals | registered in `checks/shared-copies.test.mjs`: `oidc.ts`, the two files clients, `search.ts`, the diagrams |

## 13. On big and nano

The person allowed testing on the servers where it makes sense (2026-11-26). It makes sense from the moment the
page asks for sign-in: phones need a public HTTPS address to be tested honestly, and the identity provider needs its
final name before the first account. So the forum goes to the servers in phase 3, early, with the models off.

| What | Where | How |
|---|---|---|
| The page | `https://codeforum.eibrain.org` | nginx on big as for the other sites (the pattern of `spaces-files/docker/nginx-spaces-files.conf`): a site file listening on `[2a0a:4cc0:c0:62f2:8000::1002]:443`, the certificate from certbot (webroot), proxy to the web container on `127.0.0.1:4100` with the upgrade headers for the WebSocket. The file is kept in the repository as `codemode-forum/docker/nginx-codeforum.conf` |
| DNS | the name already resolves through the proxy in front of the other sites | to be checked in phase 3: that its record points at the address above and that the address is on big's interface; if not, the record is the person's to set |
| web, agents, model, sources | big | `npm --prefix codemode-forum run docker:big:up`, on the host network (`docker/docker-compose.hostnet.yml`) as codemode-chat's on big |
| space, checker | nano | `docker:nano:rust:up` with `forum-space` (big and nano run only the Rust space server, R-D12), published on loopback and reached from big through a user unit `forum-nano-tunnel`, as codemode-chat's is |
| The identity provider | `https://id.eibrain.org`: only the name exists (the person, 2026-11-26) | an nginx site on big like the page's (`idp/nginx-id.conf`, certbot), proxy to Keycloak on a loopback port; only `/realms/` and `/resources/` are passed on, the admin console is reached through an ssh tunnel to the loopback port alone; the bare name leads to realm phi's account page. Keycloak and its database in a compose project of their own, the database dump in the daily backup to nano. Its origin address is the person's to name, as `…::1002` is for the page |
| sandbox, pdf | nano, beside the checker | the sandbox reaches the Space and opens no PDF; the pdf worker beside it has no network and shares only a socket's volume with it (phase 6; scripts phase 10) |
| Model credentials | big, the model container | until phase 4 the mounted pi login as today; from phase 4 the credential file in a volume of its own |
| Backups | nano and big | `codemode-forum/deploy/forum-backup.sh` on a daily timer on both: the store's copy on nano, Keycloak's dump on big, each host holding both in `~/phi-backup/forum` |

Rules on the servers:

- `FORUM_LOGIN=oidc` from the first start. Without a session the page shows the sign-in and nothing else.
- `FORUM_LLM` stays off until phase 4 has put budgets per person and the provider test on the page.
- Only the forum's own compose projects and its nginx site are touched. Anything that stops, restarts or rebuilds a
  container of another application there is asked about first, as before.
- Each deployment is `git pull --ff-only` on the server and the script of that host. Before the first one, the
  session says which containers it starts and on which ports.
- spaces-files on big keeps its password sign-in until phase 12. Until then the join with files is tested on this
  machine, and the forum on the servers runs with uploaded documents and repositories as sources.

## 14. Phases

Each phase is tested with fake models, keeps both applications runnable and is one commit. Its help (tips,
articles, diagrams) is part of it. Checks after each: `npm --prefix codemode-forum run typecheck`,
`npm run test:codemode-forum`, root `npm run typecheck` and `npm test`; where spaces-files changes,
`npm --prefix spaces-files run typecheck` and `npm run test:spaces-files`; where `live-models.ts` changes,
`npm run typecheck:agent` and `npm run test:agent`. From phase 3 on, a phase that changes the page is also deployed
to the servers and its task list is gone through on a phone there.

Tests that need spaces-files start it as a process (`FILES_MEM=1`) with its development identity provider, as
codemode-chat's bot tasks start the arena of spaces-mmo. No application imports another.

| Phase | Content | Exit evidence |
|---|---|---|
| 0 ✓ | Keycloak in Docker on this machine (a compose project of its own, loopback): one realm, a client for each application. spaces-files runs against it. In spaces-files: sign-out at the provider, fresh login for recovery (section 7). A note of what Keycloak needed: `idp/README.md` (the realm is `phi`; `prompt=login` beside `max_age=0`; Keycloak asks to confirm a sign-out). | spaces-files' suite passes unchanged against its development provider, with new cases for both changes; by hand against Keycloak: sign in, the tenant choice, sign out and in again asks for the password |
| 1 ✓ | Sign-in, people and rooms in the forum (section 5): `oidc.ts`, sessions, `ForumUser`, `RoomAccess`, every route and the WebSocket checked, administrators by identity, limits per person. The help's base: tips, "Words used here", "Signing in", the sign-in diagram, the extended help test. The registrations (`checks/shared-copies.test.mjs`, `AGENTS.md`). | every route refused without a session and with too low a role; a session that expires; two people who do not see each other's rooms; a request from another origin; without `FORUM_LOGIN` the present suite passes unchanged. Done: `codemode-forum/tests/auth.test.ts` (the session's end by its twelve hours with a shifted clock; the hour of idleness is the session entry's lease in the Space, not waited for in a test) and `tests/help.test.ts` (the words linked where they first appear, the diagrams in both languages, every tip used and linked); the walk through a real browser against Keycloak is still to be done by hand |
| 2 ✓ | The page (sections 4 and 10): the four places, three panes and their phone form, tokens, states, routes, the manifest; task, run, table and document moved in; `/expert` keeps the present page. Articles of *Start* and *Use* that need no workspace; the table diagram. | the task list at four widths, both languages and modes, with screenshots; names and tips on every control; the present suite passes. Done: `client/forum/` (rooms `/`, a room `/r/<room>`, `/settings`; the controls with label and tip in `controls.tsx`), the panes shared with `/expert` in `client/panes.tsx` and `client/lib/use-room.ts`, `client/styles/page.css`, the manifest and icon; the rooms' states in `GET /api/rooms` (`ForumHub.summary`: "waiting for you" while a run is stuck or a question to the person is open, also after the run), the waiting count in the bar and the tab's title, a notification from the open page (permission asked when a run is started), the bar at the bottom giving way to the keyboard; articles "What is FORUM?", "Your first plan in six steps", "The table", "The plan", "On the phone", the `forum-table` diagram. `tests/page.test.ts` (every control a wrapper with label and tip, no width above 360 px, routes, manifest, viewport), the rooms' states in `tests/auth.test.ts`, `forum.test.ts` and `talk.test.ts`; screenshots in `codemode-forum/docs/screenshots/` by `codemode-forum/tests/screenshots.ts` (fake models, Keycloak on loopback, headless Chromium: sign in, start a run with both tables, a question waiting, at 360, 390, 768 and 1280 px, German and English, light and dark, no sideways scroll, no error of the page, sign out). Moved: the answer time as a room setting to phase 4 (with `ForumSetting` and its ceilings); the tasks link, upload a photo, write a section, save and resolve a conflict to the phases that bring them (5, 6, 7); the document's sections and the settings' groups are folds and cards, not drawers; the German `forum-journey` with "Your first plan" in phase 13 |
| 3 ✓ | On the servers (section 13): Keycloak under its final name, the forum on big and nano, the nginx site of `codeforum.eibrain.org`, the tunnel, the backup timer; models off. The operator's article. | sign-in from outside; nothing but the sign-in without a session; a room and a walk through the page on a phone; the space on nano survives a restart of big's containers; a backup restored on this machine. **On the servers 2026-11-27**: sign-in from outside through Cloudflare (account `jeamy`, a test account; bootstrap admin kept until going live), without a session `/api/*` answers 401 and the page shows the sign-in only, the admin console and realm master 404 from outside; a room `golomb2026` made; big's four containers recreated while nano's space ran on; nano's backup restored on this machine with the room and the person in it. The walk on a phone: done by the person on 2026-11-27 ("looks fine on the phone"). The walk in Chrome on a desk the same day: sign-in through the provider's session, the rooms, a room with its three panes, the settings with the providers and limits, the help, sign-out confirmed at the provider and back to the sign-in; the sign-in card stood at the left edge (layout.css gives every `main` the expert page's two columns), fixed. Found on the way: Cloudflare rejected OpenSSL 3.5's HelloRetryRequest for X25519MLKEM768 (525 on fresh origin connections to every site on big), fixed by `ssl_ecdh_curve X25519MLKEM768:X25519:prime256v1:secp384r1;` in big's nginx.conf; the admin panel named no administrator with a sign-in (fixed in 74d5e62) |
| 4 ✓ | Models and providers from the page (section 8): the credential store, `ProviderInfo`, logins through sealed entries, the test call, `ForumSetting` with the ceilings, room defaults. Articles "Models and providers", "Budgets and limits". | a fake provider with every kind of prompt; the key's bytes are nowhere in the store's file; a model process killed during a login; a refreshed token survives a restart; a value above a ceiling is refused; a member refused. Done: `fileCredentialStore`/`fileModels` in `spaces/agent/src/live-models.ts` (`spaces/agent/test/credential-store.test.ts`); `server/seal.ts`, `server/providers.ts` (the web side), `server/provider-host.ts` (the model side), `server/settings.ts` (`ForumSetting`: the limits and a room's defaults, each checked against the environment's ceilings and clamped again on use), the answer time per room in `run.ts`; the page's Settings for administrators (`client/forum/AdminPlace.tsx`: providers per model process, the login box, allowed models, limits) and a room's defaults for its owner (`RoomPlace.tsx`); the credential file in the volume `forum-auth` in Docker. `tests/providers.test.ts` with the provider of `tests/providers.ts` (a key login with a choice, a text and a secret, no byte of the key in the Space's database, its WAL or shared memory; a wrong key scrubbed from the message; the test call and its spend; removal; the audit; a sign-in with a link, a device code and a pasted code whose refreshed token is in the file after a restart; a model process killed during a login: the login lapses and is not run again; a cancel), the refusals for a member and above a ceiling in `tests/auth.test.ts` |
| 5 ✓ | The files connection, reading text (section 6): the client copy, the sources process as agent host over the unix socket, `RoomLink`, check and link, the `files` source with every file in its index, the Files pane. Articles "Material", "Who sees what", "What leaves this system"; the access diagram in German. | a room reads granted folders and nothing beside them; an owner agent is refused; each limit at its edge; denied names not offered, other kinds listed; a revocation stops the next copy and leaves the taken one; a sources process killed with a request taken; a run whose writer reads the copy. Done: `codemode-forum/server/files.ts` (limits, kinds by content, the walk, `RoomLink`, `FilesRequest`/`FilesResult` from the web side), the sources process's files worker (`server/source-host.ts`: `check`, `snapshot`; the copy written in parts outside the transaction under a copy ID of its own, since a transaction holds at most 192 kB, an attempt cut off removed by the next, a walk that lost its lease writes nothing more), `server/files-client.ts` (a registered copy of spaces-files' agent client), `PlanSource.kind` `files` with `reference/` and `project/` in the pack and the index carrying kind and version, the routes `/api/rooms/<room>/link` and `/files/<block>`; the page: the room's Workspace fold for its owner (steps, the two folders, check, link, unlink), the tick on a new task, the copy's files in the Files pane; articles "Material from the files", "Who sees what" (the access diagram in German, its labels in `docs/img/src/forum-access.*.sed`), "What leaves this system". `codemode-forum/tests/files.test.ts` against a real spaces-files (`spaces-files/tests/support/agent-host-fixture.ts` as a process): link refused before the agent is registered, for its own home, a workspace it owns and one it was not granted; the copy holds both folders and nothing beside them, a key file left out, a picture named `.txt` listed as png; a run's writer lists, reads, is told a jpeg's kind and searches the copy; a revocation fails the next copy and the taken one is still read; a sources process killed after the first part: the second copy alone is there; each limit at its edge with a reader in memory; the refusals for a member and a viewer in `tests/auth.test.ts`. Also on the Rust space. Found on the way: the room page without a sign-in waited for a room list it never loads (fixed) |
| 6 ✓ | Pictures and other files (section 6, *Files that are not text*): upload through the room's agent, kinds by content, pictures in the pane, the reduced copy from the browser as byte pages, `ImageNote`, pictures in the model call, PDF text with page marks through pdfjs-dist in the sandbox container (the `sandbox` role starts here with this one job; scripts follow in phase 10), notes on other files. Article "Photos and other files". | an upload retried after a lost reply is one file; a file whose name lies about its kind; a picture over a limit; a run without a model that accepts pictures is refused; the description reaches every model and the picture only those that take it; a corrected description counts; a reduced copy holds no camera metadata; a PDF's text is found by `search` with its page; a scanned PDF, a broken one, an encrypted one and one over a limit each say what they are; the extraction cannot reach the network or a file. Done: pictures of a task (`codemode-forum/server/images.ts`): the browser reduces a photo to a JPEG of at most 1568 px a side and 400 kB, turned upright and drawn anew, so nothing of the camera is kept (`client/lib/pictures.ts`); the server takes only such a JPEG, walks its segments and refuses Exif, XMP, comments and any other block, at most 12 a task, the bytes in parts outside the transaction and the `TaskImage` last, one picture however often the same ID is sent. Before the first round the first model at the table that takes pictures describes each (`describe` work items, `ImageNote`); a person corrects a description on the page, the newest counts; every prompt names the descriptions as data, the pictures are attached only for models whose `input` has `image` (ModelInfo `images`); a run with pictures and no such model is refused. Uploads into the project folder's `material/` through the room's agent (`upload` in `FilesRequest`: the name and the operation ID are written back before the write, so a sources process that dies after spaces-files wrote the file sends the same write again and gets its receipt; a taken name gets a number; denied names refused; kinds by content); pictures of the workspace shown as pictures (`preview`, an SVG only under a sandboxing content security policy); a note on a file without text (`FileNote`) reaches the models in `list` and `read`. PDFs: the `sandbox` role (`server/sandbox-host.ts`) takes `PdfRequest`s and hands each to a child that runs `server/pdf-extract.ts` (pdfjs-dist 6.5.438, no fonts, no XFA, no image decoder, no fetch; Node's permission model reads the extractor and pdfjs only; bounded heap and time). Here the child runs in user namespaces of its own (no network, the Space's socket covered); in Docker, where a container makes no namespaces, the sandbox hands the PDF over a socket in a shared volume to the pdf worker (`server/pdf-worker.ts`), a container of its own on nano with no network, no `.env` and a read-only file system, which refuses to start where it sees an interface besides loopback. The text with `--- page N ---` marks is readable in the copy and `search` names the page; a scanned, an encrypted, a broken PDF and one over the page or size limit are named as such; without a sandbox none is opened. Article "Photos and other files" (DE, EN). Evidence: `codemode-forum/tests/images.test.ts` (the segment checks, a picture with Exif, a comment, a PNG, 1569 px, over 400 kB refused; the same ID twice is one picture; a run with three models that take none refused; the description by the first that takes pictures, attached for it alone, the descriptions in every prompt, a corrected one in the next run; the limit of 12) and `tests/workspace-files.test.ts` against a real spaces-files (an upload sent again; one whose sources process was killed after the write is one file at version 1; a taken name; a PNG named `.txt`; `.env` refused; a revoked editor refused; every PDF kind with and without a sandbox; the page in a search hit; previews; a file note in the prompt; the child of the isolation probe gets `ERR_ACCESS_DENIED` for a file of the forum, no Space socket and no network; the pdf worker over its socket). Also on the Rust space. Not done and moved: pictures beside the sections that cite them (phase 7, with `SourceRef`), a PDF of the workspace in the browser's own viewer (phase 7; Chrome shows no PDF under the sandboxing policy the previews carry), and a link into spaces-files at a file (its page has no file addresses; `FORUM_FILES_PAGE` names the page only) |
| 7 ✓ | The room as a project, and saving (section 6): kinds of task, pictures beside the sections that cite them (from phase 6), the room's documents as a source, sections written by people, `SourceRef` and the register, `PlanSave`, save one and save all, the operation ID in the request, the conflict view, save on acceptance as a room setting. Articles "The plan", "Documents of a project"; the conflict diagram. | a person's section and a model's on the same base: the second is told the newer text; a document written against another's accepted version; a lost reply and a retry give one file version; a conflict writes nothing and shows both; a revoked editor is refused and said so; a process killed between the ID and the write. Done: kinds of task (`codemode-forum/server/plantask.ts`: `kind` `document` with a `name`, three `DOCUMENT_CRITERIA` and the person's; `server/calls.ts` speaks of a document in every prompt and leaves the phase rule out, `server/checks.ts` skips the phase check); the room's documents as a source (`room`: each referenced task's export as it stands at creation, the accepted version or the newest draft said so, copied as a source of its own under a copy ID and read with the `room:` calls); sections written by people (`POST /api/rooms/<room>/section`, a revision with the person as author and `model` `human`; a stale base answered 409 with the newer text, the page shows both and offers "save anyway" and "take theirs"; a model's revision that comes second is retried with the person's text); `PlanSave` and saving (`save` in `FilesRequest`: the export fixed once under the save ID as upload parts, the operation ID written back before the write, against the file version of the block's last save; a conflict writes nothing and comes back with the workspace's text, a removed file as such, a refusal in words); save one, save all with the register as `sources.md`, the conflict view (`client/forum/SaveDocs.tsx`); `saveOnAccept` as a room default (each acceptance saved as `acc-<block>-<table>-<version>`); `SourceRef` and the register (`codemode-forum/server/register.ts`: every source a task reads proposed at creation, one entry per source however many tasks read it, a link added by hand, accepted or declined with the reason by a member, each word a line of the room; the sections that cite a source worked out from the documents as they stand, by the writers' conventions; `client/forum/Register.tsx`); pictures beside the sections that name them in backticks (the prompts say so, the checker takes a picture's name as a known file). Articles "The plan" (writing yourself, pictures) and "Documents of a project" (DE, EN), the conflict diagram (`docs/img/src/forum-conflict.*`). Evidence: `codemode-forum/tests/people.test.ts` (a person writes while a model's revision waits: the model is asked again with her text; a person after a model gets 409 with its text, then writes against it), `tests/kinds.test.ts` (a document's criteria and words, a plan's; a document written against another's accepted version 3, a draft 4 and a later accepted 5 not read), `tests/save.test.ts` against a real spaces-files (the same ID again is the same save; a sources process killed after drawing the ID and one killed after the write each leave one version; a file changed in the workspace and one removed come back with both texts and nothing written; a new name; a revoked editor refused in words; save on acceptance), `tests/register.test.ts` (proposed once, cites, a link twice one entry, a decline without reason refused, `sources.md` sent again after a change of the register is the first file version, a second save version 2). Also on the Rust space. Not done and moved: a table vote on a source and the checker's report on claims resting on a source not accepted (phase 9, with research, where sources come from the models); a PDF of the workspace in the browser's own viewer (phase 8: the preview carries pictures only, a PDF needs the sources process to hand it out as a download); a link into spaces-files at a file (needs file addresses on the spaces-files page, a change there; not before it is asked for) |
| 8 ✓ | The way back: loading a saved document's file as a new version. From phase 7: a PDF of the workspace offered as a download in the Files pane. | sections matched by heading; the appendix removed; an unchanged file loads nothing; a file too large is refused; a run goes on from the person's text. Done: "Load from the workspace" (`codemode-forum/server/hub.ts` `load`, `POST /api/rooms/<room>/load/<block>`): the file of the block's last save read through the room's agent (`preview` with `want: "text"`); a file version no newer than the last save's loads nothing; a newer one is cut at its `## ` headings (`parseSaved` in `server/export.ts`: the title line and the generated appendix left out, a heading inside a fence kept as text, text before the first heading a section of its own), each section matched to the one of the same title (changed ones revised against the revision read, new ones placed after the section before them, missing ones removed), written as one version with the person as author, and a `PlanSave` of the loaded file version so the next save writes on top of it; a file over 192 kB, a section over its limit and a document over its limits are refused in words; a section revised meanwhile asks to load again. The conflict view offers it ("Take the workspace's text into the room"). A PDF of the linked folders as a download in the Files pane (`GET /api/rooms/<room>/download`: `application/pdf` as an attachment under a sandboxing policy, any other kind refused), so the browser's own viewer opens it. Article "Documents of a project" (section *Loading from the workspace*), the conflict diagram with the third choice. Evidence: `codemode-forum/tests/loadback.test.ts` against a real spaces-files (never saved: refused; unchanged: nothing; an edited file with a changed, an added and a removed section and its appendix gives version 2 with the person's sections and the model's untouched one; loaded again: nothing; the next save version 3 with no conflict; 200 kB and a 30 kB section refused; a PDF downloaded, a text refused; a file loaded and a run at table A whose calls carry its text) and `parseSaved` on its own. Also on the Rust space. |
| 9 | Research (section 6, decision 13): the `web` call, its switch for administrator and room, the day's bound, results into the register. From phase 7: a source questioned and voted on at the table, and the checker's report on claims of an accepted document resting on a source not accepted. Article "Sources and research". | a search refused when switched off and when the day is used up; results marked as data in the prompt; a cited result is in the register with who found it; no request leaves for anything but the search address |
| 10 | Scripts (section 6, decisions 2 and 11): the `run` call, `ScriptRequest`, `ScriptResult`, `ScriptRun`, the `sandbox` role with pi-codemode, its container without network, running and re-running on the page, scripts saved with the documents. Article "Scripts: letting the table check something". | a script that loops is cut at its limit; one that asks for the network, a file or a tool it was not handed gets nothing; `read` reaches the task's copy and no other task's; a killed sandbox gives the request back; the result is data in the next prompt; none of the other four processes can load the sandbox module |
| 11 | Linking without an administrator (section 7, decision 6): the consent page in spaces-files and its operation. Dropped if decided against. | a person without the folder's ownership cannot grant it; the agent never holds more than was granted; a refused consent leaves nothing behind |
| 12 | The join on the servers: `FILES_AGENT_NET` started by the launcher, the forum's sources container as a TLS agent host, spaces-files on big moved from passwords to the provider with the rebind command (decision 9). | on this machine first, both local test beds joined; then on big: a room linked to a folder there, an upload from a phone, a saved plan, a revocation |
| 13 | Acceptance with the sky brief of section 1 and the help site: the remaining articles, `help.topic.forum_page` with its diagrams, the README. Someone who has not seen the page takes the brief from a phone with the help alone: material and a photo of a sketch, the plan, requirements, an architecture and the register, saved to the project folder. | live, costs tokens: ask first. The help site's corpus checks; the project folder with its files; the register names an accepted source for stars, comets, asteroids, constellation lines and Messier objects, each opened and confirmed by a person; at least one script checked a computation the plan relies on; the list of where that person got stuck, each point mended or noted |

Phases 4 and 5 are independent after phase 3. Phase 8 needs 7; phases 9 and 10 need only 4. Phases 0 to 2 and 5 to 11
run on this machine; 3, 12 and 13 also on the servers.

## 15. Risks

| Risk | What is done about it |
|---|---|
| The forum has never run on a server, and this plan adds sign-in to it | phase 1 keeps the present behaviour behind `FORUM_LOGIN`; phase 3 puts it on a server with sign-in required for everything and the models off |
| Three manual steps to link a room put people off | the page leads through them and checks the result; phase 11 removes two of them |
| A copy of the material is stale by the time the run ends | the task shows each file's version and when the copy was taken; a new task copies anew |
| A run cannot agree in three rounds (the live runs' finding) | not this plan's to solve; the page shows the open objections and lets the person accept, object or stop |
| The provider's issuer or a realm's name is changed later | fixed before the first account (decision 3); the operator's article says why |
| The page grows two faces, the new one and `/expert` | `/expert` gets no new function; it is removed once the new page shows the standings |
| Help falls behind the page | the tip and anchor tests fail the phase; an article is part of the commit that needs it |
| pi-ai's login flows change with a new version | pinned at 1.5.2; the fake provider of phase 4 covers every prompt kind the interface names |

## 16. Not part of this plan

- carrying a plan out, and with it writing the app's source code: scripts that check something are allowed, code of
  the product is not;
- editing a workspace's text files on this page: the Files pane lists, previews and uploads, and links to spaces-files
  for the rest;
- reading office files, reading text out of pictures or scanned pages (OCR), and fetching web pages;
- notifications to a closed page;
- the two additions the forum's plan proposes and has not decided (its sections 15 and 16, the archive repository and
  the map of the decision process); the page leaves a place for the map in the Plan pane;
- any change to codemode-chat, spaces-mmo or the library;
- touching another application's containers on big or nano without asking.

![What runs where: the person reaches the forum's web process over HTTPS and WebSocket, signs in at the identity provider and grants folders to the room in spaces-files. Web, agents, model, sources and the sandbox that runs scripts talk only through the forum's one Space; the sandbox has no network and no files. The model process calls the model providers; the sources process reaches the filesystem service of spaces-files as the room's agent to list, read and write.](img/forum-overview.svg)
