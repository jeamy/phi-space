# Plan a website with the requirements of the uploaded document (website-requirements.md). The plan must say what is built

## Introduction

Lindenhof joinery’s website will present its work and gallery to customers and industry professionals, provide a way to make enquiries, and support apprenticeship applications. It will be responsive, accessible and manageable by staff without coding.

The planned stack is Astro, a Git-based CMS and EU hosting, with an EU-hosted function for forms. Applications must be accessible only to the owners. The precise hosting, CMS login and mail arrangements remain decisions to be verified before commitment; EU hosting alone does not establish legal compliance.

### Scope and sequence

The target is a **German launch by the end of week 10 with 15 gallery projects**. English follows after launch; it is not promised in Phase 3. The remaining gallery projects are added as content becomes available. The site excludes a shop, public customer login, newsletter and chat.

Each phase ends with a runnable release. A failed check blocks that phase:

- **Phase 1, weeks 1–2:** establish the site skeleton, hosting, CMS login and backups. Check that an editor can save, a change appears on staging within five minutes, and a backup can be restored.
- **Phase 2, weeks 3–5:** build the German pages, gallery, image pipeline and redirects. Check the content schema, all 60 redirects and performance limits; both editors trial creating and publishing a project.
- **Phase 3, weeks 6–7:** add enquiry and application forms, routing and retention controls. Test delivery, attachment limits, owner-only application access and deletion.
- **Phase 4, weeks 8–10:** complete content, accessibility and legal review, restore rehearsal, cutover and handover. Production checks, including redirects and forms, must pass for launch.
- **Phase 5, after launch:** add English text and language navigation. Test translated pages and fallback notices, and rerun the launch checks.

The detailed order, dependencies and rollback steps are in [Project Phases](#project-phases). The [Traceability Matrix](#traceability-matrix) maps R1–R24 to the proposed implementation and checks; the requirements file’s exact wording still needs verification before those mappings are treated as final.

### Planning assumptions and limits

- The build budget is assumed to be **€18,000** and the running-cost ceiling **€60 per month**. Estimates, including the approximately €42.50 monthly total, are guesses until providers and quotes are confirmed.
- The joinery is assumed to have a domain and email provider. Their ongoing costs still count toward the monthly ceiling.
- A photographer is assumed to shoot six launch projects; joinery staff supply the other launch photos and content. The developer collects the 60 old URLs, with help from the joinery where needed. An external translator supplies English after launch. These assignments need confirmation.
- The week-10 launch and costs depend on timely content, viable EU services, owner-only application access and passing the checks. Deferring English is a scope decision, not a claim that it is available at launch.

[Roles and Responsibilities](#roles-and-responsibilities) assigns the work, and [Budget and Cost Estimation](#budget-and-cost-estimation) sets out the estimates. [Risks and Mitigation Strategies](#risks-and-mitigation-strategies) covers data and shared-service changes; [Open Decisions](#open-decisions) records choices requiring confirmation.

## Technology Stack

### Site and content

**Astro** generates static HTML, CSS and JavaScript from Markdown content and templates. Its image pipeline serves responsive, compressed derivatives while retaining source photos for export.

**Decap CMS** provides browser-based editing backed by Git. The proposed configuration is `public/admin/index.html` (new) and `public/admin/config.yml` (new), with content schemas in `src/content.config.ts` (new). The CMS, repository host and login integration are not yet confirmed: Phase 1 must prove that an editor can log in, save, preview and publish within five minutes. A compatible EU-based login is recommended, but its availability and provider terms must be checked.

### Hosting and forms

A managed **EU static host** builds the Git repository and serves the site. A small **EU-hosted function**, `functions/form-handler.js` (new), validates submissions and routes them by email. The working design uses a separate owners-only application mailbox; office staff may access the separate contact destination, not applications or their backups.

The selected providers must support the required access controls, encryption, delivery, backup and deletion tests before real forms are enabled. EU hosting alone does not establish data-protection compliance. Provider selection and recommendations are recorded in [Open Decisions](#open-decisions).

### Recovery and portability

Git provides page history; a nightly repository-and-media mirror in a second EU location supports recovery if the primary repository fails. A clean export must contain the content and photos needed to build the site independently. Application data and its backups are kept separate from site content and must be subject to their own access and expiry controls.

The ordered implementation and failing-capable checks are in [Project Phases](#project-phases); estimates are in [Budget and Cost Estimation](#budget-and-cost-estimation).

## Project Phases

### Scope and release gates

Phases 1–4 target a German launch with 15 real gallery projects by the end of week 10. English follows in Phase 5; the remaining gallery projects have no committed delivery date. Requirement references and thresholds remain provisional until checked against `website-requirements.md`.

Each phase ends with a runnable deployment tagged `v0.1`–`v0.4`, then `v1.1`. A failed check blocks its tag and progression. Later phases rerun applicable earlier checks. Production checks that require public DNS run immediately after cutover; failure triggers rollback. Use synthetic form submissions and do not disturb unrelated mail.

The developer performs technical steps unless another role is named. Estimates and provider decisions are in [Budget and Cost Estimation](#budget-and-cost-estimation) and [Open Decisions](#open-decisions).

### Phase 1: Skeleton, publishing and backup — weeks 1–2

**Dependencies:** none. Domain and mail access are assumptions; the owners resolve missing access. The old site remains live.

1. Create an EU-hosted Git repository and add `package.json` (new), `astro.config.mjs` (new) and `src/pages/index.astro` (new). Configure German as the default locale and reserve the English locale.
2. Add `public/admin/index.html` (new) and `public/admin/config.yml` (new) with a test collection and editorial workflow. Select and prove a compatible Git/CMS login and draft-preview integration.
3. Configure an EU static host to build `main` and provide staging previews; record reproducible settings in its configuration file. Add `scripts/check-publish-time.sh` (new) to publish a synthetic edit and poll staging.
4. Set up four staff accounts with least-privilege repository access. Add `scripts/backup.sh` (new) for a nightly repository-and-media mirror to a second EU location and `scripts/restore-drill.sh` (new) to restore into a scratch deployment. Keep credentials out of Git.
5. Add `data/cost-sheet.csv` (new) and `tests/cost-cap.test.mjs` (new), using confirmed provider prices where available.
6. Before changing DNS, export the existing zone and TTLs to `docs/dns-before-cutover.txt` (new), verify the export, then lower the relevant website-record TTLs to 300 seconds. Wait at least the previous TTL before cutover; do not change mail records.

**Release check:** staging builds and serves the skeleton; an editor can log in, save and preview a draft; a published edit appears within 300 seconds; an older version can be restored and published; and a scratch restore serves the test page within one working day. The cost test fails above the assumed €60 monthly cap. Any failure blocks `v0.1`.

**Way back:** restore the exported DNS records if the TTL change causes trouble. Revert a bad commit or change host/login provider; retain the mirror until a replacement passes a restore drill.

### Phase 2: German pages, gallery and redirects — weeks 3–5

**Dependencies:** Phase 1 publishing, preview and backup. The owners arrange the 15 launch projects and photographs; the developer collects the old URLs. These assignments are assumptions.

1. Define gallery, work and page collections in `src/content.config.ts` (new). Add 15 project files under `src/content/gallery/` (new), four work files under `src/content/work/` (new), and workshop, imprint and privacy content under `src/content/pages/` (new). Check project fields, photo counts and text limits against the verified requirements.
2. Add `src/layouts/Base.astro` (new), `src/pages/[...slug].astro` (new), `src/pages/gallery/index.astro` (new) and `src/pages/gallery/[slug].astro` (new). Provide accessible navigation and gallery filters for kind and wood. Use a static map image rather than loading an external map on page view.
3. Add `src/components/Photo.astro` (new) and configure Astro’s image pipeline for responsive AVIF/WebP images and lazy loading below the fold. Extend CMS collections and media settings in `public/admin/config.yml` to accept phone-photo uploads; verify actual upload limits.
4. Add `src/components/LangNotice.astro` (new) and routing for German fallback where an English page is absent. Do not claim English content is complete.
5. Configure sitemap generation in `astro.config.mjs` and add `public/robots.txt` (new). Add statistics only if the chosen service passes privacy and cost checks; otherwise omit them.
6. Create `data/old-urls.csv` (new), with old and destination paths, and `scripts/build-redirects.mjs` (new) to generate the selected host’s redirect configuration. Check mappings on staging before touching production.

**Release check:** `tests/content-schema.test.mjs` (new) rejects invalid content and missing work pages; `tests/redirects.test.mjs` (new) checks all 60 mapped paths for the intended 301 and a successful destination; `tests/privacy.test.mjs` (new) checks for unwanted cookies and external page-load requests. Lighthouse on representative gallery pages fails above the verified 4G LCP and transfer limits; axe fails on serious or critical findings. A synthetic 55-project build checks growth capacity. Each editor independently creates, previews and publishes a project with phone photos; record time and problems in `docs/editor-trial.md` (new). Rerun the timed publish and restore checks. Failures block `v0.2`.

**Way back:** revert content or redeploy `v0.1`; regenerate redirects from the CSV. Before any later move to Git LFS or object storage, take and verify a complete mirror, then drill a restore including photos. Clearly marked placeholders may be used on staging but do not satisfy the launch gate.

### Phase 3: Forms, private routing and retention — weeks 6–7

**Dependencies:** Phase 2 templates and a verified EU function and mail arrangement. Owners approve access, encryption and retention before real submissions are enabled. A separate owners-only mailbox is an assumption, not a confirmed provider capability.

1. **Prepare and isolate first.** Export existing mailbox rules to `docs/mail-before-phase3.md` (new). Back up existing mail and verify a restore without changing unrelated mail. Create dedicated form-mail destinations: an office-accessible contact mailbox or strictly isolated form folder, and an owners-only application mailbox. Document every copy and processor, including queues, logs, mailbox backups, exports and attachments. No broad deletion rule may affect unrelated correspondence.
2. Add `src/components/forms/ContactForm.astro` (new), `src/components/forms/ApplyForm.astro` (new), `src/pages/contact.astro` (new) and `src/pages/apprenticeship.astro` (new), with accessible labels and errors.
3. Add `functions/form-handler.js` (new). Validate file count, type and size server-side; route contact submissions to the isolated office destination and applications only to the owners’ destination. Use TLS and the approved encryption-at-rest arrangement. Exclude form contents and attachments from logs. Add EU-compatible spam controls and a delivery-failure alert without submission content.
4. Configure six-month expiry **only for isolated form data**, including every identified backup, export, queue and log copy. Use a demonstrable provider-supported mechanism; an email’s displayed date alone is not proof of backup expiry. Update `src/content/pages/privacy.md` with verified recipients, processors and retention.
5. Test with synthetic submissions: verify routing and access, restore a test application from backup, then run an accelerated or provider-supported expiry test covering the active store and every backup and copy location. Record evidence and any backup-retention lag. Enable real submissions only after owner approval and proof that the deletion deadline is met. If the provider cannot demonstrate this, keep forms disabled and escalate; a manual export alone does not prove expiry.

**Release check:** `tests/forms.e2e.mjs` (new) fails on undelivered test mail, wrong routing, an accepted oversized PDF or delivery of a honeypot submission. An office-user access test must deny access to applications and their backups. Restore and expiry evidence must cover all identified copies. Rerun applicable Phase 1–2 checks, including publishing and privacy. Any failure blocks `v0.3`.

**Way back:** disable submission and show a postal address and contact link; restore documented prior mailbox rules if changed. Restore accidentally deleted unrelated mail from the verified pre-change backup. Preserve and account for test or real submissions during rollback, applying the same access and retention controls.

### Phase 4: Hardening, cutover and handover — weeks 8–10

**Dependencies:** Phases 1–3 passed, final German content and legal review available, and 15 real projects ready. The old site stays intact through cutover.

1. Add security headers and cache rules to the selected host configuration. Editors finish content; the developer fixes template defects. Complete the manual keyboard and screen-reader review in `docs/accessibility-pass.md` (new) and record legal sign-off.
2. Restore the nightly mirror into a scratch project and verify pages and photos. Export the repository and media as a ZIP, then build it on a clean machine with `npm ci && npm run build`. Rehearse owner-mail restore and expiry with synthetic data.
3. Prepare cutover on a weekday morning: verify the DNS export and backup, archive the old site, confirm the previous TTL has elapsed, and keep the old host paid and unchanged for 30 days. Attach the live hostname to the new host and provision its certificate without changing public DNS.
4. **Rehearse rollback before cutover.** Using a temporary local hosts-file override or an equivalent provider-supported method, reach the **old host with the live hostname**, without changing public DNS. Verify its certificate, representative old pages and applicable old redirects and destinations. Remove the override and confirm normal public resolution. Record the results and old-host endpoint in `docs/cutover-checks.md` (new). If the old host cannot serve the old site and its redirects under the live hostname, resolve that failure before cutover.
5. **Check the new host before cutover.** Reach it using the live hostname through a temporary local hosts-file override or equivalent provider-supported preview that preserves the hostname and valid TLS. Check the certificate, all 60 redirects and destinations, key pages and synthetic forms. Remove the override afterwards. Failure means no DNS switch.
6. Switch only the website DNS records. Query public DNS without an override, confirm it resolves to the new host, then repeat certificate, redirect, page and synthetic-form checks through the public hostname. Compare MX, SPF, DKIM and DMARC records with the export. If a check fails, restore the prior website records and verify the old site and representative redirects through public DNS; do not alter mail records.
7. Submit the sitemap and hand over `docs/editor-guide.md` (new) and `docs/operations.md` (new), including publishing, backup checks, form-failure response and the monthly checklist. Keep the old host available for the 30-day overlap.

**Release check:** both old-host rollback rehearsal and new-host pre-cutover checks pass before DNS changes; post-cutover checks pass afterwards. The live gallery contains at least 15 valid projects, and applicable publish, privacy, performance, accessibility, form, backup and restore checks pass. `tests/scope.test.mjs` (new) checks excluded routes and scripts. The owners run the operations checklist once and record whether it takes at most one hour. The cost check fails above the assumed €60 monthly or €18,000 build caps. Any failure blocks `v0.4`; after DNS switch it also triggers rollback.

### Phase 5: English — after launch, provisionally weeks 11–12

**Dependencies:** Phase 4 release and translated content supplied by the agreed translator. This phase is outside the ten-week launch target.

1. Add translated Markdown files alongside German content using the locale structure established in Phase 2. Extend `public/admin/config.yml` for English editing.
2. Enable the language switch and appropriate hreflang and sitemap entries in `src/layouts/Base.astro` and the sitemap configuration. Retain the fallback notice for untranslated pages.

**Release check:** `tests/i18n.test.mjs` (new) fails if an available translation serves German instead, or an untranslated route lacks its fallback notice. Rerun applicable Phase 4 checks; failures block `v1.1`.

**Way back:** redeploy `v0.4` and retain translation commits and media in Git and the nightly backup for correction and retry.

Requirement status is in [Traceability Matrix](#traceability-matrix); remaining approvals are in [Open Decisions](#open-decisions).

## Roles and Responsibilities

### Assignments

Named individuals have not yet been confirmed. The joinery’s owners assign two editors and a decision-maker; one developer and the external suppliers are assumed. Dates and fees depend on their confirmation.

| Role | Responsibility |
|---|---|
| **Owners** | Supply access to the domain and mail provider, approve suppliers and costs, and make launch and legal decisions. Arrange the 15 launch projects, confirm rights to the material and approve the owner-only application destination. One owner participates in restore and handover checks. |
| **Two joinery editors** | Supply German text and photos for nine launch projects, coordinate material for the other six, and maintain content in `src/content/gallery/` (new), `src/content/work/` (new) and `src/content/pages/` (new). Each independently completes the CMS publishing trial. |
| **Developer** | Own the technical work and phase checks in [Project Phases](#project-phases). Collect the 60 old URLs, with joinery help where needed, and maintain their mappings in `data/old-urls.csv` (new). Set up publishing, forms, backups and handover; escalate provider or access failures to the owners. |
| **Photographer** | Shoot the six selected launch projects and deliver usable photos to the editors. Half-day coverage and the fee are estimates requiring a quote. |
| **Translator** | Translate the agreed English text after launch; the developer adds it to the site and configures English editing. The scope, word count and fee require confirmation. |
| **Legal reviewer** | Review the imprint and privacy notice before launch; the owners obtain and record sign-off. The reviewer and fee remain to be confirmed. |

### Phase handoffs and checks

- **Phase 1:** The developer sets up the site, CMS login and backup; the owners provide access and nominate editors. The phase fails if an editor cannot save and preview, the timed publish exceeds five minutes, or the scratch restore fails.
- **Phase 2:** Editors assemble German content and photos; the photographer supplies six projects. The developer builds the pages and collects and maps the URLs. The phase fails if either editor cannot complete the publishing trial, content-schema checks fail, or any of the 60 redirect checks fails.
- **Phase 3:** The developer implements forms and retention controls; the owners approve the access and provider arrangements. The phase fails if synthetic delivery, owner-only access, restore or expiry checks fail.
- **Phase 4:** Editors finish launch content; the legal reviewer and owners complete review. The developer performs cutover and handover. The phase fails if 15 real projects are not ready or the pre- and post-cutover checks fail.
- **Phase 5, after launch:** The translator supplies English; the developer adds it and enables language navigation. The phase fails if an available translation serves German or an untranslated route lacks its fallback notice.

Estimates and supplier assumptions are in [Budget and Cost Estimation](#budget-and-cost-estimation); unresolved assignments and approvals are in [Open Decisions](#open-decisions).

## Budget and Cost Estimation

### Basis and assumptions

The **€18,000 build budget** and **€60 monthly running-cost ceiling** are assumptions pending verification against `website-requirements.md` and owner confirmation. Hours, rates and prices are guesses, not quotes. Tax treatment is unconfirmed; compare tax-inclusive quotes against the caps.

The estimate assumes one developer at €80/hour. The owners and two editors contribute time without an external project invoice; that time is a real business cost, but is not monetised here. The joinery is assumed to own a domain and existing email service, whose estimated costs are included below.

A photographer is assumed to shoot six launch projects; staff supply the other nine. The developer collects the 60 old URLs, with joinery help as needed. An external translator supplies English after launch. Confirm these assignments and supplier prices in week 1.

### One-off build estimate

| Phase | Developer work | Hours | At €80/hour |
|---|---|---:|---:|
| Phase 1 | Repository, hosting, CMS login, publishing and backup | 30 | €2,400 |
| Phase 2 | German pages, gallery, images, redirects, tests and editor trial | 60 | €4,800 |
| Phase 3 | Forms, private routing, retention and tests | 36 | €2,880 |
| Phase 4 | Accessibility review, restore drill, cutover and handover | 30 | €2,400 |
| Phase 5, after launch | English integration and tests | 14 | €1,120 |
| **Total** | | **170** | **€13,600** |

| Other one-off item | Allowance |
|---|---:|
| Photographer: six projects, assumed half-day | €1,200 |
| Translation: approximately 8,000 words at €0.12/word, rounded | €1,000 |
| Legal review | €600 |
| Contingency, including any 30-day old-host overlap | €1,600 |
| **Other costs** | **€4,400** |

The estimated total is **€18,000**, including deferred Phase 5: €13,600 developer work plus €4,400 other costs. Of this, €15,880 is allocated to Phases 1–4, photography and legal review; €2,120 to Phase 5 development and translation; and €1,600 to contingency. There is no margin beyond that contingency. Entry of projects 16–40 is not included.

The old-host overlap is included in the plan, but its actual charge is unknown; obtain the price and check that the contingency covers it. Do not remove the overlap, the 55-project growth check or other release checks automatically to make the estimate fit.

### Estimated running cost

| Item | Monthly estimate |
|---|---:|
| EU static hosting and function | €15 |
| Backup mirror in a second EU location | €5 |
| Cookie-free statistics, if selected | €9 |
| Owners’ separate mailbox | €6 |
| Existing mailbox | €6 |
| Domain, assuming €18/year | €1.50 |
| **Services subtotal** | **€42.50** |
| Outside operator: up to one hour at the guessed €80/hour | **€80** |
| **Illustrative total including operator** | **€122.50** |

The outside operator is a separate, unquoted allowance for the monthly checklist, not a staff task assumed to be free. Verify R20’s exact wording and obtain a service quote covering the checklist and any incident response. It is **not yet established whether the operator fee counts toward the €60 ceiling**. If it does, this illustrative bundle exceeds the ceiling by **€62.50/month** and is not an acceptable capped forecast. If it does not, the services subtotal has €17.50/month of headroom, but the operator remains a real recurring cost. Omitting statistics reduces the services subtotal to €33.50 and the illustrative total to €113.50.

Git LFS or object storage might add €5–€10/month; price its backup, transfer and usage charges before adoption. Also check whether separate charges apply to build minutes, mail delivery, retention, restore, storage growth and the 30-day old-host overlap. These estimates do not establish that the required bundle is available at these prices.

### Cost controls and phase checks

The developer creates `data/cost-sheet.csv` (new) with planned, actual and committed one-off costs and each recurring service and operator charge; annual charges are converted to monthly amounts. Record tax basis, usage assumptions, quote dates and whether each charge counts toward the verified cap. `tests/cost-cap.test.mjs` (new) fails when recorded totals exceed the applicable caps. Until the operator’s treatment is resolved, show both the services-only total and the total including the operator; do not report the lower figure as proven compliance.

The test cannot detect omitted or inaccurate inputs. At each gate the developer and owners reconcile the sheet against quotes, invoices and commitments:

- **Phase 1:** Enter the proposed bundle and request written prices, including the outside operator. The forecast check fails above either applicable cap; an unresolved operator classification is flagged for owner and source review.
- **Phase 2:** Add photography, content and development commitments. The check fails if the revised forecast exceeds a cap.
- **Phase 3:** Add confirmed function, mail, backup and retention prices. The check fails if the complete applicable bundle or build forecast exceeds its cap.
- **Phase 4:** Reconcile invoices and commitments, including Phase 5, contingency, old-host overlap and the outside operator. A cap failure or unresolved treatment of a material cost blocks acceptance pending a documented decision.
- **Phase 5:** Refresh the translation quote and remaining development forecast before committing the work. A cap failure blocks the phase pending a documented decision.

### If a forecast exceeds a cap

The developer reports the amount and cause before making further affected commitments. The owners decide in writing between a cheaper **compliant** service or supplier, a defined scope or schedule change, or additional funding. Each proposal identifies the work and requirements affected, revised cost, schedule and necessary supplier agreements. Reducing an allowance alone does not reduce the work or its price.

Protect the 30-day old-host overlap, daily backups, legal review and release checks in the current plan. Change them only through an approved revision that assesses the requirement and recovery impact and updates the affected phase and gate; record any departure rather than claiming compliance. If no funded, compliant option is available, the affected phase remains blocked and a week-10 launch cannot be promised.

### Decisions to confirm

- **Budget and tax:** Verify both limits against the source and confirm tax treatment. Recommend tax-inclusive comparisons.
- **Outside operation:** Verify R20 and whether the operator fee counts toward the monthly ceiling; obtain a quote for the defined checklist and incident support. Recommend selecting a named outside operator before launch and showing its fee separately in all forecasts.
- **Suppliers and content:** Request photography, translation and legal-review quotes in week 1 and confirm staff and URL-collection responsibilities. Recommend retaining the six-project shoot only if its quote and schedule fit.
- **Hosting, mail and backups:** Price the complete bundle, including owner-only application access and demonstrable retention. Recommend selection only after the cost and Phase 3 controls pass.

See [Open Decisions](#open-decisions) for approvals and [Risks and Mitigation Strategies](#risks-and-mitigation-strategies) for delivery consequences.

## Traceability Matrix

### Basis and status

The uploaded `website-requirements.md` has not been available for verification in this discussion. The descriptions and thresholds below are **provisional paraphrases**, not verified quotations. Before plan approval, the developer must compare every row with the file, correct discrepancies and obtain the owners’ written approval for each departure. No requirement is claimed as achieved before implementation and evidence.

**Planned** means coverage is intended; **conditional** means it depends on evidence or a decision; **deferred** means full coverage is not planned for the week-10 launch. The checks below supplement [Project Phases](#project-phases).

### Priority is not a waiver

Priority determines what is protected when time or money is tight; it does not remove a requirement. An owner-approved departure must identify the unmet requirement, scope, consequence, cost and schedule. Approval does not make a departure compliant.

| Priority | Requirements, provisionally | Delivery decision |
|---|---|---|
| P0 — legal, safety and continuity | R7, R8, R16, R18, R19, R20, R22, R24 | Protect form privacy, lawful operation, redirects, recovery and the excluded-feature boundary before adding portfolio content. Failed application-access or deletion checks block real applications; missing legal sign-off blocks launch. |
| P1 — usable, maintainable site | R1–R6, R9–R15, R17, R21, R23 | Deliver the core pages, editorial workflow and quality requirements, subject to checks and confirmed provider capabilities and prices. English is deferred at launch; priority is not a waiver. |
| P2 — additional portfolio content | R5, projects 16–40 | Launch with 15 approved projects. Schedule the other 25 after launch as content and budget permit; their completion date and entry cost are not committed. Verify whether the source permits this sequence. |

### Provisional R1–R24 mapping

| Req | Working description | Coverage and status | Failing-capable acceptance check |
|---|---|---|---|
| R1 | Serve private customers | **Planned:** German work and gallery pages and an enquiry route. | Phase 3: reviewers must find the work and contact pages; `tests/forms.e2e.mjs` (new) fails if a synthetic enquiry is not delivered. |
| R2 | Serve architects and builders | **Conditional:** work and gallery pages address this audience; verify whether a dedicated page is required. | Phase 2: owners review the pages against the source; rejection blocks acceptance. |
| R3 | Support apprenticeship applicants | **Planned:** apprenticeship page and application form. The site cannot guarantee recruitment of two apprentices. | Phase 3: synthetic application delivery and owner-only access must pass. |
| R4 | A page for each kind of work | **Conditional:** four entries in `src/content/work/` (new), subject to verifying the categories. | Phase 2: `tests/content-schema.test.mjs` (new) fails if a required entry is missing. |
| R5 | Gallery of 40 projects, with photo and filter limits | **Partly deferred:** 15 real projects at launch; the other 25 follow as content and budget permit. A synthetic 55-project build checks capacity, not delivery of 40 real projects. If R5 requires 40 at launch, this is a launch departure. | Phase 2: schema checks reject invalid entries and reviewers test both filters. Phase 4: fewer than 15 valid real projects blocks the planned launch. Full coverage requires a later count of 40 valid real projects. |
| R6 | Workshop page, hours and map | **Conditional:** workshop content and a static map image, subject to current details and map rights. | Phase 2: page check fails if absent; owners reject incorrect hours or an unusable map. |
| R7 | Application form with PDF up to 5 MB | **Conditional:** accessible form and server-side validation, subject to delivery, access and retention evidence. | Phase 3: a valid PDF at the limit must be accepted, an oversized PDF rejected, and private delivery and deletion checks passed. |
| R8 | Contact form with up to three files | **Conditional:** form and function, subject to verified attachment and delivery limits. | Phase 3: `tests/forms.e2e.mjs` (new) tests delivery, allowed attachments and rejection of excess files; failure blocks release. |
| R9 | Language toggle | **Deferred:** German at launch; English content and language navigation follow in Phase 5. If both languages are required by week 10, this is an explicit launch departure. | Phase 5: `tests/i18n.test.mjs` (new) fails if an available translation serves German or a missing translation lacks a fallback notice. |
| R10 | Untrained editors and phone-photo uploads | **Conditional:** Decap CMS and image pipeline, subject to working login, actual upload limits and editor trials. The reported 12 MB source-photo size needs source verification. | Phase 2: both editors independently create, preview and publish a project with representative phone photos; record time and failures in `docs/editor-trial.md` (new). Verify time and file-size thresholds against the source. |
| R11 | Publishing within five minutes and draft preview | **Conditional:** Git-based publishing and a compatible preview integration; configuration alone proves neither. | Phase 1 onward: an editor previews a draft; time a representative edit from Publish through queue, build and deployment until it appears on the target site. Over 300 seconds fails. Repeat on production at launch. |
| R12 | Restore earlier versions for 90 days | **Conditional:** Git history and a separate mirror, provided history and media remain available for the required period. | Phase 1: restore and publish an older version and confirm 90-day retention settings. A new repository cannot yet demonstrate 90 days of history. |
| R13 | Performance on 4G and gallery transfer limit | **Planned:** responsive images, lazy loading and static pages. Source photos are retained for export; delivery uses resized and compressed derivatives. | Phase 2 onward: test the representative gallery under the source conditions; exceeding the source LCP or transfer limit fails. Working thresholds are 2.5 seconds and 1.5 MB, pending verification. |
| R14 | WCAG 2.2 AA accessibility | **Conditional:** accessible templates, automated checks and manual review; tools alone do not prove conformance. | Phase 2 onward: axe fails on serious or critical findings. Phase 4: keyboard and screen-reader defects must be resolved before launch and recorded in `docs/accessibility-pass.md` (new). |
| R15 | Search metadata and sitemap | **Conditional:** titles, descriptions and sitemap are planned; verify whether structured data is required. | Phase 2: build checks fail for missing required metadata; validate the sitemap and any required structured data. |
| R16 | Preserve 60 old addresses | **Conditional:** `data/old-urls.csv` (new) maps old paths to destinations; completeness depends on access to the old site and records. | Phases 2 and 4: `tests/redirects.test.mjs` (new) fails unless all 60 verified mappings return the intended 301 and a successful destination. |
| R17 | EU hosting and privacy-conscious page loads | **Conditional:** select verified EU services; omit statistics if a suitable service cannot satisfy the verified requirement and cost cap. EU location alone does not establish compliance. | Phase 2 onward: `tests/privacy.test.mjs` (new) detects unwanted cookies and external requests; separately review provider locations, processors and statistics data. |
| R18 | Email delivery, six-month retention and owner-only application access | **Conditional:** contact submissions go to an isolated office destination; applications go only to an owners-only destination, with TLS and approved encryption at rest. Verify whether that routing meets the source wording. | Phase 3: synthetic delivery, both owners’ access and denial for office users and editors must pass, including attachments and backups. Demonstrate expiry across every identified copy; otherwise real forms remain disabled. |
| R19 | Legal notices and spam protection | **Conditional:** imprint, privacy notice and EU-compatible spam controls; verify exact requirements and applicable law. | Phase 3: spam and legitimate-submission tests must pass. Phase 4: recorded legal review and owner sign-off are required for launch. |
| R20 | No server operation and limited monthly effort | **Conditional and disputed:** a staff-run checklist is not evidence of compliance if, as reported, R20 requires an **outside person**. Recommend a named outside operator for the checklist and incident response, subject to source verification, scope and a quote. Managed services alone do not prove this requirement is met. | Phase 4: verify the source wording; if it requires an outside person, that person must run the checklist within the verified one-hour limit and have a documented agreement. Failure blocks acceptance. Check the quoted fee against the applicable monthly cap. |
| R21 | Build and recurring-cost ceilings | **Conditional:** estimated build cost €18,000 including deferred English. Services are estimated at €42.50/month; adding the guessed outside-operator allowance of €80/month gives €122.50/month. These are guesses, not quotes. | At each phase gate, `tests/cost-cap.test.mjs` (new) fails above the applicable verified caps. Reconcile inputs with quotes, invoices and commitments. If the operator counts toward an assumed €60 cap, the illustrative total exceeds it by €62.50/month. |
| R22 | Daily backup, one-working-day restore and content export | **Conditional:** nightly repository-and-media mirror and an exportable build, subject to provider and restore evidence. Reconcile form-mail backup and retention separately where applicable. | Phases 1 and 4: `scripts/restore-drill.sh` (new) must restore and serve content within one working day. Phase 4: a clean-machine export build must include pages and photos. |
| R23 | Online within ten weeks; gallery may open with 15 | **Conditional:** target a week-10 German launch with 15 valid real projects. Verify the wording and its interaction with R5 and R9. | Phase 4: launch date, project count and live-domain checks must pass; a failed production check triggers rollback. |
| R24 | Excluded features | **Planned by omission:** provisionally exclude prices as well as a shop, public customer login, newsletter and chat. Confirm the complete exclusion list against the source before approval. Staff CMS login is distinct from public customer login. | Phase 4: `tests/scope.test.mjs` (new) fails on excluded routes or scripts; reviewers inspect pages and content for prices and other excluded features. |

### Conflict decisions and evidence

- **Portfolio size versus ten weeks and €18,000:** Do not sacrifice privacy, accessibility or redirect checks to reach 40 projects. The owners must supply and approve 15 real projects on time. The additional 25 have no committed completion date or included entry cost. If the verified source requires more at launch, record the shortfall as a departure.
- **Six-month deletion versus daily backups and 90-day recovery:** Keep form data separate from site-content revisions. Even a 30-day backup retention does not guarantee deletion by six months: a copy made just before expiry can outlive the deadline. Preserve the planned daily backup frequency and demonstrate deletion or irreversible inaccessibility of every form-data copy by its deadline; reapply expiry before restored data is reopened. Avoiding application-payload backups is an alternative to evaluate **only if** the verified recovery requirements still permit it and the phase gates are revised accordingly. If no compliant design is proven, keep real forms disabled and escalate. A manual export or fewer backups is not proof.
- **Owner-only applications versus editorial access:** Separate CMS permissions from application storage. Only the two owners may read application payloads, attachments and copies; any office notification must contain no applicant personal data. Test owner access and denial for office staff and editors. Confirm the provider’s access, encryption, backup and deletion capabilities before enabling submissions.
- **Five-minute publishing versus static builds:** Measure from the editor’s Publish action until the change appears publicly, including queue, build and deployment, with representative content and image workloads. Optimize and retest if it fails; if it still exceeds five minutes, change platform or obtain explicit acceptance of the R11 shortfall before launch. A local build time alone is not proof.
- **Large source photos versus transfer limits:** Verify the reported 12 MB source-photo requirement. Preserve originals for export while serving resized, compressed derivatives and deferring off-screen images. Test the actual launch gallery against the verified limit; do not omit images or reduce quality without owner approval.
- **Outside operation and the monthly cap:** Select managed EU services only after verifying access, deletion, backup and pricing terms. The source and owners must settle whether R20 requires an outside person and whether that person’s fee counts toward the recurring cap. On current guesses, the complete €122.50/month bundle exceeds €60 by €62.50 if the fee counts; the services-only figure is not proof of compliance. Obtain an operator quote and a complete provider bundle before commitment. If no compliant bundle fits, seek a cheaper compliant arrangement or an explicit funding, scope or schedule decision—not an unrecorded substitution of staff time or relaxation of privacy or recovery.

The R20 correction must also be reflected in [Project Phases](#project-phases), [Roles and Responsibilities](#roles-and-responsibilities), [Risks and Mitigation Strategies](#risks-and-mitigation-strategies) and [Open Decisions](#open-decisions). Until the source and cost treatment are verified and those sections agree, this matrix does not establish R20 or R21 compliance.

## Risks and Mitigation Strategies

### Scope

These risks cover changes to stored data and shared services, and delivery dependencies that could block a release. The numbered steps and release gates are in [Project Phases](#project-phases). Requirement wording remains provisional until checked against the uploaded source.

### Data and shared-service changes

| Change | Preparation and failing-capable check | Way back |
|---|---|---|
| **Phase 1, step 4: backup mirror** | Configure `scripts/backup.sh` (new) for the repository and media. `scripts/restore-drill.sh` (new) must restore them to a scratch deployment that serves the test page. | Fix or replace the mirror destination and repeat the drill. Do not treat an untested mirror as a backup. |
| **Phase 1, step 6: DNS TTL** | Verify the zone export in `docs/dns-before-cutover.txt` (new); check that the intended website-record TTL reads 300 seconds and unrelated records are unchanged. | Restore the affected records and TTLs from the verified export. |
| **Phase 2, step 6: redirects** | Generate host configuration from `data/old-urls.csv` (new) using `scripts/build-redirects.mjs` (new). `tests/redirects.test.mjs` (new) fails if any of the 60 verified mappings has the wrong 301 or an unsuccessful destination. | Correct the CSV and regenerate, or revert the commit and redeploy the previous tag. |
| **Phase 3, steps 1–5: mail routing and expiry** | Export existing rules to `docs/mail-before-phase3.md` (new), back up existing mail and verify a restore *before* changes. Test isolated destinations, access, delivery and expiry across all copies with synthetic data. | Disable submissions, restore prior rules where changed, and restore accidentally deleted unrelated mail from the verified backup. Account for any submissions already received under the same access and retention controls. |
| **Phase 4, steps 3–6: live cutover** | Archive the old site and rehearse both old-host rollback and new-host checks using the live hostname before changing DNS. After cutover, repeat live certificate, redirect, page and synthetic-form checks and compare mail records with the export. | Restore only the prior website DNS records; verify the old site and representative redirects through public DNS. Keep the old host available for the 30-day overlap. |

### Specific risks and responses

**1. DNS cutover interrupts the site or mail — Phases 1 and 4.** The website and mail share a DNS zone. Lower the website-record TTL in Phase 1 and wait at least the previous TTL before cutover. In Phase 4, failure of either pre-cutover rehearsal blocks the switch; failure of a public check triggers the rollback above. DNS propagation and rollback time are **uncertain**: some resolvers may retain an old answer beyond its TTL, so visitors can reach different hosts during propagation. Monitor both hosts during the overlap; do not promise a five-minute recovery.

**2. Mail rules delete unrelated correspondence or expose applications — Phase 3.** Apply expiry only to isolated form data, not the general office mailbox. Test legitimate and rejected submissions, and verify that office users and editors cannot read applications or their backups. A failed routing, restore or deletion check blocks real submissions. Disable the form route and restore the documented rules if a change causes trouble; investigate delivery failures without putting submission contents in alerts or logs.

**3. Application backups defeat six-month deletion — Phases 3 and 4.** Provider encryption at rest does not by itself prove owner-only access or deletion. Inventory queues, logs, attachments, exports and backups; prove that every copy expires or becomes irreversibly inaccessible by its deadline, including after a restore. An owner must restore and read a synthetic application in both Phase 3 and Phase 4. A monthly manual export is **not** a substitute for proven backup expiry. If the provider cannot demonstrate the controls, keep real forms disabled and escalate a provider or design change. If optional PGP is selected, agree and test key custody and recovery before use; keep keys out of the repository and function.

**4. A bad content edit or repository loss removes pages or photos — Phases 1–4.** Revert the affected Git commit or redeploy the previous release tag. If the repository is damaged, restore the nightly mirror to a scratch deployment and check pages and photos before replacing the live version. Phase 1 tests restoration of an older page and timed publication; later phases repeat the applicable checks.

**5. Source photos exceed repository or host limits — Phase 2.** Measure actual repository size, upload limits and build time with representative phone photos; size forecasts are guesses until measured. Preserve originals for export while serving compressed derivatives. If a move to Git LFS or object storage is proposed, price it first, take and verify a complete mirror, then restore and build with photos before switching. Missing photos or a failed restore block the change; revert to the verified mirror if necessary.

**6. Launch material or old URLs arrive late — Phases 2 and 4.** The owners arrange content and the developer collects old paths, with joinery help; these are assumptions. Mark placeholders on staging only. If the URL list is unavailable by week 4, crawl the old site and ask the owners to verify completeness; an unreachable old site puts the redirect gate at risk. Fewer than 15 valid real projects or an unverified set of 60 redirects blocks the planned launch. A different launch scope requires an explicit owner-approved departure, not an automatic waiver.

**7. A compliant service bundle exceeds the cost caps — all phases.** Compare `data/cost-sheet.csv` (new) with quotes, invoices and commitments; `tests/cost-cap.test.mjs` (new) fails on recorded totals above the assumed caps but cannot detect omitted charges. First seek a cheaper compliant bundle, then request an explicit scope, schedule or funding decision. **Do not silently reduce daily backup frequency**, legal review or release checks. If no approved and funded option meets the gates, the affected phase remains blocked.

**8. Delivery slips beyond ten weeks — Phases 1–4.** Late content, unproven providers or legal review can delay a phase. English is already scheduled after launch; that deferral is not extra schedule contingency. Keep the synthetic 55-project growth test in Phase 2 unless an approved change explicitly removes it and records the resulting requirement impact. Request legal review in week 6 and escalate failed gates immediately; do not represent a blocked phase as complete.

**9. Statistics or an embedded map introduces cookies or external requests — Phase 2 onward.** `tests/privacy.test.mjs` (new) fails on unwanted cookies or page-load requests; separately review any approved statistics provider and its data handling. Remove the offending integration and redeploy the previous tag if the check fails.

**10. Automated checks miss accessibility or legal defects — Phases 2 and 4.** Automated findings are a partial screen, not proof of WCAG conformance. Record the manual keyboard and screen-reader review in `docs/accessibility-pass.md` (new), resolve identified launch-blocking defects, and obtain recorded legal review of the notices. Missing review or sign-off blocks launch.

**11. CMS login or preview does not work for editors — Phase 1 onward.** Verify the proposed integration rather than assuming a Git provider is compatible. The Phase 1 check fails if an editor cannot log in, save and preview, or if publishing exceeds the time limit. Change integration or provider and repeat the checks. Direct Git editing by the developer is an emergency workaround, **not** a substitute for the staff-editing release gate.

### Verification across phases

- **Phase 1:** login, draft preview, timed publication, cost forecast and scratch restore must pass; DNS export and TTL are checked before proceeding.
- **Phase 2:** schema, 60 redirects, privacy, performance, accessibility screening, editor trials and the 55-project build must pass; repeat applicable Phase 1 checks.
- **Phase 3:** synthetic delivery, application access denial, backup restore and expiry across identified copies must pass; otherwise real forms stay disabled.
- **Phase 4:** old-host rollback rehearsal and new-host checks must pass before cutover; public checks, restore, legal and accessibility review, and the 15-project count must pass for release.
- **Phase 5:** translation and fallback checks must pass, together with applicable earlier checks; redeploy the Phase 4 tag if the English release fails.

### Remaining uncertainties

The requirements file must still be checked against the provisional R18 and R22 descriptions. Provider access, encryption, backup expiry and prices need evidence; the old URL inventory and availability of launch content also need confirmation. Recommendations, owners and deadlines are in [Open Decisions](#open-decisions).

## Open Decisions

### Basis and decision gates

The requirement descriptions remain provisional until the developer compares them with `website-requirements.md`. The build budget, running-cost ceiling, content suppliers, domain ownership and mail provider are planning assumptions, not confirmed answers. Prices and provider capabilities require evidence.

A decision closes only when its owner records the choice and its check passes. A missed deadline blocks the phase that depends on it. Departures require the owners’ written approval identifying the affected requirement, consequence, cost and schedule; approval does not make a departure compliant. See the [Traceability Matrix](#traceability-matrix) for requirement status.

### Decisions before Phase 1

**D1. CMS login and preview.** The developer selects a Decap-compatible EU Git/login integration by day 3. Recommend the Git provider’s login if it supports the required Decap workflow; otherwise evaluate a managed EU-hosted OAuth function. Confirm provider locations and terms rather than assuming that an EU server settles all privacy questions.

- **Check:** Phase 1 fails if an editor cannot log in, save, preview and publish within the timed gate.
- **Fallback:** change integration or provider and repeat the test. Direct Git editing may support development but does not satisfy the staff CMS gate.

**D2. Git, static hosting and function providers.** The developer recommends an EU-located Git service and managed static host by the end of week 1. Confirm compatible previews, function runtime, media capacity, locations, recovery and complete prices.

- **Check:** Phase 1 fails if the selected bundle cannot build and serve staging, pass the CMS and restore checks, or fit the recorded cost forecast.
- **Fallback:** before migration, verify a complete repository-and-media backup; change provider and repeat the restore and publishing tests.

**D4. Budget, tax and operating cap.** The owners confirm the assumed €18,000 build budget, €60 monthly ceiling and tax treatment by the end of week 2. Recommend tax-inclusive quotes and a staff-run monthly checklist.

- **Check:** Phase 1 fails if the complete forecast exceeds either assumed cap; refresh it at every subsequent gate against quotes and commitments.
- **Fallback:** seek a cheaper **compliant** bundle first, without reducing daily backup frequency. If none fits, the owners decide in writing on funding, a specific scope change or a schedule change. Identify any requirement departure and obtain supplier agreement where needed. Without an approved, funded solution, the affected phase remains blocked. See [Budget and Cost Estimation](#budget-and-cost-estimation).

### Content and launch decisions

**D3. Statistics.** By week 3, the owners, advised by the developer, decide whether to use an EU-hosted, cookie-free service or omit statistics. Recommend omission unless a service passes the privacy, operational and cost checks; do not select Google Analytics by default.

- **Check:** Phase 2 fails if page-load tests find unwanted cookies or unapproved external requests, or if the selected service exceeds the cap. Review provider processing separately.
- **Fallback:** remove the integration and retest; verify against the source whether omission is a departure.

**D5. Photos, old URLs, domain and mail access.** In week 1, the owners confirm the assumed assignments: a photographer shoots six launch projects, staff supply the other nine, and the developer collects and maps the 60 old URLs with their help. Confirm photo rights, delivery dates, domain and mail ownership, credentials and photography quote. Recommend delivery of the first 15 projects by the end of week 3 and early access for URL collection.

- **Check:** Phase 2 fails on missing required content or redirect mappings. Phase 4 fails if fewer than 15 valid real projects are ready.
- **Fallback:** placeholders are for staging only. If content is late, recommend delaying launch. A launch with fewer than 15 requires an explicit written owner-approved scope departure, identifying the affected requirement, revised count, consequences, cost and schedule; it is not the planned Phase 4 release or a claim of compliance.

**D6. English supplier and timing.** The table has decided on German launch first and English after launch. By week 8, the owners name the translator, agree the word count and obtain a quote. Recommend Phase 5 in weeks 11–12, subject to content and cost confirmation. Treat any unmet launch-language requirement as a departure, not as waived by priority.

- **Check:** Phase 5 fails if translated routes or fallback notices fail the internationalisation test, or if the refreshed cost forecast exceeds the cap.
- **Fallback:** retain the German release and record the English delay; do not claim English completion.

**D10. Image storage and repository size.** By Phase 2, the developer selects ordinary Git storage if representative originals and growth tests fit provider limits and cost. Otherwise recommend evaluating Git LFS or managed object storage, including its access, transfer, export and backup costs.

- **Check:** Phase 2 fails if uploads, the synthetic 55-project build, export or restore cannot include the photos, or the revised cost forecast exceeds the cap.
- **Fallback:** before migration, verify a complete repository-and-media mirror and restore it to a scratch site; revert to the prior storage arrangement if migration checks fail. Do not discard originals to make the test pass.

### Decisions before Phase 3

**D7. Application access and encryption.** By week 5, the owners approve a provider arrangement after the developer verifies its controls. Recommend TLS in transit and an encrypted-at-rest, owners-only mailbox or separate managed store; optional PGP requires an agreed key-custody and recovery procedure. A separate store is not ruled out merely because it is separate, provided it meets the managed-operation and cost constraints.

- **Check:** Phase 3 fails unless both owners can access synthetic applications and office users and editors cannot access their contents, attachments or backups. Verify provider encryption and access terms as well.
- **Fallback:** keep real applications disabled if the controls cannot be demonstrated; change provider or seek an explicit funding, scope or schedule decision.

**D8. Form-data backup and deletion.** The developer asks candidate providers in week 1 for documented backup, access and expiry capabilities; the owners choose the arrangement by week 6. Recommend isolated form destinations and a provider-supported means of making every copy deleted or irreversibly inaccessible by its deadline, including copies made shortly before expiry. Preserve the planned daily backup frequency.

- **Check:** Phase 3 fails unless synthetic restore and accelerated or provider-supported expiry evidence covers the active store, attachments, queues, logs, exports and backups, with expiry reapplied before restored data is reopened. A backdated message alone is not proof.
- **Fallback:** change provider or escalate funding, scope or schedule. A monthly manual export is not proof of deletion from backups. Keep real forms disabled until the controls pass; restore unrelated mailbox rules from `docs/mail-before-phase3.md` (new) if necessary.

**D9. Legal and accessibility review.** The owners commission a legal reviewer by week 6 and obtain sign-off by week 9; the developer completes the manual keyboard and screen-reader pass. Recommend review of the final imprint and privacy content with actual provider and retention details.

- **Check:** Phase 4 fails without recorded legal sign-off or with unresolved blocking accessibility findings; automated checks alone are insufficient.
- **Fallback:** correct the findings and repeat review, or delay launch.

### Verification by phase

| Phase | Decision evidence needed to pass |
|---|---|
| **Phase 1** | D1 login, preview and timed publishing; D2 provider and restore checks; D4 cost forecast. |
| **Phase 2** | D3 privacy check; D5 content and redirect checks; D10 upload, growth and recovery checks. |
| **Phase 3** | D7 owner-only access and encryption evidence; D8 restore and expiry evidence. |
| **Phase 4** | D5 launch count and live checks; D9 legal and accessibility sign-off; refreshed D4 cost check. |
| **Phase 5** | D6 translation, fallback and refreshed cost checks. |

The developer compares all decision references with the requirements source before plan approval and records discrepancies and required owner decisions. Provider selection and owner approval remain open until their respective checks pass.

## Conclusion

The plan targets a **German launch by the end of week 10**, with 15 gallery projects. English and the remaining projects follow after launch; they are not claimed as complete at launch. A shop, public customer login, newsletter and chat are excluded.

### Release milestones

Each phase ends with a runnable release; a failed check blocks progression.

- **Phase 1, weeks 1–2:** Establish publishing and backups. An editor must save and preview a draft, a published change must appear within five minutes, and a scratch restore must succeed.
- **Phase 2, weeks 3–5:** Build the German pages, gallery and redirects. Both editors must complete a publishing trial, and the content, redirect, privacy and performance checks must pass.
- **Phase 3, weeks 6–7:** Add forms and retention controls. Synthetic delivery, owner-only application access, restore and deletion tests must pass before real submissions are enabled.
- **Phase 4, weeks 8–10:** Complete review, cutover and handover. The live site must pass the launch checks, including 15 real projects, redirects and forms; a failed post-cutover check triggers DNS rollback.
- **Phase 5, after launch, provisionally weeks 11–12:** Add English. Translation and fallback tests must pass before release.

The detailed order and dependencies are in [Project Phases](#project-phases).

### Conditions for proceeding

Before approving the plan, the developer must verify every provisional mapping and threshold against `website-requirements.md`; the document was not available to this discussion. The owners must approve any departure, particularly the deferred English and gallery content, and confirm the budget, suppliers and assignments.

The estimated **€18,000 build cost**, including post-launch English, and **€42.50 monthly running cost** are guesses, not quotes. Launch depends on timely content, a compliant service bundle, owner approval and passing the release gates. The plan does not yet establish that all requirements are met or that the estimates will hold. Open choices and recommended resolutions are recorded in [Open Decisions](#open-decisions).

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

Table A, version 42: the result of the run with both tables.

Way of working: table A: the models take turns.

Both tables worked on the brief at the same time.
The base of the result is the document of table A: 2 of 2 models preferred it in the blind comparison.
Joint final round: 1 of 2 points of the other document taken over; its ballot failed, so the base stays the result.

- Table A: 3 rounds, 1486390 tokens, $2.9707, did not agree
- Table B: 3 rounds, 801501 tokens, $1.4768, did not agree

- M1 (openrouter/mistralai/codestral-2508), 1: X has a more detailed and structured plan with clear phases and milestones, making it easier to track progress and manage the project.
- M1 (openrouter/mistralai/codestral-2508), 2: X provides a more comprehensive cost estimation and budgeting process, including a detailed breakdown of costs and a contingency plan.
- M3 (openrouter/openai/gpt-6.1-terra), 1: It explicitly marks the requirement mappings as unverified, identifies deferred English and gallery content, and does not claim a compliant budget without evidence. Y claims a source reading, but its scope and cost sections contradict other parts of its plan.
- M3 (openrouter/openai/gpt-6.1-terra), 3: Its phase dependencies and gates are more consistent. Y says full redirect destination tests start in Phase 6, but its Phase 5 checks require them, including a test file not yet created.

### Sections taken over from the other table

- "Traceability Matrix": from table B, version 32, section "Requirement priorities and contradictions decided"; table B, version 32, section "Requirement priorities and contradictions decided"

### Decisions of the table

- We should break down the project into phases, with each phase ending with a runnable and testable version of the website. This will help us manage the project better and ensure that we meet the requirements within the given timeframe. (agreed: M1, M3, M2; of 3)
- Make each phase end with a runnable release and a failing-capable check; sequence data and server changes with backup and rollback before deployment. (agreed: M3, M1, M2; of 3)
- Use a static site (Astro or Hugo) built from a Git-based CMS (e.g. Decap or similar) on EU hosting, with forms handled by a small EU-hosted function and e-mail. Reason: it is cheap, fast (R13), needs no server operation (R20) and gives history through Git (R12). Open: whether the CMS can run without third-party login outside the EU. (agreed: M2, M3, M1; of 3)
- Decide the conflicts explicitly: the gallery opens with 15 projects (R23), English follows later (R9), and applications are stored encrypted or kept in a separate store visible to the owners only (R18). (agreed: M2, M1; against: M3; of 3)
- take over "Requirement priorities and contradictions decided" into "Traceability Matrix": It distinguishes priorities from waivers and explains the retention-versus-backup conflict without silently reducing backup frequency. (agreed: M1, M3; of 3)
- take over "Scope and sequence" into "Scope, assumptions and what the plan leaves out": It provides a clear and concise overview of the project's scope, sequence, and what the plan leaves out, which is essential for understanding the project's boundaries and expectations. (agreed: M1, M3; against: M2; of 3)
- take over "Scope and sequence" into "Scope, assumptions and what the plan leaves out": It provides a clear and concise overview of the project's scope, sequence, and what the plan leaves out, which is essential for understanding the project's boundaries and expectations. (agreed: M1, M3; of 3)
- take over "Requirement priorities and contradictions decided" into "Traceability Matrix": It distinguishes priorities from waivers and explains the retention-versus-backup conflict without silently reducing backup frequency. (agreed: M1, M3; of 3)
- take over "Scope and sequence" into "Scope, assumptions and what the plan leaves out": It provides a clear and concise overview of the project's scope, sequence, and what the plan leaves out, which is essential for understanding the project's boundaries and expectations. (agreed: M1, M3; of 3)
- take over "Requirement priorities and contradictions decided" into "Traceability Matrix": It distinguishes priorities from waivers and explains the retention-versus-backup conflict without silently reducing backup frequency. (agreed: M1, M3; of 3)
- Take over from the other document, section "Operations after launch (R20)", into the section "Roles and Responsibilities": Assign an outside operator a timed monthly checklist, with failure reporting and incident work explicitly separated. (agreed: M1, M3; of 3)

### Assumptions

Questions to the person that got no answer; the models were told to assume and to name the assumption in the plan:

- What is the budget for this project?
- Who supplies and shoots the photos and the 60 old URLs, who writes the English text, and does the joinery already own a domain and an e-mail provider?

### Ballots

Rounds of ballots: 3.

| Round | Version | Model | Vote | Counts as approval |
|---|---|---|---|---|
| 1 | 26 | M1 (openrouter/mistralai/codestral-2508) | approve | no: the words it gives for criterion 1, 4 are not in the plan |
| 1 | 26 | M3 (openrouter/openai/gpt-6.1-terra) | reject | no |
| 1 | 26 | M2 (anthropic/claude-sonnet-5-5) | reject | no |
| 2 | 37 | M1 (openrouter/mistralai/codestral-2508) | approve | no: the words it gives for criterion 1, 2, 3, 7 are not in the plan |
| 2 | 37 | M3 (openrouter/openai/gpt-6.1-terra) | reject | no |
| 2 | 37 | M2 (anthropic/claude-sonnet-5-5) | reject | no |
| 3 | 41 | M1 (openrouter/mistralai/codestral-2508) | approve | no: the words it gives for criterion 1, 2, 5, 7 are not in the plan |
| 3 | 41 | M3 (openrouter/openai/gpt-6.1-terra) | reject | no |
| 1 | 43 | M1 (openrouter/mistralai/codestral-2508) | approve | no: the words it gives for criterion 1, 3 are not in the plan |
| 1 | 43 | M3 (openrouter/openai/gpt-6.1-terra) | reject | no |

### Objections still standing

- M3 (openrouter/openai/gpt-6.1-terra) on "Traceability Matrix" (open): R24 leaves prices as an unchecked exclusion, and R20 substitutes an owner checklist for the outside-person limit reported in the other table’s reading. Fix asked for: Verify R20 and R24 against the source; include prices in the exclusion and scope check if confirmed, and cost and test the correct operating arrangement.
- M3 (openrouter/openai/gpt-6.1-terra) on "Traceability Matrix" (open): All 24 mappings remain provisional, and R20’s owner-run checklist may not meet the reported requirement for an outside person. The plan consequently cannot demonstrate requirement coverage. Fix asked for: Compare each row with `website-requirements.md`, correct the mappings and checks, and explicitly cost and assign any required outside operation; if the file is unavailable, obtain it before approval.
- M2 (anthropic/claude-sonnet-5-5) on "Open Decisions" (declined by the reviser, stands for its raiser): the D-numbering is out of order (D4 before D3) and the ten decisions have no deadlines for D10 Fix asked for: renumber and give each a deadline
- M3 (openrouter/openai/gpt-6.1-terra) on "Budget and Cost Estimation" (open): The cut list automatically removes the 30-day old-host overlap and release checks, contradicting the later prohibition on automatic cuts and the cutover plan. It also treats the monthly operator as staff despite the reported R20 requirement for an outside person. Fix asked for: Remove the automatic cut list, protect the overlap and checks unless an approved change revises the plan, and budget an outside operator separately while flagging whether the fee counts toward the monthly cap.
- M3 (openrouter/openai/gpt-6.1-terra) on "Traceability Matrix" (open): The matrix remains provisional without source verification, and R20’s staff-run checklist may not satisfy the reported requirement for an outside person. The plan therefore cannot establish requirement coverage or the operating-cost conflict. Fix asked for: Read `website-requirements.md`, correct every row and threshold against it, explicitly map the outside-operator requirement and its cost consequence, and mark any remaining unverifiable coverage as conditional.
- M1 (openrouter/mistralai/codestral-2508) on "Budget and Cost Estimation" (open): The cost controls and phase checks section does not explicitly mention the need to verify the source wording for R20 and whether the operator fee counts toward the monthly ceiling. Fix asked for: Add a step to verify the source wording and obtain a quote for the defined checklist and incident support in the cost controls and phase checks section.
- M3 (openrouter/openai/gpt-6.1-terra) on "Traceability Matrix" (open): All mappings and thresholds remain unverified, preventing a reliable requirement-by-requirement decision Fix asked for: compare every row with `website-requirements.md`, correct statuses and thresholds, and identify actual departures
- M1 (openrouter/mistralai/codestral-2508) on "Traceability Matrix" (open): R24 leaves prices as an unchecked exclusion, and R20 substitutes an owner checklist for the outside-person limit reported in the other table’s reading. Fix asked for: Verify the source wording for R20 and ensure that the operator fee counts toward the monthly ceiling before proceeding.
- M3 (openrouter/openai/gpt-6.1-terra) on "Traceability Matrix" (open): The R1–R24 mapping is provisional, preventing a reliable coverage and departure decision. Fix asked for: Compare each row and threshold with `website-requirements.md`, correct the matrix and record departures.
- M3 (openrouter/openai/gpt-6.1-terra) on "Open Decisions" (open): D4 recommends a staff-run checklist, contradicting the outside-operator arrangement elsewhere. Fix asked for: Recommend a named outside operator and make D4’s check and fallback consistent with that arrangement.

### Notes

None.

### Cost

The two tables together: 2287891 tokens, $4.4475 (the comparison and the final round come on top).
The last run on this task used 2431949 tokens, $4.5672 in all.
