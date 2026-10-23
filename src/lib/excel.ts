import * as XLSX from 'xlsx';
import type { Batch, Invoice } from '../types';
import { STAGE_LABELS } from '../types';
import { formatDateTime } from './format';
import { routeLabel } from './workflow';

function approvalCols(b: Batch, level: 1 | 2 | 3) {
  const a = [...b.approvals].reverse().find((x) => x.level === level);
  return {
    [`L${level} Decision`]: a ? a.decision : level === 3 && !b.requiresL3 ? 'Not required' : 'Pending',
    [`L${level} By`]: a?.by ?? '',
    [`L${level} At`]: a ? formatDateTime(a.at) : '',
    [`L${level} Comment`]: a?.comment ?? '',
  };
}

function autoWidth(ws: XLSX.WorkSheet, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  ws['!cols'] = Object.keys(rows[0]).map((k) => ({
    wch: Math.min(50, Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)) + 2),
  }));
}

/** Builds the finance workbook: a batch summary sheet plus one row per invoice. */
export function buildPaymentWorkbook(batches: Batch[], invoicesById: Map<string, Invoice>): XLSX.WorkBook {
  const summary = batches.map((b) => ({
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

  const detail = batches.flatMap((b) =>
    b.invoiceIds
      .map((id) => invoicesById.get(id))
      .filter((i): i is Invoice => !!i)
      .map((i) => ({
        'Batch No': b.batchNo,
        'Expense Category': i.category,
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
        'Batch Status': STAGE_LABELS[b.status],
        'Invoice Copy': i.fileName,
      })),
  );

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(summary);
  const ws2 = XLSX.utils.json_to_sheet(detail);
  autoWidth(ws1, summary);
  autoWidth(ws2, detail);
  for (const [ws, rows, amountCols] of [
    [ws1, summary, ['Taxable Total', 'GST Total', 'Batch Total']],
    [ws2, detail, ['Taxable Amount', 'GST Amount', 'Total Amount']],
  ] as const) {
    const keys = rows.length ? Object.keys(rows[0]) : [];
    for (const col of amountCols) {
      const c = keys.indexOf(col);
      if (c < 0) continue;
      for (let r = 1; r <= rows.length; r++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell) cell.z = '#,##0.00';
      }
    }
  }
  XLSX.utils.book_append_sheet(wb, ws1, 'Batch Summary');
  XLSX.utils.book_append_sheet(wb, ws2, 'Invoice Details');
  return wb;
}

export function downloadPaymentWorkbook(batches: Batch[], invoicesById: Map<string, Invoice>, fileName: string) {
  XLSX.writeFile(buildPaymentWorkbook(batches, invoicesById), fileName);
}

export function paymentWorkbookBase64(batches: Batch[], invoicesById: Map<string, Invoice>): string {
  return XLSX.write(buildPaymentWorkbook(batches, invoicesById), { type: 'base64', bookType: 'xlsx' });
}
