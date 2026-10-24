import type { Batch, Invoice } from '../types';
import { formatDate, formatDateTime, formatINR, formatLakh, formatMonth } from './format';
import { routeLabel } from './workflow';
import { config } from '../config';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const TD = 'padding:6px 10px;border:1px solid #d9dee7;font-size:13px;';
const TH = TD + 'background:#f1f4f9;text-align:left;font-weight:600;';
const NUM = 'text-align:right;white-space:nowrap;';


/**
 * Body of the email to the finance team. Attachments (Excel + invoice PDFs)
 * are added by the mailer; nothing here changes if some go in a follow-up email.
 */
export function financeMailHtml(b: Batch, invoices: Invoice[], nameOf: (e: string) => string, dashboardUrl: string): string {
  const step = (level: 1 | 2 | 3) => {
    if (level === 3 && !b.requiresL3) return `Not required (batch ≤ ${formatLakh(config.l3Threshold)})`;
    const a = [...b.approvals].reverse().find((x) => x.level === level && x.decision === 'APPROVED');
    return a ? `${esc(nameOf(a.by))} on ${formatDateTime(a.at)}${a.comment ? ` – “${esc(a.comment)}”` : ''}` : '—';
  };
  const summary: [string, string][] = [
    ['Batch no.', esc(b.batchNo)],
    ['Expense category', esc(b.category)],
    ['No. of invoices', String(b.invoiceCount)],
    ['Taxable total', formatINR(b.taxableTotal)],
    ['GST total', formatINR(b.gstTotal)],
    ['Batch total', `<b>${formatINR(b.totalAmount)}</b>`],
    ['Approval route', esc(routeLabel(b.requiresL3))],
  ];
  const trail: [string, string][] = [
    ['Sent by (User 1)', `${esc(nameOf(b.createdBy))} on ${formatDateTime(b.createdAt)}`],
    ['L1 approval', step(1)],
    ['L2 approval', step(2)],
    ['L3 approval', step(3)],
  ];
  const kv = (rows: [string, string][]) =>
    `<table style="border-collapse:collapse;margin:6px 0 16px">${rows.map(([k, v]) => `<tr><td style="${TH}width:170px">${k}</td><td style="${TD}">${v}</td></tr>`).join('')}</table>`;

  const invRows = invoices.map((i, n) => `<tr>
      <td style="${TD}${NUM}">${n + 1}</td>
      <td style="${TD}">${esc(i.vendorName)}</td>
      <td style="${TD}font-family:monospace">${esc(i.vendorGstin || '—')}</td>
      <td style="${TD}">${esc(i.invoiceNumber)}</td>
      <td style="${TD}white-space:nowrap">${formatDate(i.invoiceDate)}</td>
      <td style="${TD}white-space:nowrap">${formatMonth(i.serviceMonth)}</td>
      <td style="${TD}${NUM}">${formatINR(i.taxableAmount)}</td>
      <td style="${TD}${NUM}">${formatINR(i.gstAmount)}</td>
      <td style="${TD}${NUM}"><b>${formatINR(i.totalAmount)}</b></td>
    </tr>`).join('');

  const returned = b.returned?.length
    ? `<p style="margin:16px 0 6px"><b>Returned to User 1 (not in this payment):</b></p><ul style="margin:0 0 16px">${b.returned
      .map((r) => `<li>${esc(r.invoiceNumber)} – ${esc(r.vendorName)} – ${formatINR(r.totalAmount)} – “${esc(r.reason)}”</li>`).join('')}</ul>`
    : '';

  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.5">
  <p>Hi Finance team,</p>
  <p>The batch below has completed all approvals and is ready for payment.</p>
  <h3 style="font-size:15px;margin:16px 0 4px">Batch summary</h3>${kv(summary)}
  <h3 style="font-size:15px;margin:16px 0 4px">Approval trail</h3>${kv(trail)}
  <h3 style="font-size:15px;margin:16px 0 4px">Invoices</h3>
  <table style="border-collapse:collapse;margin:6px 0 16px">
    <tr><th style="${TH}">#</th><th style="${TH}">Vendor</th><th style="${TH}">GSTIN</th><th style="${TH}">Invoice no.</th><th style="${TH}">Invoice date</th>
      <th style="${TH}">Service month</th><th style="${TH}${NUM}">Taxable</th><th style="${TH}${NUM}">GST</th><th style="${TH}${NUM}">Total</th></tr>
    ${invRows}
    <tr><td style="${TH}" colspan="6">Total</td><td style="${TH}${NUM}">${formatINR(b.taxableTotal)}</td><td style="${TH}${NUM}">${formatINR(b.gstTotal)}</td><td style="${TH}${NUM}">${formatINR(b.totalAmount)}</td></tr>
  </table>
  ${returned}
  <p><b>Attachments:</b> ${esc(b.batchNo)}.xlsx (batch summary and invoice details) and a PDF copy of each invoice.</p>
  <p>Record payments (UTR) here: <a href="${esc(dashboardUrl)}">Payment queue</a></p>
  <p style="color:#64748b;font-size:12px;margin-top:24px">This is an automated email from the Invoice Payment Approvals dashboard.</p>
</div>`;
}
