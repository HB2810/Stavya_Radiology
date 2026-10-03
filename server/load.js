// PKG-M5: live radiology load, for OPD/IPD clinicians and nurses deciding where to send a patient before they order --
// not a copy of the radiology staff's Insights page (server/analytics.js), which stays radiology-only and loads every
// order to compute turnaround/SLA history. This is a *current* snapshot: one cheap aggregate query, no order rows.
import { db } from './db.js';
import { config } from './config.js';

// The six pieces of equipment the OPD/IPD dashboard tiles already name (orders.js EQUIPMENT_KEYS), always returned in
// this order even when a modality currently has nothing queued.
export const LOAD_MODALITIES = ['MRI', 'CT', 'XR', 'DEXA', 'USG', 'OPEN_MRI'];

function loadLabel(total) {
  const { busyAt, veryBusyAt } = config.loadThresholds;
  return total >= veryBusyAt ? 'Very busy' : total >= busyAt ? 'Busy' : 'Quiet';
}

/**
 * Per-modality counts: queued (REQUESTED+ACKNOWLEDGED+SCHEDULED), inProgress (on the table), and overdue -- a subset of
 * those same queued/in-progress orders whose report-target time has already passed. Informational only; never blocks
 * an order. One GROUP BY query using the orders_status index, not a full order list.
 */
export function radiologyLoad() {
  const nowIso = new Date().toISOString(); // matches orders.js's own overdue check (real time, not the simulated seeding clock)
  const rows = db.prepare(`
    SELECT x.modality AS modality,
      SUM(CASE WHEN o.status IN ('REQUESTED','ACKNOWLEDGED','SCHEDULED') THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN o.status = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS inProgress,
      SUM(CASE WHEN o.due_at < ? THEN 1 ELSE 0 END) AS overdue
    FROM orders o JOIN exam_catalog x ON x.code = o.exam_code
    WHERE o.status IN ('REQUESTED','ACKNOWLEDGED','SCHEDULED','IN_PROGRESS')
    GROUP BY x.modality
  `).all(nowIso);
  const byModality = Object.fromEntries(rows.map((r) => [r.modality, r]));
  return LOAD_MODALITIES.map((modality) => {
    const r = byModality[modality];
    const queued = r ? Number(r.queued) : 0;
    const inProgress = r ? Number(r.inProgress) : 0;
    const overdue = r ? Number(r.overdue) : 0;
    const total = queued + inProgress;
    return { modality, queued, inProgress, overdue, total, label: loadLabel(total) };
  });
}
