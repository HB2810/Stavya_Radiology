import { api } from '../api.js';
import { Badge, Card, Empty, PageHeader, useLoad } from '../ui.jsx';

const ROLE_LABEL = { radiologist: 'Radiologist', technologist: 'Technologist', reception: 'Reception', clinician: 'Clinician', nurse: 'Nurse', admin: 'Admin', auditor: 'Auditor' };

export default function AdminRoster() {
  const { data, loading } = useLoad(() => api.get('/staff/roster'));
  const rows = data || [];
  return (
    <>
      <PageHeader title="Staff roster" />
      <Card icon="user" count={rows.length} flush>
        {rows.length ? <div className="table-scroll"><table className="clinical-table compact"><thead>
          <tr><th>Code</th><th>Name</th><th>Role</th><th>Designation</th><th>Ward</th><th>Phone</th><th>Status</th></tr>
        </thead><tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td className="mono">{u.username}</td>
              <td><strong>{u.full_name}</strong></td>
              <td>{ROLE_LABEL[u.role] || u.role}</td>
              <td>{u.designation || '—'}</td>
              <td>{u.ward || '—'}</td>
              <td className="mono">{u.phone || '—'}</td>
              <td><Badge tone={u.active ? 'success' : 'neutral'}>{u.active ? 'Active' : 'Inactive'}</Badge></td>
            </tr>))}
        </tbody></table></div> : <Empty title={loading ? 'Loading…' : 'No staff found'} />}
      </Card>
    </>
  );
}
