import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppUser, Batch, Invoice, SessionUser, Vendor } from '../types';
import { DEFAULT_VENDORS, vendorKey } from '../vendors';
import type { Backend } from './backend';

export type SheetSync = { state: 'off' | 'idle' | 'syncing' | 'ok' | 'error'; message?: string; at?: string };

interface Store {
  be: Backend;
  me: SessionUser & { profile: AppUser };
  invoices: Invoice[];
  batches: Batch[];
  users: AppUser[];
  /** Built-in + user-added vendors, sorted by name. */
  vendors: Vendor[];
  invoicesById: Map<string, Invoice>;
  batchesById: Map<string, Batch>;
  nameOf: (email: string | null | undefined) => string;
  loaded: boolean;
  sheet: SheetSync;
  syncSheetNow: () => void;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ be: rawBe, me, children }: { be: Backend; me: Store['me']; children: ReactNode }) {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [customVendors, setCustomVendors] = useState<{ id: string; name: string; gstin: string }[]>([]);
  const [sheet, setSheet] = useState<SheetSync>({ state: rawBe.syncSheet ? 'idle' : 'off' });
  const latest = useRef({ invoices: [] as Invoice[], batches: [] as Batch[] });
  latest.current = { invoices: invoices ?? [], batches: batches ?? [] };
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const subs = [
      rawBe.subscribeInvoices(setInvoices), rawBe.subscribeBatches(setBatches),
      rawBe.subscribeUsers(setUsers), rawBe.subscribeVendors(setCustomVendors),
    ];
    return () => subs.forEach((u) => u());
  }, [rawBe]);

  // Only the person who made a change rewrites the sheet, shortly after the
  // change lands in the live data, so the sheet always mirrors the database.
  const syncSheetNow = useCallback((delay = 0) => {
    if (!rawBe.syncSheet) return;
    clearTimeout(timer.current);
    setSheet((s) => ({ ...s, state: 'syncing' }));
    timer.current = setTimeout(async () => {
      try {
        await rawBe.syncSheet!(latest.current.invoices, latest.current.batches);
        setSheet({ state: 'ok', at: new Date().toISOString() });
      } catch (e) {
        console.error('Google Sheet sync failed', e);
        setSheet({ state: 'error', message: (e as Error).message });
      }
    }, delay);
  }, [rawBe]);

  const be = useMemo<Backend>(() => ({
    ...rawBe,
    async commit(ops) {
      const touchesRegister = ops.some((o) => o.col === 'invoices' || o.col === 'batches');
      // Ask for Google access while still inside the click, so a pop-up isn't blocked.
      if (touchesRegister && rawBe.prepareGoogle) await rawBe.prepareGoogle().catch(() => {});
      await rawBe.commit(ops);
      if (touchesRegister) syncSheetNow(1000);
    },
  }), [rawBe, syncSheetNow]);

  const vendors = useMemo<Vendor[]>(() => {
    const byKey = new Map<string, Vendor>();
    DEFAULT_VENDORS.forEach((name) => byKey.set(vendorKey(name), { id: vendorKey(name), name, gstin: '', custom: false }));
    // A user-added entry for a built-in name only contributes its GSTIN.
    customVendors.forEach((v) => {
      const prev = byKey.get(v.id);
      byKey.set(v.id, prev ? { ...prev, gstin: v.gstin || prev.gstin } : { id: v.id, name: v.name, gstin: v.gstin ?? '', custom: true });
    });
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  }, [customVendors]);

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
      vendors,
      invoicesById: new Map(inv.map((i) => [i.id, i])),
      batchesById: new Map(bat.map((b) => [b.id, b])),
      nameOf: (email) => (email ? names.get(email) ?? email : ''),
      loaded: invoices !== null && batches !== null,
      sheet,
      syncSheetNow: () => syncSheetNow(0),
    };
  }, [be, me, invoices, batches, users, vendors, sheet, syncSheetNow]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}
