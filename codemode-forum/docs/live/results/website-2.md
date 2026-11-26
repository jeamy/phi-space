# Plan a website with the requirements of the uploaded document (website-requirements.md). The plan must say what is built

## Decision, scope and assumptions

Build the public site with **Astro and static hosting**, using an **EU-hosted headless CMS** for editing. This is the architecture decision, not yet a provider commitment. Provider selection and launch depend on verifying the CMS, hosting and form services against the €60 monthly cap, EU data-location and privacy requirements, editor workflow, backups and export. See [Architecture, providers and operating cost](#architecture-providers-and-operating-cost).

### Scope decisions

The plan prioritises legal and data protection, the old-URL redirects and usable editing over gallery size and polish. If necessary, launch with **15 projects rather than 40**: the 40-project launch requirement is then explicitly unmet, not redefined as complete. The remaining 25 need an assigned, dated and costed follow-up. Features excluded by R24 and products beyond the requirements are out of scope.

### Planning assumptions to confirm

- **Budget and deadline:** €18,000 for the build, ten weeks to launch, and no more than €60 per month to run. Treat these as constraints, but confirm whether taxes and third-party charges are included.
- **Content and production:** The joinery supplies approved German text and usable photos; English translation and content entry are not assumed to be free or unlimited. Their owner, cost and inclusion in the €18,000 remain unconfirmed. The 40-project commitment cannot be accepted until that work is estimated and assigned.
- **Client inputs and availability:** Assume the joinery can provide the German content, photos, a complete inventory of the 60 old URLs, legal review and two available editors within ten weeks. None is confirmed; late or incomplete inputs may prevent acceptance or reduce launch scope.
- **Outside person:** Their identity, role and required access are unconfirmed; access must be limited to what their agreed work requires.
- **Domain and email:** Existing ownership, access, provider and migration constraints are unconfirmed; do not assume that domain or email changes are included.

Confirm owners and deadlines for these assumptions before baselining the schedule; see [Roles, inputs and schedule](#roles-inputs-and-schedule) and [Risks and open decisions](#risks-and-open-decisions).

## Requirements and priority decisions

Here is the revised section "Requirements and priority decisions" based on the feedback and decisions made by the table:

**Baseline:** In Phase 1, the developer and client owner check the wording and thresholds in `website-requirements.md` and record acceptance evidence in `docs/acceptance.md` (new). The phase checks are specified in [Phased build and acceptance](#phased-build-and-acceptance).

Prioritize legal and data protection, redirects and usable editing over polish and project count. Attempt 40 projects at launch if inputs, capacity and funding permit. If necessary, the client owner may authorize a week-10 launch with at least 15; **R5’s 40-at-start requirement is then unmet**, even if R23 is met.

For launch and follow-up reporting, count a project when its required German content and fields and rights-cleared photos are complete and approved. English is not required for the count: where absent, the English route shows the German version with a notice under R9. Record the project count and English coverage separately.

### Requirement traceability

| ID | Requirement | Provision and failing check |
|---|---|---|
| R1 | Serve private customers seeking made-to-measure furniture. | Phase 2 presents the offer and enquiry route. Fail review if the enquiry form cannot be reached from the home page within two clicks. |
| R2 | Serve architects and builders seeking an interior-fittings partner. | Phase 2 presents relevant work and references. Fail review if references and the enquiry form are not reachable from navigation. |
| R3 | Serve applicants for the two annual apprenticeships. | Phases 2–3 provide an apprenticeship page and application route. Fail if the page is not reachable from navigation or its form fails R7. |
| R4 | Provide pages for kitchens, living, office and restoration, with photos and short text. | Phase 2 provides templates and CMS fields; Phase 4 checks supplied content. Fail if any page lacks its required text or photo. |
| R5 | Provide 40 projects at the start, then about 15 more a year; each has 5–12 photos, year, materials and up to 200 words, with filters by work and wood. | Phases 2 and 4 provide the model, gallery and filters. Fail validation for missing fields, invalid photo count or excessive text, and fail the filter test for wrong results. Fewer than 40 German-complete projects leaves R5 unmet at launch. The editors must have capacity to add about 15 a year; that future content and effort are not assured. |
| R6 | Show the workshop and people, opening hours and a map. | Phase 2 provides the page and a static map linked to an external map. Fail review if required content is absent or the page loads a third-party map request. |
| R7 | Provide an apprenticeship form for name, email, phone, letter and one PDF up to 5 MB. | Phase 3 uses a private application service. Fail if required fields are absent, a valid 5 MB PDF is rejected, or a 5.1 MB or non-PDF file is accepted. |
| R8 | Provide a contact form for name, email, phone, work type, text and up to three photos or plans. | Phase 3 uses a separate enquiry service. Fail if required fields are not validated, three valid files cannot be sent, or a fourth is accepted. |
| R9 | Provide German and English, with German first and a notice where English is missing. | Phase 2 builds language routes and German fallback. Fail if an untranslated page is missing, lacks the notice, or its language switch links to a 404. Missing English is reported, not a launch blocker. |
| R10 | Two untrained employees can maintain all content and photos in a browser; accept phone photos up to 12 MB and produce site-sized images. | Phases 2 and 4 provide CMS editing and image derivatives. Fail if either editor needs developer help or cannot upload a compliant 12 MB photo and publish it. |
| R11 | Changes are visible within five minutes of saving; drafts can be previewed. | Phase 3 connects publishing and preview. Measure save to public visibility, including queueing, image processing and deployment, on representative **40-project** content. Fail if any of three runs exceeds five minutes or if a draft is public or unavailable in preview. |
| R12 | Earlier versions can be restored for 90 days. | Prefer a verified CMS with 90-day per-edit history; test restoration in Phase 4. If only daily snapshots are available, overwritten same-day edits may be lost: **R12 is unmet**, not met by snapshots. Use that fallback only with the client owner’s written exception, and record the gap at acceptance. Fail acceptance without evidence of the required history or an approved exception. |
| R13 | Largest element appears within 2.5 seconds on 4G; the gallery’s first load is under 1.5 MB. | Phases 2 and 4 use responsive derivatives, thumbnails and lazy loading. Fail the specified throttled test if median LCP exceeds 2.5 seconds or normal first-load assets reach 1.5 MB. |
| R14 | Meet WCAG 2.2 AA. | Phases 2 and 4 use semantic markup, accessible controls and required alt text. Fail on an automated AA violation or a failed manual keyboard or accessibility review. Automated results alone do not prove full conformance. |
| R15 | Each page has its own title and description; provide business structured data and a sitemap. | Phase 2 generates metadata, LocalBusiness JSON-LD and a sitemap. Fail if required metadata is missing, structured data is invalid or a built page is absent from the sitemap. |
| R16 | Keep the old site’s 60 addresses working. | The client supplies and approves mappings; Phase 3 configures redirects. Fail if any of the 60 requests is not a single 301 to its approved destination returning 200. |
| R17 | EU hosting, no consent cookies and statistics without personal data. | The Phase 2 provider gate verifies all services and a privacy-compatible statistics solution. Fail if EU processing or anonymous statistics cannot be evidenced, or prohibited cookies are set. Include statistics in the operating quote. |
| R18 | Email form submissions to the office, store them for six months and delete them; only the two owners may see applications. | Phase 3 separates enquiry and application access and tests deletion. The recommended link-only application notification is an **exception to the email wording**, pending written approval; the form remains disabled until the decision and controls pass. Fail on unauthorised access, an expired accessible copy or its return after restoration. See [Data protection, deployment and recovery](#data-protection-deployment-and-recovery). |
| R19 | Provide Austrian-law imprint and privacy notice, and spam protection without a non-EU third party. | Phases 2–4 provide reviewed legal pages and service-side spam checks. Fail without recorded legal approval or if a bot-like test submission passes. |
| R20 | Employees run no server; an outside person spends at most one hour a month. | Managed services and static output avoid an employee-run server. Fail if a representative routine exceeds one hour. This is a routine limit, not a guarantee that incidents fit within it. |
| R21 | Run for at most €60 per month and build for €18,000. | The Phase 2 provider gate obtains quotes; the build forecast is reviewed throughout. **Neither cap is proven met.** Include services and paid outside help in the recurring total; fail if it exceeds €60 without an approved exception. Fail the build forecast if approved work cannot fit the ceiling. |
| R22 | Back up daily, restore within one working day and leave the provider with content and photos. | Phase 3 schedules content and media exports. Fail if a complete export cannot be restored within one working day or content and original photos cannot be taken away. Form-data backup coverage remains an open decision below. |
| R23 | Go online within ten weeks; the gallery may open with 15 projects. | Phase 5 targets week 10. Fail the deadline check if launch is later; record the German-complete count and any R5 exception separately. A compliant 15-project R23 launch does not satisfy R5’s 40-at-start requirement. |
| R24 | No shop, prices, customer login, newsletter or chat. | These are out of scope. Fail the Phase 4 scope and template review if any is present. |

### Conflicts and decisions

- **R23 versus R5 — ten weeks versus 40 projects:** Launch in week 10 with **15 approved projects**, subject to the owners supplying content on the assumed schedule. The owners are accountable for supplying and approving the remaining 25; the builder will help import them in five weekly batches of five, targeting 40 by the end of week 15. This post-launch work and its cost must be included in the build estimate. R5 remains unmet until all 40 are published and checked; see [Launch, content gap and follow-up](#launch-content-gap-and-follow-up).

- **R21 versus R20 and R22 — €60 per month versus managed services, backups and help:** The €60 ceiling is assumed to include CMS, hosting, forms, domain, backups, monitoring and **one hour of outside help**, not just provider subscriptions. No stack is approved until written, all-inclusive prices and a restore/export test demonstrate that it fits. If it does not, the owners must approve a higher operating budget or a revised service commitment before launch; the plan does not silently drop backups, export or the no-server-administration constraint. The one-hour allowance is a routine-operation limit, not a guarantee that incidents will fit within it.

- **R11 versus static rebuilds — publication within five minutes:** Use a CMS save webhook to trigger a static build and deployment, and measure from an editor’s save to the changed content appearing on the public site. The build must complete within five minutes under a representative 40-project load; queueing, image processing and deployment time count. If that test fails, optimize the pipeline and retest before acceptance; otherwise R11 remains unmet and the owners must approve a changed approach or publishing-time requirement.

- **R10 versus R13 — 12 MB phone photos versus a 1.5 MB gallery:** Accept photos up to 12 MB as source uploads, but generate appropriately sized responsive AVIF/WebP derivatives and serve thumbnails rather than original files in the gallery. Test the gallery’s transferred page weight against 1.5 MB under the requirement’s measurement conditions, including its normal images and page assets. If it fails, reduce derivative sizes or initial image count and retest; do not reject a compliant source photo merely to meet the delivery limit.

- **R12 and the operating cap:** Prefer verified 90-day per-edit history, including a successful restoration test. A cheaper daily export is a recovery source, **not equivalent to per-edit history and not full R12 compliance**. If it is the only available history, the client owner must approve the R12 exception in writing before committing to that configuration; record the missing same-day versions at acceptance. Otherwise select another service or obtain a revised budget. Apply this rule to both configurations in [Architecture, providers and operating cost](#architecture-providers-and-operating-cost), including its recommended low-cost fallback.

- **R18 and R22 — deletion versus backups:** Proposed daily content exports exclude submissions so long-lived content backups do not retain personal data past deletion. This does **not** establish R22 daily-backup coverage for form data. Before enabling forms, the legal reviewer and client owner must approve that scope or select separately protected form backups whose copies become irrecoverable by each submission’s six-month deadline. No deletion grace period is assumed.

## Architecture, providers and operating cost

### Architecture and provider gate

Build the public site with **Astro static output** and an **EU-hosted, browser-editable headless CMS**. This is an architecture decision, not a provider commitment. Storyblok is a candidate CMS and Bunny a candidate static host/CDN; neither is verified as suitable or affordable. The managed build, form and statistics providers remain unselected. Because the Storyblok-based estimate below is already known to exceed the cap, the plan keeps two named configurations and the Phase 1 gate chooses between them on written prices.

| Component | Intended use | Evidence required before selection |
|---|---|---|
| CMS | German and English content, drafts, previews, two editors, publishing webhook and export. | EU storage and processing, including subprocessors; sufficient seats; 90-day version recovery; original-media and content export; upload limits and price. |
| Static hosting/CDN | Serve immutable Astro releases and all 60 redirects. | EU processing and delivery, redirect support, TLS, rollback and price at expected traffic. |
| Managed build | Process images and deploy on publication without employee-run servers. | Queued builds, preview isolation, scheduling, alerts, usage limits and price; publishing tested later with 40 projects. |
| Images | Responsive derivatives from originals, including 12 MB phone photos. | CMS upload and export limits, derivative support, build-time capacity. |
| Forms and private files | Separate enquiries from applications; enforce access and retention. | EU processing, attachment limits, owner-only application access, deletion including provider backups, notification and API capabilities, price. |
| Statistics | Anonymous, cookie-free usage statistics. | EU processing, no personal data or consent cookies, price. |
| Backup storage and monitoring | Encrypted content and original-media exports; alert an operator on failure. | EU processing, retention, access, restore capability, alert delivery, price. |

The developer records evidence, links, dates, limits and written or published prices in `docs/provider-check.md` (new), for both configurations below. Verify actual tiers rather than assuming that any entry tier includes the needed seats or 90-day versions. If a mandatory capability fails, select another managed EU service or seek an approved requirement or budget change; do not replace it with a self-run server.

Version history and backups are separate controls. A daily export is not automatically equivalent to 90-day edit history. The content export holds structured content and original media, not submissions. The form-data backup gap is in [Requirements and priority decisions](#requirements-and-priority-decisions) and [Data protection, deployment and recovery](#data-protection-deployment-and-recovery).

### Two configurations to price

**Configuration A (full, Storyblok-class CMS):** a paid CMS tier with native 90-day versions, a managed build, a dedicated EU forms service. It meets R12 natively but is estimated well above €60.

**Configuration B (low-cost fallback, all guesses):** a free or lowest-tier EU CMS with at least two seats; static hosting with its included build minutes and scheduled jobs; a single EU form handler with a separate private application endpoint; a low-cost EU cookie-free statistics plan; and encrypted daily exports to cheap EU object storage, kept for 90 days and written as dated files (for example `exports/YYYY-MM-DD/`). R12 is then met by **daily snapshots, not per-edit history**: an edit made and overwritten the same day can be lost. This is the requirement traded away, and it needs written acceptance from the client owner. If the chosen CMS free tier lacks versions, B also accepts that editors cannot compare versions in the browser; a restore means importing the item from an export, performed by the outside operator.

| Item | A, monthly guess | B, monthly guess |
|---|---:|---:|
| CMS | €20 | €0 (free tier; seats unverified) |
| Hosting, CDN, redirects | €5 | €0–5 (free or lowest tier) |
| Backup storage (90 daily exports) | €5 | €2 |
| Build and scheduler | €5 | €0 (included host minutes) |
| Forms and private applications | €15 | €8 |
| Statistics | not priced | €6 |
| Domain renewal | €2 | €2 |
| Reserve | €8 | €4 |
| **Services subtotal** | **€60 plus statistics** | **€22–27** |
| Outside operator, 1 hour at the guessed €90 | €90 | €90 |
| **Total with labour** | **€150 plus statistics** | **€112–117** |

**R21's €60 cap includes everything, including paid help.** Even B, with services near €25, exceeds the cap once one paid hour is counted at €90. B fits only if the outside person's time is covered otherwise: either the routine is cut to about 20 minutes at a lower agreed rate (a guess; €60 minus €27 leaves roughly €33), or the client approves a higher cap. A is not recoverable within €60 under any labour assumption.

### Decision

**Recommendation:** pursue B as the primary candidate and use A only if B fails a mandatory capability test. The decision is the client owner's, made by the end of week 2 on written prices, with these routes:

1. **Recommended:** B, with a documented, client-approved reading of R12 (daily snapshots for 90 days) and an operator routine agreed at no more than about €33 a month.
2. Approve a higher recurring cap, at least €115 for B or €150 plus statistics for A.
3. Approve a specific requirement change and reprice. Do not silently drop recovery, privacy or managed operation.

If no stack satisfies both the 90-day recovery and €60, **the cap gives way before recovery or privacy**; R21 is then recorded as an approved exception, not as met. Until a route is evidenced and approved, R21 is not proven met and the provider gate fails. Taxes, overages and any email-provider form charges must appear in the final quote. The build estimate is separate; see [Build estimate and cost controls](#build-estimate-and-cost-controls).

### Verification in order

- **Phase 1 — capability and price gate:** The developer checks A and B against `docs/provider-check.md`. Fail the gate if mandatory capabilities or EU processing lack evidence, a price is missing, or the total with labour exceeds €60 without an approved cap change or exception.
- **Phase 2 — export feasibility:** With disposable content and media, export and import into an empty CMS space. Fail if fields, entry counts or original-media hashes differ. Do not configure the real model until this passes.
- **Phase 3 — implemented services:** Test publishing, forms, retention and scheduled exports. Fail if a control or the 40-project five-minute publish test fails. For B, also fail if an item restored from a daily export differs from its source.
- **Phase 4 — operating routine:** Time the outside operator on the real routine and the restore. Fail R20 above one hour; fail the cost review if recurring charges plus paid time exceed the approved cap.
- **Phase 5 — production confirmation:** Recheck deployed services, prices and handoff. Fail if a required service is unverified or the approved cap is exceeded.

The public build contains no submissions or private attachments. Use individual accounts and MFA where supported, grant only necessary access, and remove it when work ends.

## Roles, inputs and schedule

The R9 line, as the source holds it, wraps over two lines. The quote below uses the first line exactly as read (lines 20-21 of `website-requirements.md`) and does not paraphrase.

### Roles and handoffs

Names are placeholders until the client appoints individuals. Availability is a planning assumption, not a commitment.

| Role | Responsibility and handoff | Assumed availability |
|---|---|---|
| Developer / technical lead | Owns technical decisions, implementation, provider checks, deployment and recovery tests. Builds the German-fallback template in Phase 2. Receives approved content and redirect mappings; hands the client a tested site and operating instructions. | One lead for ten weeks; capacity and rate to be confirmed. |
| Designer | Produces page, mobile and accessibility designs, including the fallback notice. Hands approved designs to the developer. Reviews staging with the client. | Weeks 1–3 and reviews in weeks 6–9. |
| Client project owner | Decides scope and spending, supplies and approves German content and photos, assigns legal review, owns the URL inventory, accepts the release. | Weekly; decisions within two working days. |
| Two client editors | Enter and check content, learn the CMS, run the publishing test. | Training and testing in weeks 6–9; entry time to be confirmed. |
| Translator / content specialist | Translates English pages in the priority order below. Appointment and funding are not confirmed. | Weeks 2–7 and after launch, subject to agreement. |
| Legal/privacy reviewer | Reviews legal pages, privacy notices, form wording and retention. | Weeks 4 and 8. |
| Outside person | Identity and task unconfirmed. No access until appointed; least privilege. | Not assumed available. |

The client owner is the single acceptance and escalation contact. The developer reports missed dependencies weekly; the client decides scope exceptions and spending. Work order and checks are in [Phased build and acceptance](#phased-build-and-acceptance).

### German first, English as it becomes ready (R9)

The source states the rule as follows (the sentence continues on the next line of the file):

> `website-requirements.md`: - R9. German and English; German is written first, English may follow days later, and a page without an English

The second line reads "version shows the German one with a notice." **English is therefore not a launch gate.** A page or project without approved English launches in German with the visible notice. Only the pages in the priority list below are wanted in English at launch; a miss there is reported, not blocking.

English priority, in order of translation:
1. Home page, enquiry form, navigation and legal pages (legal pages in English only if the legal reviewer approves the text; otherwise German with notice).
2. The four kind-of-work pages.
3. The first 15 projects, then the remaining 25.

Consequences elsewhere in the plan:
- Phase 2: `src/pages/en/[...slug].astro` (new) renders the German entry plus `src/components/FallbackNotice.astro` (new) when the English field is empty. The page must return HTTP 200 and contain the notice.
- Phase 4: `scripts/check-content.mjs` (new) counts a project as complete when German text, required fields and rights-cleared photos are approved. Missing English is a warning. The English share is reported beside the count.
- The launch gates' "approved in both languages" reads "approved in every language in which the page is published".
- Phase 2 check that can fail: build with one deliberately untranslated page; fail if no notice appears, the page is missing, or the language switcher links to a 404.

### Input deadlines and launch impact

Dates are relative to project start; calendar dates are set at kickoff. "Complete" means supplied in usable form and approved.

| Deadline | Input and handoff | If missed |
|---|---|---|
| End of week 1 | Client appoints owner, two editors, translator, legal reviewer and any outside person; confirms access to domain and old site. | Schedule cannot be baselined; launch at risk. |
| End of week 2 | Client supplies all 60 old URLs (paths and query variants) with a proposed destination each. | Redirect acceptance blocked; launch blocker unless the client accepts R16 as unmet. |
| End of week 3 | Approved German site-wide copy and German text plus rights-cleared photos for the first 15 projects. | Entry and performance tests slip; launch content at risk. |
| End of week 4 | Translator delivers English for priorities 1 and 2; legal reviewer returns first comments. | Pages launch in German with notice. Unresolved legal comments may block forms. |
| End of week 6 | German text and photos for the remaining 25 projects; English for the first 15 delivered. | 40 at launch is at risk; report the count. |
| End of week 7 | Editors finish entry of all German-ready projects. | Launch with the German-complete count (15 minimum) under the exception. |
| End of week 8 | Written final legal approval; client approves redirect mapping. | Blocks the affected service or redirect acceptance. |
| End of week 9 | Editors trained; client signs off content, destinations and release. | Correct before release or replan. |
| After launch | Translator delivers remaining English in priority order; funding in [Build estimate and cost controls](#build-estimate-and-cost-controls). | Pages stay German with notice; no breach of R9. |

### Assumptions and what this section leaves out

- Assumed: the joinery can supply German content, photos, the URL inventory, legal review and two editors on these dates. None is confirmed.
- Not covered: translator rates and hours beyond the guesses in [Build estimate and cost controls](#build-estimate-and-cost-controls), and calendar dates, which need the real start date.

## Phased build and acceptance

The paths below are proposed and do not yet exist, apart from `website-requirements.md`. The developer owns technical work unless another role is named. Each phase ends with a runnable build and a check that can fail. Recovery controls and detailed form tests are in [Data protection, deployment and recovery](#data-protection-deployment-and-recovery).

### Ordering and gates

The order is: Phase 1, then the provider gate at the start of week 3, then Phases 2 to 6. Each step uses only what an earlier step produced.

- **Phase 1 needs no decision and no provider account.** It has three parallel tracks: local build and design; client inputs and URL discovery; and provider evidence collection. Evidence is collected in Phase 1 but not judged there.
- **Provider gate (start of week 3, between Phase 1 and Phase 2).** It is a decision point, not a phase. The decisions it needs are:
  - the selected CMS, host, build, form and statistics providers;
  - the all-inclusive operating arrangement and any approved cap or R12 exception;
  - application delivery;
  - the form-data backup scope.

  The client owner records them in `docs/decisions.md` (new). The legal reviewer agrees the backup scope. The developer checks `docs/provider-check.md` (new) against them.
- **Gate check, which can fail.** The gate fails if any of these holds:
  - a cell in `docs/provider-check.md` is empty;
  - a data location is outside the EU;
  - a written price with its read date is missing;
  - 90-day version history is not shown, with no approved R12 exception;
  - the monthly services total plus the paid outside hour exceeds the approved cap.

  The gate does not need the URL inventory. It does not claim that export or restore has passed, because those are tested in Phase 2.
- **Phase 2 starts only after the gate passes.** If the gate is late, only the provider-independent local track of Phase 1 continues. The client owner and developer then rebaseline the schedule, cost and any 15-project exception. A smaller gallery does not waive the gate.
- **Dependencies:** Phase 2 needs Phase 1 and the gate. Phase 3 needs Phase 2. Phase 4 needs Phase 3. Phase 5 needs Phase 4. Phase 6 needs Phase 5 and approved follow-up funding.
- `npm run verify` runs the checks available at each phase. A missing credential or setting fails explicitly and never skips a check silently. Production tests use synthetic data.

### Phase 1: weeks 1–2 — baseline and parallel preparation

**Depends on:** project start only.

1. **Local track.**
   - Compare R1–R24 with `website-requirements.md` and record thresholds and checks in `docs/acceptance.md` (new).
   - Create `package.json` (new), `package-lock.json` (new), `astro.config.mjs` (new), `src/pages/index.astro` (new), `README.md` (new) and `scripts/verify.mjs` (new).
   - The designer prepares mobile and accessible layouts. Provider-neutral fixture templates need no credentials.
2. **Input track.**
   - The client owner appoints the roles. A draft old-URL inventory is due in week 1 and the full list by the end of week 2.
   - Record each source and proposed destination in `data/redirects.csv` (new), with columns `source,destination,status,approved`.
   - If the list is late, the developer crawls the old site and marks the results unapproved. A crawl does not prove completeness.
3. **Evidence track.**
   - Start `docs/provider-check.md` (new) and `docs/decisions.md` (new).
   - Request written data location, retention, export, 90-day version history, seat and price evidence for A and B.
   - Prepare the gate decisions.

**Phase 1 check:** On a clean checkout, `npm ci && npm run build && npm run verify` exits 0. A local preview of `/` returns HTTP 200 with no `Set-Cookie` header. It fails on a non-zero exit, a missing `dist/index.html`, a cookie, or a requirement in `docs/acceptance.md` with no recorded check. Missing client inputs are reported separately.

### Phase 2: weeks 3–4 — export feasibility, models and templates

**Depends on:** Phase 1 and the passed provider gate. Use disposable data until step 1 passes.

1. **Restore test first.**
   - Create `docs/test-schema.json` (new) and `scripts/export-content.mjs` (new).
   - Export a disposable entry and its original media. Import them into an empty second CMS space.
   - Compare entry count, field values and image hashes. Fail on any difference.
   - The real model is configured only after this passes.
2. Write `docs/cms-schema.md` (new) and configure the models: page, work type, project, person and legal page. Before changing a shared model, export content, media and model settings.
3. Add `src/content.config.ts` (new), `src/lib/cms.ts` (new), `src/layouts/BaseLayout.astro` (new), `src/styles/global.css` (new), `src/pages/sitemap.xml.ts` (new) and `public/robots.txt` (new).
   - Build the templates, including exactly four work-type pages and the legal routes under `src/pages/de/` and `src/pages/en/` with temporary placeholders.
   - The schema requires German text and, for each project, 5–12 photos, alt text, year, materials and at most 200 words.
4. **Images and language fallback.**
   - Add `src/lib/images.ts` (new), `src/components/Image.astro` (new) and `src/components/Gallery.astro` (new), with AVIF/WebP derivatives, thumbnails and a 40-project fixture.
   - Add `src/components/FallbackNotice.astro` (new), `src/components/LanguageSwitcher.astro` (new) and `src/pages/en/[...slug].astro` (new).
5. Add `scripts/check-seo.mjs` (new), `scripts/check-privacy.mjs` (new), `scripts/check-a11y.mjs` (new) and `lighthouserc.json` (new), and extend `scripts/verify.mjs`.

**Phase 2 check:** The fixture site builds and `npm run verify` passes. Fail if any of these holds:

- the export/import comparison differs;
- a test entry without a required German field still builds (the build must break);
- the CMS accepts a project with no alt text, over 200 words, or fewer than 5 or more than 12 photos;
- the work-type count is not four, or the filter by work and wood returns wrong entries;
- an untranslated English route lacks the notice or its switcher links to a 404, or a page with English shows German body text;
- a 12 MB photo cannot be uploaded, or a public page links an original;
- SEO, accessibility or privacy checks fail;
- median LCP over three throttled 4G mobile runs exceeds 2.5 s on home or gallery, or the 40-project gallery first load reaches 1.5 MB.

Legal placeholders are allowed only in this phase.

### Phase 3: weeks 4–6 — publishing, redirects and services

**Depends on:** Phase 2 and the recorded provider, operating, application-delivery and form-backup decisions. Real submissions stay disabled until their controls and legal approval pass.

1. Configure staging, isolated draft preview, the publishing webhook and build queue. Record settings and rollback in `docs/deployment.md` (new), and keep the last working release.
2. Validate `data/redirects.csv` and resolve discrepancies with the client owner. Generate the host configuration under `deploy/` (new) and create `scripts/check-redirects.mjs` (new). Preserve the previous configuration. Client approval of destinations is a Phase 4 prerequisite.
3. Create `src/components/EnquiryForm.astro` (new) and `src/components/ApplicationForm.astro` (new), with separate service permissions, attachment validation and service-side spam checks. Record configuration in `docs/forms-operations.md` (new).
4. Retention, using the provider's native expiry if it enforces it:
   - Where it does, set six months and verify it.
   - Where it does not, create `scripts/purge-submissions.mjs` (new) with a dry-run mode, a daily scheduler and alerts.
   - Either way, keep `data/deletion-register.csv` (new). The daily run keeps any record's overrun beyond its deadline below one day, so schedule deletion earlier by a stated margin, and tell the owners the margin.
5. Extend `scripts/export-content.mjs` for encrypted daily exports of content and originals, excluding submissions. Implement the approved form-backup decision separately and test restore into an empty space.
6. Add cookie-free statistics in `src/layouts/BaseLayout.astro`, configure monitoring and test alerts. Create `scripts/check-forms.mjs` (new) and extend `scripts/verify.mjs`.

**Phase 3 check:** Staging runs and `npm run verify` passes. Fail if any of these holds:

- the inventory has other than 60 unique sources, lacks a destination for any, has duplicates or loops, or any staged source fails to give one 301 to a destination returning 200;
- any of three save-to-public runs on 40-project content exceeds five minutes;
- a draft is public or missing in preview;
- a deliberately broken build replaces the live release;
- a staging response sets a cookie or loads a third-party script;
- valid forms fail, a fourth attachment, a non-PDF or a 5.1 MB PDF is accepted, or a honeypot or under-three-second post passes;
- a valid 5 MB PDF is rejected, or test mail does not arrive within five minutes;
- a non-owner account opens an application;
- a back-dated 184-day test entry and its attachment survive, a 100-day entry is deleted, or a delayed purge run leaves a copy past its deadline;
- a missed-run alert does not arrive;
- exported or restored content or media differs, or private data appears in the build.

On a service or retention failure, disable the affected form and restore approved settings. Do not restore expired submissions.

### Phase 4: weeks 6–9 — content, training and acceptance

**Depends on:** Phase 3 staging. Final acceptance also needs approved redirect destinations and legal text.

1. Before each entry batch, export content and media and verify a restore into staging. Editors enter approved content. Create `scripts/check-content.mjs` (new) to validate German fields, year, materials, photo counts, alt text and word limits. Missing English is reported separately.
2. Replace legal placeholders with reviewed text and record approval in `docs/release-record.md` (new). The acceptance build fails if a legal page lacks a reviewer name and review date.
3. Review keyboard and screen-reader use for home, gallery, project and both forms using `docs/acceptance.md`.
4. Restore an earlier page version and confirm it shows publicly. If only daily snapshots exist, test the snapshot restore and record R12 as unmet unless the client has approved the exception.
5. Train both editors with `docs/editor-guide.md` (new). Each independently uploads a 12 MB photo, then edits, publishes and corrects a project.
6. The outside operator times the routine and restores the export into an empty space. Record time, result and recurring cost.
7. Run the broken-link check, the R24 scope review, the 60-URL redirect test and the repeat of the Phase 2 performance tests on full content.

**Phase 4 check:** Staging runs and `npm run verify` passes. Fail if any of these holds:

- required content or legal approval is missing;
- axe reports a serious or critical issue, or a manual blocker remains open;
- either editor needs developer help;
- publishing exceeds five minutes;
- an internal link is broken;
- the recovery test fails;
- the routine exceeds one hour;
- a restore differs or exceeds one working day;
- recurring cost exceeds the approved cap;
- a shop, price, login, newsletter or chat is found;
- fewer than 15 German-complete projects exist.

Below 40, record R5 as unmet and require the written exception.

### Phase 5: week 10 — release and production verification

**Depends on:** Phase 4 acceptance, all 60 approved mappings, legal approval and the client's release decision.

1. Export content and media. Record the release, redirect configuration and DNS in `docs/release-record.md`.
2. Deploy, changing only agreed web DNS or host records and leaving mail records unchanged. Enable each form only after its gates pass.
3. Confirm the scheduler and a test alert to the operator. Hand over accounts. Run a synthetic accelerated expiry test, then restore and read back the approved retention.

**Phase 5 check:** Production runs. Fail if any old URL misses, loops or reaches the wrong destination, or if the home page, a redirect sample or an enabled form fails within one hour of the switch. Also fail on a production privacy, accessibility, SEO or performance failure, a failed expiry test, read-back or alert, or costs above the approved cap.

**Way back:** Stop acceptance, disable the affected form, redeploy the previous release and restore only the changed web DNS or host records. Rerun `scripts/check-redirects.mjs` and verify the mail records are unchanged. Record the failure, owner and retest date.

### Phase 6: after launch — follow-up to 40 projects

**Depends on:** Phase 5 sign-off and approved follow-up funding and capacity. Assigned work, dates and costs are in [Launch, content gap and follow-up](#launch-content-gap-and-follow-up). Export and verify recovery before each batch.

**Phase 6 check:** The site stays runnable and `npm run verify` passes. At the week-15 review, fail if `scripts/check-content.mjs` finds fewer than 40 German-complete public projects or a missing required field. Report English coverage separately.

## Data protection, deployment and recovery

### Form delivery and access

- **Enquiries:** Send the submission to the office mailbox; use private service links for attachments where necessary. The form service, attachment store and mailbox copies are subject to the deletion controls below.
- **Applications:** Recommend an office notification containing only “new application received” and a link. The submitted details and PDF remain in private storage accessible only to the two owners. This is an exception to R18’s email wording: the client owner must approve it in writing by the end of week 2. Alternatively, send the content to the owners’ individual mailboxes only after verifying that no delegates or other users have access and that all copies meet the same deletion deadline.
- Keep the application form disabled for real submissions until delivery, access, retention, backup scope and legal approval are settled and tested. Apply the same retention controls to replies, sent items, forwarded messages and other copies; prohibit uncontrolled forwarding and downloads unless they can also be deleted on time.

Record the decision, providers, access lists, settings and evidence in `docs/forms-operations.md` (new). The legal reviewer approves it before either form receives real submissions.

### Per-submission deletion deadline

For each submission, record its receipt time and calculate its deadline as **six calendar months after receipt**. Use an earlier automatic deletion time with a documented safety margin where needed; 180 days alone is not a guarantee of six-calendar-month compliance. The service must make every copy irrecoverable **by that submission’s deadline**, including attachments, mailbox folders and sent items, logs, provider replicas and backups. A backup expiring 180 days after *backup creation* is insufficient: it may outlive the submission’s own deadline.

The developer must establish and test these controls before enabling a form:

1. **Primary storage and mail:** Configure automatic expiry against the original receipt time, including a server-side mailbox filter and retention rule covering the relevant folders and sent items. Verify that deleted items and provider-held mail copies also meet the deadline. The appointed deletion owner checks failures and overdue items; monthly inspection is an additional control, not the deletion mechanism.
2. **Independent purge and alerting:** Configure `scripts/purge-submissions.mjs` (new) to run daily through the approved managed scheduler, delete records and attachments ahead of their deadlines, and alert the deletion owner on failure or a missed scheduled run. Store only `id,received,deleted` in `data/deletion-register.csv` (new), in protected persistent storage. A daily job by itself cannot guarantee the deadline: the provider’s independent expiry control must still work if that job is delayed or missed. If either control cannot be evidenced, keep the affected form disabled.
3. **Backups and recovery:** The planned `scripts/export-content.mjs` (new) exports CMS content and original media, not submissions. This avoids submission copies in those exports but **does not prove R22 backup coverage for form data**. Before enabling forms, the client owner and legal reviewer must approve that scope or choose a separately protected form backup whose individual copies become irrecoverable by each submission’s deadline—for example, per-submission encryption with reliably destroyed keys. Provider evidence must cover replicas and provider-managed backups as well as the selected service’s visible storage. Disable the affected form if the provider cannot guarantee the deadline; no backup grace period is assumed.

Do not put submissions or attachments in public builds, CMS content, deployment artifacts or routine logs. Restrict any permitted backup and restoration environment to authorised people; never restore personal data into a public or less-restricted environment.

### Verification and failure response

- **Phase 1:** Review written provider evidence for per-submission expiry, mailbox and backup deletion, permissions, alerts and applicable limits. Fail the provider gate if any required guarantee or cost is missing; capability claims are not a substitute for later tests.
- **Phase 2:** With disposable content and media, verify export and import into an empty CMS space. Fail if fields, entry counts or original-media hashes differ. Do not put real submissions in the test.
- **Phase 3:** Use `scripts/check-forms.mjs` (new) with synthetic records and accelerated deadlines. Verify owner-only application access, notification contents, deletion of records, attachments and mailbox copies, and continued availability of a non-expired record. Delay or skip a purge-job run and fail if independent expiry does not remove every test copy by its deadline or the missed-run alert does not arrive. Restore every applicable test backup or replica and fail if expired test data is recoverable. Also invoke the deployed daily export and purge jobs and test their failure alerts. Keep the affected form disabled on any failure.
- **Phase 4:** Repeat access and expiry tests with the two real owner accounts and the real mailbox configuration, using synthetic messages. Verify provider evidence for the actual retention interval and restore an authorised test export into an empty staging space. Fail if an unauthorised user gains access, a copy survives its deadline or reappears after restoration, or the restore differs or exceeds one working day. Record evidence in `docs/forms-operations.md` (new).
- **Phase 5:** Run a synthetic production expiry and alert test with an accelerated deadline. Restore the production retention configuration, read it back and verify it against the approved per-submission deadline. Fail acceptance and disable the affected form if the test, alert or read-back fails. Do not treat a successful accelerated test as proof of undocumented provider backup guarantees.

On a deletion or access failure, disable the affected form, notify the client owner and legal reviewer, preserve evidence without exposing personal data, and follow the agreed incident procedure. Resume only after correction and a passing retest.

### Change and recovery controls

The developer tests changes with synthetic data; the client owner authorises production changes. Encrypt exports and restrict them to named operators. Record settings and recovery evidence in `docs/deployment.md` (new) and `docs/forms-operations.md` (new).

| Change and risk | Before change | Way back and failing check |
|---|---|---|
| **Phase 2: CMS model** — fields or media may be lost or hidden. | Export content, original media and model settings. | Restore the previous model in staging and rebuild. Fail if fields, language versions or media differ. |
| **Phase 3: build, webhook and staging** — publishing may stop. | Record settings and preserve the last working release. | Restore settings and redeploy that release. Fail if the home page, language routes or a test publish fails. |
| **Phase 3: redirects** — old links may break. | Preserve the previous host configuration and `data/redirects.csv` (new). | Redeploy the previous configuration. Run `scripts/check-redirects.mjs` (new); fail on a missing, looping or incorrect mapped destination. |
| **Phase 3: forms, mailbox rules or retention** — submissions may be exposed, lost or retained too long. | Save settings and access lists, not submission data; warn the office before production changes. | Disable the affected form, restore approved settings and rerun access, expiry, delayed-job and restoration tests. Expired data must not be restored. If form submissions were excluded from backups, lost submissions cannot be recovered; document this risk in the backup-scope decision. |
| **Phase 4: bulk content entry** — approved content may be overwritten. | Export content and media before each batch. | Restore the item or batch in staging. Fail if restored content or original-media hashes differ from the export. |
| **Phase 4: purge or retention change** — data may persist too long or be deleted too soon. | Preserve the approved settings and protected deletion register. | Reapply approved settings or disable the form; rerun expiry and delayed-job tests. Fail if an expired test copy remains or returns. |
| **Phase 5: release and DNS** — site or mail may fail. | Preserve the previous release, redirects and DNS records; leave mail records unchanged. | Redeploy the previous release and restore only changed web DNS records. Fail if the old site, checked redirects or unchanged mail records cannot be verified. |

These controls supplement [Phased build and acceptance](#phased-build-and-acceptance). The unresolved backup and delivery decisions are recorded in [Risks and open decisions](#risks-and-open-decisions).

## Launch, content gap and follow-up

### Launch decision

At the end of week 9, the developer reports the acceptance evidence to the client owner, who records the release decision in `docs/release-record.md` (new). Week 10 launch requires the gates in [Phased build and acceptance](#phased-build-and-acceptance) to pass; a project-count exception does not waive them.

The client approves every language version actually published and the rights-cleared images. A page without approved English may use the German fallback and notice; missing English is reported separately and does not block launch. Production redirects and enabled forms must pass their checks. If a production check fails, stop acceptance and follow [Data protection, deployment and recovery](#data-protection-deployment-and-recovery); record the failure, responsible person and retest date.

### Project-count exception and completion

Count a project when its required German content and fields and rights-cleared photos are complete and approved. Record the German-complete count and English coverage separately in `docs/release-record.md` (new).

If at least **15** are ready and the other gates pass, the client owner may authorise launch in writing. **R5’s requirement for 40 projects at launch remains unmet.** Without that exception, defer launch rather than claim full compliance.

The following is a **relative-dated, costed contingency**, not a commitment until named people, inputs and funding are agreed. The €1,960 is reserved as described in [Build estimate and cost controls](#build-estimate-and-cost-controls); the amounts below are unverified guesses.

| Deadline | Owner and handoff | Follow-up cost guess |
|---|---|---:|
| End of week 11 | Client owner supplies approved German text and rights-cleared photos for the remaining 25 projects to the editors and translator. | Client-supplied; internal effort not priced. New photography or German copywriting needs a separate quote. |
| End of week 13 | Translator delivers English versions and client approves those ready to publish. Missing English does not prevent German publication with the notice. Allow **10 hours at €60/hour**. | €600 |
| End of week 14 | Editors enter the 25 German-complete projects, add approved English where available, and check images and links; client approves the published versions. Allow **25 hours at €40/hour** for funded entry support if client capacity is unavailable. | €1,000 |
| End of week 15 | Developer runs content validation, checks representative published pages and performance, and reports the German-complete count and English coverage to the client. Allow **4 hours at €90/hour**. | €360 |
| | **Estimated funded follow-up** | **€1,960**, excluding applicable tax, new photography, German copywriting and client internal time. |

The week-15 check fails if fewer than 40 German-complete projects are publicly available or validation finds missing required fields. Missing English is reported separately. On failure, the client owner assigns corrections and a new date; later completion does not retroactively satisfy the 40-at-launch requirement. If inputs, capacity or funding are not committed, week 15 remains a target rather than an agreed delivery date.

## Build estimate and cost controls

### Build estimate

Rates, hours and amounts are **planning guesses**, not quotes. The estimates cover the work and checks assigned in [Phased build and acceptance](#phased-build-and-acceptance). Obtain capped quotes and confirm capacity before commissioning.

| Phase | Developer at €90/h | Designer at €70/h | Translation/content specialist at €60/h | Estimated cost, before VAT |
|---|---:|---:|---:|---:|
| Phase 1: baseline, provider checks and skeleton | 20 h | 6 h | — | €2,220 |
| Phase 2: templates, CMS model and images | 32 h | 14 h | — | €3,860 |
| Phase 3: publishing, redirects and forms | 34 h | — | — | €3,060 |
| Phase 4: content support, training and acceptance | 24 h | 6 h | 15 h | €3,480 |
| Phase 5: release and handover | 14 h | — | — | €1,260 |
| **Total** | **124 h** | **26 h** | **15 h** | **€13,880** |

The 15 specialist hours are a provisional allowance for site-wide English and the first 15 projects. They assume concise, approved German copy and usable photos; client editors enter content. Confirm the allowance against a content sample and quote. Client staff time is not priced here.

### Allocation and VAT scenarios

The **€1,960 follow-up allocation** is a guess: translation €600, entry €1,000 and developer check €360. It is proposed, not committed funding. Its scope and conditions are in [Launch, content gap and follow-up](#launch-content-gap-and-follow-up).

The following comparison assumes, solely for planning, that all quoted build and follow-up work is taxable at 20% and that the client cannot recover VAT. Confirm the applicable rates, invoice basis and recoverability. Apply VAT only to taxable costs; do not add it again to a gross quote.

| Calculation | €18,000 net ceiling | €18,000 gross ceiling |
|---|---:|---:|
| Ceiling available before VAT, under the assumption above | €18,000 | €15,000 |
| Phase 1–5 estimate, before VAT | €13,880 | €13,880 |
| Proposed follow-up, before VAT | €1,960 | €1,960 |
| **Remaining contingency before VAT** | **€2,160** | **−€840** |
| VAT on estimated work and follow-up at 20% | €3,168, outside the net ceiling | €3,168, inside the gross ceiling |
| Estimated work and follow-up including VAT | €19,008 | €19,008 |
| **Position against stated ceiling** | **€2,160 net remains** | **€1,008 gross over cap** |

Under a gross cap, even the proposed base work and follow-up do not fit on these assumptions, before legal review or development services. Phase 1–5 alone would cost €16,656 including VAT, leaving €1,344 gross; that remainder cannot also fund the €2,352 gross follow-up. Under a net cap, VAT is additional cash to budget for, not zero.

### Other costs to quote

These guesses are **before VAT** and are not included in the phase estimate or follow-up allocation.

| Item | Guessed range | Basis |
|---|---:|---|
| New photography | €0–€2,500 | Zero if the client supplies usable photos; upper end guesses a professional shoot for 15 projects. |
| German copywriting | €0–€1,500 | Up to about 25 hours at €60/h for site-wide copy; project texts remain with the client. |
| External legal review | €300–€900 | Imprint, privacy notice, forms and retention. |
| Development service charges | €50–€150 | Staging for roughly ten weeks; confirm whether charges are taxable. |
| **Total** | **€350–€5,050** | |

With usable client photos and text, the guessed €350–€1,050 for legal review and development charges fits the **€2,160 net contingency**, leaving €1,810–€1,110 net, assuming those charges are inside the build budget. It does not fit the gross scenario, which is already over budget. Photography, copywriting or higher quotes can exhaust the net contingency. The budget is **not yet shown to be funded**.

Do not count the follow-up allocation and contingency as the same money. Release the allocation only against an approved, assigned and quoted plan. If all 40 projects are ready at launch, reassess any unused allocation rather than assuming it can cover the same work twice. Recurring charges after launch are assessed separately in [Architecture, providers and operating cost](#architecture-providers-and-operating-cost).

### Cost controls and failing reviews

The developer records actual hours, commitments, tax basis and estimate to complete weekly in `docs/release-record.md` (new), and reports the forecast to the client owner. Compare like with like: net costs against an approved net ceiling, or gross costs against a gross ceiling. Include the funded follow-up and expected mandatory costs once, and show VAT separately. The client approves contingency use before commissioning.

- **Phase 1:** Fail the budget baseline if capacity, VAT basis, content suppliers or cost owners for the other costs remain unconfirmed.
- **Phase 2:** Fail if actual and committed costs plus the estimate to complete and expected other costs exceed the applicable ceiling, or forecast hours exceed the table total by more than 15%. Decide scope or funding before Phase 3.
- **Phase 3:** Fail the weekly review if a provider, forms or recovery commitment exceeds the approved allocation. Obtain approval or replan before commissioning.
- **Phase 4:** Repeat the forecast with the quoted follow-up and any new mandatory costs. Fail above the applicable ceiling or above 15% over estimated hours.
- **Phase 5:** Fail financial acceptance if actual and committed costs plus funded remaining work exceed the approved ceiling, or if follow-up is called funded without approval and assigned capacity.

Technical checks remain separate in [Phased build and acceptance](#phased-build-and-acceptance). If the forecast exceeds the ceiling, cut optional polish first and use client content entry only where capacity is confirmed. Do not silently cut privacy, redirect verification or editor acceptance; obtain funding or replan if mandatory work still does not fit.

### Open budget decisions

| Decision | Recommendation | Owner | Deadline |
|---|---|---|---|
| VAT basis and recoverability | Confirm whether €18,000 is net or gross, applicable rates and recoverability; replace the scenario assumptions with quotes. | Client owner, with developer | End of week 2 |
| Other costs and content supply | Obtain photography, copywriting, legal and development-service quotes; plan on client-supplied photos and German text. Assign each cost owner. | Client owner | End of week 2; update as quotes arrive |
| Fund the 25-project follow-up | Provisionally allocate €1,960 before VAT; quote and assign it, then record approval or shortfall. Under a gross cap, first resolve the forecast overrun. | Client owner | Allocation by end of week 2; commitment by end of week 9 |
| Overrun route | Prefer confirmed client-supplied content and, if necessary, a 15-project launch. If mandatory work or the funded follow-up still does not fit, approve more funding or replan; a smaller launch alone does not eliminate the follow-up cost. | Client owner | End of week 4, or earlier if the forecast fails |

## Risks and open decisions

### Decisions to close

Deadlines are relative to project start. The client owner records each decision, named owner and date. Escalate unresolved mandatory decisions at the weekly review; do not treat silence as approval.

| Decision | Recommendation | Decision owner | Deadline |
|---|---|---|---|
| Requirements baseline and acceptance thresholds | Compare R1–R24 against the source and resolve any discrepancies before approving scope. | Client owner and developer | End of week 1 |
| Providers and operating cap | Require evidence for the mandatory capabilities and a complete all-inclusive price, including paid operating time. If no arrangement passes within €60/month, approve a changed cap or replan before committing. | Developer recommends; client owner approves | End of week 2, before Phase 2 |
| Content ownership and funding | Name the German-copy, photo, translation, entry and approval owners; obtain a sample-based quote and reserve their time. Confirm what is inside €18,000, including tax and development-period charges. | Client owner | Owners by end of week 1; quotes by end of week 2 |
| Forty projects at launch | Attempt 40 if the German content, photos, entry capacity and funding are available; English may follow under R9. Otherwise authorise the 15-project exception and commit the dated, costed follow-up. Record R5 as unmet at launch. | Client owner | Funding by end of week 2; final release decision by end of week 9 |
| Application delivery | Recommend an office email notification containing no application content or attachment, with a private link accessible only to the two owners. Obtain written acceptance of this exception to R18’s email wording, or approve an alternative that meets both delivery and access requirements. Keep the application form disabled without approval and verified controls. | Client owner, with legal/privacy reviewer and developer | End of week 2 for the approach; approval and control checks before enabling |
| Form-data backup scope | Recommend separately protected daily form backups whose copies and keys are deleted within six months, if a provider can demonstrate this. Otherwise seek explicit acceptance of the R22 gap from excluding submissions; do not assume a deletion grace period. Keep forms disabled without an approved scope and verified access, backup, deletion and restore controls. | Client owner and legal/privacy reviewer, advised by developer | End of week 2 for provider selection; final approval and control checks before enabling |
| Domain and email | Confirm ownership, registrar, DNS access, renewal cost and existing mail records. Keep email with its current provider and change only necessary web records; separately scope any migration. | Client owner, with developer verification | End of week 2 |
| Outside person | Identify the person, task, dates and access needs. Start with no access; grant an individual, least-privilege account only after approval, and set a removal date. | Client owner approves; developer provisions | End of week 2, before access |
| Legal approval and deletion ownership | Appoint a reviewer and ongoing deletion operator; approve notices, retention, mailbox handling and evidence of provider deletion before enabling real submissions. | Client owner | Appointments by end of week 1; final approval by end of week 8 |
| Post-launch operation | Name an account owner and backup operator for bills, access reviews, failed builds, exports, restoration and deletion. Time the monthly routine and include paid time in the recurring cost; fund support or revise the arrangement if either limit fails. | Client owner, advised by developer | End of week 8 |

### Risk register

| Risk and trigger | Mitigation and response | Owner |
|---|---|---|
| **Delivery:** URLs, approvals, content or available editors arrive late. | Track input deadlines weekly and escalate missed handoffs. Use the approved project-count exception only for the gallery gap; replan if a mandatory gate cannot pass. | Client owner and developer |
| **Privacy:** a form service, mailbox or backup retains or exposes personal data beyond the permitted period. | Use synthetic submissions until access, deletion and restoration evidence passes legal review. Disable the affected form and restore compliant settings if a control fails; do not waive the deletion deadline. | Developer and legal/privacy reviewer |
| **Vendor:** shortlisted services lack a required EU location, permission, export, recovery or publishing capability. | Verify capabilities before commitment; retain portable exports and the last working static release. Select a compliant replacement or escalate cost and schedule changes. | Developer |
| **Cost:** seats, usage, tax or content work exceed allowances. | Obtain quotes, forecast weekly and secure approval before using contingency. Seek funding or replan rather than silently reducing controls. | Client owner |
| **Maintenance:** the routine exceeds one hour, or an incident exceeds available support. | Appoint operators and rehearse the routine and recovery before handover. Arrange funded support or revise the service design before acceptance; separately plan incident cover. | Client owner and developer |
| **Release and recovery:** deployment, redirects or DNS changes break the site or mail. | Preserve the previous release and changed settings; stop acceptance and roll back after a failed production check. Leave mail records unchanged. | Developer |

Implementation checks and rollback procedures are in [Phased build and acceptance](#phased-build-and-acceptance) and [Data protection, deployment and recovery](#data-protection-deployment-and-recovery). The project-count commitment and funding consequence are in [Launch, content gap and follow-up](#launch-content-gap-and-follow-up) and [Build estimate and cost controls](#build-estimate-and-cost-controls).

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

- M1: openrouter/openai/gpt-6.1-terra
- M2: openrouter/mistralai/codestral-2508
- M3: anthropic/claude-sonnet-5-5

### Result

Table A, version 36: the result of the run with both tables.

Way of working: table A: the models take turns.

Both tables worked on the brief at the same time.
The base of the result is the document of table A: 2 of 3 models preferred it in the blind comparison.
Joint final round: 5 of 5 points of the other document taken over; its ballot failed, so the base stays the result.

- Table A: 3 rounds, 1208812 tokens, $2.6767, did not agree
- Table B: 3 rounds, 826720 tokens, $1.7002, did not agree

- M1 (openrouter/openai/gpt-6.1-terra), 1: Both trace R1–R24, but X more clearly identifies unmet requirements, exceptions and excluded costs. Its provider and funding decisions remain conditional.
- M1 (openrouter/openai/gpt-6.1-terra), 2: Its phases give a more coherent sequence of changes, paths, owners and checks. Y has duplicate phase-check sections with conflicting check numbers and paths.
- M3 (anthropic/claude-sonnet-5-5), 1: X covers every requirement with a failing check and names what it leaves out. It decides the conflicts openly (R5, R12, R21) and does not claim compliance it cannot show. Y's cost section contradicts its own cost decisions, and its traceability section calls its cost table inconsistent.
- M3 (anthropic/claude-sonnet-5-5), 2: Phases list concrete new files in order (`scripts/export-content.mjs`, `data/redirects.csv`, `docs/provider-check.md`), each with the action to take. Y's phase list is thinner. It names files like `src/utils/imageProcessor.js` that conflict with its own architecture, and it puts the vendor gate in both Phase 0 and Phase 1.

### Sections taken over from the other table

- "Requirements and priority decisions": from table B, version 33, section "Requirement conflicts and decisions"; table B, version 33, section "Requirement conflicts and decisions"
- "Phased build and acceptance": from table B, version 33, section "Phased build plan with order and dependencies"

### Decisions of the table

- Use a hosted EU headless or Git-free CMS with a static-site build (for example Astro plus a hosted CMS, or a managed CMS such as WordPress hosting in the EU). Decide before the outline. Static output meets R13 and R20, and a managed CMS meets R10 to R12, but the 60 euros a month cap must be checked against the CMS price. (agreed: M3, M1; of 3)
- Launch with 15 projects if necessary, explicitly treating 40 at launch as unmet and agreeing a dated, costed path to the remainder. (agreed: M1, M2, M3; of 3)
- take over "Phased build plan with order and dependencies" into "Phased build and acceptance": The ordering of checks and decisions conflicts. Phase 1 contains the vendor gate and restore, which need D4, yet D4 is due before Phase 2 and Phase 1 needs only D1. (agreed: M2, M1, M3; of 3)
- take over "Requirement conflicts and decisions" into "Requirements and priority decisions": its all-inclusive operating-cap treatment and representative 40-project publish test expose constraints that the current plan understates. (agreed: M1, M3; of 3)
- take over "Phased build plan with order and dependencies" into "Phased build and acceptance": The ordering of checks and decisions conflicts. Phase 1 contains the vendor gate and restore, which need D4, yet D4 is due before Phase 2 and Phase 1 needs only D1. (agreed: M2, M1, M3; of 3)
- take over "Requirement conflicts and decisions" into "Requirements and priority decisions": its all-inclusive operating-cap treatment and representative 40-project publish test expose constraints that the current plan understates. (agreed: M2, M1, M3; of 3)
- take over "Requirement conflicts and decisions" into "Requirements and priority decisions": its all-inclusive operating-cap treatment and representative 40-project publish test expose constraints that the current plan understates | quote: "For both launch reporting and the follow-up, count a project when its required German content and fields and rights-cleared photos are complete and approved. English is not required for the count: where it is absent, the English route must show the German version with a notice under R9. This rule supersedes any both-language counting wording in [Launch, content gap and follow-up](#launch-content-gap-and-follow-up). Record the count and English coverage separately." (agreed: M2, M1, M3; of 3)
- take over "Phased build plan with order and dependencies" into "Phased build and acceptance": The ordering of checks and decisions conflicts. Phase 1 contains the vendor gate and restore, which need D4, yet D4 is due before Phase 2 and Phase 1 needs only D1. (agreed: M2, M1, M3; of 3)
- take over "Requirement conflicts and decisions" into "Requirements and priority decisions": its all-inclusive operating-cap treatment and representative 40-project publish test expose constraints that the current plan understates. (agreed: M2, M1, M3; of 3)
- take over "Requirement conflicts and decisions" into "Requirements and priority decisions": its all-inclusive operating-cap treatment and representative 40-project publish test expose constraints that the current plan understates | quote: "For both launch reporting and the follow-up, count a project when its required German content and fields and rights-cleared photos are complete and approved. English is not required for the count: where it is absent, the English route must show the German version with a notice under R9. This rule supersedes any both-language counting wording in [Launch, content gap and follow-up](#launch-content-gap-and-follow-up). Record the count and English coverage separately." (agreed: M2, M1, M3; of 3)
- Take over from the other document, section "Architecture and data flow", into the section "Phased build and acceptance": X provides a more detailed and structured plan for the architecture and data flow, with clear principles, repository layout, content models, save-to-publish pipeline, form path, and where stored data lives. (agreed: M1, M3; of 3)
- Take over from the other document, section "Requirement traceability R1 to R24", into the section "Phased build and acceptance": Explicitly calls for reviewing all applicable WCAG 2.2 AA criteria across templates and states, rather than relying on limited tests (agreed: M2, M1, M3; of 3)
- Take over from the other document, section "Risks and the way back", into the section "Data protection, deployment and recovery": Specifies owner-controlled service accounts and revocation of builder access as an exit check (agreed: M2, M1, M3; of 3)
- Take over from the other document, section "Cutover, launch and operation", into the section "Phased build and acceptance": Requires recording DNS TTLs, waiting at least the previous TTL and rehearsing rollback on a test subdomain (agreed: M2, M1, M3; of 3)
- Take over from the other document, section "Open decisions with recommendations", into the section "Risks and open decisions": Decision list D1–D12 with a fallback for each late decision, which X lacks (agreed: M2, M1, M3; of 3)

### Assumptions

Questions to the person that got no answer; the models were told to assume and to name the assumption in the plan:

- What is the budget for this project, and what is the timeframe?
- Who produces the texts, the English translations and the photos of the 40 projects, and is that work inside the 18 000 euros? It decides whether R23 is feasible.
- Can the joinery supply the German content, photos, all 60 old URLs, legal review and two available editors within the ten-week schedule?

### Ballots

Rounds of ballots: 3.

| Round | Version | Model | Vote | Counts as approval |
|---|---|---|---|---|
| 1 | 17 | M3 (anthropic/claude-sonnet-5-5) | reject | no |
| 1 | 17 | M2 (openrouter/mistralai/codestral-2508) | reject | no |
| 1 | 17 | M1 (openrouter/openai/gpt-6.1-terra) | reject | no |
| 2 | 29 | M3 (anthropic/claude-sonnet-5-5) | reject | no |
| 2 | 29 | M1 (openrouter/openai/gpt-6.1-terra) | reject | no |
| 2 | 29 | M2 (openrouter/mistralai/codestral-2508) | approve | no: the words it gives for criterion 1, 4 are not in the plan |
| 3 | 34 | M3 (anthropic/claude-sonnet-5-5) | approve | no: the words it gives for criterion 1, 2, 3, 4, 5, 6, 7 are not in the plan |
| 3 | 34 | M2 (openrouter/mistralai/codestral-2508) | approve | no: the words it gives for criterion 1, 2, 3, 5 are not in the plan |
| 3 | 34 | M1 (openrouter/openai/gpt-6.1-terra) | approve | no: the words it gives for criterion 1, 2, 5, 6, 7 are not in the plan |
| 1 | 38 | M1 (openrouter/openai/gpt-6.1-terra) | reject | no |
| 1 | 38 | M2 (openrouter/mistralai/codestral-2508) | approve | no: it does not rate criterion 5, 6, 7 |
| 1 | 38 | M3 (anthropic/claude-sonnet-5-5) | reject | no |

### Objections still standing

- the table on "Phased build and acceptance" (open): The table decided: Take over from the other document, section "Architecture and data flow", into the section "Phased build and acceptance": X provides a more detailed and structured plan for the architecture and data flow, with clear principles, repository layout, content models, save-to-publish pipeline, form path, and where stored data lives. Fix asked for: Work in what the section "Architecture and data flow" of the other document does better, as far as it fits this document.
- the table on "Phased build and acceptance" (open): The table decided: Take over from the other document, section "Requirement traceability R1 to R24", into the section "Phased build and acceptance": Explicitly calls for reviewing all applicable WCAG 2.2 AA criteria across templates and states, rather than relying on limited tests Fix asked for: Work in what the section "Requirement traceability R1 to R24" of the other document does better, as far as it fits this document.
- the table on "Phased build and acceptance" (open): The table decided: Take over from the other document, section "Cutover, launch and operation", into the section "Phased build and acceptance": Requires recording DNS TTLs, waiting at least the previous TTL and rehearsing rollback on a test subdomain Fix asked for: Work in what the section "Cutover, launch and operation" of the other document does better, as far as it fits this document.
- M3 (anthropic/claude-sonnet-5-5) on "Phased build and acceptance" (open): the DNS TTL recording and test-subdomain rollback rehearsal, which the table decided to take over, do not appear as steps. The register assigns the rehearsal to Phase 4 and Phase 5 has none. Fix asked for: add a Phase 4 step that records the TTLs, rehearses rollback on a test subdomain and states a failing check, and add a Phase 5 wait of at least the previous TTL.
- M3 (anthropic/claude-sonnet-5-5) on "Phased build and acceptance" (open): the table decided to take over the repository layout, content models and save-to-publish pipeline, but these are only scattered in file lists. The WCAG 2.2 AA review of all criteria is also missing; Phase 4 only checks "axe" and keyboard use. Fix asked for: add a data-flow subsection and a full AA criteria review step.

### Notes

None.

### Cost

The two tables together: 2035532 tokens, $4.3769 (the comparison and the final round come on top).
The last run on this task used 2332203 tokens, $4.8363 in all.
