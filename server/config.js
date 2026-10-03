// Central, validated configuration. Every setting the server reads from the environment is declared here, with its default.
// Values are read lazily (getters), so a test or an operator changing process.env is honoured; validateConfig() is run once at startup.
// A .env file in the project root is loaded when this module is first imported (not under `node --test`); real environment variables win.
// Values marked PROVISIONAL are placeholders until the hospital confirms them (see .env.example).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = () => process.env;
const num = (name, dflt) => { const v = env()[name]; return v === undefined || v === '' ? dflt : Number(v); };
const flag = (name, dflt = false) => { const v = env()[name]; return v === undefined || v === '' ? dflt : v === '1' || v === 'true'; };
const str = (name, dflt = '') => (env()[name] === undefined || env()[name] === '' ? dflt : String(env()[name]));
const inProduction = () => env().NODE_ENV === 'production';

export const config = {
  get production() { return inProduction(); },
  get port() { return num('PORT', 4000); },
  get host() { return str('HOST', '127.0.0.1'); },
  // The defaults live under the project root (not the working directory), so the database is the same wherever the server is started.
  // A path given in the environment is resolved against the working directory, as before.
  get dbFile() { const f = str('RIS_DB'); return f === ':memory:' ? f : f ? path.resolve(f) : path.join(ROOT, 'data', 'ris.db'); },
  get webDir() { const d = str('RIS_WEB_DIR'); return d ? path.resolve(d) : path.join(ROOT, 'web', 'dist'); },
  get otpWebhook() { return str('RIS_OTP_WEBHOOK'); },
  // Shows the one-time code in the API response. Local demos only: never honoured when NODE_ENV=production.
  get devOtp() { return flag('RIS_DEV_OTP') && !inProduction(); },
  get requirePatientOtp() { return env().RIS_REQUIRE_PATIENT_OTP !== '0'; },
  get demoWeakPasswords() { return flag('RIS_DEMO_WEAK_PASSWORDS') && !inProduction(); },
  get hospitalName() { return str('HOSPITAL_NAME', 'Stavya Spine Hospital · Radiology'); },
  get hospitalAddress() { return str('HOSPITAL_ADDRESS'); },
  // PROVISIONAL clinical timings: confirm with the hospital before real use.
  get slaHours() { return { STAT: num('RIS_SLA_HOURS_STAT', 1), URGENT: num('RIS_SLA_HOURS_URGENT', 4), ROUTINE: num('RIS_SLA_HOURS_ROUTINE', 24) }; },
  get criticalMinutes() { return num('RIS_CRITICAL_MINUTES', 60); },
  get duplicateWindowDays() { return num('RIS_DUPLICATE_WINDOW_DAYS', 30); },
  // PROVISIONAL (PKG-M5): combined queued + in-progress orders in a modality at or above which the OPD/IPD load widget
  // calls it "Busy" / "Very busy" instead of "Quiet". Same thresholds for every modality for now; confirm with radiology
  // (a modality with fewer machines may warrant a lower bar) before relying on these day to day.
  get loadThresholds() { return { busyAt: num('RIS_LOAD_BUSY_AT', 3), veryBusyAt: num('RIS_LOAD_VERY_BUSY_AT', 6) }; },
  get sessionHours() { return num('RIS_SESSION_HOURS', 8); },
  // Body size limits: 12 MB only for the few routes that carry images or audio, 1 MB everywhere else.
  get maxBodyBytes() { return num('RIS_MAX_BODY_BYTES', 1_000_000); },
  get maxUploadBodyBytes() { return num('RIS_MAX_UPLOAD_BODY_BYTES', 12_000_000); },
  // When 1, transition and assign calls without expectedRevision are rejected (the web app always sends it).
  get requireRevision() { return flag('RIS_REQUIRE_REVISION'); },
  get idempotencyTtlHours() { return num('RIS_IDEMPOTENCY_TTL_HOURS', 24); }
};

/** Loads <project>/.env (real environment variables win). Skipped under `node --test` so tests never depend on a developer's local file. */
export function loadEnvFile() {
  if (process.env.NODE_TEST_CONTEXT) return false;
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

loadEnvFile(); // before anything reads a setting, so .env applies to the server, the seed script and any tool that imports the modules

/** Returns { errors, warnings }. Startup refuses to run with errors. */
export function validateConfig() {
  const errors = []; const warnings = [];
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(config.port, 1, 65535)) errors.push('PORT must be a whole number from 1 to 65535');
  for (const [k, v] of Object.entries(config.slaHours)) if (!(Number.isFinite(v) && v > 0 && v <= 24 * 30)) errors.push(`RIS_SLA_HOURS_${k} must be a number of hours above 0`);
  if (!(Number.isFinite(config.criticalMinutes) && config.criticalMinutes > 0 && config.criticalMinutes <= 1440)) errors.push('RIS_CRITICAL_MINUTES must be between 1 and 1440');
  if (!int(config.duplicateWindowDays, 0, 365)) errors.push('RIS_DUPLICATE_WINDOW_DAYS must be a whole number from 0 to 365');
  { const { busyAt, veryBusyAt } = config.loadThresholds; if (!int(busyAt, 1, 1000) || !int(veryBusyAt, 1, 1000) || veryBusyAt <= busyAt) errors.push('RIS_LOAD_BUSY_AT must be a whole number >= 1 and RIS_LOAD_VERY_BUSY_AT must be a greater whole number'); }
  if (!(Number.isFinite(config.sessionHours) && config.sessionHours > 0 && config.sessionHours <= 72)) errors.push('RIS_SESSION_HOURS must be between 0 and 72');
  if (!int(config.maxBodyBytes, 1024, 100_000_000) || !int(config.maxUploadBodyBytes, 1024, 100_000_000)) errors.push('RIS_MAX_BODY_BYTES and RIS_MAX_UPLOAD_BODY_BYTES must be byte counts of at least 1024');
  if (config.otpWebhook && !/^https?:\/\//.test(config.otpWebhook)) errors.push('RIS_OTP_WEBHOOK must be an http(s) URL');
  if (config.dbFile !== ':memory:' && fs.existsSync(config.dbFile) && !fs.statSync(config.dbFile).isFile()) errors.push(`RIS_DB ${config.dbFile} is not a file`);
  if (inProduction()) {
    if (flag('RIS_DEV_OTP')) errors.push('RIS_DEV_OTP=1 returns one-time codes in the API response and must not be set when NODE_ENV=production');
    if (flag('RIS_DEMO_WEAK_PASSWORDS')) errors.push('RIS_DEMO_WEAK_PASSWORDS=1 must not be set when NODE_ENV=production');
    if (!config.otpWebhook) warnings.push('RIS_OTP_WEBHOOK is not set: patient registration and password reset cannot send codes');
    if (config.dbFile === ':memory:') errors.push('RIS_DB=:memory: cannot be used in production');
  }
  if (!config.otpWebhook && !config.devOtp) warnings.push('No one-time-code delivery is configured (RIS_OTP_WEBHOOK); new-patient registration and password reset will fail');
  if (!config.hospitalAddress) warnings.push('HOSPITAL_ADDRESS is empty; invoices and receipts print no address');
  return { errors, warnings };
}
