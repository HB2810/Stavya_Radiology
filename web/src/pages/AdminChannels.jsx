import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Card, Empty, FormError, Icon, Modal, Notice, PageHeader, toast, useAction, useLoad } from '../ui.jsx';

function ChannelModal({ ch, onClose, onSaved }) {
  const [f, setF] = useState({
    name: ch.name, paymentPlace: ch.payment_place, paymentGate: !!ch.payment_gate, reportHandover: ch.report_handover,
    defaultPriority: ch.default_priority, allowStatReception: !!ch.allow_stat_reception, autoQueue: !!ch.auto_queue,
    quickEntry: !!ch.quick_entry, tokenPrefix: ch.token_prefix, sortOrder: ch.sort_order, notes: ch.notes, active: !!ch.active
  });
  const a = useAction();
  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setF({ ...f, [k]: v });
  };
  const save = () => a.run(async () => {
    const saved = await api.post(`/masters/channels/${ch.code}`, f);
    toast('Channel saved'); onSaved(saved); onClose();
  });
  return (
    <Modal title={ch.code} icon="settings" onClose={onClose} foot={<><button className="btn btn-light" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={a.busy} onClick={save}>Save</button></>}>
      <FormError error={a.error} />
      <div className="form-grid">
        <label className="wide"><span>Name</span><input value={f.name} onChange={set('name')} /></label>
        <label><span>Payment place</span><select value={f.paymentPlace} onChange={set('paymentPlace')}><option>RADIOLOGY</option><option>IPD_CREDIT</option><option>NONE</option></select></label>
        <label><span>Report handover</span><select value={f.reportHandover} onChange={set('reportHandover')}><option>CONSULTANT</option><option>PATIENT</option><option>WARD</option></select></label>
        <label><span>Default priority</span><select value={f.defaultPriority} onChange={set('defaultPriority')}><option>ROUTINE</option><option>URGENT</option><option>STAT</option></select></label>
        <label><span>Token prefix</span><input value={f.tokenPrefix} onChange={set('tokenPrefix')} /></label>
        <label><span>Sort</span><input type="number" value={f.sortOrder} onChange={set('sortOrder')} /></label>
        <label className="check-row"><input type="checkbox" checked={f.paymentGate} onChange={set('paymentGate')} /><span>Payment gate before scan</span></label>
        <label className="check-row"><input type="checkbox" checked={f.allowStatReception} onChange={set('allowStatReception')} /><span>Reception may set STAT</span></label>
        <label className="check-row"><input type="checkbox" checked={f.autoQueue} onChange={set('autoQueue')} /><span>Auto token / queue (when traffic system is on)</span></label>
        <label className="check-row"><input type="checkbox" checked={f.quickEntry} onChange={set('quickEntry')} /><span>Quick entry (ER)</span></label>
        <label className="check-row"><input type="checkbox" checked={f.active} onChange={set('active')} /><span>Active</span></label>
        <label className="wide"><span>Notes</span><textarea rows={2} value={f.notes} onChange={set('notes')} /></label>
      </div>
    </Modal>
  );
}

function TrafficOptionalCard({ opts, onChange }) {
  const a = useAction();
  const [f, setF] = useState({
    trafficSystemEnabled: !!(opts?.trafficSystemEnabled),
    tokenEnabled: !!(opts?.tokenEnabled),
    autoTrafficEnabled: !!(opts?.autoTrafficEnabled),
    reservedEmergencySlots: opts?.reservedEmergencySlots ?? 8
  });
  useEffect(() => {
    if (!opts) return;
    setF({
      trafficSystemEnabled: !!(opts.tokenEnabled || opts.autoTrafficEnabled),
      tokenEnabled: !!opts.tokenEnabled,
      autoTrafficEnabled: !!opts.autoTrafficEnabled,
      reservedEmergencySlots: opts.reservedEmergencySlots ?? 8
    });
  }, [opts?.tokenEnabled, opts?.autoTrafficEnabled, opts?.reservedEmergencySlots]);

  const saveMaster = (on) => a.run(async () => {
    const saved = await api.post('/masters/traffic-options', { trafficSystemEnabled: on, reservedEmergencySlots: f.reservedEmergencySlots });
    setF({
      trafficSystemEnabled: !!(saved.tokenEnabled || saved.autoTrafficEnabled),
      tokenEnabled: !!saved.tokenEnabled,
      autoTrafficEnabled: !!saved.autoTrafficEnabled,
      reservedEmergencySlots: saved.reservedEmergencySlots ?? 8
    });
    toast(on ? 'Token & auto traffic turned ON' : 'Token & auto traffic turned OFF');
    onChange?.(saved);
  });

  const saveParts = () => a.run(async () => {
    const saved = await api.post('/masters/traffic-options', {
      tokenEnabled: f.tokenEnabled,
      autoTrafficEnabled: f.autoTrafficEnabled,
      reservedEmergencySlots: Number(f.reservedEmergencySlots)
    });
    setF({
      trafficSystemEnabled: !!(saved.tokenEnabled || saved.autoTrafficEnabled),
      tokenEnabled: !!saved.tokenEnabled,
      autoTrafficEnabled: !!saved.autoTrafficEnabled,
      reservedEmergencySlots: saved.reservedEmergencySlots ?? 8
    });
    toast('Traffic options saved');
    onChange?.(saved);
  });

  return (
    <Card title="Token & automation traffic (optional)" icon="command" tone={f.trafficSystemEnabled ? 'green' : 'amber'}>
      <FormError error={a.error} />
      <Notice>
        Optional package. When off, reception / assistant / technician still run — without token numbers or auto ACK→SCHEDULED.
        Channel “Auto queue” only applies when automated traffic is on here.
      </Notice>
      <div className="traffic-optional-bar">
        <div>
          <strong>{f.trafficSystemEnabled ? 'Enabled' : 'Disabled'}</strong>
          <span className="table-sub">Master switch for the whole optional traffic system</span>
        </div>
        <button
          type="button"
          className={`btn ${f.trafficSystemEnabled ? 'btn-light' : 'btn-primary'}`}
          disabled={a.busy}
          onClick={() => saveMaster(!f.trafficSystemEnabled)}
        >
          {f.trafficSystemEnabled ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <label className="check-row">
          <input type="checkbox" checked={f.tokenEnabled} onChange={(e) => setF({ ...f, tokenEnabled: e.target.checked, trafficSystemEnabled: e.target.checked || f.autoTrafficEnabled })} />
          <span>Token numbers (M-001, X-014…)</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={f.autoTrafficEnabled} onChange={(e) => setF({ ...f, autoTrafficEnabled: e.target.checked, trafficSystemEnabled: f.tokenEnabled || e.target.checked })} />
          <span>Automated traffic (auto queue + ETA ranking)</span>
        </label>
        <label>
          <span>Reserved slots for emergency / privileged (5–10)</span>
          <input type="number" min={5} max={10} value={f.reservedEmergencySlots} onChange={(e) => setF({ ...f, reservedEmergencySlots: e.target.value })} />
        </label>
      </div>
      <p className="note">These slots stay held for ER, STAT and privileged patients so routine walk-ins do not fill the entire machine queue.</p>
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={a.busy} onClick={saveParts}>Save options</button>
      </div>
    </Card>
  );
}

const INTEGRATION_LABEL = {
  whatsapp_reports: 'WhatsApp · send signed report to patient',
  whatsapp_alerts: 'WhatsApp · operational alerts (sedation / critical)',
  pacs_auto_report: 'PACS / viewer · auto draft report when study complete',
  anesthesia_module: 'Anaesthesia module · sedation request push',
  sedation_notify: 'Sedation notify · anaesthetist (in-app + WhatsApp when on)'
};

function IntegrationsCard() {
  const list = useLoad(() => api.get('/integrations'));
  const a = useAction();
  const toggle = (row) => a.run(async () => {
    await api.post(`/integrations/${row.key}`, { enabled: !row.enabled });
    toast(`${INTEGRATION_LABEL[row.key] || row.key}: ${row.enabled ? 'off' : 'on'}`);
    list.reload();
  });
  return (
    <Card title="Future integrations (hooks ready)" icon="settings" count={list.data?.length} flush>
      <FormError error={a.error} />
      <Notice>
        Ready for later wiring. When enabled, events are queued to an outbox (WhatsApp / PACS / anaesthesia). No live provider is connected yet — turn on when credentials and modules are ready.
      </Notice>
      {!list.data ? <Empty title="Loading…" /> : (
        <div className="table-scroll"><table className="clinical-table compact">
          <thead><tr><th>Integration</th><th>Status</th><th className="col-action">Action</th></tr></thead>
          <tbody>{list.data.map((row) => (
            <tr key={row.key}>
              <td><strong>{INTEGRATION_LABEL[row.key] || row.key}</strong><span className="table-sub">{row.config?.note || row.key}</span></td>
              <td><Badge tone={row.enabled ? 'success' : 'neutral'}>{row.enabled ? 'Armed' : 'Off'}</Badge></td>
              <td className="col-action"><button className={row.enabled ? 'danger' : 'primary'} disabled={a.busy} onClick={() => toggle(row)}>{row.enabled ? 'Disable' : 'Enable'}</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Card>
  );
}

export default function AdminChannels() {
  const list = useLoad(() => api.get('/masters/channels?all=1'));
  const machines = useLoad(() => api.get('/masters/machines?all=1'));
  const rules = useLoad(() => api.get('/masters/queue-rules'));
  const traffic = useLoad(() => api.get('/masters/traffic-options'));
  const [edit, setEdit] = useState(null);
  const a = useAction();

  const toggleMachine = (m) => a.run(async () => {
    await api.post(`/masters/machines/${m.id}`, { active: !m.active });
    machines.reload(); toast(m.active ? 'Machine off' : 'Machine on');
  });

  return (
    <>
      <PageHeader title="Channels & traffic" subtitle="Token / auto traffic is optional. Reserved ER slots and future PACS / WhatsApp / anaesthesia hooks live here." />

      <TrafficOptionalCard opts={traffic.data} onChange={() => { traffic.reload(); rules.reload(); }} />
      <IntegrationsCard />

      <Card title="Channels" icon="command" count={list.data?.length} flush>
        <FormError error={a.error} />
        {!list.data?.length ? <Empty title="Loading…" /> : (
          <div className="table-scroll"><table className="clinical-table compact">
            <thead><tr><th>Channel</th><th>Pay</th><th>Handover</th><th>Gates</th><th>Status</th><th className="col-action">Action</th></tr></thead>
            <tbody>{list.data.map((c) => (
              <tr key={c.code}>
                <td><strong>{c.name}</strong><span className="table-sub">{c.code} · {c.encounter_type} · prefix {c.token_prefix}</span></td>
                <td>{c.payment_place}</td>
                <td>{c.report_handover}</td>
                <td><div className="cell-flags">
                  {c.payment_gate ? <Badge tone="warning">Pay gate</Badge> : null}
                  {c.auto_queue ? <Badge tone="success">Auto queue</Badge> : <Badge>Manual</Badge>}
                  {c.allow_stat_reception ? <Badge tone="danger">STAT ok</Badge> : null}
                </div></td>
                <td><Badge tone={c.active ? 'success' : 'neutral'}>{c.active ? 'Active' : 'Off'}</Badge></td>
                <td className="col-action"><button onClick={() => setEdit(c)}>Edit</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <div className="grid-2">
        <Card title="Machines" icon="scan" count={machines.data?.length} flush>
          {!machines.data?.length ? <Empty title="Loading…" /> : (
            <div className="table-scroll"><table className="clinical-table compact">
              <thead><tr><th>Machine</th><th>Hours</th><th>Status</th><th className="col-action">Action</th></tr></thead>
              <tbody>{machines.data.map((m) => (
                <tr key={m.id}>
                  <td><strong>{m.name}</strong><span className="table-sub">{m.modality} · token {m.token_prefix}</span></td>
                  <td className="mono">{m.open_time}–{m.close_time}</td>
                  <td><Badge tone={m.active ? 'success' : 'neutral'}>{m.active ? 'Active' : 'Off'}</Badge></td>
                  <td className="col-action"><button className={m.active ? 'danger' : 'primary'} onClick={() => toggleMachine(m)}>{m.active ? 'Disable' : 'Enable'}</button></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <Card title="Queue rules" icon="worklist">
          {rules.data ? (
            <>
              <p className="note">Priority order (first jumps the queue) — used only when automated traffic is on:</p>
              <ol>{(rules.data.priorityOrder || []).map((c) => <li key={c}><code>{c}</code></li>)}</ol>
              <p className="note">No-show after <b>{rules.data.noShowMinutes}</b> minutes past ETA.</p>
              <p className="chart-title">Hold reasons</p>
              <div className="chips">{(rules.data.holdReasons || []).map((h) => <span className="chip" key={h}>{h}</span>)}</div>
              <div className="cell-flags" style={{ marginTop: 12 }}>
                <Badge tone={rules.data.tokenEnabled ? 'success' : 'neutral'}>Tokens {rules.data.tokenEnabled ? 'on' : 'off'}</Badge>
                <Badge tone={rules.data.autoTrafficEnabled ? 'success' : 'neutral'}>Auto traffic {rules.data.autoTrafficEnabled ? 'on' : 'off'}</Badge>
                <Badge tone="info">{rules.data.reservedEmergencySlots ?? 8} ER/privileged slots held</Badge>
              </div>
            </>
          ) : <Empty title="Loading…" />}
        </Card>
      </div>
      {edit && <ChannelModal ch={edit} onClose={() => setEdit(null)} onSaved={() => list.reload()} />}
    </>
  );
}
