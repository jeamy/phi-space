# Planraum: a folder becomes an agreed plan, on one page (plan, 2026-11-26)

Status: proposed on 2026-11-26, nothing built. The decisions of section 2 are open until the person confirms them.
Starting point: `codemode-forum/` (phases 0 to 11 of `docs/gemeinsame-planung-plan-2026-11-22.en.md`) and
`spaces-files/` (phases 1 to 5 of `docs/zanzibar-agent-filesystem-plan.en.md` and what followed) as of commit
`20ec683` on master.

## 1. Goal

One page on which a team turns the material in a folder into a plan that several models have worked out and agreed
on, and gets that plan back as a file in the same workspace.

1. A person signs in once.
2. They open a room and link it to a folder of a spaces-files workspace: one folder to read from, one to write to.
3. They write a brief, choose models and a budget, and start.
4. The models read the material, ask, propose, object and vote. The person answers questions and may accept or
   object at any time.
5. The plan is saved as a file in the workspace, with a version, the workspace's rights and its audit.
6. People edit the file with their own rights. The next run reads it again.

![The six steps as a cycle: material in a workspace folder, the brief, the table where the models discuss, the plan with its versions, the file in the workspace, people editing it, and the next run reading it again. The person answers questions at the table and accepts or objects to the plan.](img/planraum-journey.svg)

The page must work on a phone as well as on a desk, everything a person or an administrator sets must be settable on
the page, and the help is part of every phase, written for people who know neither application.

"Planraum" is a working title (section 2, decision 2).

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

**To be decided, with a recommendation each.** Nothing is built before decisions 1, 3, 4 and 6 are taken.

| # | Question | Recommendation |
|---|---|---|
| 1 | Where does the page live: inside `codemode-forum/` or in a sixth application? | Inside `codemode-forum/`. The page's server must follow the forum's Space (`server/hub.ts`) anyway; a separate application would build that hub a second time. The present page stays reachable as the expert view (`/expert`). |
| 2 | The name on the page | "Planraum" in both languages until a better one is found; the directory and the `FORUM_` prefix stay. |
| 3 | Which identity provider | Keycloak in Docker, one realm for both applications, issuer on a host name of its own (`id.<domain>`), fixed before the first account. NetBird's built-in provider cannot register a further client and is not used. |
| 4 | "Sign-in of the providers": this plan reads it as the credentials of the **model** providers (API keys, OAuth logins). | As read. The identity provider itself is the root of trust and stays in the operator's environment; the page shows it and cannot change it. |
| 5 | OAuth logins of personal subscriptions (a chat subscription used as a model account) on a deployment several people use | Off unless the operator sets `FORUM_SUBSCRIPTION_LOGIN=1`. Such subscriptions are sold for their holder's own use; whether a provider's terms allow more is for the operator to check. API keys are always offered. |
| 6 | Who creates the room's agent in spaces-files (only a tenant administrator may register an actor today) | First the tenant administrator, on the spaces-files page, with no change there (phases 4 to 6). A consent page in spaces-files with a narrow new operation follows as phase 7 and is decided then. |
| 7 | Is workspace material read live during a run, or copied when a task is created? | Copied. spaces-files keeps no old versions, and the forum's checks quote lines that must not move under them. |
| 8 | Is the plan saved by a person's click or by itself? | By a click. Saving on acceptance becomes a room setting in phase 5, off by default. |
| 9 | The accounts on big when spaces-files changes from password sign-in to the provider | An operator command that rebinds an actor to a new issuer and subject, audited. Decided before phase 9, not needed locally. |
| 10 | Does the forum get the durable agent (pi-durable) with this work? | No. Nothing here needs it; the forum plan's own condition (its section 14) stays. |

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
  never calls it. Agent hosts over TLS work only in the tests. Phase 9 needs it; phases 4 to 6 use the unix socket.
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
┌ Planraum › Project X ───────────── ? ─ ☰ ┐            ┌ Project X ─────── ? ☰ ┐
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

![Who may see what: the folder owner in spaces-files grants the room's agent viewer on the source folder and editor on the target folder and can revoke both at any time. The agent reads the source folder and writes plan.md into the target folder; everything else in the workspace is never visible to the room. A copy of the material is taken when a task is created; room members see it, and excerpts of it go to the model providers in prompts.](img/planraum-access.svg)

**The room's agent.** The forum is one enrolled agent host of spaces-files (`operator enroll-host`). Each linked
room is one agent actor there: host peer of the forum, agent ID `room-<id>`. The agent has only what an owner in
spaces-files grants it: `viewer` on the folder to read from, `editor` on the folder to write to. That grant is the
consent. It is in spaces-files' audit and can be revoked there at any time.

Why one actor per room and not one for the whole forum: with a single actor, a task in one room could name a folder
that was granted for another. The forum cannot ask spaces-files what a person may see, so the rights must already be
separate where spaces-files checks them.

**Linking a room** (phases 4 to 6, no change to spaces-files):

1. The room's owner chooses "link a workspace". The page shows the agent's ID and the three steps.
2. A tenant administrator registers that agent on the spaces-files page, with the forum's host peer and the agent's
   ID (the page offers the peer as a choice once the host is enrolled with a key; with a unix socket alone it is
   typed in).
3. An owner of the folders grants `viewer` and `editor` there.
4. Back in the room, "check" lists what the agent now sees. The owner marks one folder as source and one as target.

The link is refused when the agent turns out to be owner of a folder (`listGrants` answers instead of refusing): an
owner could grant on, and a room must never be able to.

**Only the sources process talks to spaces-files.** It already is the one process that sees repositories; it now
also holds the host key (a file of its own, mode 600). The client is a copy of `spaces-files/client/agent-client.ts`
and, for phase 9, of `client/agent-net-client.ts`, registered as shared copies. The web process asks through entries,
as it does for repositories:

| Entry | Content |
|---|---|
| `RoomLink` | room, tenant, agent ID, source folder, target folder, who linked it |
| `FilesRequest` | room, one of `check`, `list`, `preview`, `snapshot`, `save`, `load`; for `save` the operation ID once it is issued |
| `FilesResult` | the answer, or the refusal with spaces-files' own code |

**Reading: a third kind of source.** `PlanSource.kind` gets `files` beside `docs` and `repo`. When a task is
created, the sources process walks the source folder with `listPage` and copies its text files into the Space, in the
form uploaded documents already have (`SourceFile`, `SourceIndex`), with each file's path, size and version. The three
reading calls (`list`, `read`, `search`) then work on that copy as on any pack.

- Offered: files that are valid UTF-8, up to 200 kB each. Not offered: binary files, and the names the repository
  pack already refuses (`.env*`, `*.pem`, `*.key`, `auth.json`, …).
- Proposed limits, each a variable: 200 files, 4 MB together, eight levels deep. A folder beyond them is refused with
  the number that was exceeded, never cut silently.
- The page says, where the folder is chosen, that excerpts go to the model providers.
- A revocation in spaces-files stops every later listing, copy and save. A copy already taken stays with its task
  until the task or the room is deleted. The help says this in plain words.

**Writing: save to the workspace.** A member chooses "save". The sources process writes the plan's Markdown (the
export of `server/export.ts`) to `<target>/<name>.md`.

- A first save uses `expectedVersion` 0, a later one the version the last save returned (`PlanSave`: block, document
  version, path, file version, who).
- If someone changed the file meanwhile, spaces-files answers `versionConflict` and nothing is overwritten. The page
  shows both texts side by side (`client/lib/diff.ts`) and offers: save under a new name, or take the workspace's
  text into the room (phase 6).
- The operation ID is written into the `FilesRequest` before the call. A sources process that takes the request over
  after a crash sends the same ID, and spaces-files answers from its receipt: one save, one version.

**The way back** (phase 6). "Load from the workspace" reads the target file. If its version is newer than the last
save, its text becomes a new version of the document, cut into sections at its headings, the generated appendix
removed, the person as author. A run on that block then goes on from the person's text.

## 7. Changes to spaces-files

Kept small, each with its own tests in `spaces-files/tests/`. None changes a stored format.

| Change | Why | Phase |
|---|---|---|
| Signing out also ends the provider's session (`end_session_endpoint` from the discovery document) | "sign out, sign in" must ask again on a shared device | 0 |
| The recovery sign-in demands a fresh login (`max_age=0`, `auth_time` checked) | the strongest authority should not ride on an old session | 0 |
| `launch.ts` starts the TLS listener when `FILES_AGENT_NET` is set | documented, never started | 9 |
| A consent page `/link` and an operation by which a person creates an agent that can never hold more than they grant it | linking without a tenant administrator; decision 6 | 7 |
| An operator command that rebinds an actor to a new issuer and subject | big's accounts when it leaves password sign-in; decision 9 | 9 |

Not changed: the browser API, the cookies, the origin check, the rule that no tenant Space is exposed.

## 8. Models and their providers, from the page

**Pi in the background.** Every model call of the forum already goes through pi-ai (`completeSimple`, loaded by the
model process through `spaces/agent/src/live-models.ts`, version 1.5.2). pi-ai also brings what this section needs:
the list of 43 providers, the state of each one's credentials (`checkAuth`), and the login flows
(`Models.login(provider, "api_key" | "oauth", interaction)`), nine of them OAuth. Nothing is added to the
dependencies. pi-durable stays out (decision 10): a work item that reads in steps already survives a crash through its
`ReadStep` entries.

**Where credentials live.** Only in the model process, as today. New is a store of its own:
`fileCredentialStore(path)` in `spaces/agent/src/live-models.ts` implements pi-ai's `CredentialStore` on one file
(`FORUM_AUTH_FILE`, mode 600, in a directory of mode 700, written to a temporary file and renamed). A refreshed token
is written back. Environment keys go on working. `~/.pi/agent/auth.json` is read once to fill an empty store and never
written.

**A login from the page.** The web process never holds a credential at rest and the Space never holds one in the
clear.

1. An administrator chooses a provider and "add key" or "sign in". The web process writes a `ProviderLogin`.
2. The model process takes it, starts pi-ai's flow and writes what the flow asks or says as `ProviderPrompt` entries:
   a link to open, a device code to type in, a field for a key or for a code to paste. Each prompt that expects a
   secret carries a public key the model process made for this login only.
3. The page shows the prompt. The administrator's answer goes to the web process over HTTPS, is sealed there to that
   public key (X25519, HKDF, AES-256-GCM, all from `node:crypto`) and written as a `ProviderAnswer` with a lease of
   one minute.
4. The model process opens it, hands it to the flow, removes the entry, stores the credential and publishes the
   provider's new state. The private key never leaves its memory.

A login that needs a browser on the model's own machine falls back to the flow's "paste the code" form, so it works
from a phone. With several model processes a login is addressed to one of them; the page lists each.

| Entry | Content |
|---|---|
| `ProviderInfo` | per model process: each provider, which kinds of login it offers, whether credentials are there and of which kind, never the credential |
| `ProviderLogin`, `ProviderPrompt`, `ProviderAnswer` | one login in progress, as above; leased, gone when it ends |
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
- A web app manifest and icons, so the page can be put on the home screen. No offline mode.

**How it is checked.** In the browser at 360, 390, 768 and 1280 px, in both languages and both modes, by a list of
tasks (sign in, link, start, answer a question, save, resolve a conflict), with screenshots in
`codemode-forum/docs/` (no device data in them). What can fail mechanically is tested: every control has a name and a
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
| Start | What is a Planraum? | what it is for, in one screen, with the cycle diagram |
| Start | Your first plan in six steps | the journey of section 1, one step per heading, with what the screen shows |
| Start | Words used here | room, workspace, folder, table, model, brief, version, objection, budget, grant: one sentence each |
| Use | Material: folders and files | what the room reads, what it never sees, what a copy is |
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

**3. The help site.** The Planraum becomes an entry of `help-site/` like the six applications there (the pattern of
commit `415a817`): an introduction, an article `help.topic.planraum` in both languages in the corpus seeds, the
catalogue entry and the counts in `tests/help-consistency.test.ts`.

**Diagrams.** Drawn as the repository's are: Graphviz sources in `docs/img/src/` with the shared `style.inc`, rendered
to SVG by hand with the command in that file (Graphviz is a program on the developer's machine, not a dependency).

| Diagram | Shows | Exists |
|---|---|---|
| `planraum-journey` | the six steps as a cycle | drawn with this plan |
| `planraum-access` | who may see what; the grant and the copy | drawn with this plan |
| `planraum-overview` | what runs where | drawn with this plan |
| `planraum-table` | how the models reach a decision: kickoff, drafts, review, votes, acceptance | phase 2 |
| `planraum-signin` | one account, two applications | phase 1 |
| `planraum-conflict` | two people changed the same file: what happens, what to choose | phase 5 |

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
| A saved plan overwrites a person's work | `expectedVersion` on every save; a conflict writes nothing |
| A stolen session | `__Host-` cookie, `Strict`, CSRF header, one hour idle; the provider's second factor |
| A personal subscription serves strangers | decision 5: off unless the operator turns it on |
| Money | a budget for every run, per room and per person a day, under the operator's ceilings; a provider can be tested before a run |
| The copied files drift from their originals | registered in `checks/shared-copies.test.mjs`: `oidc.ts`, the two files clients, the diagrams |

## 13. Phases

Each phase is tested with fake models, keeps both applications runnable and is one commit. Its help (tips,
articles, diagrams) is part of it. Checks after each: `npm --prefix codemode-forum run typecheck`,
`npm run test:codemode-forum`, root `npm run typecheck` and `npm test`; where spaces-files changes,
`npm --prefix spaces-files run typecheck` and `npm run test:spaces-files`; where `live-models.ts` changes,
`npm run typecheck:agent` and `npm run test:agent`.

Tests that need spaces-files start it as a process (`FILES_MEM=1`) with its development identity provider, as
codemode-chat's bot tasks start the arena of spaces-mmo. No application imports another.

| Phase | Content | Exit evidence |
|---|---|---|
| 0 | Keycloak in Docker on this machine (a compose project of its own, loopback): one realm, a client for each application. spaces-files runs against it. In spaces-files: sign-out at the provider, fresh login for recovery (section 7). A note in `docs/` of what Keycloak needed. | spaces-files' suite passes unchanged against its development provider, with new cases for both changes; by hand against Keycloak: sign in, the tenant choice, sign out and in again asks for the password |
| 1 | Sign-in, people and rooms in the forum (section 5): `oidc.ts`, sessions, `ForumUser`, `RoomAccess`, every route and the WebSocket checked, administrators by identity, limits per person. The help's base: tips, "Words used here", "Signing in", the sign-in diagram, the extended help test. The registrations (`checks/shared-copies.test.mjs`, `AGENTS.md`). | every route refused without a session and with too low a role; a session that expires; two people who do not see each other's rooms; a request from another origin; without `FORUM_LOGIN` the present suite passes unchanged |
| 2 | The page (sections 4 and 10): the four places, three panes and their phone form, tokens, states, routes, the manifest; task, run, table and document moved in; `/expert` keeps the present page. Articles of *Start* and *Use* that need no workspace; the table diagram. | the task list at four widths, both languages and modes, with screenshots; names and tips on every control; the present suite passes |
| 3 | Models and providers from the page (section 8): the credential store, `ProviderInfo`, logins through sealed entries, the test call, `ForumSetting` with the ceilings, room defaults. Article "Models and providers", "Budgets and limits". | a fake provider with every kind of prompt; the key's bytes are nowhere in the store's file; a model process killed during a login; a refreshed token survives a restart; a value above a ceiling is refused; a member refused |
| 4 | The files connection, reading (section 6): the client copy, the sources process as agent host over the unix socket, `RoomLink`, check and link, the `files` source, the Files pane. Articles "Material", "Who sees what", "What leaves this system"; the access diagram in German. | a room reads a granted folder and nothing beside it; an owner agent is refused; each limit at its edge; binary and denied names not offered; a revocation stops the next copy and leaves the taken one; a sources process killed with a request taken; a run whose writer reads the copy |
| 5 | Saving (section 6): `PlanSave`, the operation ID in the request, the conflict view, save on acceptance as a room setting. Article "The plan", the conflict diagram. | a lost reply and a retry give one version; a conflict writes nothing and shows both; a revoked editor is refused and said so; a process killed between the ID and the write |
| 6 | The way back: loading the workspace's file as a new version of the document. | sections matched by heading; the appendix removed; an unchanged file loads nothing; a file too large is refused; a run goes on from the person's text |
| 7 | Linking without an administrator (section 7, decision 6): the consent page in spaces-files and its operation. Dropped if decided against. | a person without the folder's ownership cannot grant it; the agent never holds more than was granted; a refused consent leaves nothing behind |
| 8 | Acceptance and the help site: the remaining articles, `help.topic.planraum` with its diagrams, the README, a whole journey by someone who has not seen the page, on a phone, with the help alone. | the help site's corpus checks; the list of where that person got stuck, and each point mended or noted |
| 9 | Prepared for a server, carried out only on the person's word: `FILES_AGENT_NET` started by the launcher, the forum's compose files with the sources process as a TLS agent host, Keycloak's compose file for a server, the rebind command, the nginx notes. | the local test beds of both applications joined on this machine (`docker:local`); nothing started on big or nano |

Phases 3 and 4 are independent after phase 2. Phase 6 needs 5. Everything runs on this machine.

## 14. Risks

| Risk | What is done about it |
|---|---|
| The forum has never run on a server, and this plan adds sign-in to it | phase 1 keeps the present behaviour behind `FORUM_LOGIN`; phase 9 is separate and asked for |
| Three manual steps to link a room put people off | the page leads through them and checks the result; phase 7 removes two of them |
| A copy of the material is stale by the time the run ends | the task shows each file's version and when the copy was taken; a new task copies anew |
| A run cannot agree in three rounds (the live runs' finding) | not this plan's to solve; the page shows the open objections and lets the person accept, object or stop |
| The provider's issuer or a realm's name is changed later | fixed before the first account (decision 3); the operator's article says why |
| The page grows two faces, the new one and `/expert` | `/expert` gets no new function; it is removed once the new page shows the standings |
| Help falls behind the page | the tip and anchor tests fail the phase; an article is part of the commit that needs it |
| pi-ai's login flows change with a new version | pinned at 1.5.2; the fake provider of phase 3 covers every prompt kind the interface names |

## 15. Not part of this plan

- carrying a plan out;
- editing or uploading files on this page: the Files pane lists and previews, and links to spaces-files for the rest;
- binary files as material;
- notifications to a closed page;
- the two additions the forum's plan proposes and has not decided (its sections 15 and 16, the archive repository and
  the map of the decision process); the page leaves a place for the map in the Plan pane;
- any change to codemode-chat, spaces-mmo or the library;
- starting anything on big or nano.

![What runs where: the person reaches the forum's web process over HTTPS and WebSocket, signs in at the identity provider and grants folders to the room in spaces-files. Web, agents, model and sources talk only through the forum's one Space. The model process calls the model providers; the sources process reaches the filesystem service of spaces-files as the room's agent to list, read and write.](img/planraum-overview.svg)
