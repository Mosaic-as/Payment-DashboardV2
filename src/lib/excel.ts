import * as XLSX from 'xlsx';
import type { Batch, Invoice } from '../types';
import { STAGE_LABELS } from '../types';
import { formatDateTime, formatMonth } from './format';
import { routeLabel, stageOf } from './workflow';

type Row = Record<string, string | number>;

function approvalCols(b: Batch, level: 1 | 2 | 3): Row {
  const a = [...b.approvals].reverse().find((x) => x.level === level);
  return {
    [`L${level} Decision`]: a ? a.decision : level === 3 && !b.requiresL3 ? 'Not required' : 'Pending',
    [`L${level} By`]: a?.by ?? '',
    [`L${level} At`]: a ? formatDateTime(a.at) : '',
    [`L${level} Comment`]: a?.comment ?? '',
  };
}

const invoiceCols = (i: Invoice): Row => ({
  'Expense Category': i.category,
  'Service Month': formatMonth(i.serviceMonth),
  'Vendor Name': i.vendorName,
  'Vendor GSTIN': i.vendorGstin,
  'Invoice No': i.invoiceNumber,
  'Invoice Date': i.invoiceDate,
  'Taxable Amount': i.taxableAmount,
  'GST Amount': i.gstAmount,
  'Total Amount': i.totalAmount,
  Notes: i.notes,
  'Uploaded By': i.createdBy,
  'Validated By': i.validatedBy ?? '',
  'Validated At': formatDateTime(i.validatedAt),
});

/** One row per batch with its approval trail. */
export function batchSummaryRows(batches: Batch[]): Row[] {
  return batches.map((b) => ({
    'Batch No': b.batchNo,
    'Expense Category': b.category,
    'No. of Invoices': b.invoiceCount,
    'Taxable Total': b.taxableTotal,
    'GST Total': b.gstTotal,
    'Batch Total': b.totalAmount,
    'Approval Route': routeLabel(b.requiresL3),
    Status: STAGE_LABELS[b.status],
    'Sent By': b.createdBy,
    'Sent At': formatDateTime(b.createdAt),
    ...approvalCols(b, 1),
    ...approvalCols(b, 2),
    ...approvalCols(b, 3),
    'Payment Ref / UTR': b.paymentRef ?? '',
    'Paid At': formatDateTime(b.paidAt),
  }));
}

/** One row per invoice sent for payment (i.e. inside a batch). */
export function invoiceDetailRows(batches: Batch[], invoicesById: Map<string, Invoice>): Row[] {
  return batches.flatMap((b) =>
    b.invoiceIds
      .map((id) => invoicesById.get(id))
      .filter((i): i is Invoice => !!i)
      .map((i) => ({
        'Batch No': b.batchNo,
        ...invoiceCols(i),
        'Batch Status': STAGE_LABELS[b.status],
        'Payment Ref / UTR': b.paymentRef ?? '',
        'Invoice Copy': i.fileUrl || i.fileName,
      })),
  );
}

/** Every uploaded invoice with its current stage. */
export function allInvoiceRows(invoices: Invoice[], batchesById: Map<string, Batch>): Row[] {
  return invoices.map((i) => ({
    Status: STAGE_LABELS[stageOf(i, batchesById)],
    'Batch No': (i.batchId && batchesById.get(i.batchId)?.batchNo) || '',
    ...invoiceCols(i),
    'Uploaded At': formatDateTime(i.createdAt),
    'Invoice Copy': i.fileUrl || i.fileName,
  }));
}

/** Header row + values, for writing to Google Sheets. */
export function toTable(rows: Row[]): (string | number)[][] {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]);
  return [keys, ...rows.map((r) => keys.map((k) => r[k] ?? ''))];
}

function autoWidth(ws: XLSX.WorkSheet, rows: Row[]) {
  if (!rows.length) return;
  ws['!cols'] = Object.keys(rows[0]).map((k) => ({
    wch: Math.min(50, Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)) + 2),
  }));
}

function sheet(rows: Row[], amountCols: string[]) {
  const ws = XLSX.utils.json_to_sheet(rows);
  autoWidth(ws, rows);
  const keys = rows.length ? Object.keys(rows[0]) : [];
  for (const col of amountCols) {
    const c = keys.indexOf(col);
    if (c < 0) continue;
    for (let r = 1; r <= rows.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell) cell.z = '#,##0.00';
    }
  }
  return ws;
}

/** Builds the finance workbook: a batch summary sheet plus one row per invoice. */
export function buildPaymentWorkbook(batches: Batch[], invoicesById: Map<string, Invoice>): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(batchSummaryRows(batches), ['Taxable Total', 'GST Total', 'Batch Total']), 'Batch Summary');
  XLSX.utils.book_append_sheet(wb, sheet(invoiceDetailRows(batches, invoicesById), ['Taxable Amount', 'GST Amount', 'Total Amount']), 'Invoice Details');
  return wb;
}

export function downloadPaymentWorkbook(batches: Batch[], invoicesById: Map<string, Invoice>, fileName: string) {
  XLSX.writeFile(buildPaymentWorkbook(batches, invoicesById), fileName);
}

export function paymentWorkbookBase64(batches: Batch[], invoicesById: Map<string, Invoice>): string {
  return XLSX.write(buildPaymentWorkbook(batches, invoicesById), { type: 'base64', bookType: 'xlsx' });
}
