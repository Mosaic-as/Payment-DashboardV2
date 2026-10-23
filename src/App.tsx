import { useEffect, useState } from 'react';
import { config } from './config';
import { getBackend, type Backend } from './data/backend';
import { DEMO_USERS } from './data/demoBackend';
import { StoreProvider, useStore } from './data/store';
import { ROLE_LABELS, type AppUser, type Role, type SessionUser } from './types';
import { useAction, ErrorNote } from './components/ui';
import { Overview } from './views/Overview';
import { MakerInvoices } from './views/MakerInvoices';
import { ApprovalQueue } from './views/ApprovalQueue';
import { FinanceQueue } from './views/FinanceQueue';
import { AdminUsers } from './views/AdminUsers';
import { BatchesView } from './views/BatchesView';

type Tab = { id: string; label: string; render: () => JSX.Element };

function tabsFor(role: Role): Tab[] {
  const overview: Tab = { id: 'overview', label: 'Dashboard', render: () => <Overview /> };
  const batches: Tab = { id: 'batches', label: 'All batches', render: () => <BatchesView /> };
  switch (role) {
    case 'maker':
      return [{ id: 'invoices', label: 'My invoices', render: () => <MakerInvoices /> }, overview, batches];
    case 'approver1':
    case 'approver2':
    case 'approver3':
      return [{ id: 'queue', label: 'Approval queue', render: () => <ApprovalQueue /> }, overview, batches];
    case 'finance':
      return [{ id: 'finance', label: 'Payment queue', render: () => <FinanceQueue /> }, overview, batches];
    case 'admin':
      return [overview, batches, { id: 'users', label: 'Users & roles', render: () => <AdminUsers /> }];
  }
}

function GoogleLinks() {
  const { be, sheet, syncSheetNow } = useStore();
  if (be.mode !== 'firebase') return null;
  const { sheetId, driveFolderId } = config.google;
  const label = {
    off: '', idle: 'Sheet', syncing: 'Updating sheet…', ok: 'Sheet updated', error: 'Sheet update failed',
  }[sheet.state];
  return (
    <div className="glinks">
      {driveFolderId && (
        <a href={`https://drive.google.com/drive/folders/${driveFolderId}`} target="_blank" rel="noreferrer" title="Invoice copies, by service month">📁 Drive</a>
      )}
      {sheetId && (
        <>
          <a
            href={`https://docs.google.com/spreadsheets/d/${sheetId}`}
            target="_blank"
            rel="noreferrer"
            className={`sheet-${sheet.state}`}
            title={sheet.state === 'error' ? sheet.message : sheet.at ? `Last updated ${new Date(sheet.at).toLocaleTimeString()}` : 'Live payment register'}
          >📊 {label}</a>
          {sheet.state === 'error' && <button className="link-btn small" onClick={syncSheetNow}>Retry</button>}
        </>
      )}
    </div>
  );
}

function Shell() {
  const { be, me } = useStore();
  const tabs = tabsFor(me.profile.role);
  const [tab, setTab] = useState(tabs[0].id);
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>₹</span>
          <span>{config.appName}</span>
          {be.mode === 'demo' && <span className="demo-pill" title="No Firebase config — data is stored only in this browser">DEMO</span>}
        </div>
        <nav className="tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === current.id} className={t.id === current.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <GoogleLinks />
        <div className="who">
          <div>
            <div className="who-name">{me.profile.name || me.name}</div>
            <div className="who-role">{ROLE_LABELS[me.profile.role]}</div>
          </div>
          <button className="btn btn-ghost" onClick={() => be.signOut()}>Sign out</button>
        </div>
      </header>
      <main className="content">{current.render()}</main>
    </div>
  );
}

function Login({ be, error }: { be: Backend; error: string }) {
  const { busy, error: signInError, run } = useAction();
  const providerName = config.ssoProvider === 'google' ? 'Google Workspace' : 'Microsoft 365';
  return (
    <div className="login">
      <div className="login-card">
        <div className="logo logo-lg" aria-hidden>₹</div>
        <h1>{config.appName}</h1>
        {be.mode === 'firebase' ? (
          <>
            <p className="muted">Sign in with your company account (@{config.allowedDomains.join(', @')}).</p>
            <button className="btn btn-primary btn-block" disabled={busy} onClick={() => run(() => be.signIn())}>
              {busy ? 'Signing in…' : `Sign in with ${providerName}`}
            </button>
          </>
        ) : (
          <>
            <div className="note note-warn">
              <b>Demo mode.</b> Firebase is not configured, so there is no SSO and data stays in this browser.
              Pick a role to try the workflow.
            </div>
            <div className="demo-users">
              {DEMO_USERS.map((u: AppUser) => (
                <button key={u.email} className="btn btn-outline" onClick={() => run(() => be.signIn(u.email))}>
                  <b>{ROLE_LABELS[u.role]}</b>
                  <span className="muted">{u.name}</span>
                </button>
              ))}
            </div>
          </>
        )}
        <ErrorNote error={error || signInError} />
      </div>
    </div>
  );
}

function Pending({ be, user }: { be: Backend; user: SessionUser }) {
  const inactive = user.profile && !user.profile.active;
  return (
    <div className="login">
      <div className="login-card">
        <h1>{inactive ? 'Access disabled' : 'Access pending'}</h1>
        <p>
          You are signed in as <b>{user.email}</b>, but {inactive ? 'your access has been disabled' : 'no role has been assigned to you yet'}.
          Ask an administrator to {inactive ? 're-enable' : 'add'} you under <i>Users &amp; roles</i>.
        </p>
        <button className="btn btn-outline" onClick={() => be.signOut()}>Sign out</button>
      </div>
    </div>
  );
}

export default function App() {
  const [be, setBe] = useState<Backend | null>(null);
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    let unsub = () => {};
    getBackend().then((b) => {
      setBe(b);
      unsub = b.onAuth((u, err) => {
        setUser(u);
        setAuthError(err ?? '');
      });
    }).catch((e) => setAuthError(String(e)));
    return () => unsub();
  }, []);

  if (!be || user === undefined) return <div className="splash">{authError || 'Loading…'}</div>;
  if (!user) return <Login be={be} error={authError} />;
  if (!user.profile || !user.profile.active) return <Pending be={be} user={user} />;
  return (
    <StoreProvider be={be} me={{ ...user, profile: user.profile }}>
      <Shell key={user.email} />
    </StoreProvider>
  );
}
