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
  /** Applies all operations atomically. */
  commit(ops: WriteOp[]): Promise<void>;
  uploadFile(invoiceId: string, file: File): Promise<string>;
  /** Returns a short-lived URL for viewing an attachment (access-checked). */
  getFileUrl(path: string): Promise<string>;
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
