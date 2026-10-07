import { useState } from 'react';
import { api } from '../api.js';
import { Badge, Card, Empty, FormError, Icon, PageHeader, PriorityBadge, fmt, toast, useAction, useLoad } from '../ui.jsx';

/**
 * Assistant lane (after reception, before technician):
 * Call token from waiting → collect ID / consent / basics → transfer to modality.
 */
export default function Assistant({ user }) {
  const list = useLoad(() => api.get('/cases?assist=1&open=1'));
  const [active, setActive] = useState(null);
  const a = useAction();

  const queue = (list.data || []).flatMap((c) =>
    (c.modalities || [])
      .filter((m) => m.status === 'WAITING' || m.status === 'AT_ASSISTANT')
      .map((m) => ({ case: c, mod: m }))
  );

  const call = (c, m) => a.run(async () => {
    await api.post(`/case-modalities/${m.id}/call`, {});
    toast(`Called ${m.token_no || m.modality}`);
    const fresh = await api.get(`/cases/${c.id}`);
    const mod = (fresh.modalities || []).find((x) => x.id === m.id) || m;
    setActive({ case: fresh, mod });
    list.reload();
  });

  return (
    <>
      <PageHeader
        title="Assistant desk"
        subtitle="When a token’s turn comes: call the patient, collect consent and basics, then transfer to the modality for the technician."
        actions={<button className="btn btn-light" onClick={() => list.reload()}>Refresh</button>}
      />

      <Card title="Waiting / with assistant" icon="worklist" count={queue.length} tone={queue.length ? 'amber' : 'green'} flush>
        {!queue.length ? <Empty title="Nothing waiting" detail="New entries from reception appear here with a token." /> : (
          <div className="table-scroll"><table className="clinical-table queue">
            <thead><tr><th>Token</th><th>Patient</th><th>Category</th><th>Channel</th><th>ETA</th><th>Lane</th><th className="col-action">Action</th></tr></thead>
            <tbody>{queue.map(({ case: c, mod: m }) => (
              <tr key={m.id} className={c.is_new ? 'row-new' : ''}>
                <td><strong className="mono token-num">{m.token_no || '—'}</strong><span className="table-sub">{m.machine_code || m.modality}</span></td>
                <td><strong>{c.patient_name}</strong><span className="table-sub">{c.mrn} · {c.case_no}</span></td>
                <td><div className="cell-flags"><Badge tone="info">{m.modality === 'XR' ? 'X-ray' : m.modality}</Badge><PriorityBadge priority={c.priority} /></div></td>
                <td>{c.channel_name || c.channel_code}<span className="table-sub">{c.clinical_indication}</span></td>
                <td className="mono">{m.eta_at ? fmt(m.eta_at) : '—'}</td>
                <td>{m.status === 'AT_ASSISTANT' ? <Badge tone="violet">With you</Badge> : <Badge tone="warning">Waiting</Badge>}</td>
                <td className="col-action">
                  {m.status === 'WAITING'
                    ? <button className="primary" disabled={a.busy} onClick={() => call(c, m)}>Call</button>
                    : <button className="primary" onClick={() => setActive({ case: c, mod: m })}>Continue</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      {active && (
        <AssistModal
          user={user}
          caseRow={active.case}
          mod={active.mod}
          onClose={() => setActive(null)}
          onDone={() => { setActive(null); list.reload(); }}
        />
      )}
      <FormError error={a.error} />
    </>
  );
}

function AssistModal({ caseRow, mod, onClose, onDone }) {
  const [f, setF] = useState({
    idVerified: !!mod.assist_id_verified,
    consentOk: !!mod.assist_consent_ok,
    allergyChecked: !!mod.assist_allergy_checked,
    prepDone: !!mod.assist_prep_done,
    pregnancyAsked: !!mod.assist_checklist?.pregnancyAsked,
    implantAsked: !!mod.assist_checklist?.implantAsked,
    fastingChecked: !!mod.assist_checklist?.fastingChecked,
    valuablesRemoved: !!mod.assist_checklist?.valuablesRemoved,
    escortOk: !!mod.assist_checklist?.escortOk,
    notes: mod.assist_notes || ''
  });
  const a = useAction();
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const transfer = () => a.run(async () => {
    await api.post(`/case-modalities/${mod.id}/assist-transfer`, f);
    toast(`Transferred ${mod.token_no || mod.modality} to modality`);
    onDone();
  });

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-shell wide" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2><Icon name="user" size={16} /> Assist · {caseRow.patient_name}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <div className="modal-body">
          <p className="note" style={{ marginTop: 0 }}>
            Token <b>{mod.token_no}</b> · {mod.modality === 'XR' ? 'X-ray' : mod.modality} · {caseRow.case_no}
            <br />{caseRow.clinical_indication}
            {caseRow.allergy ? <><br />Allergy on file: <b>{caseRow.allergy}</b></> : null}
          </p>
          <FormError error={a.error} />
          <div className="form-grid">
            <label className="check"><input type="checkbox" checked={f.idVerified} onChange={set('idVerified')} /> Identity verified (OPD/IPD ID / name / DOB) *</label>
            <label className="check"><input type="checkbox" checked={f.consentOk} onChange={set('consentOk')} /> Consent explained &amp; obtained *</label>
            <label className="check"><input type="checkbox" checked={f.allergyChecked} onChange={set('allergyChecked')} /> Allergy / contrast questions asked *</label>
            <label className="check"><input type="checkbox" checked={f.prepDone} onChange={set('prepDone')} /> Prep / gowning / instructions done</label>
            <label className="check"><input type="checkbox" checked={f.pregnancyAsked} onChange={set('pregnancyAsked')} /> Pregnancy asked (if relevant)</label>
            <label className="check"><input type="checkbox" checked={f.implantAsked} onChange={set('implantAsked')} /> Implants / pacemaker asked (MRI)</label>
            <label className="check"><input type="checkbox" checked={f.fastingChecked} onChange={set('fastingChecked')} /> Fasting / prep checked</label>
            <label className="check"><input type="checkbox" checked={f.valuablesRemoved} onChange={set('valuablesRemoved')} /> Metal / valuables removed</label>
            <label className="check"><input type="checkbox" checked={f.escortOk} onChange={set('escortOk')} /> Escort / relative informed</label>
            <label className="wide"><span>Notes for technician</span>
              <textarea rows={3} value={f.notes} onChange={set('notes')} placeholder="Anything the technologist should know before selecting sub-services" />
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <span className="left-note">After transfer, technician selects sub-modality services.</span>
          <button className="btn btn-light" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={a.busy || !f.idVerified || !f.consentOk || !f.allergyChecked} onClick={transfer}>
            {a.busy ? 'Saving…' : 'Transfer to modality'}
          </button>
        </div>
      </div>
    </div>
  );
}
