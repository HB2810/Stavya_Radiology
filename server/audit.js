// Hash-chained audit trail (ported from the Stavya PACS design): each event's hash covers the previous one.
import { createHash, randomUUID } from 'node:crypto';
import { db } from './db.js';
import { conflict, now, tx, uid } from './util.js';

export const GENESIS = '0'.repeat(64);
const digest = (prev, e) =>
  createHash('sha256')
    .update(JSON.stringify({ prev, id: e.event_id, ts: e.ts, action: e.action, actor: e.actor_id, name: e.actor_name,
      role: e.actor_role, patient: e.patient_id ?? null, resource: e.resource ?? null, outcome: e.outcome, details: e.details_json ?? null }))
    .digest('hex');

// Call audit() INSIDE the transaction of the change it records, so both commit or both roll back. Outside a transaction it
// opens its own, which also makes read-last-hash + insert atomic if a second process ever writes to the same database.
export function audit({ action, actor, patientId = null, resource = null, outcome = 'SUCCESS', details = null }) {
  return tx(db, () => {
    const last = db.prepare('SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1').get();
    const prev = last ? last.event_hash : GENESIS;
    const e = {
      event_id: randomUUID(), ts: now(), action,
      actor_id: actor?.id || 'system', actor_name: actor?.fullName || actor?.name || 'System', actor_role: actor?.role || 'service',
      patient_id: patientId, resource, outcome, details_json: details ? JSON.stringify(details) : null
    };
    const hash = digest(prev, e);
    db.prepare(`INSERT INTO audit_events (event_id, ts, action, actor_id, actor_name, actor_role, patient_id, resource, outcome, details_json, prev_hash, event_hash)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(e.event_id, e.ts, e.action, e.actor_id, e.actor_name, e.actor_role, e.patient_id, e.resource, e.outcome, e.details_json, prev, hash);
    return hash;
  });
}

export function listAudit(limit = 100, offset = 0) {
  return db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
}

// Anchors: the chain head (event id, hash, count) is recorded so that later truncation or a full rewrite of the chain can be detected.
// The returned anchor should also be exported or printed and kept outside this server (a hash held only here proves little).
export function anchorAudit(actor) {
  return tx(db, () => {
    const head = db.prepare('SELECT id, event_hash FROM audit_events ORDER BY id DESC LIMIT 1').get();
    if (!head) throw conflict('NOTHING_TO_ANCHOR', 'The audit log is empty');
    const total = db.prepare('SELECT COUNT(*) c FROM audit_events').get().c;
    const anchor = { id: uid('anc'), audit_id: head.id, event_hash: head.event_hash, total, created_by: actor.id, created_by_name: actor.fullName, created_at: now() };
    db.prepare('INSERT INTO audit_anchors (id, audit_id, event_hash, total, created_by, created_by_name, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(anchor.id, anchor.audit_id, anchor.event_hash, anchor.total, anchor.created_by, anchor.created_by_name, anchor.created_at);
    audit({ action: 'AUDIT_ANCHORED', actor, resource: anchor.id, details: { auditId: anchor.audit_id, total, hash: anchor.event_hash } });
    return anchor;
  });
}
export const listAnchors = () => db.prepare('SELECT * FROM audit_anchors ORDER BY audit_id DESC LIMIT 100').all();

export function verifyAudit() {
  const rows = db.prepare('SELECT * FROM audit_events ORDER BY id ASC').all();
  let prev = GENESIS;
  for (const row of rows) {
    if (row.prev_hash !== prev) return { valid: false, total: rows.length, brokenAt: row.id, message: `Broken link at event ${row.id}` };
    if (digest(prev, row) !== row.event_hash) return { valid: false, total: rows.length, brokenAt: row.id, message: `Tampered event ${row.id}` };
    prev = row.event_hash;
  }
  // Every recorded anchor must still be in the chain with the same hash; this is what exposes truncation of the newest events.
  const byId = new Map(rows.map((r) => [r.id, r.event_hash]));
  const anchors = listAnchors();
  const bad = anchors.find((a) => byId.get(a.audit_id) !== a.event_hash);
  if (bad) return { valid: false, total: rows.length, brokenAt: bad.audit_id, anchors: anchors.length, message: `Anchor ${bad.id} (event ${bad.audit_id}) no longer matches the chain: events were removed or rewritten` };
  return { valid: true, total: rows.length, brokenAt: null, latestHash: prev, anchors: anchors.length, message: `${rows.length} audit events verified${anchors.length ? `, ${anchors.length} anchor(s) match` : ''}` };
}
