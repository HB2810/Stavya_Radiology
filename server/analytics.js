import { db } from './db.js';
import { OPEN_STATUSES } from './orders.js';

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
const mins = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;

export function summary(days = 30) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const orders = db.prepare(`SELECT o.*, x.modality FROM orders o JOIN exam_catalog x ON x.code = o.exam_code WHERE o.created_at >= ?`).all(since);
  const count = (key) => orders.reduce((m, o) => ((m[o[key]] = (m[o[key]] || 0) + 1), m), {});
  const open = orders.filter((o) => OPEN_STATUSES.includes(o.status));
  const reported = orders.filter((o) => o.reported_at);
  const done = orders.filter((o) => o.completed_at);
  const late = reported.filter((o) => o.reported_at > o.due_at).length;
  const crit = db.prepare('SELECT * FROM critical_cases WHERE created_at >= ?').all(since);
  const comm = crit.map((c) => {
    const e = db.prepare("SELECT at FROM critical_events WHERE case_id = ? AND state = 'COMMUNICATED' ORDER BY at LIMIT 1").get(c.id);
    return e ? mins(c.created_at, e.at) : null;
  }).filter((x) => x != null);
  const perDay = {};
  for (const o of orders) { const d = o.created_at.slice(0, 10); const x = (perDay[d] ||= { OPD: 0, IPD: 0, OT: 0, EXTERNAL: 0, n: 0 }); x[o.source] = (x[o.source] || 0) + 1; x.n++; }
  return {
    windowDays: days, total: orders.length,
    byStatus: count('status'), bySource: count('source'), byPriority: count('priority'), byModality: count('modality'),
    backlog: open.length, overdue: open.filter((o) => o.due_at < new Date().toISOString()).length,
    medianMinutes: { requestToComplete: median(done.map((o) => mins(o.created_at, o.completed_at))), requestToReport: median(reported.map((o) => mins(o.created_at, o.reported_at))) },
    slaMet: reported.length ? Math.round(((reported.length - late) / reported.length) * 100) : null,
    critical: { total: crit.length, open: crit.filter((c) => ['OPEN', 'ESCALATED'].includes(c.state)).length, medianMinutesToCommunicate: median(comm) },
    perDay: Object.entries(perDay).sort().map(([date, x]) => ({ date, ...x }))
  };
}
