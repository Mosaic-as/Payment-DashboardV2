import type { AppUser, Batch, Invoice, SessionUser, WriteOp } from '../types';
import type { Backend } from './backend';

/**
 * DEMO MODE — used automatically when no Firebase config is set.
 * Everything is stored in this browser's localStorage, there is no real SSO,
 * and anyone can pick any role. Never use for real invoices.
 */
const KEY = 'ipa-demo-db-v2';
const SESSION_KEY = 'ipa-demo-session';
const FILE_PREFIX = 'ipa-demo-file:';

type Db = { invoices: Record<string, unknown>; batches: Record<string, unknown>; users: Record<string, unknown>; mail: Record<string, unknown> };

export const DEMO_USERS: AppUser[] = [
  { email: 'maker@mosaicwellness.in', name: 'Riya (User 1)', role: 'maker', active: true },
  { email: 'approver1@mosaicwellness.in', name: 'Arjun (User 2)', role: 'approver1', active: true },
  { email: 'approver2@mosaicwellness.in', name: 'Meera (User 3)', role: 'approver2', active: true },
  { email: 'approver3@mosaicwellness.in', name: 'Vikram (User 4)', role: 'approver3', active: true },
  { email: 'finance@mosaicwellness.in', name: 'Finance Team', role: 'finance', active: true },
  { email: 'admin@mosaicwellness.in', name: 'Admin', role: 'admin', active: true },
];

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch (e) { throw new Error('Browser storage is full or blocked: ' + (e as Error).message); }
}

function load(): Db {
  const raw = safeGet(KEY);
  if (raw) return JSON.parse(raw);
  const db: Db = { invoices: {}, batches: {}, users: {}, mail: {} };
  for (const u of DEMO_USERS) db.users[u.email] = u;
  return db;
}

export function createDemoBackend(): Backend {
  let db = load();
  const listeners = { invoices: new Set<() => void>(), batches: new Set<() => void>(), users: new Set<() => void>(), auth: new Set<() => void>() };
  const save = () => safeSet(KEY, JSON.stringify(db));
  const emit = (k: keyof typeof listeners) => listeners[k].forEach((f) => f());

  function session(): SessionUser | null {
    const email = safeGet(SESSION_KEY);
    if (!email) return null;
    const p = db.users[email] as AppUser | undefined;
    return { email, name: p?.name ?? email, profile: p ?? null };
  }

  function sub<T>(k: 'invoices' | 'batches' | 'users', cb: (rows: T[]) => void) {
    const fire = () => cb(Object.entries(db[k]).map(([id, v]) => ({ ...(v as T), ...(k === 'users' ? { email: id } : { id }) })));
    listeners[k].add(fire);
    fire();
    return () => void listeners[k].delete(fire);
  }

  // Keep multiple tabs in sync so roles can be tried side by side.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) { db = load(); emit('invoices'); emit('batches'); emit('users'); }
    if (e.key === SESSION_KEY) emit('auth');
  });

  return {
    mode: 'demo',
    onAuth(cb) {
      const fire = () => cb(session());
      listeners.auth.add(fire);
      fire();
      const unsubUsers = sub('users', fire);
      return () => { listeners.auth.delete(fire); unsubUsers(); };
    },
    async signIn(email) {
      safeSet(SESSION_KEY, email!);
      emit('auth');
    },
    async signOut() {
      try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
      emit('auth');
    },
    subscribeInvoices: (cb) => sub<Invoice>('invoices', cb),
    subscribeBatches: (cb) => sub<Batch>('batches', cb),
    subscribeUsers: (cb) => sub<AppUser>('users', cb),
    async commit(ops: WriteOp[]) {
      const next: Db = JSON.parse(JSON.stringify(db));
      for (const op of ops) {
        const col = next[op.col];
        if (op.type === 'set') col[op.id] = op.data;
        else if (op.type === 'update') {
          if (!col[op.id]) throw new Error(`${op.col}/${op.id} does not exist`);
          col[op.id] = { ...(col[op.id] as object), ...op.data };
        } else delete col[op.id];
      }
      db = next;
      save();
      emit('invoices'); emit('batches'); emit('users');
    },
    async uploadFile(invoiceId, file) {
      const path = `invoices/${invoiceId}/${Date.now()}_${file.name}`;
      if (file.size < 1_500_000) {
        const dataUrl = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = () => rej(r.error);
          r.readAsDataURL(file);
        });
        try { safeSet(FILE_PREFIX + path, dataUrl); } catch { /* demo: keep the name only */ }
      }
      return path;
    },
    async getFileUrl(path) {
      const url = safeGet(FILE_PREFIX + path);
      if (!url) throw new Error('Demo mode keeps only small attachments (< 1.5 MB) in the browser.');
      // Browsers block opening data: URLs in a tab, so hand back a blob URL.
      return URL.createObjectURL(await (await fetch(url)).blob());
    },
  };
}
