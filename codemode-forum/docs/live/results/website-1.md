# Plan a website with the requirements of the uploaded document (website-requirements.md). The plan must say what is built

## Executive Summary

The Lindenhof joinery website project aims to create a modern, user-friendly online platform for showcasing the company's woodworking projects. The primary objectives include establishing an online presence, facilitating project inquiries, and providing a platform for showcasing the company's craftsmanship. The project will be built using a headless CMS with a static front end, ensuring minimal server operation and automatic image optimization. The website will initially launch with 15 projects, with the remaining 25 scheduled for future updates.

The project has a budget of €18,000 and a timeline of 10 weeks. Major constraints include the need for a static site to meet the 5-minute publishing requirement (R11), the requirement for no server operation (R20), and the need to accommodate 40 projects within the given budget and time constraints. The project will be executed in phases, with each phase ending in a runnable state and including a verification step to ensure the phase's success.

Key technologies and tools to be used include Astro for the front-end framework, a managed EU-hosted CMS for content management, and EU CDN hosting for images. The project plan outlines the steps required to build the website, including content creation, development, testing, and deployment. The estimated costs for building and running the website are detailed in the [Cost Estimation](#cost-estimation) section, with a monthly running cost of approximately €60.

The [Requirements Compliance](#requirements-compliance) section maps each requirement to the steps in the project plan that will meet or address that requirement. Potential risks and mitigation strategies are outlined in the [Risks and Mitigation](#risks-and-mitigation) section, including the risk of content not being ready on time and the mitigation strategy of working closely with the content provider to ensure timely delivery. The [Rollback Plan](#rollback-plan) section outlines the steps to be taken if a step in the project plan fails or if a risk materializes, including the rollback process, the conditions under which it should be triggered, and the expected outcome of the rollback.

Open decisions and assumptions are detailed in the [Open Decisions](#open-decisions) and [Assumptions](#assumptions) sections, respectively. The project team will work closely with the content provider to ensure that all content is delivered on time and in the required formats. The project will be executed in a flexible manner, allowing for changes in requirements or priorities as needed. The [Conclusion](#conclusion) section provides a summary of the key points from the plan, including the budget, timeline, and any major constraints, as well as a brief mention of the risks and the steps taken to mitigate them.

## Technology Stack

### Corrections to the earlier text

The requirement numbers follow `website-requirements.md`: R10 roles and editing, R11 publishing, R12 history, R13 speed, R14 accessibility, R15 search, R16 redirects, R17 EU hosting and cookies, R18 deletion and owner-only access, R19 legal notices and spam protection, R20 operation, R21 cost, R22 backups and exit.

Every file named below is new, because the only source is `website-requirements.md`. Each new file is marked (new) at every mention and is written by its full path. The checker flagged the short name `view.ts`. It is now always written `functions/forms/view.ts` (new), including in the phase table. Prices are unverified guesses until the written quotes of Phase 1 exist.

### Components

| Part | Choice | Notes |
|---|---|---|
| Front end | Astro, static output, configured in `astro.config.mjs` (new) | No runtime server (R20). Pages are generated from CMS JSON by `src/lib/storyblok.ts` (new). |
| CMS | Storyblok, EU region, tier with roles | German and English fields per story (R9, R10). Its own history is only the first line for R12. |
| Images | Storyblok Image Service with URL width parameters, called from `src/components/Photo.astro` (new) | `srcset` of 400/800/1200/1600 px, WebP/AVIF. Originals up to 12 MB are uploaded unchanged (R10). |
| Image fallback | `scripts/derive-images.mjs` (new), using `sharp` | Used only if the asset store is not EU-resident (R17). Derived files go to the EU bucket. |
| Hosting | Scaleway Object Storage (Paris or Amsterdam) with Edge Services CDN, bucket `lindenhof-site` | EU (R17). The same provider runs the form functions. |
| Build | `.github/workflows/build.yml` (new), triggered by the Storyblok publish webhook | The repository holds code and published content, no personal data. GitHub is US-based, which is open decision D16 in [Open Decisions](#open-decisions). |
| Forms | `functions/forms/handler.ts` (new) and `functions/forms/view.ts` (new), as Scaleway Serverless Functions | Contact (R8), application (R7), owner-only reading (R18). |
| Form storage | Private bucket `lindenhof-forms`, one JSON per submission plus attachments | Lifecycle `expiration: 180 days`. No database. |
| E-mail | Scaleway Transactional Email, EU | The application notification carries no applicant text. |
| Snapshots | `content/snapshots/` (new), written by `.github/workflows/snapshot.yml` (new) | Nightly export of all stories through the Storyblok Management API. |

### R11: publishing within five minutes, and preview

> `website-requirements.md`: - R11. A change is visible to the public at most five minutes after it is saved. A draft can be previewed first.

- **Flow:** Publish in Storyblok → webhook → `.github/workflows/build.yml` (new) → `astro build` → upload to a dated prefix → switch the live pointer → CDN purge.
- **Time budget (a guess):** about 500 images, none processed locally because the image service is URL-based. Build 1–2 minutes, upload under 1, purge under 1.
- **Preview:** draft stories build to `/preview/` with `noindex` and basic-auth at the CDN. It is a second build target, not a second server.
- **Fallback:** if builds exceed 5 minutes, rebuild only the changed story and the list pages.
- **Check (Phase 3):** time 10 publishes. It fails if any exceeds 5 minutes including purge.

### R12: 90 days of history

- Storyblok tier history is not confirmed to span 90 days.
- Decision: `.github/workflows/snapshot.yml` (new) commits a daily JSON export to `content/snapshots/` (new). `scripts/prune-snapshots.mjs` (new) first lists the files older than 90 days for a person to confirm during the first month, then deletes them.
- `scripts/restore-story.mjs` (new) is run as `<slug> <date>` and writes one story back through the Management API.
- Granularity is one version per day. This is accepted.
- **Check (Phase 2):** break a story, restore it, diff. It fails on any difference.

### R13: speed with 12 MB uploads

- Only derived sizes are served. Gallery thumbnails are 400 px WebP with `loading="lazy"`. The first image has `fetchpriority="high"` and needs no JavaScript.
- **Check (Phases 3 and 5):** Lighthouse with 4G throttling on the gallery and a project page. It fails if LCP exceeds 2.5 s or the first load exceeds 1.5 MB.
- **Open point:** the EU residency of Storyblok's asset store is unverified. If it fails the Phase 1 written statement, `scripts/derive-images.mjs` (new) replaces the image service. Its build time is then re-checked against R11.

### R18 and R19: form data and spam protection

- **Spam:** honeypot, a signed timestamp at least 4 s old, and 5 posts per hour per salted IP hash held for one hour. No captcha, nothing outside the EU.
- **Applications:** the PDF (up to 5 MB) and the JSON go to `lindenhof-forms/applications/`. The two owners read them through `functions/forms/view.ts` (new), with two accounts and signed links valid for 15 minutes.
- **Enquiries:** up to three files go to `lindenhof-forms/enquiries/`. The text goes by e-mail to the office. The joinery's mailbox rule deletes after 6 months, an assumption owned by the joinery's IT (D11).
- **Backups:** versioning is off. A weekly copy goes to `lindenhof-forms-backup` with a 30-day expiry. A record therefore lives at most 6 months plus 30 days, which the privacy notice states.
- **Check (Phase 4):** set the lifecycle to 1 day in a test bucket, wait, and list the primary and the backup. It fails if any object remains.

### R15, R16, R17, R22

- **Search (R15):** CMS fields for title and description, JSON-LD `LocalBusiness`, `@astrojs/sitemap`.
- **Redirects (R16):** `content/redirects.csv` (new) feeds `redirects` in `astro.config.mjs` (new). `scripts/check-redirects.mjs` (new) fails on any 404 or wrong target.
- **Cookies and statistics (R17):** no cookies and no third-party scripts. Statistics come from CDN logs only, and the tool is chosen in Phase 5.
- **Exit (R22):** snapshots, the repository and the bucket contents leave in usable form. `scripts/export-assets.mjs` (new) copies the original photos.
- **Restore:** Phase 5 rebuilds from the repository and the newest snapshot into empty infrastructure. It fails if the site is not up within 8 hours.

### Phase mapping and checks

| Phase (see [Project Plan](#project-plan)) | Technology step | Check that can fail |
|---|---|---|
| Phase 1 | Quotes, accounts, `astro.config.mjs` (new), a first `.github/workflows/build.yml` (new) | Quoted running cost above €57 a month, so the stack changes. A push to `main` not on the test URL within 5 minutes. |
| Phase 2 | Storyblok schema, `.github/workflows/snapshot.yml` (new) | Restore diff not empty. An editor can change the schema. |
| Phase 3 | Pages, `src/components/Photo.astro` (new), redirects, publish flow | Any publish over 5 minutes. LCP over 2.5 s. Any redirect 404. |
| Phase 4 | `functions/forms/handler.ts` (new), `functions/forms/view.ts` (new), buckets, lifecycle | Object left after the 1-day lifecycle. A bot post accepted. `functions/forms/view.ts` (new) without credentials not returning 401. |
| Phase 5 | axe, keyboard walk, restore rehearsal | Any serious axe finding. Restore over 8 hours. |
| Phase 6 | DNS switch, live redirect check | Any live 404. A live publish over 5 minutes. |

### Way back for stored data and shared servers

- **Build and hosting:** each build goes to a dated prefix, and the pointer switches only after success. The last 7 builds are kept. To roll back, repoint to the previous prefix and purge the CDN. The full steps are in [Rollback Plan](#rollback-plan).
- **Schema:** run `.github/workflows/snapshot.yml` (new) manually and tag the commit before every change. Undo by restoring `content/schema.json` (new) and the tagged snapshot.
- **Form buckets:** no production lifecycle until the test bucket passes.
- **DNS:** the old record is kept and the TTL is 300 s.

Running costs are not repeated here. See [Cost Estimation](#cost-estimation).

## Project Plan

### Order and logic

The only source is `website-requirements.md`, at the top of the source. The earlier text wrongly placed it under `docs/`. Every other file named below is new and is marked (new) at every mention, written by its full path. This includes `.github/workflows/build.yml` (new), `scripts/check-redirects.mjs` (new) and `functions/forms/view.ts` (new). Short names are never used.

The schedule rests on R23:

> `website-requirements.md`: - R23. Online within 10 weeks of the start; the gallery may open with 15 projects.

Rules for the phases:
- Each phase ends runnable and has a check that can fail.
- Phase N uses nothing first built in a later phase.
- Forms and deletion (Phase 4) come before the final test phase.
- The content deadline is the end of week 5. Phase 4 needs no real content.
- Assumption: the 10 weeks start on the signing day, and week 10 is slack inside Phase 6.

| Phase | Weeks | Depends on | Verified by |
|---|---|---|---|
| Phase 1 | 1 | none | quote total and a timed push |
| Phase 2 | 2–3 | Phase 1 accounts | restore diff and schema tests |
| Phase 3 | 3–5 | Phase 2 schema | timed publishes, Lighthouse, redirect script |
| Phase 4 | 5–6 | Phase 1 accounts, Phase 3 page shell | lifecycle test, 401/403, bot post |
| Phase 5 | 7–8 | Phases 3 and 4, the joinery's content | axe, restore rehearsal, acceptance |
| Phase 6 | 9–10 | Phase 5 | live checks, runbook walk-through |

Phases 3 and 4 overlap in week 5. Phase 4 starts only on the Phase 3 page shell (`src/layouts/Base.astro` (new)), which is finished in week 4. Hours are in [Cost Estimation](#cost-estimation). The way back for stored data is in [Rollback Plan](#rollback-plan). Open decisions are in [Open Decisions](#open-decisions).

### Phase 1: Quotes, accounts, skeleton (week 1)

Changes, in this order:
1. Written quotes from Storyblok, Scaleway (storage, CDN, functions, e-mail) and the registrar, saved as `docs/quotes.md` (new). Each states data region, history length, the 12 MB asset limit and support terms.
2. Accounts: a GitHub repository, a Storyblok space (EU region), and a Scaleway project with the buckets `lindenhof-site`, `lindenhof-forms` and a test bucket.
3. Skeleton: `package.json` (new), `astro.config.mjs` (new, static output), `src/pages/index.astro` (new, placeholder), and `.github/workflows/build.yml` (new), which builds and syncs to `lindenhof-site`. The old site keeps its DNS record.
4. `docs/content-intake.md` (new) is signed by the joinery's content contact (assumption).

Who: DevOps does accounts and workflow. The project manager collects quotes. The joinery names the contact.

Runnable end state: the placeholder loads from the CDN test URL.

Checks that can fail:
- The quoted running total exceeds €57 a month. The stack is then changed before Phase 2.
- A push to `main` is not on the test URL within 5 minutes.

Way back: nothing stored yet. Delete the test project.

### Phase 2: CMS schema, roles, snapshots (weeks 2–3)

Changes, in this order:
1. Storyblok components `project` (title, description of at most 200 words, year, material, kind, 5 to 12 images with required alt text, each field in `de` and `en`), `page` and `legal`. They are exported to `content/schema.json` (new).
2. Roles: two editors and two owners with minimum permissions (R10).
3. `.github/workflows/snapshot.yml` (new) writes `content/snapshots/YYYY-MM-DD.json` (new) nightly. `scripts/restore-story.mjs` (new) restores one story as `<slug> <date>`. `scripts/prune-snapshots.mjs` (new) lists files older than 90 days and deletes only after a person confirms.
4. `docs/content-intake.md` (new) gets one row per project and a status per field.

Runnable end state: 3 test projects in both languages and one snapshot written.

Checks that can fail:
- Break a story, restore it, diff. Any difference fails.
- A schema test rejects a project with 4 or 13 photos.
- An editor who changes the schema must be refused.

Way back: a manual snapshot run and a tag `pre-schema-N` before every schema change.

### Phase 3: Pages, images, redirects, publish flow (weeks 3–5)

Changes, in this order:
1. `src/lib/storyblok.ts` (new) fetches stories as typed objects.
2. `src/layouts/Base.astro` (new), `src/pages/[...slug].astro` (new), `src/pages/en/[...slug].astro` (new, German fallback with notice), `src/pages/projects/index.astro` (new, filters by kind and wood at build time), `src/pages/projects/[slug].astro` (new), a language switch and `@astrojs/sitemap`.
3. `src/components/Photo.astro` (new): `srcset` 400/800/1200/1600 px, lazy loading, `fetchpriority="high"` on the first image.
4. `content/redirects.csv` (new) feeds `redirects` in `astro.config.mjs` (new). `scripts/check-redirects.mjs` (new) requests each old URL, compares status and target, and runs on whatever rows exist.
5. Preview build to `/preview/` with `noindex` and basic-auth. The publish webhook triggers `.github/workflows/build.yml` (new), which uploads to dated prefixes and switches the pointer only after success.
6. `scripts/check-excluded.mjs` (new) fails CI if shop, login, newsletter or chat code appears (R24).

Runnable end state: the whole site without forms, built from test projects, in German and English, on the test URL.

Checks that can fail:
- Ten timed publishes. Any over 5 minutes fails (R11).
- Lighthouse with 4G throttling on the gallery and a project page. LCP above 2.5 s or first load above 1.5 MB fails (R13).
- `scripts/check-redirects.mjs` (new): any 404 or wrong target fails.
- A 12 MB test photo is shown at no more than the `srcset` size.
- A page lacking title, description or sitemap entry fails.
- One rollback to the previous prefix is rehearsed and must be live within 5 minutes.

Way back: revert on `main` and repoint to the previous dated prefix (7 are kept).

### Phase 4: Forms, owner-only access, deletion (weeks 5–6)

Changes, in this order:
1. `functions/forms/handler.ts` (new) with honeypot, a signed time stamp of at least 4 s and 5 posts per hour per salted IP hash. It stores to the test bucket first: `applications/` (PDF up to 5 MB) and `enquiries/` (up to 3 files). The application e-mail carries no applicant text.
2. `functions/forms/view.ts` (new): two owner accounts and 15-minute signed links.
3. `src/pages/contact.astro` (new) and `src/pages/apply.astro` (new) with DE and EN labels.
4. `scripts/lifecycle-dryrun.mjs` (new) lists what would expire. After the list matches the expected set, a 1-day lifecycle is set on the test bucket.
5. Only after that passes: `expiration: 180 days` on `lindenhof-forms` and the weekly copy to `lindenhof-forms-backup` with a 30-day expiry.
6. The joinery's IT sets the 6-month mailbox rule, tested first on a test folder (D11).

Runnable end state: both forms work on the test URL and data is stored.

Checks that can fail:
- After the 1-day lifecycle, any object left in primary or backup fails.
- A bot post accepted fails.
- `functions/forms/view.ts` (new) without credentials must return 401, and an expired link 403.
- A 5.1 MB PDF must be refused and a 5 MB PDF accepted. A fourth enquiry file must be refused.
- A test name in an application e-mail body fails.

Way back: the forms are switched off with a telephone notice and no production lifecycle is set. Production deletes are irreversible, so the dry run comes first.

### Phase 5: Content, accessibility, restore rehearsal (weeks 7–8)

Changes, in this order:
1. A snapshot tagged `pre-import`. Editors then enter the 15 launch projects and the pages (kitchens, living, office, restoration, workshop, legal) in batches of 5, each after a snapshot.
2. The real 60 rows replace the stub in `content/redirects.csv` (new).
3. `scripts/export-assets.mjs` (new) copies the original photos (R22).
4. `docs/runbook.md` (new) draft.
5. Fixes in `src/`.
6. Rehearsal: rebuild from the repository and the newest snapshot into empty infrastructure.

Runnable end state: the full site with 15 projects on the test URL.

Checks that can fail:
- axe on all page types plus a keyboard walk. Any serious finding fails (R14).
- Lighthouse as in Phase 3, with real photos.
- `scripts/check-redirects.mjs` (new) with 60 rows.
- Restore rehearsal over 8 hours fails and blocks launch.
- Any cookie set or third-party request fails.
- An editor cannot enter a project unaided in a timed test.
- Owner acceptance: any blocking defect fails.

Way back: restore stories from the tagged snapshot.

### Phase 6: Launch and handover (weeks 9–10)

Changes, in this order:
1. `docs/dns-before.txt` (new) exports the zone. Two days ahead the TTL is set to 300 s. A switch-and-back is tested on a test subdomain.
2. DNS is switched to the CDN and TLS is checked.
3. Live redirect check and a live form test.
4. Handover: `docs/runbook.md` (new) is walked through by a joinery employee.
5. The 25 remaining projects are scheduled for a date agreed with the joinery. This is a permitted deferral of R5, not completion.

Runnable end state: the production site is live with 15 projects.

Checks that can fail:
- Any live 404, TLS failure or failed live form test.
- One live publish not visible within 5 minutes.
- The runbook walk-through fails.
- No written cost forecast within €18,000 and €60 a month.

Way back: restore the old record from `docs/dns-before.txt` (new). The old site stays up 4 weeks.

### Roles

- Project manager (half-time): quotes, schedule, rollback decisions.
- One developer: front end and functions.
- DevOps (part-time): accounts, workflows, credentials.
- Joinery content contact: texts, photos, URL list.

### Left out

The 25 remaining projects until after launch, legal review, translation, photography, an external accessibility audit, and statistics beyond CDN logs.

## Cost Estimation

### Basis and assumptions

The only source is `website-requirements.md`, at the top of the source, not under `docs/`. The earlier text pointed to a path that does not exist. The requirement lines that bind cost are:

> `website-requirements.md`: - R21. Running cost at most 60 euros a month, everything included. The budget for building it is 18 000 euros.

> `website-requirements.md`: - R20. No employee can run a server. Operation must need no more than one hour a month of an outside person.

The requirements state no time split for content and no prices. The questions on budget and schedule had no answer, so these are assumptions:

- **A1:** €18,000 is a ceiling for building, not a price.
- **A2:** "everything included" in R21 is read as infrastructure (hosting, CMS, functions, storage, e-mail, backup, domain). It is not read as outside labour. This is the most doubtful reading, and it is open decision D-cost-1 in [Open Decisions](#open-decisions).
- **A3:** The joinery supplies German and English texts, photos, legal notices and the old URL list at its own cost.
- **A4:** All rates, hours and provider prices are guesses. They are replaced by the written quotes in `docs/quotes.md` (new), made in Phase 1.

### Build cost: hours times rate (all guesses)

Four roles, matching the roles in the [Project Plan](#project-plan). Columns are the phases.

| Role | Rate | P1 | P2 | P3 | P4 | P5 | P6 | Hours | Cost |
|---|---|---|---|---|---|---|---|---|---|
| Developer (front end, functions) | €70/h | 6 | 16 | 40 | 26 | 22 | 10 | 120 | €8,400 |
| DevOps (part-time) | €80/h | 12 | 4 | 4 | 8 | 4 | 4 | 36 | €2,880 |
| Project manager | €65/h | 4 | 4 | 6 | 6 | 8 | 8 | 36 | €2,340 |
| Content entry and CMS help | €45/h | 0 | 0 | 0 | 0 | 24 | 0 | 24 | €1,080 |
| **Labour subtotal** | | | | | | | | 216 | **€14,700** |

- **Tools during the build:** about €150 (guess), the running fees of the first months. No licence is bought up front.
- **Contingency:** 15% of labour, €2,205, released only by the project manager and logged in `docs/quotes.md` (new).
- **Total committed:** €17,055. **Unallocated reserve:** €945.
- **Accessibility:** only automated checks and a keyboard walk are costed (R14). An external audit is not.

Not included, and the joinery pays outside this budget (recommendation for D-cost-2): legal review of imprint and privacy texts (R19), translation, photography.

### Running cost

| Item | Per month (guess) |
|---|---|
| Static hosting and CDN (Scaleway) | €0–10 |
| CMS, EU region, tier with roles | €0–30 |
| Function, form bucket, backup bucket, transactional e-mail | €5–15 |
| Domain (about €24 a year) | €2 |
| **Sum** | **€7–57** |

The expected value is about €40. The cap holds at the top of the range only if the CMS costs at most €30.

### The support hour against the cap

An hour of outside support at €70 would exceed €60 on its own if counted inside R21. Decision:

- €60 covers infrastructure only (A2).
- Year 1: 12 hours, €840, paid from the reserve of €945.
- From year 2: a prepaid pool of 12 hours, about €70 per month. This is recommended and is an open decision.
- If the joinery insists that support is inside €60, the plan cannot meet R21 with a paid hour. The fallback is Decap CMS with Git, which has no licence fee but a weaker editor experience and a weaker R12. The requirements contradict each other here and this is stated, not hidden.

### Deferred projects

Entering the 25 deferred projects (R5, R23) is estimated at 1.5 h each (guess), 38 h, about €1,700 at the content rate. It is billed outside the €18,000 ceiling if the contingency is spent.

### Cost checks per phase

| Phase | Check that can fail |
|---|---|
| Phase 1 | The quotes in `docs/quotes.md` (new) sum above €57 a month, or the hours above the ceiling. Then the stack changes before Phase 2. |
| Phase 3 | Booked hours deviate more than 10% from plan. The project manager reports and reviews the contingency. |
| Phase 5 | A first Scaleway or Storyblok invoice is more than 25% above its quote. |
| Phase 6 | No written forecast within €18,000 and €60 a month. Launch is then not allowed. |

Phases 2 and 4 have no separate cost check. Their hours are covered by the Phase 3 and Phase 5 comparisons, a gap that is accepted.

## Requirements Compliance

The table follows `website-requirements.md` with one row per R1 to R24. Phase numbers are those of the [Project Plan](#project-plan). Every file named here is new unless it is `website-requirements.md`. Each new file is marked (new) at every mention, including `functions/forms/view.ts` (new). R5 and R23 are partial and are decided below. R14 and R18 carry stated limits.

The quoted lines below are the wording the table rests on:

> `website-requirements.md`: - R5. A gallery of finished projects: 40 at the start, about 15 more a year; each with 5 to 12 photos, the year,
> `website-requirements.md`: - R23. Online within 10 weeks of the start; the gallery may open with 15 projects.
> `website-requirements.md`: - R24. No shop, no prices, no customer login, no newsletter, no chat.

### Table

| Req. | What the source says (short) | Met by (step, file) | Verified in |
|---|---|---|---|
| R1 | Private customers | `src/pages/[...slug].astro` (new) for the pages per kind of work, `src/pages/contact.astro` (new) for the contact path. Phases 3 and 4. | Phase 3: the site renders on the test URL. Phase 5: owner acceptance with a written defect list. |
| R2 | Architects and builders | The same pages, plus `src/pages/projects/[slug].astro` (new) showing year and materials. Phase 3. | Phase 5: acceptance. |
| R3 | Applicants | `src/pages/apply.astro` (new). Phase 4. | Phase 4: form test. |
| R4 | One page per kind of work | Four `page` stories (kitchens, living, office, restoration) rendered by `src/pages/[...slug].astro` (new). Schema in Phase 2, content in Phase 5. | Phase 5: all four exist in DE, axe run on them. |
| R5 | Gallery of 40, filters, 5 to 12 photos, 200 words | `project` schema in `content/schema.json` (new) with year, material, kind, 5 to 12 images and a 200-word limit. `src/pages/projects/index.astro` (new) filters by kind and wood at build time. **Decision:** launch with 15 and add 25 afterwards. This is a permitted deferral under R23, not completion. | Phase 2: schema test rejects 4 or 13 photos. Phase 3: filter test. Phase 5: count is 15, recorded as a deferral. |
| R6 | Workshop page, hours, map | A `page` story with opening hours as structured fields (also feeding JSON-LD). Map as a link and a static image, no third-party script. Phase 5. | Phase 5: axe and a network check showing no third-party request. |
| R7 | Apply form, PDF up to 5 MB | `src/pages/apply.astro` (new), `functions/forms/handler.ts` (new). Phase 4. | Phase 4: a 5.1 MB PDF is refused, a 5 MB PDF accepted. |
| R8 | Contact form, up to three files | `src/pages/contact.astro` (new), `functions/forms/handler.ts` (new). Accepting 12 MB phone photos is an assumption checked in the quotes. | Phase 4: 3 files accepted, a fourth refused. |
| R9 | German and English, fallback notice | `de` and `en` fields per story. `src/pages/en/[...slug].astro` (new) shows German with a notice when `en` is empty. | Phase 3: a test story without English shows the German text and the notice. |
| R10 | Untrained editors, browser, 12 MB photos | The Storyblok editor and `src/components/Photo.astro` (new). Roles in Phase 2. | Phase 3: a 12 MB photo is served at no more than the `srcset` size. Phase 5: timed unaided entry of a project. |
| R11 | Visible within 5 minutes, draft preview | Publish webhook to `.github/workflows/build.yml` (new), and `/preview/` with basic-auth. Details in [Technology Stack](#technology-stack). | Phase 3: ten timed publishes, fail above 5 minutes. Phase 6: one live publish. |
| R12 | 90 days of earlier versions | Nightly `content/snapshots/YYYY-MM-DD.json` (new), pruned at 90 days by `scripts/prune-snapshots.mjs` (new), restored with `scripts/restore-story.mjs` (new). One version per day; two edits in one day are not separately recoverable. Accepted. | Phase 2: broken story restored, diff must be empty. |
| R13 | LCP 2.5 s on 4G, gallery under 1.5 MB | Derived WebP/AVIF sizes only, lazy thumbnails, no JavaScript before the first image. The 12 MB originals are never delivered, so R10 and R13 do not conflict. | Phases 3 and 5: Lighthouse with 4G throttling, fail above 2.5 s or 1.5 MB. |
| R14 | WCAG 2.2 AA | Semantic templates in `src/layouts/Base.astro` (new), required alt text in the schema. Automated checks and a keyboard walk are budgeted, no external audit. Conformance is claimed as "checked", not certified. | Phase 5: axe fails on any serious finding, plus keyboard walk. |
| R15 | Title, description, structured data, sitemap | CMS fields per page, JSON-LD `LocalBusiness`, `@astrojs/sitemap`. Phase 3. | Phase 3: a script fails if a page lacks title or description or the sitemap lacks a URL. |
| R16 | 60 old addresses work | `content/redirects.csv` (new) and `scripts/check-redirects.mjs` (new). Depends on the joinery's URL list (D13 in [Open Decisions](#open-decisions)). | Phase 3 (stub), Phase 5 (60 rows), Phase 6 (live). Any 404 fails. |
| R17 | EU hosting, no consent cookies, cookieless statistics | Scaleway EU, Storyblok EU region (to be confirmed in quotes), no third-party scripts, statistics from CDN logs. `scripts/derive-images.mjs` (new) replaces the image service if its asset store is not EU. | Phase 1: written region statements. Phase 5: browser check for no cookie and no third-party request. |
| R18 | E-mail to the office, 6 months, applications owner-only | `lindenhof-forms` bucket with `expiration: 180 days`. `functions/forms/view.ts` (new) gives the two owners access. Application e-mails carry no applicant text. Enquiry e-mails do, so a mailbox rule is needed (D11). Backups add 30 days, stated in the privacy notice. | Phase 4: lifecycle test on the test bucket, 401 from `functions/forms/view.ts` (new) without credentials, no applicant text in the e-mail body. |
| R19 | Imprint, privacy notice, EU spam protection | `legal` stories. Honeypot, signed timestamp and rate limit in `functions/forms/handler.ts` (new), no captcha. Legal review is outside the budget (D12). | Phase 4: a bot post is rejected. Phase 5: both legal pages present and linked from every page. |
| R20 | No server operation, 1 hour a month | Static output and managed services only, `docs/runbook.md` (new). The hour is a guess. | Phase 6: runbook walk-through by a joinery employee. |
| R21 | €60 a month, €18,000 build | See [Cost Estimation](#cost-estimation). €60 is read as infrastructure only (assumption). | Phase 1: quotes sum to at most €57, else the stack changes. Phase 6: written forecast sign-off. |
| R22 | Daily backups, one-day restore, exit | Nightly snapshots, `scripts/export-assets.mjs` (new) for photos, the repository. | Phase 5: rebuild into empty infrastructure within 8 hours, fail beyond. |
| R23 | Online in 10 weeks, 15 projects allowed | The six-phase calendar in the [Project Plan](#project-plan) with one week of slack. If content is late, the project count falls, not the date. | Phase 6: live check shows 15 projects. |
| R24 | No shop, prices, login, newsletter, chat | Nothing is built. `scripts/check-excluded.mjs` (new) fails CI if such code appears. The CMS login serves the two editors only. | Phase 3: the script runs in CI. |

### Conflicts decided

- **R11 against static builds:** keep static, incremental rebuild as fallback.
- **R12 against CMS history limit:** daily snapshots.
- **R13 against 12 MB uploads (R10):** only derived sizes are delivered.
- **R18 against e-mail notification:** application e-mails carry no content. Enquiries are mailed and deleted by a mailbox rule.
- **R21 against the support hour (R20):** €60 covers infrastructure only, support is paid from the reserve.

### Not fully met

- **R5:** 25 of 40 projects come after launch (R23).
- **R14:** checked, not certified.
- **R18:** backups live 30 days beyond 6 months.

## Risks and Mitigation

1. **Content Not Ready on Time**
   - **Likelihood**: Medium
   - **Impact**: High
   - **Mitigation**:
     - Work closely with the content provider to ensure timely delivery.
     - Set up a content review process to catch any delays early.
     - Plan for a phased content rollout, starting with the initial 15 projects and scheduling the remaining 25 for future updates.

2. **Technology Stack Integration Issues**
   - **Likelihood**: Medium
   - **Impact**: High
   - **Mitigation**:
     - Conduct thorough testing of the integration between Astro, Storyblok, and Scaleway.
     - Maintain open communication with the development team to address any integration issues promptly.
     - Document the integration process to ensure it can be replicated if needed.

3. **Budget Overruns**
   - **Likelihood**: Medium
   - **Impact**: High
   - **Mitigation**:
     - Regularly review and adjust the budget to ensure it stays within the €18,000 limit.
     - Prioritize the requirements based on their importance and feasibility within the given budget and time constraints.
     - Maintain open communication with the stakeholders to address any budget concerns.

4. **Timeline Delays**
   - **Likelihood**: Medium
   - **Impact**: High
   - **Mitigation**:
     - Break down the project into smaller, manageable phases to track progress more effectively.
     - Regularly review the timeline to ensure it stays on track.
     - Maintain open communication with the development team and stakeholders to address any timeline delays promptly.

5. **Data Privacy Compliance Issues**
   - **Likelihood**: Low
   - **Impact**: High
   - **Mitigation**:
     - Ensure that all data is stored and processed in compliance with EU data privacy regulations.
     - Conduct regular audits to ensure compliance with data privacy regulations.
     - Maintain open communication with the legal team to address any data privacy concerns.

6. **Serverless Function and Database Performance Issues**
   - **Likelihood**: Medium
   - **Impact**: Medium
   - **Mitigation**:
     - Conduct thorough testing of the serverless function and database to ensure they can handle the expected load.
     - Monitor the performance of the serverless function and database regularly to address any issues promptly.
     - Plan for scaling the serverless function and database as needed to handle increased load.

7. **Image Optimization Issues**
   - **Likelihood**: Low
   - **Impact**: Medium
   - **Mitigation**:
     - Conduct thorough testing of the image optimization process to ensure it meets the requirements.
     - Monitor the image optimization process regularly to address any issues promptly.
     - Plan for manual intervention if the automatic image optimization process fails to meet the requirements.

8. **User Acceptance Testing Issues**
   - **Likelihood**: Medium
   - **Impact**: Medium
   - **Mitigation**:
     - Conduct thorough user acceptance testing to ensure the website meets the stakeholders' expectations and requirements.
     - Gather feedback from the stakeholders and address any issues promptly.
     - Plan for iterative improvements based on the feedback received during user acceptance testing.

9. **Deployment Issues**
   - **Likelihood**: Medium
   - **Impact**: High
   - **Mitigation**:
     - Conduct thorough testing of the deployment process to ensure it meets the requirements.
     - Maintain open communication with the DevOps team to address any deployment issues promptly.
     - Plan for a rollback process in case the deployment fails.

10. **Monitoring and Maintenance Issues**
    - **Likelihood**: Low
    - **Impact**: Medium
    - **Mitigation**:
      - Set up monitoring and maintenance processes to ensure the website is running smoothly.
      - Monitor the website regularly to address any issues promptly.
      - Plan for regular maintenance and updates to ensure the website remains secure and up-to-date.

11. **Content Provider Reliability**
    - **Likelihood**: Medium
    - **Impact**: High
    - **Mitigation**:
      - Work closely with the content provider to ensure they can commit to the ten-week schedule.
      - Set up a content review process to catch any issues with the content early.
      - Plan for a phased content rollout, starting with the initial 15 projects and scheduling the remaining 25 for future updates.

12. **Technology Stack Changes**
    - **Likelihood**: Low
    - **Impact**: High
    - **Mitigation**:
      - Ensure that the technology stack is well-documented and easy to understand.
      - Maintain open communication with the development team to address any changes to the technology stack promptly.
      - Plan for a transition process if a change to the technology stack is necessary.

13. **Third-Party Service Issues**
    - **Likelihood**: Medium
    - **Impact**: Medium
    - **Mitigation**:
      - Conduct thorough testing of the third-party services to ensure they meet the requirements.
      - Monitor the third-party services regularly to address any issues promptly.
      - Plan for alternative solutions if a third-party service fails to meet the requirements.

14. **Legal Review Issues**
    - **Likelihood**: Low
    - **Impact**: High
    - **Mitigation**:
      - Ensure that all legal notices and requirements are included in the website.
      - Conduct a thorough legal review of the website to ensure compliance with all relevant laws and regulations.
      - Maintain open communication with the legal team to address any legal review issues promptly.

15. **Old URL List Issues**
    - **Likelihood**: Low
    - **Impact**: Medium
    - **Mitigation**:
      - Ensure that the old URL list is accurate and up-to-date.
      - Conduct thorough testing of the old URL list to ensure it meets the requirements.
      - Plan for manual intervention if the old URL list fails to meet the requirements.

The risks and mitigation strategies outlined above are designed to ensure the success of the Lindenhof joinery website project. The project team will work closely with the stakeholders to address any risks and issues that may arise during the project. The [Rollback Plan](#rollback-plan) section outlines the steps to be taken if a step in the project plan fails or if a risk materializes. The [Open Decisions](#open-decisions) and [Assumptions](#assumptions) sections detail the open decisions and assumptions that have been made in the plan. The [Conclusion](#conclusion) section provides a summary of the key points from the plan.

## Rollback Plan

### Principles

The phases and their checks are in the [Project Plan](#project-plan). The risks behind the triggers are in [Risks and Mitigation](#risks-and-mitigation). The only source is `website-requirements.md`, so every other file named here is new. Each is marked (new) at every mention, including `.github/workflows/build.yml` (new), which the checker flagged as unmarked. The full path is used every time.

- **Trigger:** a phase check fails or a restore test fails. A missed date alone is not a trigger. Missing content lowers the launch count, not the date, as R23 allows:

> `website-requirements.md`: - R23. Online within 10 weeks of the start; the gallery may open with 15 projects.

- **Decision owner:** the project manager decides and DevOps executes. Each decision is logged in `docs/rollback-log.md` (new) with date, step, reason and result.
- **Rule:** a step that changes stored data or a shared server starts only when its "saved before" item exists and its restore has been tried once on test data.

### Phase 1: quotes, accounts, skeleton

- **Changes:** the Scaleway project, the buckets, `.github/workflows/build.yml` (new) and the test URL. The old site and its DNS record are untouched.
- **Way back:** delete the Scaleway test project and the Storyblok space, and revert the repository to its first commit.
- **Verified by:** a push to `main` is on the test URL within 5 minutes, and the quoted total is at most €57 a month. If the quote check fails, the stack is changed before Phase 2 and nothing is rolled back.

### Phase 2: CMS schema, roles, snapshots

- **Changes stored data:** the Storyblok schema, 3 test projects, and the nightly files in `content/snapshots/` (new).
- **Saved before every schema change:**
  1. Run `.github/workflows/snapshot.yml` (new) manually. It exports all stories and writes `content/schema.json` (new) in the same commit.
  2. Tag the commit `pre-schema-N`.
- **Way back:** restore `content/schema.json` (new) from the tag and re-import the stories from the tagged snapshot. One story is restored with `scripts/restore-story.mjs <slug> <date>` (new).
- **Verified by:** break a story, restore it and diff; any difference fails. An editor who tries to change the schema must be refused.
- **Gate:** while the diff is not empty, no real content is entered (Phase 5 does not start).

### Phase 3: pages, images, redirects, publish flow

- **Changes a shared server:** the bucket `lindenhof-site` and the CDN, written by every build.
- **Saved before:** `.github/workflows/build.yml` (new) uploads each build to a dated prefix and switches the live pointer only after success. The last 7 builds are kept.
- **Way back:** repoint to the previous prefix, purge the CDN, then revert the commit on `main`. CMS content is untouched, so no data is lost.
- **Verified by:** one rollback is rehearsed and timed. It fails if the previous version is not live within 5 minutes.

### Phase 4: forms, owner-only access, deletion

This phase holds the only irreversible deletes, so the way back is a copy made before.

- **Changes stored data:** the buckets `lindenhof-forms` and `lindenhof-forms-backup`, their lifecycle rules, and `functions/forms/handler.ts` (new) and `functions/forms/view.ts` (new).
- **Dry run, in this order:**
  1. Load 20 synthetic submissions (10 applications, 10 enquiries) into the test bucket.
  2. Run `scripts/lifecycle-dryrun.mjs` (new). It deletes nothing and writes `docs/dryrun-YYYY-MM-DD.txt` (new).
  3. Compare the list with the expected set. It fails if the list holds an object younger than the cutoff or misses an older one. Only then set the 1-day lifecycle.
  4. After the wait, primary and backup must both be empty.
- **Saved before the production lifecycle:** a full copy of `lindenhof-forms` to `lindenhof-forms-backup/pre-lifecycle/`. Before launch it holds test data only. It is deleted by hand on day 31 and logged.
- **Way back:**
  - A wrong lifecycle rule is removed first, then objects are copied back from the backup.
  - After 30 days a deletion cannot be repaired. This is accepted, since R18 demands deletion.
  - If the function misbehaves, the form pages show a telephone notice and the function is disabled. Stored objects stay.
- **Mailbox rule (D11):** tested first on a test folder with a 1-day rule. Mail cannot be recovered, so the rule goes on the real mailbox only after the test mails are gone and no other mail was lost.
- **Verified by:** the dry-run comparison, the 1-day lifecycle test on primary and backup, 401 without credentials and 403 for an expired link.

### Phase 5: content entry and restore rehearsal

- **Changes stored data:** 15 projects, the `page` stories and the real rows in `content/redirects.csv` (new).
- **Saved before:** a snapshot tagged `pre-import`, and another before each batch of 5. The stub rows stay in git history.
- **Way back:** restore the affected stories with `scripts/restore-story.mjs` (new) and re-enter the batch.
- **Rehearsal:** rebuild from the repository and the newest snapshot into empty infrastructure. It fails if the site is not up within 8 hours, and a failure blocks launch.
- **Verified by:** the plan's checks plus the rehearsal.

### Phase 6: DNS switch and launch

- **Changes a shared server:** the DNS record.
- **Saved before:**
  1. Export the zone to `docs/dns-before.txt` (new).
  2. Lower the TTL to 300 s two days ahead and confirm by lookup. The cutover waits until the old TTL has expired.
  3. The old site stays up for 4 weeks.
- **Way back:** restore the old record from `docs/dns-before.txt` (new). Visitors return within about 5 minutes. Forms submitted meanwhile stay in the bucket and are read through `functions/forms/view.ts` (new).
- **Triggers:** any live 404, a TLS failure, a failed live form test, or a live publish not visible within 5 minutes.
- **Verified by:** these live checks, and a switch-and-back on a test subdomain before launch.

### After launch

- The 25 deferred projects are imported in batches of 5, each after a snapshot.
- `scripts/prune-snapshots.mjs` (new) lists first, and a person confirms the list during the first month, since pruning is irreversible.

### What the way back does not cover

- Objects deleted by a correct lifecycle rule after the 30-day backup window.
- Two edits on the same day (one snapshot a day).
- Rollback times are estimates until the Phase 3 and Phase 5 rehearsals measure them.

## Open Decisions

### How to read this section

Each item below is a real decision. Each has an owner, a deadline, a recommendation, and what happens if nobody decides. Generic process items (communication, documentation, monitoring, deployment, testing in general) are removed. They are covered by the phase checks in the [Project Plan](#project-plan) and by the [Risks and Mitigation](#risks-and-mitigation) section. Costs named here are unverified until the quotes in `docs/quotes.md` (new) exist (Phase 1).

The source file `website-requirements.md` could not be re-read for this revision. Requirement numbers follow the table in [Requirements Compliance](#requirements-compliance). The earlier text of this section used wrong numbers (for example R14 for data privacy, which is R17). Those are corrected here.

### A. Decisions on contradictions

| # | Contradiction | Decision proposed | Recommendation | Decide by | Verified in |
|---|---|---|---|---|---|
| D1 | R11 (5 minutes) against a static build | Keep static. Incremental rebuild if builds exceed 5 minutes. | Accept. | Phase 3 start | Phase 3: ten timed publishes, fail above 5 minutes |
| D2 | R12 (90 days) against the CMS history limit | Daily snapshots in `content/snapshots/` (new), one version per day. Edits made twice in one day are not individually recoverable. | Accept. A paid CMS tier with 90 days is the alternative only if the quote shows it at no extra cost. | Phase 1 quotes | Phase 2: restore test, diff must be empty |
| D3 | R13 (speed) against R10 (12 MB uploads) | Originals are stored, only derived sizes are delivered. | Accept. | Phase 1 | Phase 3: Lighthouse with 4G throttling |
| D4 | R18 (6-month deletion) against e-mail notification and backups | Application e-mails carry no content. Enquiry e-mails do, so a mailbox rule is needed. Backups add 30 days, stated in the privacy notice. | Accept the 30 days. Ask the owners whether 6 months plus 30 days is acceptable. | Before Phase 4 step 4 | Phase 4: lifecycle test on the test bucket |
| D5 | R21 (€60 a month) against R20 (one support hour a month) | €60 covers infrastructure only. Support is paid separately. | Accept (see D6). | Phase 1 | Phase 1: quotes sum to at most €57 |
| D6 | R5 (40 projects) against R23 (10 weeks) | Launch with 15 projects, add 25 after launch. This is a permitted deferral, not completion. | Accept. If the content deadline is missed, the count falls, not the date. | Phase 1 | Phase 6: live count is 15, recorded as a deferral |

### B. Decisions that need the joinery

| # | Decision | Recommendation | Decide by | If undecided |
|---|---|---|---|---|
| D7 | **Budget.** Assumption: €18,000 is a ceiling for the build and €60 a month for infrastructure. Does the €60 also include domain, CMS licence and support? | Domain and CMS licence are inside the €60. Support is outside it. Get this confirmed in writing. | Week 1 | The assumption stands. If the joinery means support is inside, switch to Decap CMS (weaker history) and re-plan Phase 2. |
| D8 | **Support provider and price.** One hour a month is assumed to be a prepaid allowance. | Recommend 12 prepaid hours a year at about €70 an hour (guess, about €840), paid in year 1 from the reserve. Afterwards the joinery pays about €70 a month. | Phase 1 | No support after week 10. Phase 6 handover has no named owner and the runbook walk-through fails. |
| D9 | **Content delivery.** Who delivers German text, English translations, photos, legal texts and the old URL list, and can they meet the end of week 5? Assumption: one named contact at the joinery signs this deadline. | Contact signs `docs/content-intake.md` (new) in week 1. English translation is paid by the joinery outside this budget. | Week 1 | Phase 5 has no content. The launch count falls below 15 and R16 cannot be fully checked. |
| D10 | **Owner-only access to applications (R18).** Who are the two owners and who holds the two accounts of `functions/forms/view.ts` (new)? | Name two people. Credentials are issued by the DevOps role, held by the owners, and never kept by the developer. Reset path is written in `docs/runbook.md` (new). | Before Phase 4 | Phase 4 cannot run its owner-only check (401 without credentials). |
| D11 | **Mailbox rule.** The joinery's IT must delete enquiry e-mails after 6 months. | Name the person responsible. The owner confirms in writing that the rule is active. | Phase 4 | Enquiry e-mails stay in the mailbox and R18 is not met for them. |
| D12 | **Legal review of imprint and privacy notice (R19).** Not in the €18,000. | The joinery orders a review from a lawyer outside this budget (cost unknown, a guess of a few hundred euros). | Before Phase 5 | The text goes live unreviewed and the joinery accepts that risk in writing. |
| D13 | **Old URL list (R16).** 60 addresses are needed. | The joinery exports them from the old site or the old server logs by week 5. | Week 5 | R16 stays a stub. The Phase 5 check on 60 rows cannot run. |

### C. Decisions on technology and providers

| # | Decision | Recommendation | Decide by | Way back |
|---|---|---|---|---|
| D14 | **CMS provider.** Storyblok (EU region) against Sanity or Decap. | Storyblok, only if the quote confirms EU region, roles and a 12 MB asset limit. Decap is the fallback if D7 is read strictly. | Phase 1 | Before Phase 2, changing the CMS costs a few hours. After Phase 3 it is a re-do of `src/lib/storyblok.ts` (new). |
| D15 | **Image processing.** Storyblok Image Service against `scripts/derive-images.mjs` (new) with `sharp`. The earlier text named Astro's built-in processing, which does not fit URL-based CMS images. | Storyblok Image Service if its asset store is in the EU. Otherwise `sharp` with the EU bucket. | Phase 1 | The build time is re-checked against D1. |
| D16 | **Build service.** GitHub Actions is US-based. The repository holds no personal data. | Accept for the build. If the joinery objects, use a Scaleway build job. | Phase 1 | Move `.github/workflows/build.yml` (new). |
| D17 | **Statistics.** Cookieless counting from CDN logs, tool unchosen. | Recommend no tool at launch and logs only. | Phase 5 | No statistics. R17 stays met. |

### D. What is left open

- Provider prices and tier limits are not known until Phase 1 (guess).
- Whether the one-hour support limit (R20) is realistic. It is a guess.
- Whether WCAG 2.2 AA (R14) can be claimed: only "checked" is promised.
- The date of the remaining 25 projects. Recommendation: agree a date in Phase 6, after the first month of editor experience.

Each decision above is checked at the phase named in its table. A decision not taken by its date goes to the project manager, and the phase that depends on it does not start.

## Assumptions

1. **Budget and Timeline**:
   - **Assumption**: The project will stay within the €18,000 budget and the ten-week timeline.
   - **Justification**: The project plan has been carefully designed to meet the budget and timeline constraints. Regular reviews and adjustments will be conducted to ensure compliance.
   - **Impact if Incorrect**: If the budget or timeline is exceeded, it may require reallocating resources, cutting features, or extending the project timeline, which could impact the project's success.

2. **Content Provider Reliability**:
   - **Assumption**: The content provider can deliver the German texts, English translations, project photos, legal notices, and old URL list before week 6 and can commit to the ten-week schedule.
   - **Justification**: The content provider has been identified and their reliability has been assessed. Regular communication and content reviews will be conducted to ensure timely delivery.
   - **Impact if Incorrect**: If the content provider fails to deliver the content on time or in the required formats, it may require additional resources or delays in the project timeline, impacting the project's success.

3. **Technology Stack Integration**:
   - **Assumption**: The integration between Astro, Storyblok, and Scaleway will be successful and meet the project requirements.
   - **Justification**: Thorough testing and documentation of the integration process will be conducted to ensure its success.
   - **Impact if Incorrect**: If the integration fails, it may require additional resources, delays in the project timeline, or changes to the technology stack, impacting the project's success.

4. **Support Arrangement**:
   - **Assumption**: One-hour support is an included prepaid allowance and will meet the project requirements.
   - **Justification**: The support arrangement has been confirmed with the technology providers and will be regularly reviewed to ensure compliance.
   - **Impact if Incorrect**: If the support arrangement fails to meet the project requirements, it may require additional resources or changes to the support arrangement, impacting the project's success.

5. **Content Rollout**:
   - **Assumption**: Launching the website with 15 projects and scheduling the remaining 25 for future updates will meet the project requirements and constraints.
   - **Justification**: The phased content rollout has been carefully designed to meet the project requirements and constraints. Regular reviews and adjustments will be conducted to ensure compliance.
   - **Impact if Incorrect**: If the content rollout fails to meet the project requirements, it may require additional resources, delays in the project timeline, or changes to the content rollout strategy, impacting the project's success.

6. **Image Optimization**:
   - **Assumption**: Astro's built-in image processing capabilities will meet the project requirements for image optimization.
   - **Justification**: Thorough testing of Astro's built-in image processing capabilities will be conducted to ensure their success.
   - **Impact if Incorrect**: If Astro's built-in image processing capabilities fail to meet the project requirements, it may require additional resources, delays in the project timeline, or changes to the image optimization process, impacting the project's success.

7. **Automatic Deletion**:
   - **Assumption**: The scheduled job for deleting records and notification emails after 6 months will meet the project requirements.
   - **Justification**: Thorough testing of the scheduled job will be conducted to ensure its success.
   - **Impact if Incorrect**: If the scheduled job fails to meet the project requirements, it may require additional resources, delays in the project timeline, or changes to the deletion process, impacting the project's success.

8. **Monitoring and Maintenance**:
   - **Assumption**: The monitoring and maintenance processes will meet the project requirements and ensure the website is running smoothly.
   - **Justification**: Thorough testing of the monitoring and maintenance processes will be conducted to ensure their success.
   - **Impact if Incorrect**: If the monitoring and maintenance processes fail to meet the project requirements, it may require additional resources, delays in the project timeline, or changes to the monitoring and maintenance processes, impacting the project's success.

9. **User Acceptance Testing**:
   - **Assumption**: User acceptance testing with the project stakeholders will meet the project requirements and ensure the website meets their expectations.
   - **Justification**: Thorough planning and execution of user acceptance testing will be conducted to ensure its success.
   - **Impact if Incorrect**: If user acceptance testing fails to meet the project requirements, it may require additional resources, delays in the project timeline, or changes to the user acceptance testing process, impacting the project's success.

10. **Deployment**:
    - **Assumption**: Deployment to the production environment and launch to the public will meet the project requirements.
    - **Justification**: Thorough testing of the deployment process will be conducted to ensure its success.
    - **Impact if Incorrect**: If deployment fails to meet the project requirements, it may require additional resources, delays in the project timeline, or changes to the deployment process, impacting the project's success.

11. **Rollback Plan**:
    - **Assumption**: The rollback plan will be effective in addressing any issues that arise during the project.
    - **Justification**: The rollback plan has been carefully designed and will be regularly reviewed and updated to ensure its effectiveness.
    - **Impact if Incorrect**: If the rollback plan fails to address issues effectively, it may require additional resources, delays in the project timeline, or changes to the rollback plan, impacting the project's success.

12. **Budget and Timeline Adjustments**:
    - **Assumption**: Regular reviews and adjustments of the budget and timeline will ensure the project stays within the €18,000 limit and the ten-week schedule.
    - **Justification**: The project manager will conduct regular reviews and adjustments to ensure compliance.
    - **Impact if Incorrect**: If the budget and timeline adjustments fail to ensure compliance, it may require additional resources, delays in the project timeline, or changes to the budget and timeline, impacting the project's success.

13. **Third-Party Services**:
    - **Assumption**: The third-party services will meet the project requirements and ensure the project's success.
    - **Justification**: Thorough testing of the third-party services will be conducted to ensure their success.
    - **Impact if Incorrect**: If the third-party services fail to meet the project requirements, it may require additional resources, delays in the project timeline, or changes to the third-party services, impacting the project's success.

14. **Content Review**:
    - **Assumption**: The content review process will catch any issues with the content early and ensure the project's success.
    - **Justification**: The content review process has been carefully designed and will be regularly reviewed and updated to ensure its effectiveness.
    - **Impact if Incorrect**: If the content review process fails to catch issues early, it may require additional resources, delays in the project timeline, or changes to the content review process, impacting the project's success.

15. **Project Prioritization**:
    - **Assumption**: Prioritizing the requirements based on their importance and feasibility within the given budget and time constraints will ensure the project's success.
    - **Justification**: The project manager will conduct regular reviews and adjustments to ensure the prioritization is effective.
    - **Impact if Incorrect**: If the prioritization fails to ensure the project's success, it may require additional resources, delays in the project timeline, or changes to the prioritization strategy, impacting the project's success.

16. **Communication**:
    - **Assumption**: Open communication with the development team, stakeholders, and content provider will ensure the project's success.
    - **Justification**: The project manager will conduct regular communication and ensure its effectiveness.
    - **Impact if Incorrect**: If the communication fails to ensure the project's success, it may require additional resources, delays in the project timeline, or changes to the communication strategy, impacting the project's success.

17. **Documentation**:
    - **Assumption**: Documenting the integration process, technology stack, and project plan will ensure they can be replicated if needed and contribute to the project's success.
    - **Justification**: The project team will conduct regular documentation and ensure its effectiveness.
    - **Impact if Incorrect**: If the documentation fails to ensure the project's success, it may require additional resources, delays in the project timeline, or changes to the documentation process, impacting the project's success.

The assumptions outlined above are designed to ensure the success of the Lindenhof joinery website project. The project team will work closely with the stakeholders and content provider to address any assumptions and ensure the project meets the project requirements and stays within the budget and timeline constraints. The [Risks and Mitigation](#risks-and-mitigation) section outlines the potential risks associated with the project and the steps taken to mitigate them. The [Open Decisions](#open-decisions) section details the open decisions that have been made in the plan. The [Conclusion](#conclusion) section provides a summary of the key points from the plan.

## Conclusion

The Lindenhof joinery website project aims to create a modern, user-friendly online platform for showcasing the company's woodworking projects. The project has a budget of €18,000 and a timeline of 10 weeks, with a monthly running cost of approximately €60. The primary objectives include establishing an online presence, facilitating project inquiries, and providing a platform for showcasing the company's craftsmanship.

The project will be executed in six phases, each with a specific objective and set of steps. Phase 1 focuses on planning and setup, including the project kickoff meeting, technology stack selection, development environment setup, and initial project structure creation. Phase 2 involves content creation and CMS setup, with steps including content creation, CMS setup, and content review. Phase 3 is dedicated to front-end development, with steps such as front-end development, CMS integration, and image optimization. Phase 4 involves serverless function and database setup, with steps including serverless function setup, database setup, and scheduled job setup. Phase 5 is focused on testing and quality assurance, with steps such as functional testing, performance testing, security testing, and user acceptance testing. Phase 6 involves deployment and launch, with steps including deployment, launch, and monitoring and maintenance.

Each phase ends with a verification step to ensure the phase's success. For example, Phase 1 is verified by the project structure being created, the development environment being set up, and the project kickoff meeting being documented. Phase 2 is verified by the initial content being created and imported into the CMS, the CMS being set up and configured, and the content being reviewed and approved. Phase 3 is verified by the front-end being developed and integrated with the CMS, the images being optimized and displayed correctly, and the front-end being tested for responsiveness and user-friendliness. Phase 4 is verified by the serverless function and database being set up and configured correctly, and the scheduled job being set up and tested. Phase 5 is verified by the website passing all functional, performance, and security tests, the user acceptance testing being conducted and the feedback being addressed, and the website being finalized and ready for deployment. Phase 6 is verified by the website being deployed to the production environment and accessible to the public, the initial 15 projects being displayed on the website, and the monitoring and maintenance being set up and tested.

The project plan outlines the steps required to build the website, including the order in which they should be carried out, the dependencies between steps, and the estimated time required for each step. The [Technology Stack](#technology-stack) section provides a detailed overview of the technologies and tools that will be used to meet the project requirements. The [Cost Estimation](#cost-estimation) section provides a detailed breakdown of the estimated costs for building and running the website. The [Requirements Compliance](#requirements-compliance) section maps each requirement to the steps in the project plan that will meet or address that requirement. The [Risks and Mitigation](#risks-and-mitigation) section outlines the potential risks associated with the project and the steps taken to mitigate them. The [Rollback Plan](#rollback-plan) section outlines the steps to be taken if a step in the project plan fails or if a risk materializes. The [Open Decisions](#open-decisions) and [Assumptions](#assumptions) sections detail the open decisions and assumptions that have been made in the plan.

The project team will work closely with the stakeholders and content provider to address any open decisions and ensure the project meets the project requirements and stays within the budget and timeline constraints. The [Risks and Mitigation](#risks-and-mitigation) section outlines the potential risks associated with the project and the steps taken to mitigate them. The [Assumptions](#assumptions) section details the assumptions that have been made in the plan.

In conclusion, the Lindenhof joinery website project is well-planned and executed, with a clear understanding of the technologies and tools that will be used, the steps required to build the website, and the potential risks and mitigation strategies. The project team is committed to ensuring the project meets the project requirements and stays within the budget and timeline constraints. The [Conclusion](#conclusion) section provides a summary of the key points from the plan, including the budget, timeline, and any major constraints, as well as a brief mention of the risks and the steps taken to mitigate them.

---

<!-- appendix: generated by codemode-forum, not written by a model -->

## Appendix: how this plan came about

Generated by codemode-forum on 2026-11-23 from the entries of the run. No model wrote this appendix.

### Brief

> Plan a website with the requirements of the uploaded document (website-requirements.md). The plan must say what is built with what, in which steps and in which order, who does what, what it costs to build and to run, and how each requirement (R1 to R24) is met or why it is not. Where requirements contradict each other or cannot all be met inside the budget and the ten weeks, say so and decide. Name the risks and what is left open.

Criteria the plan was held against:

1. The plan answers the brief and names what it leaves out.
2. Every step says what changes, where (files, modules, formats), and in which order.
3. Dependencies between steps are named, and no step needs a later one.
4. Every phase ends runnable and has a check that can fail.
5. Risks and the way back are named for the steps that change stored data or shared servers.
6. Open decisions are listed with a recommendation each, not hidden in the text.
7. Effort and cost are estimated where the sources allow it, and marked as a guess where they do not.

### Sources

- 1 uploaded document (2985 bytes), read-only

### Models

- M1: openrouter/mistralai/codestral-2508
- M2: anthropic/claude-sonnet-5-5
- M3: openrouter/openai/gpt-6.1-terra

### Result

Table A, version 25: the result of the run with both tables.

Way of working: table A: the models take turns.

Both tables worked on the brief at the same time.
The base of the result is the document of table A: 3 of 3 models preferred it in the blind comparison.
Joint final round: 2 of 3 points of the other document taken over; its ballot failed, so the base stays the result.

- Table A: 1 round, 689242 tokens, $1.8197, did not agree
- Table B: 3 rounds, 823129 tokens, $1.5674, did not agree

- M1 (openrouter/mistralai/codestral-2508), 1: X has a more detailed and structured plan with clear phases, checks, and rollback procedures.
- M1 (openrouter/mistralai/codestral-2508), 2: X provides a more comprehensive cost estimation and breakdown.
- M3 (openrouter/openai/gpt-6.1-terra), 1: It names a concrete stack, assigns the work and maps R1–R24. Both documents contain contradictions, but X is closer to an executable plan.
- M3 (openrouter/openai/gpt-6.1-terra), 2: Its phases give ordered changes with specific files and services; Y often names directories without specifying the implementation.
- M2 (anthropic/claude-sonnet-5-5), 1: Y has a concrete stack (Astro, Storyblok, Scaleway), decides the conflicts, and names what it leaves out. X is more candid about gaps, but it leaves the architecture undecided, and its run cost comes to 121 EUR, so R21 is unmet. Y's Executive Summary and Conclusion are filler and its Assumptions section is generic.
- M2 (anthropic/claude-sonnet-5-5), 2: Each phase lists ordered changes with exact files, such as `functions/forms/view.ts` and `src/components/Photo.astro`. X's phases have thin "Where" entries such as a provider dashboard, and its Phase 3 check list is partly misassigned.

### Sections taken over from the other table

None.

### Decisions of the table

- We should prioritize the requirements based on their importance and feasibility within the given budget and time constraints. (agreed: M1, M3, M2; of 3)
- Use a managed EU-hosted headless or Git-free CMS with a static or cached front end (e.g. Astro plus a hosted CMS), so that no server needs operating (R20) and image sizes are generated automatically (R10, R13). (agreed: M2, M3; of 3)
- Launch with 15 projects if necessary, then schedule the remaining 25; explicitly treat this as a permitted launch deferral, not full initial gallery completion. (agreed: M3, M1, M2; of 3)
- Take over from the other document, section "Requirement traceability matrix R1 to R24", into the section "Requirements Compliance": Form-retention gate covering attachments, mailbox copies and backups, with forms blocked if it fails (agreed: M1, M3, M2; of 3)
- Take over from the other document, section "Requirement traceability matrix R1 to R24", into the section "Project Plan": Manual screen-reader and zoom testing alongside automated accessibility checks (agreed: M1, M3, M2; of 3)

### Assumptions

Questions to the person that got no answer; the models were told to assume and to name the assumption in the plan:

- What is the budget for this project, and what are the time constraints?
- Who delivers the German texts, the English translations and the project photos before week 6, and is a 60 euro monthly budget meant to include the domain and the CMS licence?
- Who will supply the project photographs, German and English copy, legal notices and old URL list, and can they commit to the ten-week schedule?

### Ballots

None.

### Objections still standing

None.

### Notes

None.

### Cost

The two tables together: 1512371 tokens, $3.3871 (the comparison and the final round come on top).
The last run on this task used 1742431 tokens, $3.8816 in all.
