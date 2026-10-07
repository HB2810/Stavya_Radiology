import { createServer } from './app.js';
import { seedCatalog } from './catalog.js';
import { config, validateConfig } from './config.js';
import { db, migration } from './db.js';
import { ensureRosterUsers } from './ensure-roster.js';

const { errors, warnings } = validateConfig();
for (const w of warnings) console.warn(`[config] warning: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`[config] error: ${e}`);
  console.error('Refusing to start. Fix the settings above (see .env.example).');
  process.exit(1);
}

seedCatalog();
const demoPw = process.env.RIS_DEMO_PASSWORD || '1234';
const roster = ensureRosterUsers(demoPw);
if (roster.created.length) console.log(`[roster] added demo users: ${roster.created.join(', ')}`);
if (roster.reset) console.log(`[roster] temporary password set for ${roster.reset} active users`);

const server = createServer();
server.listen(config.port, config.host, () => console.log(`Stavya RIS listening on http://${config.host}:${config.port} (schema v${migration.to})`));

// A rejected promise nobody awaited is logged and the server keeps serving: it is almost always an advisory side effect.
process.on('unhandledRejection', (reason) => console.error('[FATAL?] unhandled promise rejection (continuing):', reason));
// An uncaught exception leaves the process in an unknown state: stop taking requests, close the database cleanly, exit non-zero so a supervisor restarts it.
let stopping = false;
function shutdown(code, why) {
  if (stopping) return; stopping = true;
  console.error(`[shutdown] ${why}`);
  const done = () => { try { db.close(); } catch { /* already closed */ } process.exit(code); };
  server.close(done); setTimeout(done, 5000).unref();
}
process.on('uncaughtException', (e) => { console.error('[FATAL] uncaught exception:', e); shutdown(1, 'uncaught exception'); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0, sig));
