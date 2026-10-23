import type { AppUser, Batch, Invoice, SessionUser, WriteOp } from '../types';

/**
 * Storage/auth abstraction. Business logic (src/data/actions.ts) only talks to
 * this interface, so the same workflow runs against Firebase or demo storage.
 */
export interface Backend {
  mode: 'firebase' | 'demo';
  onAuth(cb: (user: SessionUser | null, error?: string) => void): () => void;
  signIn(demoEmail?: string): Promise<void>;
  signOut(): Promise<void>;
  subscribeInvoices(cb: (rows: Invoice[]) => void): () => void;
  subscribeBatches(cb: (rows: Batch[]) => void): () => void;
  subscribeUsers(cb: (rows: AppUser[]) => void): () => void;
  /** Vendors added by users (the built-in list is in src/vendors.ts). */
  subscribeVendors(cb: (rows: { id: string; name: string; gstin: string }[]) => void): () => void;
  /** Applies all operations atomically. */
  commit(ops: WriteOp[]): Promise<void>;
  /** Stores an invoice copy (Drive: in the service-month folder). */
  uploadFile(invoiceId: string, file: File, meta: { name: string; serviceMonth: string }): Promise<{ path: string; url: string }>;
  /** Moves/renames a stored copy after the invoice's service month or details change. */
  relocateFile?(path: string, meta: { name: string; serviceMonth: string }): Promise<void>;
  /** Returns a URL for viewing an attachment that has no stored link (demo). */
  getFileUrl(path: string): Promise<string>;
  /** Rewrites the Google Sheet register from the current data. */
  syncSheet?(invoices: Invoice[], batches: Batch[]): Promise<void>;
  /** Makes sure Google access is ready; called from a click so any pop-up isn't blocked. */
  prepareGoogle?(): Promise<void>;
}

let instance: Backend | null = null;

export async function getBackend(): Promise<Backend> {
  if (instance) return instance;
  const { isDemoMode } = await import('../config');
  instance = isDemoMode
    ? (await import('./demoBackend')).createDemoBackend()
    : (await import('./firebaseBackend')).createFirebaseBackend();
  return instance;
}
