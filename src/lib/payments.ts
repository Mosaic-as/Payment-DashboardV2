import * as XLSX from 'xlsx';
import type { Batch, Invoice, Payment } from '../types';
import { formatINR, round2, todayIso } from './format';

/** UTRs: 12 (IMPS/UPI), 16 (NEFT) or 22 (RTGS) letters and digits. */
export const UTR_RE = /^[A-Z0-9]{12,22}$/;

export type PaymentInput = Pick<Payment, 'utr' | 'date' | 'tds' | 'paid'>;
export interface PaymentEntry extends PaymentInput { batchId: string; invoiceId: string }
export interface RowIssue { row: number; message: string }

/** Checks one payment against its invoice. Returns errors (block) and warnings. */
export function checkPayment(p: PaymentInput, inv: Invoice): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!UTR_RE.test(p.utr)) errors.push(`UTR "${p.utr}" should be 12–22 letters and digits (IMPS/UPI 12, NEFT 16, RTGS 22).`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) errors.push('Payment date is missing or not a valid date.');
  else if (p.date > todayIso()) errors.push('Payment date cannot be in the future.');
  else if (p.date < inv.invoiceDate) warnings.push('Payment date is before the invoice date.');
  if (!Number.isFinite(p.tds) || p.tds < 0) errors.push('TDS must be zero or more.');
  if (!Number.isFinite(p.paid) || p.paid <= 0) errors.push('Amount paid must be more than zero.');
  if (Number.isFinite(p.tds) && Number.isFinite(p.paid)) {
    const gap = round2(inv.totalAmount - p.tds - p.paid);
    if (gap < -1) errors.push(`Amount paid + TDS (${formatINR(p.paid + p.tds)}) is more than the invoice total (${formatINR(inv.totalAmount)}).`);
    else if (gap > 1) warnings.push(`Amount paid + TDS is ${formatINR(gap)} less than the invoice total (short payment / other deduction?).`);
  }
  return { errors, warnings };
}

// ── Excel template ───────────────────────────────────────────────────────────
const COLS = {
  ref: 'Ref (do not edit)',
  batch: 'Batch No',
  category: 'Expense Category',
  vendor: 'Vendor',
  invoiceNo: 'Invoice No',
  invoiceDate: 'Invoice Date',
  total: 'Invoice Total',
  utr: 'UTR',
  date: 'Payment Date (DD-MM-YYYY)',
  tds: 'TDS Amount',
  paid: 'Amount Paid (blank = Total − TDS)',
} as const;

const unpaid = (b: Batch) => b.invoiceIds.filter((id) => !b.payments?.[id]);

/** Template listing every unpaid invoice in approved batches. */
export function buildUtrTemplate(batches: Batch[], invoicesById: Map<string, Invoice>): XLSX.WorkBook {
  const rows = batches
    .filter((b) => b.status === 'WITH_FINANCE')
    .flatMap((b) => unpaid(b).map((id) => invoicesById.get(id)).filter((i): i is Invoice => !!i).map((i) => ({
      [COLS.ref]: i.id,
      [COLS.batch]: b.batchNo,
      [COLS.category]: b.category,
      [COLS.vendor]: i.vendorName,
      [COLS.invoiceNo]: i.invoiceNumber,
      [COLS.invoiceDate]: i.invoiceDate.split('-').reverse().join('-'),
      [COLS.total]: i.totalAmount,
      [COLS.utr]: '',
      [COLS.date]: '',
      [COLS.tds]: '',
      [COLS.paid]: '',
    })));
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [Object.fromEntries(Object.values(COLS).map((c) => [c, '']))]);
  ws['!cols'] = Object.values(COLS).map((c, i) => ({ wch: Math.max(c.length + 2, i === 3 ? 34 : 14), hidden: i === 0 }));
  const help = XLSX.utils.aoa_to_sheet([
    ['How to fill this template'],
    ['1. Enter the UTR and payment date for each invoice you have paid. Leave rows you have not paid empty.'],
    ['2. TDS Amount: tax deducted at source (0 if none). Amount Paid: what was transferred; leave blank to use Invoice Total − TDS.'],
    ['3. Several invoices of the same vendor paid in one transfer can share the same UTR.'],
    ['4. Do not change or delete the hidden "Ref" column — it links each row to its invoice.'],
    ['5. Upload the file in the dashboard: Payment queue → Upload UTRs. You will see a preview before anything is saved.'],
  ]);
  help['!cols'] = [{ wch: 120 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'UTR Upload');
  XLSX.utils.book_append_sheet(wb, help, 'Instructions');
  return wb;
}

export function downloadUtrTemplate(batches: Batch[], invoicesById: Map<string, Invoice>) {
  XLSX.writeFile(buildUtrTemplate(batches, invoicesById), `UTR_Template_${todayIso()}.xlsx`);
}

// ── Upload parsing ───────────────────────────────────────────────────────────
function toIsoDate(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/); // DD-MM-YYYY, Indian order
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const d = new Date(iso + 'T00:00:00');
    return d.getDate() === Number(m[1]) ? iso : '';
  }
  return '';
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/[₹,\s]/g, '');
  return s === '' ? NaN : Number(s);
}

const cell = (r: Record<string, unknown>, ...names: string[]) => {
  const key = Object.keys(r).find((k) => names.some((n) => k.trim().toLowerCase().startsWith(n.toLowerCase())));
  return key === undefined ? undefined : r[key];
};

/** Reads an uploaded workbook into plain rows (first sheet). */
export function readUploadedRows(data: ArrayBuffer): Record<string, unknown>[] {
  const wb = XLSX.read(data, { type: 'array', cellDates: true });
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' });
}

/**
 * Matches uploaded rows to unpaid invoices in approved batches and checks them.
 * Rows with no UTR are ignored, so a partly filled template is fine.
 */
export function parseUtrRows(rows: Record<string, unknown>[], batches: Batch[], invoicesById: Map<string, Invoice>) {
  const ready: (PaymentEntry & { invoice: Invoice; batchNo: string; row: number })[] = [];
  const problems: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const batchOf = new Map<string, Batch>();
  for (const b of batches) for (const id of b.invoiceIds) batchOf.set(id, b);
  const seen = new Set<string>();
  // UTR → vendor, from payments already recorded, to flag the same UTR on different vendors.
  const utrVendor = new Map<string, string>();
  for (const b of batches) for (const [id, p] of Object.entries(b.payments ?? {})) {
    const v = invoicesById.get(id)?.vendorName;
    if (v) utrVendor.set(p.utr, v);
  }

  rows.forEach((r, i) => {
    const row = i + 2; // Excel row number (row 1 is the header)
    const utr = String(cell(r, 'utr') ?? '').trim().toUpperCase().replace(/\s+/g, '');
    if (!utr) return;
    const ref = String(cell(r, 'ref') ?? '').trim();
    let inv = ref ? invoicesById.get(ref) : undefined;
    if (!inv) {
      // Fallback when the Ref column was lost: batch no. + invoice no.
      const bn = String(cell(r, 'batch') ?? '').trim();
      const no = String(cell(r, 'invoice no') ?? '').trim().toLowerCase();
      const b = batches.find((x) => x.batchNo === bn);
      inv = b?.invoiceIds.map((id) => invoicesById.get(id)).find((x) => x?.invoiceNumber.trim().toLowerCase() === no);
    }
    if (!inv) return void problems.push({ row, message: 'Invoice not found (Ref / Batch No + Invoice No do not match any invoice).' });
    const b = batchOf.get(inv.id);
    const label = `${inv.invoiceNumber} (${inv.vendorName})`;
    if (!b || b.status !== 'WITH_FINANCE') {
      return void problems.push({ row, message: `${label} is not awaiting payment${b ? ` (batch is ${b.status === 'PAID' ? 'already paid' : 'still in approval'})` : ''}.` });
    }
    const existing = b.payments?.[inv.id];
    if (existing) {
      if (existing.utr === utr) return; // same as recorded — nothing to do
      return void problems.push({ row, message: `${label} already has UTR ${existing.utr}. To correct it, edit it on the batch screen.` });
    }
    if (seen.has(inv.id)) return void problems.push({ row, message: `${label} appears more than once in the file.` });
    seen.add(inv.id);

    const tdsCell = cell(r, 'tds');
    const tds = tdsCell === '' || tdsCell === undefined ? 0 : toNumber(tdsCell);
    const paidCell = cell(r, 'amount paid');
    const paid = paidCell === '' || paidCell === undefined ? round2(inv.totalAmount - (Number.isFinite(tds) ? tds : 0)) : toNumber(paidCell);
    const p: PaymentInput = { utr, date: toIsoDate(cell(r, 'payment date')), tds: round2(tds), paid: round2(paid) };
    const { errors, warnings: w } = checkPayment(p, inv);
    if (errors.length) return void problems.push({ row, message: `${label}: ${errors.join(' ')}` });
    w.forEach((message) => warnings.push({ row, message: `${label}: ${message}` }));
    const other = utrVendor.get(utr);
    if (other && other !== inv.vendorName) warnings.push({ row, message: `${label}: UTR ${utr} is also used for ${other} (a different vendor).` });
    utrVendor.set(utr, inv.vendorName);
    ready.push({ ...p, batchId: b.id, invoiceId: inv.id, invoice: inv, batchNo: b.batchNo, row });
  });
  return { ready, problems, warnings };
}
