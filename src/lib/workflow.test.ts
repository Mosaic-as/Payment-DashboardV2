import { describe, expect, it } from 'vitest';
import type { Batch, Invoice, WriteOp } from '../types';
import type { Backend } from '../data/backend';
import { returnInvoices } from '../data/actions';
import { validateInvoice, makeDupKey } from './validation';
import { makeBatchNo, nextStatusOnApprove, planBatches, returnInfo, requiresL3, stageOf, verifyBatchTotal } from './workflow';
import { allInvoiceRows, buildPaymentWorkbook, toTable } from './excel';
import { driveFileName, monthFolderName } from './format';
import * as XLSX from 'xlsx';
import { DEFAULT_VENDORS, vendorKey } from '../vendors';

const inv = (over: Partial<Invoice> = {}): Invoice => ({
  id: Math.random().toString(36).slice(2),
  vendorName: 'Acme Pvt Ltd', vendorGstin: '27ABCDE1234F1Z5', invoiceNumber: 'INV-1', invoiceDate: '2026-10-01',
  taxableAmount: 100000, gstAmount: 18000, totalAmount: 118000, category: 'Warehouse - Rent', serviceMonth: '2026-09', notes: '',
  dupKey: '', filePath: 'x', fileName: 'x.pdf', fileUrl: 'https://drive.google.com/file/d/x/view', status: 'VALIDATED', batchId: null,
  createdBy: 'm@x.com', createdAt: '', updatedAt: '', validatedBy: 'm@x.com', validatedAt: '', history: [],
  ...over,
});

describe('L3 routing threshold (₹20 lakh)', () => {
  it('requires L3 only strictly above 20,00,000', () => {
    expect(requiresL3(2_000_000)).toBe(false);
    expect(requiresL3(2_000_000.01)).toBe(true);
    expect(requiresL3(1_999_999)).toBe(false);
  });

  it('routes L2 approval to L3 or straight to finance', () => {
    expect(nextStatusOnApprove({ status: 'PENDING_L1', requiresL3: false })).toBe('PENDING_L2');
    expect(nextStatusOnApprove({ status: 'PENDING_L2', requiresL3: false })).toBe('WITH_FINANCE');
    expect(nextStatusOnApprove({ status: 'PENDING_L2', requiresL3: true })).toBe('PENDING_L3');
    expect(nextStatusOnApprove({ status: 'PENDING_L3', requiresL3: true })).toBe('WITH_FINANCE');
    expect(() => nextStatusOnApprove({ status: 'PAID', requiresL3: true })).toThrow();
  });
});

describe('planBatches', () => {
  it('groups by expense category and decides routing on the batch total', () => {
    const plan = planBatches([
      inv({ category: 'Rent', totalAmount: 1_500_000, taxableAmount: 1_271_186.44, gstAmount: 228_813.56 }),
      inv({ category: 'Rent', totalAmount: 600_000, taxableAmount: 508_474.58, gstAmount: 91_525.42 }),
      inv({ category: 'Travel', totalAmount: 50_000, taxableAmount: 47_619.05, gstAmount: 2_380.95 }),
    ]);
    expect(plan.map((p) => p.category)).toEqual(['Rent', 'Travel']);
    expect(plan[0].totalAmount).toBe(2_100_000);
    expect(plan[0].requiresL3).toBe(true); // individual invoices < 20L, batch > 20L
    expect(plan[1].requiresL3).toBe(false);
  });
});

describe('stageOf / verifyBatchTotal', () => {
  const b = (over: Partial<Batch>): Batch => ({
    id: 'b1', batchNo: 'B', category: 'Rent', invoiceIds: [], invoiceCount: 0, taxableTotal: 0, gstTotal: 0, totalAmount: 0,
    requiresL3: false, status: 'PENDING_L1', approvals: [], createdBy: '', createdAt: '', updatedAt: '', paymentRef: null, paidAt: null, paidBy: null,
    ...over,
  });
  it('shows a rejected batch as Returned on its invoices', () => {
    const i = inv({ batchId: 'b1' });
    expect(stageOf(i, new Map([['b1', b({ status: 'REJECTED', invoiceIds: [i.id] })]]))).toBe('RETURNED');
    expect(stageOf(i, new Map([['b1', b({ status: 'PENDING_L2', invoiceIds: [i.id] })]]))).toBe('PENDING_L2');
    expect(stageOf(inv(), new Map())).toBe('VALIDATED');
  });
  it('detects a tampered batch total', () => {
    const i = inv({ id: 'i1', batchId: 'b1' });
    expect(verifyBatchTotal(b({ invoiceIds: ['i1'], totalAmount: 118000 }), [i]).ok).toBe(true);
    expect(verifyBatchTotal(b({ invoiceIds: ['i1'], totalAmount: 1000 }), [i]).ok).toBe(false);
    expect(verifyBatchTotal(b({ invoiceIds: ['i1', 'i2'], totalAmount: 118000 }), [i]).ok).toBe(false);
  });
  it('builds the finance Excel with summary and invoice sheets', () => {
    const i = inv({ id: 'i1', batchId: 'b1' });
    const wb = buildPaymentWorkbook([b({ invoiceIds: ['i1'], invoiceCount: 1, totalAmount: 118000 })], new Map([['i1', i]]));
    expect(wb.SheetNames).toEqual(['Batch Summary', 'Invoice Details']);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Invoice Details']);
    expect(rows[0]['Invoice No']).toBe('INV-1');
    expect(rows[0]['Total Amount']).toBe(118000);
  });
});

describe('validateInvoice', () => {
  const base = { ...inv(), hasAttachment: true };
  it('passes a correct invoice', () => {
    expect(validateInvoice(base, []).errors).toEqual([]);
  });
  it('rejects totals that do not add up, beyond ₹1 round-off', () => {
    expect(validateInvoice({ ...base, totalAmount: 118500 }, []).errors.join()).toMatch(/does not match/);
    const r = validateInvoice({ ...base, totalAmount: 118000.5 }, []);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toMatch(/Round-off/);
  });
  it('flags non-standard GST rates, bad GSTIN, duplicates and missing copy', () => {
    expect(validateInvoice({ ...base, gstAmount: 15000, totalAmount: 115000 }, []).warnings.join()).toMatch(/not a standard slab/);
    expect(validateInvoice({ ...base, vendorGstin: 'BAD' }, []).errors.join()).toMatch(/GSTIN/);
    const other = { id: 'other', dupKey: makeDupKey(' ACME  pvt ltd', 'inv-1 '), invoiceNumber: 'INV-1' };
    expect(validateInvoice(base, [other]).errors.join()).toMatch(/Duplicate/);
    expect(validateInvoice({ ...base, hasAttachment: false }, []).errors.join()).toMatch(/Attach/);
  });
  it('rejects future dates', () => {
    expect(validateInvoice({ ...base, invoiceDate: '2999-01-01' }, []).errors.join()).toMatch(/future/);
  });
});

describe('Google Drive and Sheet layout', () => {
  it('names month folders so they sort chronologically', () => {
    expect(monthFolderName('2026-10')).toBe('2026-10 (October 2026)');
    expect(monthFolderName('2027-01')).toBe('2027-01 (January 2027)');
  });
  it('names Drive files by month, vendor and invoice number', () => {
    expect(driveFileName('2026-10', 'Acme / Sons: Ltd', 'INV\\7', 'scan.final.PDF')).toBe('2026-10 - Acme - Sons- Ltd - INV-7.PDF');
    expect(driveFileName('2026-10', 'Acme', 'A1', 'noext')).toBe('2026-10 - Acme - A1');
  });
  it('requires a valid service month', () => {
    const base = { ...inv(), hasAttachment: true };
    expect(validateInvoice({ ...base, serviceMonth: '' }, []).errors.join()).toMatch(/Service month is required/);
    expect(validateInvoice({ ...base, serviceMonth: '2026-13' }, []).errors.join()).toMatch(/not a valid month/);
    expect(validateInvoice({ ...base, serviceMonth: '2999-01' }, []).warnings.join()).toMatch(/future/);
  });
  it('lists every uploaded invoice with status, service month and Drive link', () => {
    const table = toTable(allInvoiceRows([inv({ status: 'DRAFT' })], new Map()));
    const row = Object.fromEntries(table[0].map((h, i) => [h, table[1][i]]));
    expect(row.Status).toBe('Draft');
    expect(String(row['Service Month'])).toMatch(/^Sep\w* 2026$/);
    expect(row['Invoice Copy']).toBe('https://drive.google.com/file/d/x/view');
  });
});

describe('categories and vendors', () => {
  it('builds batch numbers from the part after "Warehouse -"', () => {
    expect(makeBatchNo('Warehouse - Electricity', new Date(2026, 9, 24))).toMatch(/^B261024-ELEC-[A-Z0-9]{4}$/);
    expect(makeBatchNo('Warehouse - Loading/Unloading', new Date(2026, 9, 24))).toMatch(/^B261024-LOAD-/);
  });
  it('treats differently written vendor names as the same vendor', () => {
    expect(vendorKey('M/S Liberal')).toBe(vendorKey('m/s  liberal.'));
    expect(new Set(DEFAULT_VENDORS.map(vendorKey)).size).toBe(DEFAULT_VENDORS.length);
  });
});

describe('returning single invoices from a batch', () => {
  const batchOf = (invs: Invoice[], over: Partial<Batch> = {}): Batch => ({
    id: 'b1', batchNo: 'B1', category: 'Warehouse - Rent', invoiceIds: invs.map((i) => i.id), invoiceCount: invs.length,
    taxableTotal: 0, gstTotal: 0, totalAmount: invs.reduce((s, i) => s + i.totalAmount, 0), requiresL3: true,
    status: 'PENDING_L2', approvals: [], createdBy: 'm@x.com', createdAt: '', updatedAt: '', paymentRef: null, paidAt: null, paidBy: null,
    ...over,
  });
  const big = inv({ id: 'big', batchId: 'b1', taxableAmount: 1_525_423.73, gstAmount: 274_576.27, totalAmount: 1_800_000 });
  const small = inv({ id: 'small', batchId: 'b1', taxableAmount: 508_474.58, gstAmount: 91_525.42, totalAmount: 600_000 });

  it('recalculates totals and drops the L3 step when the batch falls to ₹20 lakh or less', async () => {
    const ops: WriteOp[] = [];
    const be = { commit: async (o: WriteOp[]) => void ops.push(...o) } as unknown as Backend;
    const b = batchOf([big, small]);
    await returnInvoices(be, 'a2@x.com', b, ['small'], 'Wrong GST rate', new Map([[big.id, big], [small.id, small]]));
    const d = ops[0].data as Partial<Batch>;
    expect(d.invoiceIds).toEqual(['big']);
    expect(d.invoiceCount).toBe(1);
    expect(d.totalAmount).toBe(1_800_000);
    expect(d.requiresL3).toBe(false);
    expect(d.returned?.[0]).toMatchObject({ invoiceId: 'small', level: 2, by: 'a2@x.com', reason: 'Wrong GST rate' });
    expect(d.status).toBeUndefined(); // stays at the same level
  });

  it('refuses to return every invoice (that is a batch rejection) or without a reason', async () => {
    const be = { commit: async () => {} } as unknown as Backend;
    const m = new Map([[big.id, big], [small.id, small]]);
    await expect(returnInvoices(be, 'a', batchOf([big, small]), ['big', 'small'], 'x', m)).rejects.toThrow(/Reject/);
    await expect(returnInvoices(be, 'a', batchOf([big, small]), ['small'], '  ', m)).rejects.toThrow(/reason/);
  });

  it('shows a taken-out invoice as Returned with the approver reason', () => {
    const b = batchOf([big], { returned: [{ invoiceId: 'small', invoiceNumber: 'X', vendorName: 'V', totalAmount: 1, level: 2, by: 'a2@x.com', at: '', reason: 'Wrong GST rate' }] });
    const map = new Map([['b1', b]]);
    expect(stageOf(small, map)).toBe('RETURNED');
    expect(stageOf(big, map)).toBe('PENDING_L2');
    expect(returnInfo(small, map)?.reason).toBe('Wrong GST rate');
    expect(returnInfo(big, map)).toBeNull();
  });
});
