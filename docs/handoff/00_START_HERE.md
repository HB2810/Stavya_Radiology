# Stavya Radiology — Backend & Integration Handoff

**Package prepared:** 1 October 2026
**For:** the outsourced backend team engaged to productionise this Radiology Information System (RIS) and integrate
it with Stavya Spine Hospital's OPD/IPD system.
**What you have:** a working reference implementation (Node.js + SQLite), fully functional end to end, plus the nine
chapters in this folder documenting its data, behaviour, API and the integration work still to do.

## What this project is

A Radiology Information System for Stavya Spine Hospital: requests, scheduling, safety screening, consent,
reporting, critical-result communication, billing (with the hospital's real tariff and discount rules), and a live
load indicator so OPD/IPD staff can see how busy radiology is before sending a patient.

**It deliberately contains no PACS, DICOM, image viewer, image storage or image-based AI.** That was removed from an
earlier, larger prototype by product decision. Nothing in this handoff asks you to build any of that back in — if a
future phase wants it, treat it as new scope, not a gap in this package.

## How to use this package

1. Start with this file, then read the chapters in order — each is a prerequisite for the next:

   | # | Chapter | Read this to understand |
   |---|---|---|
   | 01 | [Data model and relationships](01_DATA_MODEL_AND_RELATIONSHIPS.md) | Every table, every column, the full ER diagram, and the append-only/idempotency guarantees any rebuild must keep |
   | 02 | [API reference](02_API_REFERENCE.md) | All 87 endpoints: method, role, request/response, error codes |
   | 03 | [Business rules and workflows](03_BUSINESS_RULES_AND_WORKFLOWS.md) | The state machines — order lifecycle, reporting, critical results, discount/refund approval, safety screening |
   | 04 | **[OPD/IPD/external integration contract](04_OPD_IPD_INTEGRATION_CONTRACT.md)** | **Start here if you only read one chapter.** What's self-contained today and exactly what to build to connect this to the hospital's real OPD/IPD system |
   | 05 | [Billing and discount module](05_BILLING_AND_DISCOUNT_MODULE.md) | The service/price master (from the hospital's own charge sheet), payments, discounts, refunds |
   | 06 | [Security, roles and audit](06_SECURITY_ROLES_AND_AUDIT.md) | Auth, the 7-role permission matrix, the tamper-evident audit chain |
   | 07 | [Deployment and operations](07_DEPLOYMENT_AND_OPERATIONS.md) | How to run it, every environment variable, and what a production stack needs that the reference stack doesn't have |
   | 08 | [Known limitations and open decisions](08_KNOWN_LIMITATIONS_AND_OPEN_DECISIONS.md) | The go-live checklist — every placeholder value and who must decide its real value |
   | 09 | [UI screens and role flows](09_UI_SCREENS_AND_ROLE_FLOWS.md) | What each of the 7 roles' screens actually needs from the backend, independent of whether the frontend is rebuilt |

2. **Run the reference implementation yourself before changing anything** — chapter 07 has the exact commands. Seeing
   the real behaviour (and its test suite) settles more questions than prose can.

3. Every chapter ends with **"Open questions for the hospital / backend team"** — genuine ambiguities the writers
   found, not restatements of the placeholder list. Chapter 08 is the consolidated checklist; the others are where
   the reasoning for each item lives.

## Package contents

```
docs/handoff/        — this documentation (9 chapters + this index)
reference-implementation/
  server/            — the API (Node 24, zero npm dependencies, node:sqlite)
  server/migrations/  — versioned schema history (001-004), the authoritative schema source
  server/data/radiology-master-import.json — the hospital's real tariff + discount data, extracted from their
                         own charge-sheet spreadsheets and already imported into the running system
  web/src/           — the reference UI (React + Vite), built on the hospital's existing SSIE design system
  test/              — the end-to-end test suite (run it: it encodes exact intended behaviour)
  README.md          — the original developer README (quick-start, demo accounts, feature list)
  package.json, web/package.json
```

**Deliberately NOT included:** `node_modules` (run `npm install`), the demo SQLite database and its WAL/SHM files
and any `.env`/password files (all synthetic demo data — regenerate with `npm run seed`, see chapter 07), and the
hospital's original Excel files (the extracted, structured JSON that replaces them is in `server/data/`).

## The single most important thing to get right

This system's clinical core — the order state machine, safety and consent gates, immutable signed reports, and the
critical-result communication loop — is tested, audited, and working. **Chapter 04, §5 ("What must NOT change when
integration is added")** says this explicitly: build the OPD/IPD integration as an adapter at the edges of this
system, not a rewrite of the clinical workflow underneath it. If a decision in this handoff is genuinely unclear,
treat chapter 08's "who decides" column as authoritative on *who* to ask — most answers belong to Stavya's radiology
leadership or hospital IT, not to this document.
