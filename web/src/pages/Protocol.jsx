import { useState } from 'react';
import { api } from '../api.js';
import { Badge, Card, Empty, FormError, Icon, Notice, PageHeader, PriorityBadge, fmt, go, inr, toast, useAction, useLoad } from '../ui.jsx';

/** Technician: after assistant transfer — select sub-modality services; can add mid-diagnostic. */
export default function Protocol({ user }) {
  const awaiting = useLoad(() => api.get('/cases?awaiting=1&open=1'));
  const openCases = useLoad(() => api.get('/cases?open=1'));
  const [active, setActive] = useState(null); // { case, mod, mode: 'protocol'|'add' }
  const a = useAction();
  const canProtocol = ['technologist', 'radiologist', 'admin'].includes(user.role);

  const ready = (awaiting.data || []).flatMap((c) =>
    (c.modalities || []).filter((m) => m.status === 'AWAITING_PROTOCOL').map((m) => ({ case: c, mod: m }))
  );

  const mid = (openCases.data || []).flatMap((c) =>
    (c.modalities || [])
      .filter((m) => ['PROTOCOLLED', 'IN_QUEUE', 'IN_PROGRESS'].includes(m.status))
      .map((m) => ({ case: c, mod: m }))
  );

  return (
    <>
      <PageHeader
        title="Technician · protocol"
        subtitle={canProtocol
          ? 'Patient arrives from assistant. Select sub-modality services from the catalog. Add more mid-scan if the study needs it.'
          : 'View-only. Technician selects billed sub-services here after assistant transfer.'}
        actions={<button className="btn btn-light" onClick={() => { awaiting.reload(); openCases.reload(); }}>Refresh</button>}
      />

      <Notice>{canProtocol
        ? 'Amounts appear for reception payment after you save services. Use “Add mid-diagnostic” if you need another series during the scan.'
        : 'Assistant must transfer first. Then the technician protocols services.'}</Notice>

      <Card title="Ready at modality (select services)" icon="scan" count={ready.length} tone={ready.length ? 'amber' : 'green'} flush>
        {!ready.length ? <Empty title="Nothing at modality" detail="When the assistant transfers a patient, the token shows here." /> : (
          <div className="table-scroll"><table className="clinical-table queue">
            <thead><tr><th>Token</th><th>Patient</th><th>Category</th><th>Assist notes</th><th>ETA</th><th className="col-action">Action</th></tr></thead>
            <tbody>{ready.map(({ case: c, mod: m }) => (
              <tr key={m.id}>
                <td><strong className="mono token-num">{m.token_no || '—'}</strong><span className="table-sub">{m.machine_code || m.modality}</span></td>
                <td><strong>{c.patient_name}</strong><span className="table-sub">{c.mrn} · {c.case_no}</span></td>
                <td><div className="cell-flags"><Badge tone="info">{m.modality === 'XR' ? 'X-ray' : m.modality}</Badge><PriorityBadge priority={c.priority} /></div></td>
                <td><span className="table-sub">{m.assist_notes || '—'}{m.assist_consent_ok ? ' · consent ✓' : ''}</span></td>
                <td className="mono">{m.eta_at ? fmt(m.eta_at) : '—'}</td>
                <td className="col-action">{canProtocol
                  ? <button className="primary" onClick={() => setActive({ case: c, mod: m, mode: 'protocol' })}>Select sub-services</button>
                  : <span className="table-sub">Tech only</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      {canProtocol && (
        <Card title="In progress — add mid-diagnostic" icon="plus" count={mid.length} tone="info" flush>
          {!mid.length ? <Empty title="No open modalities" detail="After the first protocol, you can add extra services here while scanning." /> : (
            <div className="table-scroll"><table className="clinical-table queue">
              <thead><tr><th>Token</th><th>Patient</th><th>Category</th><th>Status</th><th>Orders</th><th className="col-action">Action</th></tr></thead>
              <tbody>{mid.map(({ case: c, mod: m }) => {
                const n = (c.orders || []).filter((o) => o.case_modality_id === m.id).length;
                return (
                  <tr key={m.id}>
                    <td><strong className="mono">{m.token_no || '—'}</strong></td>
                    <td><strong>{c.patient_name}</strong><span className="table-sub">{c.case_no}</span></td>
                    <td><Badge tone="info">{m.modality}</Badge></td>
                    <td><Badge tone="violet">{m.status}</Badge></td>
                    <td>{n} service(s)</td>
                    <td className="col-action"><div className="row-actions">
                      <button className="btn btn-light btn-sm" onClick={() => setActive({ case: c, mod: m, mode: 'add' })}>Add service</button>
                      <button className="btn btn-light btn-sm" onClick={() => go('/worklist')}>Worklist</button>
                    </div></td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
        </Card>
      )}

      {active && canProtocol && (
        <ProtocolModal
          caseRow={active.case}
          mod={active.mod}
          mode={active.mode}
          onClose={() => setActive(null)}
          onDone={() => { setActive(null); awaiting.reload(); openCases.reload(); }}
        />
      )}
      <FormError error={a.error} />
    </>
  );
}

function ProtocolModal({ caseRow, mod, mode, onClose, onDone }) {
  const services = useLoad(() => api.get(`/cases/modalities/${mod.modality}/services`), [mod.modality]);
  const [picked, setPicked] = useState({});
  const [q, setQ] = useState('');
  const a = useAction();
  const adding = mode === 'add';

  const rows = (services.data || []).filter((e) => !q || `${e.name} ${e.code} ${e.sub_group || ''}`.toLowerCase().includes(q.toLowerCase()));
  const selected = Object.keys(picked);
  const total = selected.reduce((s, code) => {
    const e = (services.data || []).find((x) => x.code === code);
    return s + Number(e?.price || 0);
  }, 0);

  const toggle = (code) => setPicked((p) => {
    const n = { ...p };
    if (n[code]) delete n[code]; else n[code] = { side: 'NA' };
    return n;
  });

  const save = () => a.run(async () => {
    const body = {
      services: selected.map((examCode) => ({ examCode, side: picked[examCode].side })),
      confirmDuplicate: true,
      add: adding
    };
    const r = await api.post(`/case-modalities/${mod.id}/protocol`, body);
    toast(`${selected.length} ${mod.modality} service(s) ${adding ? 'added' : 'saved'} · ${inr(r.amount)}`);
    onDone();
  });

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-shell wide" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2><Icon name="scan" size={16} /> {adding ? 'Add mid-diagnostic' : 'Protocol'} {mod.modality === 'XR' ? 'X-ray' : mod.modality} · {caseRow.patient_name}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <div className="modal-body">
          <p className="note" style={{ marginTop: 0 }}>
            {caseRow.case_no} · token <b>{mod.token_no}</b> · {caseRow.clinical_indication}
            {mod.assist_notes ? <><br />Assistant: {mod.assist_notes}</> : null}
          </p>
          <label className="search-box" style={{ maxWidth: 'none', marginBottom: 10 }}><Icon name="search" size={14} /><input placeholder="Filter sub-services in this category" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <FormError error={a.error} />
          {!services.data ? <Empty title="Loading catalog…" /> : (
            <div className="table-scroll" style={{ maxHeight: 360 }}><table className="clinical-table compact">
              <thead><tr><th></th><th>Sub-service</th><th className="n">Price</th><th>Side</th></tr></thead>
              <tbody>{rows.map((e) => {
                const on = !!picked[e.code];
                return (
                  <tr key={e.code} className={on ? 'row-new' : ''} onClick={() => toggle(e.code)} style={{ cursor: 'pointer' }}>
                    <td><input type="checkbox" checked={on} onChange={() => toggle(e.code)} onClick={(ev) => ev.stopPropagation()} /></td>
                    <td><strong>{e.name}</strong><span className="table-sub">{e.code}{e.sub_group ? ` · ${e.sub_group}` : ''}</span></td>
                    <td className="mono n">{inr(e.price)}</td>
                    <td onClick={(ev) => ev.stopPropagation()}>
                      {on ? <select value={picked[e.code].side} onChange={(ev) => setPicked({ ...picked, [e.code]: { side: ev.target.value } })}>
                        <option value="NA">n/a</option><option>Left</option><option>Right</option><option>Both</option>
                      </select> : '—'}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
        </div>
        <div className="modal-foot">
          <span className="left-note">{selected.length} selected · estimate {inr(total)}</span>
          <button className="btn btn-light" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={a.busy || !selected.length} onClick={save}>
            {a.busy ? 'Saving…' : adding ? 'Add to study' : 'Save services → queue'}
          </button>
        </div>
      </div>
    </div>
  );
}
