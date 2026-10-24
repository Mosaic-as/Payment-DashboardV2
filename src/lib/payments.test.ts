import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Batch, Invoice } from '../types';
import { buildUtrTemplate, parseUtrRows, readUploadedRows } from './payments';
import { financeMailHtml } from './financeMail';

const inv = (id: string, over: Partial<Invoice> = {}): Invoice => ({
  id, vendorName: 'Delhivery Limited', vendorGstin: '', invoiceNumber: `INV-${id}`, invoiceDate: '2026-09-15',
  taxableAmount: 100000, gstAmount: 18000, totalAmount: 118000, category: 'Warehouse - Rent', serviceMonth: '2026-09', notes: '',
  dupKey: '', filePath: 'f', fileName: 'f.pdf', fileUrl: '', status: 'VALIDATED', batchId: 'b1',
  createdBy: 'm', createdAt: '', updatedAt: '', validatedBy: 'm', validatedAt: '', history: [], ...over,
});
const batch = (ids: string[], over: Partial<Batch> = {}): Batch => ({
  id: 'b1', batchNo: 'B261024-RENT-AB12', category: 'Warehouse - Rent', invoiceIds: ids, invoiceCount: ids.length,
  taxableTotal: 0, gstTotal: 0, totalAmount: 0, requiresL3: false, status: 'WITH_FINANCE', approvals: [],
  createdBy: 'm', createdAt: '', updatedAt: '', paymentRef: null, paidAt: null, paidBy: null, ...over,
});
const row = (ref: string, utr: string, date: unknown, tds: unknown = '', paid: unknown = '') =>
  ({ 'Ref (do not edit)': ref, 'Batch No': 'B261024-RENT-AB12', 'Invoice No': `INV-${ref}`, UTR: utr, 'Payment Date (DD-MM-YYYY)': date, 'TDS Amount': tds, 'Amount Paid (blank = Total − TDS)': paid });

describe('UTR upload', () => {
  const invoices = [inv('a'), inv('b'), inv('c', { vendorName: 'Om Packaging' })];
  const byId = new Map(invoices.map((i) => [i.id, i]));

  it('accepts Indian date formats, defaults Amount paid to Total − TDS, ignores rows without a UTR', () => {
    const r = parseUtrRows([
      row('a', 'sbin426012345678', '20-10-2026', 2000),
      row('b', 'SBIN426012345678', new Date(2026, 9, 21)),
      row('c', '', ''),
    ], [batch(['a', 'b', 'c'])], byId);
    expect(r.problems).toEqual([]);
    expect(r.ready.map((x) => [x.invoiceId, x.utr, x.date, x.tds, x.paid])).toEqual([
      ['a', 'SBIN426012345678', '2026-10-20', 2000, 116000],
      ['b', 'SBIN426012345678', '2026-10-21', 0, 118000],
    ]);
  });

  it('flags bad UTRs, future dates, overpayment, duplicates, unknown and already-paid invoices', () => {
    const b = batch(['a', 'b', 'c'], { payments: { c: { utr: 'HDFC0000000000000001', date: '2026-10-01', tds: 0, paid: 118000, by: 'f', at: '' } } });
    const r = parseUtrRows([
      row('a', 'ABC', '20-10-2026'),
      row('b', 'SBIN426012345678', '01-01-2999'),
      row('b', 'SBIN426012345678', '20-10-2026', 0, 200000),
      row('zzz', 'SBIN426012345678', '20-10-2026'),
      row('c', 'ICIC0000000000000002', '20-10-2026'),
    ], [b], byId);
    expect(r.ready).toEqual([]);
    const msgs = r.problems.map((p) => `${p.row}: ${p.message}`).join('\n');
    expect(msgs).toMatch(/^2: .*12–22 letters/m);
    expect(msgs).toMatch(/^3: .*future/m);
    expect(msgs).toMatch(/^4: .*more than once/m);
    expect(msgs).toMatch(/^5: Invoice not found/m);
    expect(msgs).toMatch(/^6: .*already has UTR HDFC0000000000000001/m);
  });

  it('blocks paying more than the invoice total', () => {
    const r = parseUtrRows([row('a', 'SBIN426012345678', '20-10-2026', 5000, 118000)], [batch(['a'])], byId);
    expect(r.problems[0].message).toMatch(/more than the invoice total/);
  });

  it('warns on short payment and on one UTR used for different vendors', () => {
    const r = parseUtrRows([
      row('a', 'SBIN426012345678', '20-10-2026', 0, 100000),
      row('c', 'SBIN426012345678', '20-10-2026'),
    ], [batch(['a', 'b', 'c'])], byId);
    expect(r.ready).toHaveLength(2);
    expect(r.warnings.map((w) => w.message).join('\n')).toMatch(/less than the invoice total[\s\S]*different vendor/);
  });

  it('round-trips through the downloadable template', () => {
    const wb = buildUtrTemplate([batch(['a', 'b'])], byId);
    const ws = wb.Sheets['UTR Upload'];
    XLSX.utils.sheet_add_aoa(ws, [['SBIN426012345678', '20-10-2026', 1000]], { origin: 'H2' });
    const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const r = parseUtrRows(readUploadedRows(data), [batch(['a', 'b'])], byId);
    expect(r.problems).toEqual([]);
    expect(r.ready).toHaveLength(1);
    expect(r.ready[0]).toMatchObject({ invoiceId: 'a', tds: 1000, paid: 117000, date: '2026-10-20' });
  });
});

describe('finance email body', () => {
  it('has the summary, approval trail, every invoice and escapes text', () => {
    const b = batch(['a'], {
      totalAmount: 118000, taxableTotal: 100000, gstTotal: 18000, createdAt: '2026-10-24T05:00:00Z',
      approvals: [{ level: 1, by: 'a1', at: '2026-10-24T06:00:00Z', decision: 'APPROVED', comment: 'ok <fine>' }],
    });
    const html = financeMailHtml(b, [inv('a', { vendorName: 'A & B <Traders>' })], (e) => e.toUpperCase(), 'https://x/');
    expect(html).toContain('B261024-RENT-AB12');
    expect(html).toContain('A &amp; B &lt;Traders&gt;');
    expect(html).toContain('“ok &lt;fine&gt;”');
    expect(html).toMatch(/Not required/);
    expect(html).toContain('₹1,18,000.00');
    expect(html).not.toContain('drive.google.com');
  });
});
