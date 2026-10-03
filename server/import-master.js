// One-time, idempotent importer: loads the hospital's real radiology tariff (server/data/radiology-master-import.json)
// into the service master (exam_catalog) and the discount-scheme master (discount_schemes). Called from seed.js on
// every seed, and runnable standalone: `node server/import-master.js` (against RIS_DB, default the project's data/ris.db).
//
// Re-running is safe: codes are generated deterministically from the source file (same modality+item, same order,
// every run), so the same row always upserts the same exam_catalog row rather than creating a duplicate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { now, tx } from './util.js';
import { makeExamCode } from './catalog.js';
import { audit } from './audit.js';

const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'radiology-master-import.json');

// Modalities the current (hand-written) exam_catalog uses that the hospital's sheet has no coverage for at all.
// Those rows keep whatever price they were seeded with, but are flagged so nobody bills off an invented number.
const NO_SHEET_COVERAGE = ['OPEN_MRI', 'USG'];
const NO_SHEET_NOTE = 'No hospital rate sheet supplied for this modality -- placeholder price, confirm before billing';

const EST_MINUTES = { MRI: 30, CT: 20, XR: 10, DEXA: 20 };
const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// "CT SCAN SPINE" -> "SPINE", "MRI SPINE" -> "SPINE", "CT GENERIC TIERS" -> "GENERIC_TIERS": drops a leading modality
// word or two so the body_part reads like the hand-written ones (LUMBAR_SPINE, ...) instead of repeating the modality.
function bodyPartFrom(modality, subGroup) {
  const words = collapse(subGroup).toUpperCase().split(' ').filter(Boolean);
  while (words.length > 1 && (words[0] === modality || words[0] === 'CT' || words[0] === 'SCAN' || words[0] === 'MRI' || words[0] === 'X-RAY' || words[0] === 'XR')) words.shift();
  return words.join('_').replace(/[^A-Z0-9_]/g, '') || 'GENERAL';
}
// A tier's lookup key: "CT ANGIO" -> "ANGIO", "CT FULL STUDY" -> "FULL_STUDY". Generic so any future generic-tier
// row (not just CT's) is picked up the same way, matched against a row's own priceTierHint.
function tierKey(modality, item) {
  const words = collapse(item).toUpperCase().split(' ').filter(Boolean);
  while (words.length > 1 && words[0] === modality) words.shift();
  return words.join('_');
}
const isContrastItem = (item) => /CONTRAST|ANGIO|VENOGRAM|VENOGRAPHY|MYELOGRAM/i.test(item);

export function importMasterData(user) {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const data = JSON.parse(raw);
  const catalog = Array.isArray(data.catalog) ? data.catalog : [];
  const discounts = Array.isArray(data.discounts) ? data.discounts : [];
  const actorId = user?.id || 'system';

  // Generic tariff tiers (e.g. CT's SCREENING/FULL STUDY/ANGIO) used to price an item that has no item-level rate
  // but does carry a priceTierHint. Built from the same file so it never drifts from the catalog rows themselves.
  const tiers = new Map();
  for (const row of catalog) if (row.cash != null && /GENERIC TIERS?$/i.test(row.subGroup || '')) tiers.set(tierKey(row.modality, row.item), { cash: row.cash, online: row.online, label: collapse(row.item) });

  const t = now();
  const usedCodes = new Set(); // fresh per run: generation depends only on file content/order, not prior DB state
  const upsert = db.prepare(`
    INSERT INTO exam_catalog (code, name, modality, body_part, est_minutes, prep, uses_contrast, ionising, mri, keywords, price, sub_group, online_price, source, active, price_note, updated_at, updated_by)
    VALUES (@code, @name, @modality, @body_part, @est_minutes, '', @uses_contrast, @ionising, @mri, '', @price, @sub_group, @online_price, @source, 1, @price_note, @updated_at, @updated_by)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name, modality = excluded.modality, body_part = excluded.body_part, sub_group = excluded.sub_group,
      uses_contrast = excluded.uses_contrast, ionising = excluded.ionising, mri = excluded.mri,
      price = excluded.price, online_price = excluded.online_price, source = excluded.source,
      price_note = excluded.price_note, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `);

  let fromSheet = 0; let unpriced = 0; let tierPriced = 0;
  const result = tx(db, () => {
    for (const row of catalog) {
      const modality = collapse(row.modality).toUpperCase();
      const item = collapse(row.item);
      const subGroup = collapse(row.subGroup);
      if (!modality || !item) continue;
      const code = makeExamCode(modality, item, usedCodes);
      let price = row.cash ?? null; let onlinePrice = row.online ?? null; let note = row.note ? collapse(row.note) : null;
      if (price == null && row.priceTierHint) {
        const tier = tiers.get(String(row.priceTierHint).toUpperCase());
        if (tier) {
          price = tier.cash; onlinePrice = tier.online ?? tier.cash;
          note = `${note ? note + ' ' : ''}Priced via the ${tier.label} tier (₹${tier.cash}).`;
          tierPriced++;
        }
      }
      if (price == null) unpriced++;
      upsert.run({
        code, name: item, modality, body_part: bodyPartFrom(modality, subGroup), sub_group: subGroup || null,
        est_minutes: EST_MINUTES[modality] || 15, uses_contrast: isContrastItem(item) ? 1 : 0,
        ionising: modality === 'MRI' ? 0 : 1, mri: modality === 'MRI' ? 1 : 0,
        price, online_price: onlinePrice, source: 'HOSPITAL_SHEET', price_note: note, updated_at: t, updated_by: actorId
      });
      fromSheet++;
    }

    // The sheet has no MRI/XR/CT/DEXA-only coverage gap here: it simply never mentions Open MRI or Ultrasound at all.
    // Those modalities keep whatever (placeholder) price they already carry, just flagged as unconfirmed.
    const placeholders = db.prepare(`UPDATE exam_catalog SET source = 'PLACEHOLDER', price_note = ?, updated_at = ?, updated_by = ? WHERE modality IN (${NO_SHEET_COVERAGE.map(() => '?').join(',')})`)
      .run(NO_SHEET_NOTE, t, actorId, ...NO_SHEET_COVERAGE).changes;

    const upsertScheme = db.prepare(`
      INSERT INTO discount_schemes (id, label, kind, value, requires_reason, requires_approval, active, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, kind = excluded.kind, value = excluded.value,
        requires_reason = excluded.requires_reason, requires_approval = excluded.requires_approval, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `);
    for (const d of discounts) {
      upsertScheme.run(String(d.code), String(d.label), String(d.kind || 'PERCENT'), Number(d.value), d.requiresReason ? 1 : 0, d.requiresApproval ? 1 : 0, t, actorId, t, actorId);
    }

    return { catalogRows: catalog.length, fromSheet, unpriced, tierPriced, placeholdersFlagged: placeholders, discountSchemes: discounts.length };
  });
  if (user) audit({ action: 'MASTER_IMPORTED', actor: user, details: result });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('Importing hospital master data from', DATA_FILE);
  console.log(JSON.stringify(importMasterData(), null, 1));
}
