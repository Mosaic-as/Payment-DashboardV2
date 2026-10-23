import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  OAuthProvider,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { collection, doc, getFirestore, onSnapshot, writeBatch, type DocumentData } from 'firebase/firestore';
import { config, isAllowedEmail } from '../config';
import { allInvoiceRows, batchSummaryRows, invoiceDetailRows, toTable } from '../lib/excel';
import {
  GOOGLE_SCOPES, clearGoogleToken, driveViewUrl, getAccessToken, loadGoogleIdentity, relocateDriveFile,
  setGoogleHint, setGoogleToken, uploadToDrive, writeSheetTabs,
} from '../lib/google';
import type { AppUser, Batch, Invoice } from '../types';
import type { Backend } from './backend';

const emailOf = (u: User) => (u.email ?? u.providerData.find((p) => p.email)?.email ?? '').toLowerCase();

export function createFirebaseBackend(): Backend {
  const app = initializeApp(config.firebase);
  const auth = getAuth(app);
  const db = getFirestore(app);
  void setPersistence(auth, browserLocalPersistence);

  function provider() {
    if (config.ssoProvider === 'google') {
      const p = new GoogleAuthProvider();
      // Also asks for Drive + Sheets so invoices and the register can be saved.
      GOOGLE_SCOPES.forEach((s) => p.addScope(s));
      // Pre-selects the Workspace domain; enforcement happens in the rules.
      p.setCustomParameters({ hd: config.allowedDomains[0], prompt: 'select_account' });
      return p;
    }
    const p = new OAuthProvider('microsoft.com');
    p.setCustomParameters({
      prompt: 'select_account',
      ...(config.microsoftTenantId ? { tenant: config.microsoftTenantId } : {}),
    });
    return p;
  }

  function listen<T>(col: string, cb: (rows: T[]) => void) {
    return onSnapshot(
      collection(db, col),
      (snap) => cb(snap.docs.map((d) => ({ ...(d.data() as T), id: d.id }))),
      (err) => console.error(`Listening to ${col} failed`, err),
    );
  }

  return {
    mode: 'firebase',

    onAuth(cb) {
      let unsubProfile: (() => void) | null = null;
      const unsubAuth = onAuthStateChanged(auth, (u) => {
        unsubProfile?.();
        unsubProfile = null;
        if (!u) return cb(null);
        const email = emailOf(u);
        if (!isAllowedEmail(email)) {
          void signOut(auth);
          return cb(null, `${email || 'This account'} is not a company account. Sign in with your @${config.allowedDomains.join(' / @')} email.`);
        }
        setGoogleHint(email);
        void loadGoogleIdentity().catch(() => {});
        const name = u.displayName || email;
        unsubProfile = onSnapshot(
          doc(db, 'users', email),
          (snap) => cb({ email, name, profile: snap.exists() ? ({ ...(snap.data() as AppUser), email }) : null }),
          () => cb({ email, name, profile: null }),
        );
      });
      return () => {
        unsubProfile?.();
        unsubAuth();
      };
    },

    async signIn() {
      const result = await signInWithPopup(auth, provider());
      const token = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
      if (token) setGoogleToken(token);
    },

    async signOut() {
      clearGoogleToken();
      await signOut(auth);
    },

    subscribeInvoices: (cb) => listen<Invoice>('invoices', cb),
    subscribeBatches: (cb) => listen<Batch>('batches', cb),
    subscribeVendors: (cb) => listen<{ id: string; name: string; gstin: string }>('vendors', cb),
    subscribeUsers: (cb) => listen<AppUser>('users', (rows) => cb(rows.map((r) => ({ ...r, email: (r as AppUser & { id: string }).id })))),

    async commit(ops) {
      if (ops.length > 450) throw new Error('Too many changes in one step (max 450). Send fewer invoices at a time.');
      const batch = writeBatch(db);
      for (const op of ops) {
        const r = doc(db, op.col, op.id);
        if (op.type === 'set') batch.set(r, op.data as DocumentData);
        else if (op.type === 'update') batch.update(r, op.data as DocumentData);
        else batch.delete(r);
      }
      // Firestore waits indefinitely when the server can't be reached; say so instead.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(
          new Error('The server did not confirm the save within 30 seconds. Check the internet connection (a firewall may be blocking firestore.googleapis.com), then reload and check whether it went through.'),
          { code: 'timeout' },
        )), 30_000);
      });
      try {
        await Promise.race([batch.commit(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },

    async uploadFile(_invoiceId, file, meta) {
      if (!config.google.driveFolderId) throw new Error('Google Drive folder is not configured (VITE_DRIVE_FOLDER_ID).');
      const id = await uploadToDrive(file, meta.name, meta.serviceMonth);
      return { path: id, url: driveViewUrl(id) };
    },

    relocateFile: (path, meta) => relocateDriveFile(path, meta.name, meta.serviceMonth),

    async getFileUrl(path) {
      return driveViewUrl(path);
    },

    async prepareGoogle() {
      if (config.google.sheetId || config.google.driveFolderId) await getAccessToken();
    },

    async syncSheet(invoices, batches) {
      if (!config.google.sheetId) return;
      const byCreated = <T extends { createdAt: string }>(xs: T[]) => [...xs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const sortedBatches = byCreated(batches);
      const invoicesById = new Map(invoices.map((i) => [i.id, i]));
      const batchesById = new Map(batches.map((b) => [b.id, b]));
      await writeSheetTabs([
        { title: 'Sent for Payment', rows: toTable(invoiceDetailRows(sortedBatches, invoicesById)) },
        { title: 'Batches', rows: toTable(batchSummaryRows(sortedBatches)) },
        { title: 'All Invoices', rows: toTable(allInvoiceRows(byCreated(invoices), batchesById)) },
      ]);
    },
  };
}
