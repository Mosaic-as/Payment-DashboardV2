/**
 * Runs the app's real workflow actions against firestore.rules in the
 * Firestore emulator. Run with: npm run test:rules  (needs Java 11+).
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import type { Backend } from '../src/data/backend';
import {
  addVendor, approveBatch, saveUser, approveSelected, noteFinanceMail, recordPayments, rejectBatch, returnInvoices, saveInvoice,
  saveMailSettings, sendForApproval, validateInvoice, type InvoiceInput,
} from '../src/data/actions';
import type { Batch, Invoice, Role, WriteOp } from '../src/types';

const D = 'mosaicwellness.in';
const MAKER = `tamjeed.khan@${D}`;
const A1 = `approver.one@${D}`;
const A2 = `approver.two@${D}`;
const A3 = `approver.three@${D}`;
const FIN = `finance@${D}`;
const ADMIN = `asif.shaikh@${D}`;

let env: RulesTestEnvironment;

// The emulator's compat Firestore, wrapped in the app's Backend interface,
// so the exact writes the app makes are checked by the rules.
type CompatDb = ReturnType<ReturnType<RulesTestEnvironment['authenticatedContext']>['firestore']>;
function backendAs(email: string): { be: Backend; db: CompatDb } {
  const db = env.authenticatedContext(email, { email, email_verified: true, firebase: { sign_in_provider: 'google.com' } }).firestore();
  const be = {
    mode: 'firebase',
    async commit(ops: WriteOp[]) {
      const b = db.batch();
      for (const op of ops) {
        const ref = db.collection(op.col).doc(op.id);
        if (op.type === 'set') b.set(ref, op.data!);
        else if (op.type === 'update') b.update(ref, op.data!);
        else b.delete(ref);
      }
      await b.commit();
    },
    async uploadFile(id: string) { return { path: `drive-${id}`, url: `https://drive.google.com/file/d/drive-${id}/view` }; },
    async getFileUrl(p: string) { return p; },
  } as unknown as Backend;
  return { be, db };
}

async function setRole(email: string, role: Role) {
  await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection('users').doc(email).set({ name: email, role, active: true }));
}

async function load(db: CompatDb) {
  const inv = (await db.collection('invoices').get()).docs.map((d) => ({ ...(d.data() as Invoice), id: d.id }));
  const bat = (await db.collection('batches').get()).docs.map((d) => ({ ...(d.data() as Batch), id: d.id }));
  return { invoices: inv, invoicesById: new Map(inv.map((i) => [i.id, i])), batches: bat };
}

const input = (no: string, total: number, category = 'Warehouse - Rent'): InvoiceInput => {
  const taxable = Math.round((total / 1.18) * 100) / 100;
  return {
    vendorName: 'Delhivery Limited', vendorGstin: '', invoiceNumber: no, invoiceDate: '2026-10-01',
    taxableAmount: taxable, gstAmount: Math.round((total - taxable) * 100) / 100, totalAmount: total,
    category, serviceMonth: '2026-09', notes: 'TEST',
  };
};

/** User 1 uploads, validates and sends; returns the created batches. */
async function makeBatch(totals: number[], category?: string) {
  const { be, db } = backendAs(MAKER);
  for (const [i, t] of totals.entries()) {
    const id = await saveInvoice(be, MAKER, null, input(`T-${Math.random().toString(36).slice(2, 7)}-${i}`, t, category), new File(['%PDF'], 'x.pdf'));
    const inv = (await load(db)).invoicesById.get(id)!;
    await validateInvoice(be, MAKER, inv, []);
  }
  const { invoices } = await load(db);
  return sendForApproval(be, MAKER, invoices.filter((i) => i.status === 'VALIDATED' && !i.batchId));
}

const pay = (b: Batch, ids = b.invoiceIds, utr = 'SBIN426012345678') =>
  ids.map((invoiceId) => ({ invoiceId, payment: { utr, date: '2026-10-20', tds: 0, paid: 1 } }));

async function batchFor(email: string, id: string) {
  const { db } = backendAs(email);
  const s = await load(db);
  return { batch: s.batches.find((b) => b.id === id)!, invoicesById: s.invoicesById };
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-payment-dashboard',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
afterAll(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  for (const [e, r] of [[MAKER, 'maker'], [A1, 'approver1'], [A2, 'approver2'], [A3, 'approver3'], [FIN, 'finance'], [ADMIN, 'admin']] as const) {
    await setRole(e, r);
  }
});

describe('the reported case: same person as User 1, then switched to Approver 1', () => {
  it('can approve the batch they sent', async () => {
    const [b] = await makeBatch([11800]);
    await setRole(MAKER, 'approver1');
    const { be } = backendAs(MAKER);
    const { batch, invoicesById } = await batchFor(MAKER, b.id);
    await assertSucceeds(approveBatch(be, MAKER, batch, '', invoicesById));
  });
});

describe('full approval chain', () => {
  it('≤ ₹20 lakh: L1 → L2 → Finance → Paid', async () => {
    const [b] = await makeBatch([11800]);
    for (const who of [A1, A2]) {
      const { batch, invoicesById } = await batchFor(who, b.id);
      await assertSucceeds(approveBatch(backendAs(who).be, who, batch, 'ok', invoicesById));
    }
    let { batch } = await batchFor(FIN, b.id);
    expect(batch.status).toBe('WITH_FINANCE');
    await assertSucceeds(recordPayments(backendAs(FIN).be, FIN, batch, pay(batch)));
    ({ batch } = await batchFor(FIN, b.id));
    expect(batch.status).toBe('PAID');
  });

  it('> ₹20 lakh goes through L3', async () => {
    const [b] = await makeBatch([2_360_000]);
    for (const who of [A1, A2, A3]) {
      const { batch, invoicesById } = await batchFor(who, b.id);
      await assertSucceeds(approveBatch(backendAs(who).be, who, batch, '', invoicesById));
    }
    expect((await batchFor(FIN, b.id)).batch.status).toBe('WITH_FINANCE');
  });

  it('blocks the wrong person: maker or L2 cannot approve at L1, finance cannot pay early', async () => {
    const [b] = await makeBatch([11800]);
    for (const who of [MAKER, A2, FIN]) {
      const { batch, invoicesById } = await batchFor(who, b.id);
      await assertFails(approveBatch(backendAs(who).be, who, batch, '', invoicesById));
    }
    const { batch } = await batchFor(FIN, b.id);
    await assertFails(recordPayments(backendAs(FIN).be, FIN, { ...batch, status: 'WITH_FINANCE' }, pay(batch)));
  });

  it('whole-batch reject returns invoices to User 1, who can fix and resend', async () => {
    const [b] = await makeBatch([11800]);
    const { batch } = await batchFor(A1, b.id);
    await assertSucceeds(rejectBatch(backendAs(A1).be, A1, batch, 'wrong vendor'));
    const { be, db } = backendAs(MAKER);
    const inv = (await load(db)).invoices[0];
    await assertSucceeds(saveInvoice(be, MAKER, inv, { ...input(inv.invoiceNumber, 11800), notes: 'fixed' }, null));
  });
});

describe('per-invoice decisions', () => {
  it('approve some, return the rest: batch moves on with recalculated route', async () => {
    const [b] = await makeBatch([1_800_000, 600_000]); // ₹24 L → needs L3
    expect(b.requiresL3).toBe(true);
    let { batch, invoicesById } = await batchFor(A1, b.id);
    const [big, small] = batch.invoiceIds;
    await assertSucceeds(approveSelected(backendAs(A1).be, A1, batch, [big], '', invoicesById));
    ({ batch, invoicesById } = await batchFor(A1, b.id));
    expect(batch.levelApproved).toEqual([big]);
    expect(batch.status).toBe('PENDING_L1');
    await assertSucceeds(returnInvoices(backendAs(A1).be, A1, batch, [small], 'GST should be 12%', invoicesById));
    ({ batch } = await batchFor(A1, b.id));
    expect(batch.status).toBe('PENDING_L2'); // everything left was approved
    expect(batch.requiresL3).toBe(false); // ₹18 L now
    expect(batch.levelApproved ?? []).toEqual([]);

    // User 1 can edit, re-validate and resend the returned invoice
    const { be, db } = backendAs(MAKER);
    const ret = (await load(db)).invoicesById.get(small)!;
    await assertSucceeds(validateInvoice(be, MAKER, ret, []));
    const fresh = (await load(db)).invoicesById.get(small)!;
    await assertSucceeds(sendForApproval(be, MAKER, [fresh]));
  });

  it('approving every ticked invoice moves the batch on', async () => {
    const [b] = await makeBatch([10_000, 20_000]);
    const { batch, invoicesById } = await batchFor(A1, b.id);
    await assertSucceeds(approveSelected(backendAs(A1).be, A1, batch, batch.invoiceIds, '', invoicesById));
    expect((await batchFor(A1, b.id)).batch.status).toBe('PENDING_L2');
  });

  it('User 1 cannot edit an invoice still in approval', async () => {
    await makeBatch([11800]);
    const { be, db } = backendAs(MAKER);
    const inv = (await load(db)).invoices[0];
    await assertFails(saveInvoice(be, MAKER, inv, input(inv.invoiceNumber, 11800), null));
  });
});

describe('large batches stay within the rules evaluation limit', () => {
  it('100 invoices: approve some, return some, approve the rest, through L2 and finance', async () => {
    const [b] = await makeBatch(Array.from({ length: 100 }, (_, i) => 10_000 + i));
    let { batch, invoicesById } = await batchFor(A1, b.id);
    expect(batch.invoiceCount).toBe(100);
    await assertSucceeds(approveSelected(backendAs(A1).be, A1, batch, batch.invoiceIds.slice(0, 60), '', invoicesById));
    ({ batch, invoicesById } = await batchFor(A1, b.id));
    await assertSucceeds(returnInvoices(backendAs(A1).be, A1, batch, batch.invoiceIds.slice(80), 'missing PO', invoicesById));
    ({ batch, invoicesById } = await batchFor(A1, b.id));
    expect(batch.invoiceCount).toBe(80);
    await assertSucceeds(approveBatch(backendAs(A1).be, A1, batch, '', invoicesById));
    ({ batch, invoicesById } = await batchFor(A2, b.id));
    expect(batch.status).toBe('PENDING_L2');
    await assertSucceeds(approveBatch(backendAs(A2).be, A2, batch, '', invoicesById));
    ({ batch } = await batchFor(FIN, b.id));
    await assertSucceeds(recordPayments(backendAs(FIN).be, FIN, batch, pay(batch, batch.invoiceIds.slice(0, 50))));
    ({ batch } = await batchFor(FIN, b.id));
    await assertSucceeds(recordPayments(backendAs(FIN).be, FIN, batch, pay(batch, batch.invoiceIds.slice(50))));
    expect((await batchFor(FIN, b.id)).batch.status).toBe('PAID');
  });

  it('L2 can return an invoice and reject a batch', async () => {
    const [b] = await makeBatch([10_000, 20_000]);
    let { batch, invoicesById } = await batchFor(A1, b.id);
    await assertSucceeds(approveBatch(backendAs(A1).be, A1, batch, '', invoicesById));
    ({ batch, invoicesById } = await batchFor(A2, b.id));
    await assertSucceeds(returnInvoices(backendAs(A2).be, A2, batch, [batch.invoiceIds[0]], 'duplicate', invoicesById));
    ({ batch } = await batchFor(A2, b.id));
    await assertSucceeds(rejectBatch(backendAs(A2).be, A2, batch, 'wrong period'));
  });
});

describe('payments per invoice and the finance email', () => {
  async function toFinance(totals: number[]) {
    const [b] = await makeBatch(totals);
    for (const who of [A1, A2]) {
      const { batch, invoicesById } = await batchFor(who, b.id);
      await approveBatch(backendAs(who).be, who, batch, '', invoicesById);
    }
    return b.id;
  }

  it('finance records UTRs in parts, corrects one, and the batch locks once fully paid', async () => {
    const id = await toFinance([10_000, 20_000, 30_000]);
    let { batch } = await batchFor(FIN, id);
    const [a, b, c] = batch.invoiceIds;
    await assertSucceeds(recordPayments(backendAs(FIN).be, FIN, batch, pay(batch, [a])));
    ({ batch } = await batchFor(FIN, id));
    expect(batch.status).toBe('WITH_FINANCE');
    await assertSucceeds(recordPayments(backendAs(FIN).be, FIN, batch, pay(batch, [a], 'HDFC0000000000000001'))); // correction
    ({ batch } = await batchFor(FIN, id));
    expect(batch.payments?.[a].utr).toBe('HDFC0000000000000001');
    await assertSucceeds(recordPayments(backendAs(FIN).be, FIN, batch, pay(batch, [b, c])));
    ({ batch } = await batchFor(FIN, id));
    expect(batch.status).toBe('PAID');
    expect(batch.paidBy).toBe(FIN);
    await assertFails(recordPayments(backendAs(FIN).be, FIN, { ...batch, status: 'WITH_FINANCE' }, pay(batch, [a], 'ICIC0000000000000002')));
  });

  it('only finance can record payments, and only for invoices in the batch', async () => {
    const id = await toFinance([10_000]);
    const { batch } = await batchFor(FIN, id);
    await assertFails(recordPayments(backendAs(A2).be, A2, batch, pay(batch)));
    await assertFails(recordPayments(backendAs(FIN).be, FIN, { ...batch, invoiceIds: [...batch.invoiceIds, 'other'] }, pay(batch, ['other'])));
  });

  it('L2/L3/finance/admin can record the email outcome; others cannot', async () => {
    const id = await toFinance([10_000]);
    const { batch } = await batchFor(A2, id);
    await assertSucceeds(noteFinanceMail(backendAs(A2).be, batch, { status: 'sent', at: 'now', by: A2, parts: 1 }));
    await assertSucceeds(noteFinanceMail(backendAs(FIN).be, batch, { status: 'failed', at: 'now', by: FIN, error: 'x' }));
    await assertFails(noteFinanceMail(backendAs(A1).be, batch, { status: 'sent', at: 'now', by: A1 }));
    await assertFails(noteFinanceMail(backendAs(A2).be, batch, { status: 'sent', at: 'now', by: FIN })); // must be yourself
  });

  it('only an admin can change the email settings; everyone can read them', async () => {
    const s = { to: [`fin@${D}`], cc: [`cfo@${D}`], mailerUrl: 'https://script.google.com/macros/s/abc/exec' };
    await assertSucceeds(saveMailSettings(backendAs(ADMIN).be, s));
    await assertFails(saveMailSettings(backendAs(FIN).be, s));
    await assertSucceeds(backendAs(A1).db.collection('settings').doc('mail').get());
  });
});

describe('super user (all roles)', () => {
  const SU = `super.user@${D}`;

  it('uploads, sends, approves at L1, L2 and L3, records payments and manages settings', async () => {
    await setRole(SU, 'superuser');
    const { be, db } = backendAs(SU);
    const id = await saveInvoice(be, SU, null, input('SU-1', 2_360_000), new File(['%PDF'], 'x.pdf'));
    await assertSucceeds(validateInvoice(be, SU, (await load(db)).invoicesById.get(id)!, []));
    const [b] = await sendForApproval(be, SU, [(await load(db)).invoicesById.get(id)!]);
    expect(b.requiresL3).toBe(true);
    for (const expected of ['PENDING_L2', 'PENDING_L3', 'WITH_FINANCE']) {
      const { batch, invoicesById } = await batchFor(SU, b.id);
      await assertSucceeds(approveBatch(be, SU, batch, '', invoicesById));
      expect((await batchFor(SU, b.id)).batch.status).toBe(expected);
    }
    const { batch } = await batchFor(SU, b.id);
    await assertSucceeds(noteFinanceMail(be, batch, { status: 'sent', at: 'now', by: SU, parts: 1 }));
    await assertSucceeds(recordPayments(be, SU, (await batchFor(SU, b.id)).batch, pay(batch)));
    expect((await batchFor(SU, b.id)).batch.status).toBe('PAID');
    await assertSucceeds(saveMailSettings(be, { to: [`fin@${D}`], cc: [], mailerUrl: '' }));
    await assertSucceeds(addVendor(be, SU, [], 'Super Vendor', ''));
  });

  it('can return and reject like any approver', async () => {
    await setRole(SU, 'superuser');
    const [b] = await makeBatch([10_000, 20_000]);
    let { batch, invoicesById } = await batchFor(SU, b.id);
    await assertSucceeds(returnInvoices(backendAs(SU).be, SU, batch, [batch.invoiceIds[0]], 'wrong', invoicesById));
    ({ batch } = await batchFor(SU, b.id));
    await assertSucceeds(rejectBatch(backendAs(SU).be, SU, batch, 'redo'));
  });
});

describe('user management', () => {
  it('admin can make another user a super user, and change their own role to super user', async () => {
    const { be } = backendAs(ADMIN);
    await assertSucceeds(saveUser(be, { email: MAKER, name: 'Tamjeed', role: 'superuser', active: true }));
    await assertSucceeds(saveUser(be, { email: `new.person@${D}`, name: 'New', role: 'superuser', active: true }));
    await assertSucceeds(saveUser(be, { email: ADMIN, name: 'Asif', role: 'superuser', active: true }));
  });
  it('a super user can manage users; an admin cannot demote itself to a non-admin role', async () => {
    await setRole(MAKER, 'superuser');
    await assertSucceeds(saveUser(backendAs(MAKER).be, { email: A1, name: 'A1', role: 'approver2', active: true }));
    await assertFails(saveUser(backendAs(ADMIN).be, { email: ADMIN, name: 'Asif', role: 'maker', active: true }));
  });
});

describe('vendors', () => {
  it('maker can add a vendor, approver cannot', async () => {
    await assertSucceeds(addVendor(backendAs(MAKER).be, MAKER, [], 'Kalyan Movers', '27ABCDE1234F1Z5'));
    await assertFails(addVendor(backendAs(A1).be, A1, [], 'Other Movers', ''));
  });
});
