# 07 — Deployment and operations

Reference implementation: `/Users/stavyaspinehospital/Radiology/radiology-ms/ris` — Node.js ≥ 22.5, `node:sqlite`
(built into Node, no database driver dependency), zero npm dependencies. This chapter documents how the reference
system is run today, every environment variable it reads, the schema-migration mechanism, the operational
limitations that follow from "one process, one SQLite file," and how demo data is generated. It ends with a clearly
labelled, non-binding suggestion for what a production stack should provide in place of each reference-only piece.

**Out of scope, noted once:** PACS, DICOM, an image viewer, image storage, image-based AI. This system stores no
images, so nothing in this chapter concerns image infrastructure either.

This is a **reference implementation**, not a mandated target stack. The backend team may rebuild this in a
different language, framework, or database. What must survive the rebuild is the *behaviour* described here:
the environment-variable contract's intent (even if the variable names change), the migration discipline, and —
most importantly — an honest accounting of what the reference build quietly gets away with by running as a single
process, which a multi-instance production deployment cannot.

---

## 1. Running the reference implementation

Everything below is driven by `package.json` at the project root:

```json
{
  "engines": { "node": ">=22.5" },
  "scripts": {
    "start": "node server/index.js",
    "seed": "node server/seed.js",
    "test": "node --test --no-warnings test/*.test.js"
  }
}
```

- **`npm start`** runs `server/index.js`. It calls `validateConfig()` first (§2) and refuses to start — exits with
  code 1 — if any environment variable fails validation. If it passes, it calls `seedCatalog()` (idempotent: the
  built-in exam catalog, report templates and reference lists, `INSERT OR IGNORE`/conditional — see §4), opens the
  database (which itself runs pending migrations — §3), and listens on `config.host:config.port`
  (`127.0.0.1:4000` by default). Logs the applied schema version on startup. `SIGINT`/`SIGTERM` trigger a graceful
  shutdown: stop accepting new connections, close the SQLite handle, exit 0; an uncaught exception does the same but
  exits 1 (so a process supervisor restarts it) and force-exits after a 5-second grace period if `server.close()`
  hangs.
- **`npm run seed`** runs `server/seed.js` directly (see §6 — demo data).
- **`npm test`** runs Node's built-in test runner (`node --test`, no external test framework) across the 8 files in
  `test/*.test.js` (`flow`, `agency`, `discounts`, `load`, `roles`, `masters`, `review-fixes`,
  `traffic-sources`). Every test file sets `process.env.RIS_DB = ':memory:'` before importing `server/app.js`, so
  tests never touch `data/ris.db` and each file gets an isolated in-memory database seeded fresh via `seedDemo()`.
- **Web client build**: the UI (`web/src/*.jsx`) is a separate Vite/React project under `web/`. Build it with
  `cd web && npm install && npm run build`; the server serves the result as static files from `config.webDir`
  (default `web/dist`) alongside the API — there is no separate static-file server in the reference deployment.
  `cd web && npm run dev` runs a hot-reload dev server that proxies `/api/*` to `:4000` for frontend development;
  it is not used in production.

There is no Dockerfile, process manager config, reverse-proxy config, or CI/deployment pipeline anywhere in this
repository — the reference implementation is "clone it, set environment variables, `npm start`." A production
deployment needs all of that built from scratch; nothing here can be cited as a starting point beyond the
`npm start` entry point itself.

**No TLS, no reverse-proxy awareness.** `server/app.js` opens a plain `node:http` server — no HTTPS listener, no
`X-Forwarded-*` trust configuration, no CORS headers, and no built-in rate limiting beyond the per-username login
lockout in `auth.js` (§5). The reference default (`HOST=127.0.0.1`) only ever binds loopback, which is why this is
tolerable for a demo running on one machine. In production this process must sit behind a reverse proxy (nginx,
Caddy, a cloud load balancer, etc.) that terminates TLS, and the backend team should decide there whether to add
CORS and rate-limiting at that layer or inside the application.

---

## 2. Environment variables (`server/config.js`)

`server/config.js` is the single source of truth: every setting the server reads from `process.env` is declared
here as a lazy getter (so a value changed at runtime, e.g. by a test, is honoured) with an explicit default, and
`validateConfig()` — called once at startup by `server/index.js` — refuses to start if anything is out of range.
**There is no `.env.example` file in this repository** despite being referenced in two source comments
(`config.js`, `index.js`) — the backend team should either add one documenting the variables below, or replace this
mechanism entirely with whatever configuration approach the production stack uses. A `.env` file at the project
root is auto-loaded on import (`loadEnvFile()`) except under `node --test`, so test runs never depend on a
developer's local file; real `process.env` values always win over `.env`.

| Variable | Default | Validated range / notes | Safe to leave at default in production? |
|---|---|---|---|
| `NODE_ENV` | unset | `=== 'production'` is the single switch (`config.production`) that tightens several checks below | **Must be set to `production`** — several dangerous defaults are only blocked when this is set |
| `PORT` | `4000` | integer 1–65535 | Fine as a default; typically fixed by the deployment environment anyway |
| `HOST` | `127.0.0.1` | any string | **No** — loopback-only; production needs this bound appropriately for its network topology (often still `127.0.0.1` behind a reverse proxy on the same host, but confirm) |
| `RIS_DB` | `<project root>/data/ris.db` | must be an existing file if present; `:memory:` is **rejected outright when `NODE_ENV=production`** | **No** — point this at a real, backed-up volume path in production; never leave unset if the project directory itself isn't persisted |
| `RIS_WEB_DIR` | `<project root>/web/dist` | any path | Fine, provided the web build was actually placed there |
| `RIS_OTP_WEBHOOK` | `''` (unset) | must be `http://` or `https://` if set | **No** — unset means OTP delivery is not configured at all; patient registration and password reset cannot send codes (§5, §7). A `startup warning` is logged when unset, in production or not |
| `RIS_DEV_OTP` | `false` | **forced off / rejected when `NODE_ENV=production`** (startup error if set) | N/A in production — this is a local-demo convenience that echoes the one-time code back in the API response instead of sending it; it can never be relied on as a bypass in production because `validateConfig()` refuses to start if it's set there |
| `RIS_REQUIRE_PATIENT_OTP` | `true` (any value other than the literal string `'0'` means true) | boolean-ish | Leave at default (true) in production; this is the patient-facing OTP gate during registration |
| `RIS_DEMO_WEAK_PASSWORDS` | `false` | **forced off / rejected when `NODE_ENV=production`** | N/A in production — only relaxes the 10-character minimum on seed-created passwords for local convenience |
| `HOSPITAL_NAME` | `'Stavya Spine Hospital · Radiology'` | free text | Confirm wording with the hospital before go-live; it prints on invoices/receipts |
| `HOSPITAL_ADDRESS` | `''` | free text | **No** — empty means invoices and receipts print no address (startup warning); set a real address |
| `RIS_SLA_HOURS_STAT` / `_URGENT` / `_ROUTINE` | `1` / `4` / `24` | each `0 < hours ≤ 720` | **No** — explicitly marked PROVISIONAL in the source; confirm real turnaround targets with radiology before relying on the worklist's overdue sort or the SLA-met analytics figure |
| `RIS_CRITICAL_MINUTES` | `60` | `1–1440` | **No** — PROVISIONAL; the minutes a critical result has before `sweepCritical()` escalates it (see the correctness caveat in §4 of chapter 03 and §4 below — the sweep itself is lazy, not just the number) |
| `RIS_DUPLICATE_WINDOW_DAYS` | `30` | `0–365` | Reasonable default; confirm with radiology whether 30 days is the right duplicate-order window for every modality |
| `RIS_LOAD_BUSY_AT` / `RIS_LOAD_VERY_BUSY_AT` | `3` / `6` | both integers ≥ 1, `veryBusyAt > busyAt` | **No** — PROVISIONAL and identical across every modality; informational widget only (never blocks ordering), but a modality with fewer machines likely needs a lower bar |
| `RIS_SESSION_HOURS` | `8` | `0 < hours ≤ 72` | Reasonable default, but see §4 — the session store itself (not just its TTL) is the real production gap |
| `RIS_MAX_BODY_BYTES` | `1,000,000` (1 MB) | `1024–100,000,000` | Fine as a default for JSON API bodies |
| `RIS_MAX_UPLOAD_BODY_BYTES` | `12,000,000` (12 MB) | `1024–100,000,000` | Applies only to the routes marked `upload: true` (ID-proof images, voice notes on messages, etc.); fine as a default, adjust if the hospital's scanned documents run larger |
| `RIS_REQUIRE_REVISION` | `false` | boolean flag | Worth turning **on** in production once every client is confirmed to send `expectedRevision` — it closes a lost-update race that's otherwise merely optional (see chapter 03 §1.5) |
| `RIS_IDEMPOTENCY_TTL_HOURS` | `24` | integer | Reasonable default for how long an `Idempotency-Key` is remembered (`idempotency.js`) |
| `RIS_DEMO_PASSWORD` | — (no default; required) | ≥ 10 characters unless `RIS_DEMO_WEAK_PASSWORDS` | Only read by `server/seed.js`, not by `config.js`/the running server. **Never use the seed script, or this variable, against a production database** — see §6 |

`validateConfig()` returns `{ errors, warnings }`. Any **error** (out-of-range value, a production-forbidden flag
set, `RIS_DB=:memory:` in production, a malformed `RIS_OTP_WEBHOOK` URL, an `RIS_DB` path that exists but isn't a
regular file) stops the process from starting at all — `server/index.js` prints every error and exits 1.
**Warnings** are logged but do not block startup: no OTP delivery configured, and an empty `HOSPITAL_ADDRESS`. A
backend team retargeting this to a different config-loading mechanism (12-factor env, a secrets manager, etc.)
should keep this fail-fast-on-error / warn-but-boot-on-warning split — it is what currently stops, for example, a
production deployment from silently running with `RIS_DEV_OTP=1` leaking one-time codes into API responses.

---

## 3. The migration system (`server/migrations/index.js`)

Schema changes are plain JS modules, one per file, each exporting `{ id, name, up(db), down?(db) }` with
consecutive integer `id`s starting at 1. They are registered by hand in `server/migrations/index.js`'s
`MIGRATIONS` array (currently `[001_baseline, 002_foundation, 003_service_master, 004_discount_scheme_link]`,
`LATEST = 4`) — adding a migration means creating the new file and appending it to that array; **an already-applied
migration file is never edited**, only superseded by a new one.

Applied versions are tracked in a `schema_version(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)` table,
created on demand if missing. `migrate(db, { file, target = LATEST, makeBackup = true, log })` is called once,
automatically, every time `server/db.js` opens the database (so simply starting the server upgrades the schema —
there is no separate "run migrations" deployment step to remember). It:

1. Reads the current version (`MAX(version)` from `schema_version`, or 0 for a brand-new database).
2. **Refuses to run at all if the database's version is newer than this build knows** (`from > LATEST` throws) —
   this stops an old server binary from being pointed at a database a newer version already migrated, which would
   otherwise silently reinterpret a schema it doesn't understand.
3. If there is work to do (`target > from`) **and** the database already has data (detected by the presence of a
   `users` table — i.e. it isn't a brand-new, empty database) **and** it isn't `:memory:`, it takes a consistent
   backup first via SQLite's `VACUUM INTO '<file>.pre-v<N>-<timestamp>.bak'` (works correctly even under WAL mode)
   and `chmod`s it `0600`. This is the *only* backup mechanism anywhere in the codebase — see §4.
4. Applies each pending migration's `up(db)`, normally wrapped in the shared transaction helper `tx()` from
   `util.js` (`BEGIN IMMEDIATE` / `COMMIT`, with nested calls becoming savepoints) so a migration failure rolls
   back cleanly and the error is re-thrown with the failing migration's id and name.
5. Records each applied id/name/timestamp into `schema_version` in the same transaction as the migration itself.

**By design, every migration except one is additive and safe to run against a populated database**: new tables,
new nullable columns, new indexes. The one exception, `003_service_master.js`, needed to make
`exam_catalog.price` nullable (it was `REAL NOT NULL DEFAULT 0`) — a price of `0` must never be confused with "no
price set yet" (that would silently bill a study as free), so unpriced imported items needed to become a real
`NULL` rather than a fabricated `0`. **SQLite has no `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL`.** The only
way to relax a column constraint is to rebuild the table: create a new table with the desired shape, copy the data
across, drop the old table, rename the new one into place. Two further complications followed directly from that:

- `orders.exam_code` is a foreign key into `exam_catalog(code)`, and SQLite refuses to `DROP TABLE exam_catalog`
  while a foreign key still references it and enforcement is on.
- `PRAGMA foreign_keys` is a **documented no-op while a transaction is already open** in SQLite — it can only be
  toggled outside a transaction.

So `003_service_master.js` is the one migration marked `rawSql: true`, which opts it out of the runner's normal
`tx()` wrapper (see the `rawSql` branch in `migrate()` above) and instead manages its own
`PRAGMA foreign_keys = OFF` → `BEGIN IMMEDIATE` → rebuild-and-rename → `COMMIT` → `PRAGMA foreign_keys = ON`
sequence, with its own try/catch that rolls back and always re-enables enforcement in a `finally` block even on
failure.

**What a backend team on a different database needs to take from this, independent of SQLite specifics:** the
general category of change — relaxing or tightening a `NOT NULL`/`CHECK` constraint, changing a column's type, or
anything else a plain `ALTER COLUMN` can't express — needs special handling on *any* database, not just SQLite's
particular workaround. On a different RDBMS the mechanics differ (PostgreSQL, for example, supports
`ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL` directly without a table rebuild, and lets you add
`NOT VALID` constraints to avoid a full-table scan/lock on a large populated table; MySQL's story is closer to
SQLite's for some constraint changes depending on version and storage engine). The migration discipline a
production backend should keep, regardless of engine, is:
- Treat "this migration needs a non-trivial rebuild, not just an `ALTER`" as its own category, flagged and
  reviewed separately from additive changes.
- Never silently coerce an unknown/missing value to a default that has business meaning (here: never default an
  unpriced exam to `price = 0`) — carry the "we don't know yet" state explicitly (`NULL` plus `price_note`, in this
  codebase) through the migration.
- Take a verified backup immediately before any migration that touches a populated database, and prove the backup
  is restorable, not just taken (this codebase's `VACUUM INTO` step has never been tested for restore — see §4).
- Decide up front how rollback (`down()`) is handled for a destructive-shape change; this project's own
  `003_service_master.js.down()` is explicitly commented as a **development-only** rollback that coalesces a
  `NULL` price back to `0` — i.e. **it is not safe to run `down()` on a production database with real `NULL`
  prices**, because it reintroduces exactly the "0 means free" ambiguity the migration existed to remove.

---

## 4. Operational limitations of the reference stack (single-process SQLite)

The reference server is designed, deliberately, to run as **exactly one Node process** against **one SQLite file**.
Several pieces of application logic are only correct under that assumption, and none of them would raise an error
if violated — they would silently misbehave. A production backend that wants horizontal scaling, PM2 cluster mode,
or any other form of multiple concurrent server processes against the same data must address every item below, not
just swap the database engine.

- **In-memory session store.** `server/auth.js` keeps both the session table and the login-lockout counters in
  plain JS `Map`s (`const sessions = new Map()`, `const attempts = new Map()`), scoped to the process. Two
  consequences: (1) **a server restart silently logs out every signed-in user** — there is no persisted session
  store; (2) **running more than one server process (PM2 cluster mode, multiple containers, etc.) breaks sign-in
  outright**, because a session created on worker A is invisible to worker B — a user's next request, if routed to
  a different worker, sees them as signed out. A production backend needs an external, shared session store (Redis,
  a database table, signed/stateless JWTs — whichever the chosen stack prefers) before it can run more than one
  instance.
- **The lazy critical-result escalation sweep.** As documented in chapter 03 §3, `sweepCritical()` only ever runs
  as the first line of `listCritical()` — i.e. only when something calls `GET /api/critical`. There is no
  timer, cron job, or background worker. This is already a correctness gap on a single instance (an overdue
  critical result stays `OPEN` and un-escalated until somebody happens to open the critical-results list); it does
  not get worse with multiple processes (each would just redundantly re-run the same read-triggered sweep), but it
  is exactly the kind of logic a production backend should replace with a real scheduler regardless — see the
  suggestions in §7.
- **`COUNT(*)+1`-style identifier generation.** Every human-facing sequence number in this codebase — the order
  `accession` (`orders.js`, `RAD-<year>-<n>`), the walk-in registration number (`registration.js`'s `reg_no`,
  `REG-<year>-<padded n>`), the external-registration encounter reference (`EXT-RAD-<year>-<padded n>`), and the
  patient MRN (`registration.js`, `SSH-<1001+n>`) — is generated by running `SELECT COUNT(*) ... WHERE ... LIKE
  '<prefix>%'` and adding 1, inside the same write transaction as the insert that consumes it. This is safe **only**
  because this codebase has exactly one SQLite connection, one in-process write path, and `tx()`'s `BEGIN
  IMMEDIATE` acquires SQLite's write lock for the duration — there is never a second writer able to compute the
  same `COUNT(*)` concurrently. **This pattern is a classic race condition the moment there is more than one writer
  — multiple processes, or a database engine that permits concurrent writers (which SQLite, with one connection,
  deliberately does not).** A production backend must replace every one of these with a real atomic sequence
  (`SERIAL`/`IDENTITY`/`SEQUENCE` on a real RDBMS, or an application-level allocator backed by a unique constraint
  and a retry loop) — not a `COUNT(*)+1` read-then-write.
- **No payment gateway.** `billing.js` records payments (`CASH`/`CHEQUE`/`ONLINE`) and non-cash refund payouts as
  staff-entered reference numbers; nothing in this codebase calls out to a real payment processor (no Razorpay,
  Stripe, UPI gateway, etc.). An "ONLINE" payment is literally a staff member typing in a transaction ID they read
  off an external terminal/app. A production backend integrating real payments needs its own gateway integration
  end-to-end (authorization, webhook/callback reconciliation, idempotent capture), which does not exist here in
  any form to extend.
- **No SMS/WhatsApp gateway for OTP or critical-result alerts.** `RIS_OTP_WEBHOOK` (§2, `server/otp.js`) is a
  **stub HTTP contract, not an implementation**: when set, `deliver()` does a single `fetch(RIS_OTP_WEBHOOK, {
  method: 'POST', body: { channel, target, message } })` and treats any non-2xx response as a hard failure
  (`502 OTP_DELIVERY_FAILED`); it is entirely the receiving webhook's job to actually hand that message to an SMS
  or WhatsApp provider. If `RIS_OTP_WEBHOOK` is unset (and `RIS_DEV_OTP` is off, which it must be in production),
  OTP delivery simply fails with `503 OTP_DELIVERY_NOT_CONFIGURED` — registration and password reset do not
  work at all. Separately, **critical-result notifications are database rows, not messages**: `notify()` in
  `server/notifications.js` only `INSERT`s into a `notifications` table that the web UI polls/reads — nobody is
  actually paged, texted, or emailed when a critical result opens or escalates. The only real-world alerting in the
  critical-result loop is the radiologist's own phone call, which a human then records via
  `POST /api/critical/:id/communicate` after the fact. A production backend wanting push/SMS/WhatsApp delivery for
  either OTPs or critical alerts has to build that integration from nothing; `RIS_OTP_WEBHOOK`'s shape is the only
  existing contract to possibly reuse, and only for OTPs.
- **No real backup/restore tooling.** Beyond the migration runner's own pre-migration `VACUUM INTO` snapshot
  (§3, taken only when migrating a *populated* database, and never exercised as a restore in this codebase or its
  tests), there is no scheduled backup, no replication, no point-in-time recovery, and no documented restore
  procedure. `.gitignore` excludes `data/*.db*` and `data/demo-password.txt` from version control, confirming the
  database file is operational state, never committed. In practice, "backup" today means "copy `data/ris.db`
  while confident nothing is writing to it" (SQLite's WAL mode, `PRAGMA journal_mode = WAL` set in `db.js`, makes
  a naive file copy unsafe while the server is live unless the copy tool is WAL-aware, e.g. the SQLite `.backup`
  command or another `VACUUM INTO` call). A production backend needs a real, tested, scheduled backup/restore
  procedure appropriate to whatever database it ends up using.
- **Time zone handling is implicit, not configured.** `util.js`'s `dateRange()` — the function behind every
  day/week/month/custom date filter in the system (registration lists, the worklist, analytics) — parses dates with
  `new Date(year, month, day)`, which JavaScript evaluates in the **host process's local time zone**. Nowhere in
  this codebase (`config.js`, `index.js`, or anywhere else — confirmed by search) is a time zone explicitly set or
  even referenced; there is no `TZ` handling and no mention of "Asia/Kolkata" or "IST" in the source. The system
  behaves correctly for a Gujarat-based hospital only because whatever host runs `node server/index.js` happens to
  have its local/OS time zone set to India Standard Time (UTC+5:30) — "today" for every date filter is computed
  against that host clock's zone, implicitly. **A production backend on a different stack (or even just a
  differently configured host, e.g. a container image that defaults to UTC) needs an explicit time-zone decision**:
  either pin the process's zone deliberately (Node respects the `TZ` environment variable), or rewrite day-boundary
  logic to compute explicitly against a fixed offset/zone rather than relying on ambient host configuration. Do not
  assume a rebuild "just works" because the reference implementation currently does, on one particular host.

---

## 5. Supporting operational notes

- **Login throttling** (`server/auth.js`) locks a *username* out for 5 minutes after 5 consecutive failed
  attempts (`429 TOO_MANY_ATTEMPTS`), tracked in the same in-process `Map` discussed in §4 — it resets on a
  process restart and is not shared across multiple instances, same as sessions.
- **Body size limits** are enforced in `app.js`'s `readJson()` against `config.maxBodyBytes` /
  `config.maxUploadBodyBytes` (per-route, via the route table's `upload` flag) — oversized bodies are rejected
  `413 TOO_LARGE` before JSON parsing, not after.
- **Idempotency** (`server/idempotency.js`) supports a client-supplied `Idempotency-Key` header on mutating
  routes (`idem: true` in the route table, the default), remembered for `RIS_IDEMPOTENCY_TTL_HOURS` (default 24).
  This is stored in SQLite, not in-memory, so it *does* survive a restart and would, unlike sessions, be shareable
  across multiple processes if they shared the same database — but see §4 on why multiple processes writing to
  the same SQLite file is unsupported for other reasons regardless.
- **Logging** is `console.log`/`console.warn`/`console.error` only — no structured logging, no log levels beyond
  that, no correlation/request IDs, no shipping to an aggregator. `npm start`'s logs (schema version on boot,
  config warnings, `[WARN]` lines from `bestEffort()` failures such as a notification insert failing) go wherever
  the process's stdout/stderr are directed by whatever runs it; the reference deployment relies entirely on the
  operator to capture that (the project directory shows a stray `data/server.log` from a manually redirected
  local run — not an application-managed log file).

---

## 6. Seeding demo data (`server/seed.js` + `server/demo-data.js`)

**Everything this section describes is synthetic, invented demonstration data — names, phone numbers, diagnoses,
scan results, payments, and the "Stavya Spine Hospital" demo traffic generally. None of it should ever be mistaken
for real patient, clinical, or financial figures**, and this seeding path must never be pointed at a production
database.

- `npm run seed` runs `server/seed.js`'s CLI entry point. It requires `RIS_DEMO_PASSWORD` to be set (≥10
  characters unless `RIS_DEMO_WEAK_PASSWORDS=1` and not production) — the script exits 1 immediately otherwise. The
  same password is used for every seeded user account.
- `seedDemo(password)` (called either way) first runs `seedCatalog()` (`server/catalog.js` — built-in exam
  definitions, report templates, proof types, referral sources, designations, a medicine list, a disease list and a
  surgery-procedure tree; everything inserted with `INSERT OR IGNORE`, so re-running it is harmless) and
  `importMasterData()` (`server/import-master.js`, reading `server/data/radiology-master-import.json` — the
  hospital's **real** tariff sheet, not demo data; see chapter 05 for how `price = NULL` + `price_note` is used for
  rows the sheet gave no rate for — this import is idempotent via `ON CONFLICT ... DO UPDATE` and is safe/expected
  to run on every seed invocation, even against a database that already has it).
- If `users` is already non-empty, `seedDemo` stops there and reports `{ skipped: true }` — **seeding never
  overwrites or duplicates an existing user base**; it is a one-time, first-run operation per database.
- Otherwise it creates the base staff roster from `server/roster.js` (see the placeholder note in §7/chapter 03 —
  employee codes `101`–`902` are plain placeholder numbers) and three starter patients/encounters.
- Unless `--no-traffic` is passed, `seedTraffic(password)` (`server/demo-data.js`) then plays roughly 320
  synthetic scans across two weeks through the **real domain functions** (`orders.js`, `reports.js`, `critical.js`,
  `messages.js`, `clinical.js`, `registration.js`, `billing.js`, `discounts.js`) using a seeded, deterministic PRNG
  and a simulated clock (`setClock()` in `util.js`, which `nowMs()`/`now()` everywhere else in the codebase reads
  from instead of the real system clock while seeding runs) — so the resulting audit hash chain, notifications,
  prices and payments are all internally consistent, not hand-inserted rows that bypass business rules. The final
  hours of the simulated traffic are deliberately left "live": patients mid-scan, one open critical case, one
  escalated, one awaiting ward acknowledgement, a pending and an approved refund, cheques still in process, and
  some overdue reports — intended to give a fresh demo something to immediately interact with. Because the clock is
  relative to *when you seed*, re-running the seed produces a new "today."
- Both `data/*.db*` and `data/demo-password.txt` are `.gitignore`d — the reference repository never ships a
  pre-seeded database or a committed demo password.

---

## 7. SUGGESTED production stack shape (not a requirement baked into the reference code)

The following is a **suggestion** for what a from-scratch or re-platformed backend should provide in place of each
reference-only piece documented above. None of this is implemented in the reference codebase; it is offered as a
starting checklist for the outsourced team's own architecture decisions, not a spec to match line-for-line.

| Reference-only piece | Suggested production replacement |
|---|---|
| `node:sqlite`, one file, one process | A real RDBMS (PostgreSQL or MySQL are the common choices) with proper connection pooling, so multiple application instances can serve traffic concurrently |
| `COUNT(*)+1` sequence numbers | Native sequence objects (`SERIAL`/`IDENTITY`/`SEQUENCE`) or an allocator with a unique constraint and retry — never a read-then-increment pattern once more than one writer exists |
| In-memory session `Map` | An external, shared session store (Redis, a sessions table, or stateless signed tokens) so sign-in survives a restart and works across multiple instances |
| Lazy, read-triggered critical-result sweep | A real job scheduler (cron, a queue-backed worker, a managed scheduler) running the escalation check on a fixed interval regardless of whether anyone opens the critical-results list — this closes a genuine patient-safety gap, not just a scaling one |
| `RIS_OTP_WEBHOOK` stub contract | A direct integration with an SMS/WhatsApp Business API provider (or a message queue feeding a dedicated notification worker) for both OTP delivery and critical-result alerting — today's "notification" is a database row nobody is paged for |
| No payment gateway | A real payment gateway integration (card/UPI processor) with webhook-based reconciliation and idempotent capture, replacing today's "staff types in a reference number" |
| `console.*` logging | Structured logging (JSON logs) with request correlation IDs, shipped to a log aggregator, plus metrics/tracing (an APM tool) for observability — there is currently no way to answer "how is the system performing in production" beyond reading raw stdout |
| `.env` / plain environment variables for `RIS_OTP_WEBHOOK` and any future payment credentials | A secrets manager (cloud provider secrets store, Vault, etc.) rather than plaintext environment variables for anything that is a credential, not just a tuning knob |
| Ad-hoc `VACUUM INTO` only before a migration | A scheduled, tested, point-in-time-capable backup/restore procedure appropriate to the chosen RDBMS, run on a schedule independent of whether a migration happens to be in flight |
| Implicit host time zone | An explicit time-zone decision (pin `TZ`, or compute day boundaries against a named zone/offset in code) rather than relying on whatever zone the deployment host happens to default to |

---

## 8. Placeholders and demo-only values called out elsewhere, repeated here for this chapter's context

These are documented in full in chapter 03 §8; restated briefly because they are directly relevant to deployment
sign-off:

- **Employee codes** (`server/roster.js`, `101`–`902`) — plain placeholder numbers used as login usernames; replace
  with real Stavya HR codes before production, then reseed.
- **Unpriced catalog items** (`exam_catalog.price IS NULL`, with `price_note` explaining why) block ordering
  outright (`EXAM_PRICE_NOT_SET`) until an admin sets a real price.
- **`RIS_LOAD_BUSY_AT` / `RIS_LOAD_VERY_BUSY_AT`**, **`RIS_SLA_HOURS_*`**, and **`RIS_CRITICAL_MINUTES`** are all
  explicitly PROVISIONAL tuning numbers (§2 above) that need confirmation from radiology/hospital leadership, not
  just a technical default.
- **`RIS_OTP_WEBHOOK` unset** means OTP delivery is simply not configured — this is a deployment blocker for
  registration and password-reset flows, not a cosmetic gap.
- **In-memory session storage** means a server restart silently logs out every user — call this out explicitly in
  any production go-live plan (§4).
- **SQLite / single-process assumptions** underpin several pieces of logic that would silently break under
  horizontal scaling (§4) — this is the single most important architectural fact in this chapter for the backend
  team to internalize before choosing a deployment topology.

---

## Open questions for the hospital / backend team

- No `.env.example` exists despite being referenced by comments in `config.js` and `index.js` — was one dropped
  from the repository, or never created? Either way, the production team needs a canonical list of required vs.
  optional environment variables before go-live; this chapter's §2 table is a best-effort reconstruction from the
  source, not a file the hospital's ops team can diff against.
- There is no answer in the code for how backups should be scheduled, retained, or tested for restore — only the
  incidental pre-migration `VACUUM INTO` snapshot exists, and it has no companion restore procedure or test.
  Confirm an RPO/RTO target with the hospital so the backend team can size a real backup strategy.
- The reference implementation has no documented maximum scale (concurrent users, orders/day) it was validated
  against beyond the ~320-scan/2-week demo traffic — there's no load test or capacity figure to carry forward into
  a production sizing exercise.
- Time zone handling (§4) works today only because of an unstated assumption about the host's local clock; confirm
  whether the hospital operates across more than one time zone (unlikely for a single physical hospital, but worth
  asking) before hard-coding Asia/Kolkata into a rebuild.
- `RIS_REQUIRE_REVISION` defaults to off; confirm with the backend team building the production client whether it
  will always send `expectedRevision` on every transition/assign call, so this can safely default to **on** in
  production rather than staying optional.
