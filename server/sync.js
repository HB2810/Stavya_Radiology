// Cheap change-stamp so every open tab can poll and refresh when another role acts.
import { db } from './db.js';

export function syncStamp() {
  const pick = (sql) => {
    try { return db.prepare(sql).get()?.t || ''; } catch { return ''; }
  };
  const parts = [
    pick("SELECT MAX(updated_at) t FROM orders"),
    pick("SELECT MAX(updated_at) t FROM rad_cases"),
    pick("SELECT MAX(created_at) t FROM rad_case_modalities"),
    pick("SELECT MAX(transferred_at) t FROM rad_case_modalities"),
    pick("SELECT MAX(protocolled_at) t FROM rad_case_modalities"),
    pick("SELECT MAX(at) t FROM order_events"),
    pick("SELECT MAX(created_at) t FROM notifications"),
    pick("SELECT MAX(created_at) t FROM audit_log")
  ];
  const stamp = parts.filter(Boolean).sort().pop() || '0';
  // Include open counts so empty→first and last-complete→empty also flip the stamp.
  let openOrders = 0; let openCases = 0; let assist = 0; let awaitProto = 0;
  try {
    openOrders = db.prepare("SELECT COUNT(*) c FROM orders WHERE status NOT IN ('CANCELLED','COLLECTED')").get().c;
    openCases = db.prepare("SELECT COUNT(*) c FROM rad_cases WHERE status = 'OPEN'").get().c;
    assist = db.prepare("SELECT COUNT(*) c FROM rad_case_modalities WHERE status IN ('WAITING','AT_ASSISTANT')").get().c;
    awaitProto = db.prepare("SELECT COUNT(*) c FROM rad_case_modalities WHERE status = 'AWAITING_PROTOCOL'").get().c;
  } catch { /* schema mid-migrate */ }
  return {
    stamp: `${stamp}|${openOrders}|${openCases}|${assist}|${awaitProto}`,
    openOrders,
    openCases,
    assistQueue: assist,
    awaitingProtocol: awaitProto,
    at: new Date().toISOString()
  };
}
