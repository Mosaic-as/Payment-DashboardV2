import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppUser, Batch, Invoice, SessionUser } from '../types';
import type { Backend } from './backend';

interface Store {
  be: Backend;
  me: SessionUser & { profile: AppUser };
  invoices: Invoice[];
  batches: Batch[];
  users: AppUser[];
  invoicesById: Map<string, Invoice>;
  batchesById: Map<string, Batch>;
  nameOf: (email: string | null | undefined) => string;
  loaded: boolean;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ be, me, children }: { be: Backend; me: Store['me']; children: ReactNode }) {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);

  useEffect(() => {
    const subs = [be.subscribeInvoices(setInvoices), be.subscribeBatches(setBatches), be.subscribeUsers(setUsers)];
    return () => subs.forEach((u) => u());
  }, [be]);

  const value = useMemo<Store>(() => {
    const inv = invoices ?? [];
    const bat = [...(batches ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const names = new Map(users.map((u) => [u.email, u.name]));
    return {
      be,
      me,
      invoices: [...inv].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      batches: bat,
      users,
      invoicesById: new Map(inv.map((i) => [i.id, i])),
      batchesById: new Map(bat.map((b) => [b.id, b])),
      nameOf: (email) => (email ? names.get(email) ?? email : ''),
      loaded: invoices !== null && batches !== null,
    };
  }, [be, me, invoices, batches, users]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}
