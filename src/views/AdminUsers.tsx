import { useState } from 'react';
import { isAllowedEmail, config } from '../config';
import { removeUser, saveUser } from '../data/actions';
import { useStore } from '../data/store';
import { ROLE_LABELS, type AppUser, type Role } from '../types';
import { ErrorNote, useAction } from '../components/ui';

const ROLES = Object.keys(ROLE_LABELS) as Role[];
const blank: AppUser = { email: '', name: '', role: 'maker', active: true };

export function AdminUsers() {
  const { be, me, users } = useStore();
  const [form, setForm] = useState<AppUser>(blank);
  const { busy, error, run } = useAction();
  const sorted = [...users].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.email.localeCompare(b.email));

  async function submit() {
    if (!isAllowedEmail(form.email)) throw new Error(`Email must be a company address (@${config.allowedDomains.join(', @')}).`);
    if (!form.name.trim()) throw new Error('Name is required.');
    await saveUser(be, form);
    setForm(blank);
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Users &amp; roles</h1>
          <p className="muted">Only listed, active company users can use the dashboard. Each person has exactly one role.</p>
        </div>
      </div>

      <div className="card">
        <h3>{users.some((u) => u.email === form.email.toLowerCase()) ? 'Update user' : 'Add user'}</h3>
        <div className="form-grid">
          <label>Company email<input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value.trim().toLowerCase() })} placeholder={`name@${config.allowedDomains[0]}`} /></label>
          <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </label>
          <label className="inline"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
        </div>
        <div className="row-gap">
          <button className="btn btn-primary" disabled={busy} onClick={() => run(submit)}>Save user</button>
          {form.email && <button className="btn btn-ghost" onClick={() => setForm(blank)}>Clear</button>}
        </div>
        <ErrorNote error={error} />
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th className="actions-col" /></tr></thead>
          <tbody>
            {sorted.map((u) => (
              <tr key={u.email}>
                <td>{u.name}</td><td>{u.email}</td><td>{ROLE_LABELS[u.role]}</td>
                <td>{u.active ? 'Active' : <span className="muted">Disabled</span>}</td>
                <td className="actions-col">
                  <button className="btn btn-sm btn-ghost" onClick={() => setForm(u)}>Edit</button>
                  {u.email !== me.email && (
                    <button className="btn btn-sm btn-ghost danger" onClick={() => confirm(`Remove ${u.email}?`) && run(() => removeUser(be, u.email))}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
