# 08 — Known Limitations and Decisions Needed From the Hospital

## Purpose and how to use this chapter

This is a **go-live checklist**, not an essay. Every placeholder, provisional default, or deliberately-unbuilt
piece of the reference implementation is listed here once, grouped by area, in the same four-column shape:

**What it is today → Decision needed → Who decides → Where it lives in code.**

Detail and rationale for most items already live in earlier chapters; this chapter does not repeat that reasoning,
it indexes it. Where a row says "see §x of chapter NN," go there for the full explanation, code paths and test
references. Items that have no fuller write-up elsewhere are explained fully here, in one or two lines.

Sources for this checklist: `grep -rn "PLACEHOLDER\|PROVISIONAL\|price_note"` across `server/`, every `PROVISIONAL`
comment in `server/config.js`, `server/critical.js` and `server/roster.js`, the README's own "Before real use"
section (reorganised and extended here, not copied), and the "Placeholder / demo-only" sections already written in
chapters 04 and 06. Nothing below is invented; every row cites a real file.

Out of scope, as for every chapter in this package: PACS, DICOM, an image viewer, image storage. This system
stores no images, so there is nothing to check off for them.

## 1. Identity and access

| Item | Today | Decision needed | Who decides | File |
|---|---|---|---|---|
| Employee login codes | Plain sequential numbers `101`–`902` used as the login username (`users.username`) | Replace with Stavya's real employee codes before go-live, then reseed or update `users.username` in place | Hospital HR / IT, with backend team executing the data change | `server/roster.js:10-33` (header comment flags this explicitly) |
| Minimum password length | 10 characters, no complexity/rotation/breach-list rule; `RIS_DEMO_WEAK_PASSWORDS=1` drops even that (hard-refused only when `NODE_ENV=production`) | Is 10 chars with no other rule acceptable for production, or does hospital IT policy require complexity/rotation/breach checks? | Hospital IT security policy owner | `server/auth.js:23,86-87`; full discussion in 06_SECURITY_ROLES_AND_AUDIT.md §1.2, §9 |
| Session storage | In-memory `Map` (`server/auth.js:34`) — a server restart silently logs out every signed-in user; does not work correctly behind more than one app process/instance | Acceptable for v1, or does production need a shared session store (Redis, DB-backed) from day one, especially if horizontally scaled? | Backend/infra team, informed by expected deployment topology | `server/auth.js:34`; see 06_SECURITY_ROLES_AND_AUDIT.md §1.4, §8 |
| Login lockout storage | Same in-memory-`Map` issue as sessions, for failed-login counters (`server/auth.js:35`) — a restart silently un-blocks an in-progress brute-force attempt | Same storage decision as sessions, likely resolved together | Backend/infra team | `server/auth.js:35` |
| Rate limiting | Only per-username login lockout and per-target OTP resend throttling exist; **no general IP-based rate limiting anywhere in the app** | Add a reverse-proxy/API-gateway-level limiter in front of the whole API before production | Backend/infra team | whole app; noted in 06_SECURITY_ROLES_AND_AUDIT.md §8 |
| CORS | No CORS headers are set anywhere in `server/app.js`; the API only works same-origin today (fine because the SPA is served from the same process) | If production serves the web app from a different origin than the API, explicit CORS configuration must be added — do not assume it already works | Backend team, once deployment topology is fixed | `server/app.js`; 06_SECURITY_ROLES_AND_AUDIT.md §8 |
| Multi-factor authentication | None. Login is employee code + password only | Does the hospital require MFA for clinical/admin roles before production? | Hospital IT security policy owner | `server/auth.js` (no MFA code path exists) |
| Patient search exposure | Any authenticated employee can search **all** patients by name/phone/MRN with no masking and no audit trail (distinct from the masked, role-gated `lookupPatients()` used by the registration wizard) | Acceptable for the target jurisdiction's patient-privacy rules, or should this be tightened/masked/audited the same way? | Hospital compliance / legal, with backend team implementing | 06_SECURITY_ROLES_AND_AUDIT.md §3.3, §9 |

## 2. Clinical and operational timings (all explicitly `PROVISIONAL` in source)

| Item | Today (default) | Decision needed | Who decides | File |
|---|---|---|---|---|
| SLA hours (STAT / URGENT / ROUTINE) | 1h / 4h / 24h, env-overridable (`RIS_SLA_HOURS_STAT`/`_URGENT`/`_ROUTINE`) | Confirm real report-turnaround targets per priority | Radiology clinical leadership | `server/config.js:32` (comment: "PROVISIONAL clinical timings: confirm with the hospital") |
| Critical-communication window | 60 minutes before an open critical result escalates (`RIS_CRITICAL_MINUTES`) | Confirm the real escalation window for a radiologist-to-clinician critical call | Radiology clinical leadership | `server/config.js:33`; `server/critical.js:9` |
| Load-busy thresholds | Same for every modality: "Busy" at 3 combined queued+in-progress orders, "Very busy" at 6 (`RIS_LOAD_BUSY_AT`/`RIS_LOAD_VERY_BUSY_AT`) | A modality with fewer machines may need a lower bar than one with more — confirm per-modality, or accept one shared number | Radiology operations leadership | `server/config.js:35-38` (comment tagged `PKG-M5`) |
| Duplicate-order window | 30 days — same exam for the same patient within this window must be explicitly confirmed by the requester (`RIS_DUPLICATE_WINDOW_DAYS`) | Confirm 30 days is clinically appropriate (it is not marked `PROVISIONAL` in source but is an env-overridable default with no stated clinical sign-off) | Radiology clinical leadership | `server/config.js:34` |
| Session length | 8 hours (`RIS_SESSION_HOURS`), validated to be between 0 and 72 | Confirm against hospital IT session-timeout policy | Hospital IT | `server/config.js:39` |

## 3. Pricing and the exam catalog

| Item | Today | Decision needed | Who decides | File |
|---|---|---|---|---|
| Unpriced catalog items | **51 of 188** imported catalog rows have `price = NULL` (re-run `node server/import-master.js` against a scratch DB to reconfirm this count — do not trust a stale figure). Mostly individual CT studies (lumbar/cervical/dorsal spine, abdomen, thorax, PNS, …), four DEXA combination rows, and a handful of MRI specials. Each is un-orderable (`EXAM_PRICE_NOT_SET`) until priced. | Get real per-item rates from finance for all 51, item by item | Stavya finance / radiology administration | `server/data/radiology-master-import.json`, `server/import-master.js`; full list and mechanism in 05_BILLING_AND_DISCOUNT_MODULE.md §2.2 |
| CT per-study vs. generic-tier pricing | The sheet defines 3 generic CT tariff tiers (Screening ₹4,000 / Full Study ₹6,000 / Angio ₹10,000), but only the Angio tier is actually wired to any row via `priceTierHint` (8 rows). Individual CT studies (lumbar spine, abdomen, thorax, etc.) are **not** auto-mapped onto Full Study/Screening — they are simply `NULL`-priced today. | Choose one: (a) price each CT study individually, or (b) formally adopt the 3-tier model and have reception always bill CT work as one of the three tiers. The code supports either; it does not decide. | Stavya finance, with radiology operations input | `server/import-master.js` (`tierKey`, `NO_SHEET_COVERAGE`); 05_BILLING_AND_DISCOUNT_MODULE.md §2.2 |
| `OPEN_MRI` and `USG` (ultrasound) prices | The hospital's tariff sheet never mentions these two modalities at all. Both keep their original hand-written seed prices from `server/reference-data.js`, now flagged `source = 'PLACEHOLDER'` | Get real Open MRI and ultrasound rates from finance before any order in these modalities is billed for real | Stavya finance | `server/import-master.js` (`NO_SHEET_COVERAGE = ['OPEN_MRI', 'USG']`), `server/reference-data.js:61-68` (`PRICES`) |
| Discount schemes | Three hard-coded schemes from the hospital's own tariff file: Staff 100% (reason + approval required), Nearest relative 25% (reason required), Distant relative 10% (reason required). Any discount ≥50% or marked `requires_reason` needs a written reason; any ≥50% or marked `requires_approval` needs a second (different) person's sign-off. | Confirm these are the complete, correct set of standing discount schemes — and whether the 50% reason/approval threshold itself is the right cut-off | Stavya finance / hospital administration | `server/data/radiology-master-import.json` (`discounts`), `server/discounts.js:13,29,31` |
| Original hand-written catalog and prices (pre-import) | `server/reference-data.js`'s `EXAMS`/`PRICES` (20 exams) are the original placeholder demo catalog, superseded by the real import for everything the sheet covers | No action needed for priced items; this file is still the fallback source for `OPEN_MRI`/`USG` prices above, and should only be hand-edited for genuinely new exams not in any hospital sheet | Radiology administration, with backend team | `server/reference-data.js:1-68` |

## 4. Reference-data masters (registration/clinical-history dropdowns)

All of the following are explicitly commented `// PLACEHOLDERS: replace with the hospital's own masters` in source.
None are clinically or operationally critical to launch, but all were invented for the demo and were never reviewed
by hospital staff:

| List | Today | File |
|---|---|---|
| ID proof types | Aadhaar, PAN, Driving Licence, Voter ID, Passport | `server/reference-data.js:71` (`PROOF_TYPES`) |
| Referral sources | Self/walk-in, Referred by a doctor, Hospital staff, Website, Family/friend | `server/reference-data.js:72` (`REFERRALS`) |
| Designations / occupations (patient past-history form) | Generic invented lists (Business owner, Engineer, …; Student, House Wife, …) | `server/reference-data.js:73-74` |
| Medicines (past-history picker) | 24 invented common medicines with drug class | `server/reference-data.js:75-78` |
| Diseases by organ system (past-history picker) | 6 organ systems, invented disease lists | `server/reference-data.js:79-80` |
| Surgery tree (region > level > approach > type > add-on) | Spine-surgery taxonomy invented for the demo | `server/reference-data.js:81-84` |

**Decision needed:** should these be replaced with Stavya's own standard lists before go-live, or are they
acceptable free-text-adjacent conveniences that can be refined post-launch? **Who decides:** radiology
administration / clinical records team.

## 5. External system integration

| Item | Today | Decision needed | Who decides | Pointer |
|---|---|---|---|---|
| OPD / IPD / HIS integration | Patients and encounters are entered **locally** by reception/clinicians; there is no live connection to any hospital information system | Full integration shape (patient master lookup, OPD visit feed, IPD ADT feed, external order intake, result return) — this is a substantial design question on its own | Hospital IT + backend/integration team | **See 04_OPD_IPD_INTEGRATION_CONTRACT.md in full — not repeated here** |
| OTP delivery channel (patient registration, password reset) | `RIS_OTP_WEBHOOK` is **unset by default** — code delivery is non-functional until wired. `RIS_DEV_OTP=1` is local-demo-only (prints/returns the code in the API response; refused outright when `NODE_ENV=production`) | Choose and wire an actual SMS/email gateway behind the webhook POST contract | Hospital IT / chosen SMS-email vendor, backend team to implement | `server/otp.js:12-13,25-32`, `server/config.js:24-27,75,78` |
| SMS / WhatsApp notifications in general | Beyond OTP delivery, the system has **no outbound SMS/WhatsApp integration at all** — `notifications.js` is purely in-app (a `notifications` table, polled/read by the signed-in user); nothing pages a clinician's phone | Does the hospital want critical-result or SLA-breach alerts pushed to a phone (SMS/WhatsApp/push), beyond the in-app notification bell? | Radiology clinical leadership + hospital IT | `server/notifications.js` (no gateway call anywhere in the file) |
| Payment gateway | No payment gateway is integrated. Online payments are **manually recorded** by staff from a gateway/UPI confirmation they see elsewhere (`gateway` is a free-choice label: UPI/Card/NetBanking/Razorpay/Other; `reference` is staff-entered and only checked for accidental duplicate entry) | Integrate a real gateway (the agency's prior app used Razorpay live checkout; explicitly **not ported** here) if the hospital wants in-system online collection rather than manual reconciliation | Hospital finance + backend team | `server/billing.js:55-58`; README "Agency workflow" table, Pay-now row |
| Aadhaar OTP verification (Surepass) | Not ported from the agency app. Aadhaar is Verhoeff-validated and stored only as a hash + last 4 digits; there is no live government verification | Does production need live Aadhaar verification, or is local checksum validation sufficient? | Hospital compliance / legal | README "Not ported" line; `server/patients.js` (Aadhaar handling) |

## 6. Infrastructure and operations

| Item | Today | Decision needed | Who decides | File |
|---|---|---|---|---|
| HTTPS | Not set up; the server listens plain HTTP on `127.0.0.1:4000` by default | Put TLS termination (reverse proxy or direct) in front before any real network exposure | Backend/infra team | `server/config.js` (`host`/`port`), README "Before real use" |
| Backups | **None implemented.** `data/ris.db` (SQLite, WAL mode) has no backup job of any kind in this codebase | Define and implement a backup schedule and a tested restore procedure before go-live | Hospital IT / backend team | `server/db.js`; README "Before real use" (states this plainly, no code backs it) |
| Retention policy | **None implemented.** Nothing ages out, archives, or purges clinical, audit, or financial records; the one soft-delete that exists (`clinical.js:44`, past-history entries) keeps rows forever, just hidden from UI | Define a retention/archival policy per hospital and regulatory requirements (clinical records, audit log, payment records may each have different legal minimums) | Hospital compliance / legal, backend team to implement | `server/clinical.js:44`; no retention code exists elsewhere |
| SQLite / single-process assumptions | One `DatabaseSync` connection, WAL mode, 5-second busy timeout (`server/db.js`). Several correctness properties depend on being a single writer: the audit hash-chain's "read last hash, then insert" (`audit.js`), and every `COUNT(*)`-based sequence number (accession numbers in `orders.js`, registration numbers, receipt numbers) | Fine for one instance. A horizontally-scaled rebuild (multiple app servers, or a different DB engine) must re-examine every single-writer assumption, not just swap the driver | Backend team, once the target stack is chosen | `server/db.js`, `server/util.js` (`tx()`), `server/audit.js:14`; 06_SECURITY_ROLES_AND_AUDIT.md §8 |
| Hospital identity on documents | `HOSPITAL_NAME` defaults to `"Stavya Spine Hospital · Radiology"`; `HOSPITAL_ADDRESS` defaults to **empty**, printed on invoices/receipts | Set both for production; an empty address currently prints nothing (a startup warning, not an error) | Hospital administration | `server/config.js:29-30,79` |
| Body size limits | 1 MB for ordinary API calls, 12 MB for the few routes carrying images/audio (ID proofs, consent recordings) | Confirm these are sufficient for real-world ID-proof photo sizes and audio consent recordings before go-live | Backend team, with input from reception on real file sizes seen in the field | `server/config.js:41-42` |
| Database file location | Defaults to `<project root>/data/ris.db`, overridable via `RIS_DB` | Point this at the real production storage location/volume as part of deployment | Backend/infra team | `server/config.js:22` |

## Open questions for the hospital / backend team

- No single item above is individually blocking, but **go-live readiness is the sum of every row in this
  checklist** — is there an owner tracking this list end to end, or does each area's owner (finance, radiology
  leadership, hospital IT, backend team) need to sign off independently with no single point of coordination?
- Several items here (backups, retention, MFA, SMS/WhatsApp alerting, payment gateway) are not just configuration —
  they are features that do not exist in the reference implementation at all. Is the expectation that the backend
  team builds all of these during the rebuild, or that some are deferred to a post-launch phase? This chapter
  cannot answer that; it only confirms they are currently absent.
- The 51 unpriced catalog items and the CT per-study-vs-tier question (§3) block real billing for a meaningful slice
  of CT work specifically — is that acceptable for a phased go-live (launch with MRI/XR/DEXA/priced-CT only), or
  must every modality be fully priced before any go-live?
- Retention policy (§6) has no default and no code today — does the hospital already have a records-retention
  policy from the main hospital information system that radiology should simply inherit, rather than defining one
  from scratch for this module?
