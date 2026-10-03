# Stavya RIS: radiology management and coordination (no PACS)

A radiology information system that connects OPD, IPD and OT clinicians with the radiology department:
requests, scheduling, safety screening, worklist, reporting, critical-result communication, messaging, analytics and a tamper-evident audit log.
It stores **no images** and has no DICOM/PACS code.

Built from the Stavya_Radiology_Full design (state machine, hash-chained audit, role separation, critical-finding workflow) on the same
zero-dependency stack (Node 22.5+, `node:sqlite`). The agency's swapi backend is **not** used or contacted.

## Run
```bash
cd ris
RIS_DEMO_PASSWORD='choose-10+-chars' npm run seed     # demo users plus two weeks of OPD/IPD/OT/walk-in traffic, first run only
                                                      # add --no-traffic for just the users and 3 patients
npm start                                             # API + web on http://127.0.0.1:4000
# web app (rebuild after UI changes)
cd web && npm install && npm run build
# dev with hot reload: npm run dev in web/ (proxies /api to :4000)
npm test                                              # 15 end-to-end tests
```
Sign in with the **employee code** (case-insensitive) and the seed password. People, roles and codes live in one file, `server/roster.js`.
**The codes there (101, 102 ...) are placeholders: replace them with the real Stavya employee codes before real use, then reseed.**
Names and designations come from the Stavya organisation chart as recorded in the SSIE Radiology module; reception, ward nurses, admin and auditor are
generic role accounts because that material does not name them.

| Code | Person | Designation |
|---|---|---|
| 101 | Dr. Preety Ajay Krishnan | Radiologist, Head of Radiology (reports every study) |
| 102 | Hardik Ashokbhai Patel | MRI Technician |
| 103 to 107 | Mayur Jagdishbhai Solanki, Aditi Rakeshkumar Patel, Bijo Rajan, Tirth Sureshbhai Patel, Yashkumar Mangalbhai Parmar | Radiology Technologist |
| 201 to 203 | Dr. Mirant Bharat Dave, Dr. Bharat R. Dave, Dr. Ajay Krishnan | Consultant Spine Surgeon (request scans) |
| 204 | Dr. Ravi Ranjan Rai | Junior Spine Consultant |
| 205 | Dr. Krishna Pillai | Fellow (places IPD orders on the consultant's behalf) |
| 206 | Dr. Vivek Nair | Medical Officer (places IPD orders on the consultant's behalf) |
| 301, 302 | Reception 1, Reception 2 | Radiology Reception |
| 401 to 405 | HDU, ICU, Ward A, Ward B, Private nurses | Ward nurses |
| 901, 902 | Radiology Administrator, Compliance Auditor | Administrator, Auditor |

## Seed data
`npm run seed` fills an empty database with **guided samples** (`server/guided-data.js`): about 30 curated cases, one for every
situation each role can meet (a request at each workflow step, a blocked safety check, an overdue report, a critical result in
each state, and one walk-in bill for each money situation: unpaid, part paid, paid, cheque in process, online, each discount
outcome, each refund stage). Seeding prints the guide: which sample is for whom and what to do with it. Three patients with no
scans (SSH-1001 to SSH-1003) are left free for practising a new request. The placeholder exams that predate the hospital
charge sheet are hidden, so only the hospital tariff is offered.

- `npm run seed -- --traffic` gives the older bulk set instead: about 320 random scans over 14 days (`server/demo-data.js`).
- `npm run seed -- --empty` creates only the staff accounts and the three patients.

Cases are played through the real workflow with a simulated clock, so the audit chain, notifications, prices and payments are
genuine. All people and results are invented. Times are relative to when you seed, so reseed for a fresh "today".

## Who can do what
| Role | Main abilities |
|---|---|
| clinician / nurse (OPD, IPD) | Request exams, follow their own patients' orders (nurses: their ward), read **signed** reports only, message radiology, acknowledge critical results |
| reception | Register patients and encounters, acknowledge, schedule, check in, no-show |
| technologist | Start/complete scans, record safety screening |
| radiologist | Report and sign, addenda, override safety blocks, communicate critical results, reassign |
| admin / auditor | Analytics, audit log and chain verification (auditor is read-only) |

## Workflow
`REQUESTED → ACKNOWLEDGED → SCHEDULED → ARRIVED → IN_PROGRESS → COMPLETED → REPORT_DRAFTED → REPORTED` (plus `NO_SHOW`, `CANCELLED`).
"Scan complete" is a status set by the technologist; there is no image transfer.

## Smart features (all rule-based and transparent, no AI)
- **Exam suggestion** from the clinical indication (keyword match against the catalog).
- **Duplicate detection**: same exam for the same patient within 30 days must be confirmed.
- **Safety screening** blocks the scan for contrast allergy / low eGFR, pregnancy with ionising exams, and MRI implants; only a radiologist can override, with a reason.
- **SLA-driven worklist**: overdue first, then STAT/URGENT/ROUTINE, then earliest due (report targets 1h / 4h / 24h).
- **Critical wording detector** in reports (cauda equina, cord compression, pneumothorax, ...). Signing requires an explicit critical / not-critical decision.
- **Critical result loop**: radiologist records who was told, by which channel, with read-back; the ward acknowledges with an action plan; cases not communicated within 60 minutes escalate.
- **Signed reports are immutable**; changes are addenda linked in a SHA-256 signature chain, verified on every view.
- **Analytics**: backlog, overdue, median request→scan and request→report, SLA met %, critical time-to-communicate, mix by source/modality.

## Agency workflow (ported from the agency app, no swapi)
| Agency feature | Here |
|---|---|
| Registration wizard (identify, OTP, patient details, diagnosis) with English/Hindi/Gujarati hints | `#/register` (reception). OTP is checked **on the server**; existing patients found by phone, email, UHID or Aadhaar skip OTP |
| Patient form: ID proofs with front/back images, reference, occupation, Police ID upload, country/state/city | Same fields. Aadhaar is validated (Verhoeff) and stored only as a hash + last 4 digits |
| Modality > tests, per-scan No charge / 5, 10, 25% discount, prices | Same; discounts of 50% or more (incl. no charge) need a written reason |
| Registration list and dashboard tiles (Total, DEXA, MRI, Open MRI, X-Ray, Sonography, CT), Day/Week/Month/Custom, search, Excel and PDF export | `#/registrations`, `#/orders`. Excel = CSV; PDF = browser Print / Save as PDF |
| Pay now: cash denominations with change return, cheque (process later), online payment ID | Same, plus a receipt per payment. Online is a manually entered reference; **no gateway is connected** |
| Refund request | Needs a different person (admin) to approve, then pay-out |
| Invoice editor (report no, dates, lines, discount %, add/remove scan) | Registration page. Totals are always calculated by the server |
| Technician: status breakdown strip, journey Arrived, Prepared, Scan in/out, Finalised, Dispatched, Collected, Terminated with timestamps and turnaround | `#/worklist` and the order Overview |
| Patient's words (text and audio recording), medical consent, past history (diseases, medicines, surgery tree, other disease), patient consent form (CT/MRI contrast, sedation, English/Gujarati) | Order tabs. Saving the consent moves the scan to Prepared; a scan cannot start before that |
| OPD summary with include toggles and PDF | Visit summary page (print / save as PDF) |
| Forgot password | Code to the phone number on the account, then a new password |

Not ported: the spine-clinic scoring sections in the agency's OPD summary (ODI, SF36, etc.), Aadhaar OTP through Surepass, and the Razorpay live checkout. The agency embedded API tokens in its front end; none of that was copied.

Server settings: `RIS_OTP_WEBHOOK` (POST endpoint that delivers the code by SMS/email), `RIS_DEV_OTP=1` (local demo only: prints and shows the code), `RIS_REQUIRE_PATIENT_OTP=0` (skip OTP for new patients),
`HOSPITAL_NAME`, `HOSPITAL_ADDRESS` (printed on invoices). Prices and master lists in `server/reference-data.js` are **placeholders**: replace them with the hospital's tariff and masters.

## Design
The UI reuses the SSIE Radiology module's stylesheet and layout (`web/src/ssie.css` is SSIE's `styles.css` with the demo banner offset removed;
`web/src/extras.css` holds the few additions). Same tokens, Inter font, sidebar groups (People / Work / Safety), header search and critical chip,
card anatomy, KPI strip, "Next" card, work queue, day board, patient banner with UHID/admission, consultant, ward/room/bed and allergy,
Journey/Studies/Safety/Reports chart tabs, stepper, timeline, modals and toasts. Not ported because they depend on images or rooms: image viewer/measure tabs,
room board, scheduling calendar, the demo/training bar.

## Layout
`server/` API (one module per domain) · `server/reference-data.js` exam catalog, report templates and critical patterns (edit for the hospital) · `web/` React UI · `test/` end-to-end tests.

## Before real use
- **Patients and encounters** are entered locally today. Connect the hospital's source of truth by replacing the create/lookup in `server/patients.js`
  with an adapter (HIS/swapi API or feed); orders already carry `encounter_id` and source (OPD/IPD/OT/EXTERNAL).
- Set up HTTPS in front of the server, backups of `data/ris.db`, and review roles and the exam catalog with clinical leads.
- There is no MFA, and sessions are in memory (restart signs everyone out). Both are noted for production hardening.
- Critical-result and SLA times are provisional defaults to confirm with the hospital.
