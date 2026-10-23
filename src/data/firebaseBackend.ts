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
import { getBlob, getStorage, ref, uploadBytes } from 'firebase/storage';
import { config, isAllowedEmail } from '../config';
import type { AppUser, Batch, Invoice } from '../types';
import type { Backend } from './backend';

const emailOf = (u: User) => (u.email ?? u.providerData.find((p) => p.email)?.email ?? '').toLowerCase();

export function createFirebaseBackend(): Backend {
  const app = initializeApp(config.firebase);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const storage = getStorage(app);
  void setPersistence(auth, browserLocalPersistence);

  function provider() {
    if (config.ssoProvider === 'google') {
      const p = new GoogleAuthProvider();
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
      await signInWithPopup(auth, provider());
    },

    async signOut() {
      await signOut(auth);
    },

    subscribeInvoices: (cb) => listen<Invoice>('invoices', cb),
    subscribeBatches: (cb) => listen<Batch>('batches', cb),
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
      await batch.commit();
    },

    async uploadFile(invoiceId, file) {
      const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
      const path = `invoices/${invoiceId}/${Date.now()}_${safe}`;
      await uploadBytes(ref(storage, path), file, { contentType: file.type });
      return path;
    },

    async getFileUrl(path) {
      return URL.createObjectURL(await getBlob(ref(storage, path)));
    },
  };
}
