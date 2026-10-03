import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Card, Empty, FormError, Icon, Notice, PageHeader, PriorityBadge, fmt, go, inr, toast, useAction, useLoad } from '../ui.jsx';

/** Technician / technician assistant: pick billed services inside a category. Reception may view only. */
export default function Protocol({ user }) {
  const list = useLoad(() => api.get('/cases?awaiting=1&open=1'));
  const [active, setActive] = useState(null); // case_modality row + case
  const a = useAction();
  const canProtocol = ['technologist', 'radiologist', 'admin'].includes(user.role);

  const open = (c, m) => setActive({ case: c, mod: m });

  const awaiting = (list.data || []).flatMap((c) =>
    (c.modalities || []).filter((m) => m.status === 'AWAITING_PROTOCOL').map((m) => ({ case: c, mod: m }))
  );

  return (
    <>
      <PageHeader title="Protocol services" subtitle={canProtocol
        ? 'Reception sent categories only. Select the exact CT / MRI / X-ray services from the catalog.'
        : 'View-only for reception. Technician / assistant selects billed services here.'}
        actions={<button className="btn btn-light" onClick={() => list.reload()}>Refresh</button>} />

      <Notice>{canProtocol
        ? 'Amounts and counter payment appear for reception only after you save services on a category.'
        : 'You opened categories at the desk. Wait for the technician to protocol services — then collect payment on the desk.'}</Notice>

      <Card title="Awaiting protocol" icon="worklist" count={awaiting.length} tone={awaiting.length ? 'amber' : 'green'} flush>
        {!awaiting.length ? <Empty title="Nothing waiting" detail="When reception opens a case with CT / MRI / X-ray, it shows up here." /> : (
          <div className="table-scroll"><table className="clinical-table queue">
            <thead><tr><th>Token</th><th>Patient</th><th>Category</th><th>Channel</th><th>ETA</th><th className="col-action">Action</th></tr></thead>
            <tbody>{awaiting.map(({ case: c, mod: m }) => (
              <tr key={m.id} className={c.is_new ? 'row-new' : ''}>
                <td><strong className="mono token-num">{m.token_no || '—'}</strong><span className="table-sub">{m.machine_code || m.modality}</span></td>
                <td><strong>{c.patient_name}</strong><span className="table-sub">{c.mrn} · {c.case_no}</span></td>
                <td><Badge tone="info">{m.modality === 'XR' ? 'X-ray' : m.modality}</Badge><PriorityBadge priority={c.priority} /></td>
                <td>{c.channel_name || c.channel_code}<span className="table-sub">{c.clinical_indication}</span></td>
                <td className="mono">{m.eta_at ? fmt(m.eta_at) : '—'}</td>
                <td className="col-action">{canProtocol
                  ? <button className="primary" onClick={() => open(c, m)}>Select services</button>
                  : <span className="table-sub">Tech selects</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      {active && canProtocol && <ProtocolModal user={user} caseRow={active.case} mod={active.mod} onClose={() => setActive(null)} onDone={() => { setActive(null); list.reload(); }} />}
      <FormError error={a.error} />
    </>
  );
}

function ProtocolModal({ caseRow, mod, onClose, onDone }) {
  const services = useLoad(() => api.get(`/cases/modalities/${mod.modality}/services`), [mod.modality]);
  const [picked, setPicked] = useState({}); // code -> { side }
  const [q, setQ] = useState('');
  const a = useAction();

  const rows = (services.data || []).filter((e) => !q || `${e.name} ${e.code}`.toLowerCase().includes(q.toLowerCase()));
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
      confirmDuplicate: true
    };
    const r = await api.post(`/case-modalities/${mod.id}/protocol`, body);
    toast(`${selected.length} ${mod.modality} service(s) saved · ${inr(r.amount)}`);
    onDone();
  });

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-shell wide" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2><Icon name="scan" size={16} /> Protocol {mod.modality === 'XR' ? 'X-ray' : mod.modality} · {caseRow.patient_name}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <div className="modal-body">
          <p className="note" style={{ marginTop: 0 }}>{caseRow.case_no} · token <b>{mod.token_no}</b> · {caseRow.clinical_indication}</p>
          <label className="search-box" style={{ maxWidth: 'none', marginBottom: 10 }}><Icon name="search" size={14} /><input placeholder="Filter services in this category" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <FormError error={a.error} />
          {!services.data ? <Empty title="Loading catalog…" /> : (
            <div className="table-scroll" style={{ maxHeight: 360 }}><table className="clinical-table compact">
              <thead><tr><th></th><th>Service</th><th className="n">Price</th><th>Side</th></tr></thead>
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
          <button className="btn btn-primary" disabled={a.busy || !selected.length} onClick={save}>{a.busy ? 'Saving…' : 'Save services → queue'}</button>
        </div>
      </div>
    </div>
  );
}
