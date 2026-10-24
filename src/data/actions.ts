import { config } from '../config';
import { paymentWorkbookBase64 } from '../lib/excel';
import { financeMailHtml } from '../lib/financeMail';
import { driveFileName, formatINR, newId, nowIso, round2 } from '../lib/format';
import { makeDupKey } from '../lib/validation';
import { LEVEL_OF, makeBatchNo, nextStatusOnApprove, planBatches, requiresL3, verifyBatchTotal } from '../lib/workflow';
import type { AppUser, Batch, FinanceMail, HistoryEntry, Invoice, MailSettings, Payment, Vendor, WriteOp } from '../types';
import type { PaymentInput } from '../lib/payments';
import { vendorKey } from '../vendors';
import type { Backend } from './backend';

export type InvoiceInput = Pick<
  Invoice,
  'vendorName' | 'vendorGstin' | 'invoiceNumber' | 'invoiceDate' | 'taxableAmount' | 'gstAmount' | 'totalAmount' | 'category' | 'serviceMonth' | 'notes'
>;

const entry = (by: string, action: string, note?: string): HistoryEntry => ({ at: nowIso(), by, action, ...(note ? { note } : {}) });

/** Create or edit an invoice. Any edit puts it back to Draft so it must be re-validated. */
export async function saveInvoice(be: Backend, by: string, existing: Invoice | null, input: InvoiceInput, file: File | null): Promise<string> {
  const id = existing?.id ?? newId();
  const fields = {
    ...input,
    vendorName: input.vendorName.trim(),
    vendorGstin: input.vendorGstin.trim().toUpperCase(),
    invoiceNumber: input.invoiceNumber.trim(),
    notes: input.notes.trim(),
    dupKey: makeDupKey(input.vendorName, input.invoiceNumber),
  };
  let fileFields = {};
  if (file) {
    if (file.size > config.maxAttachmentMb * 1024 * 1024) throw new Error(`Attachment is larger than ${config.maxAttachmentMb} MB.`);
    const name = driveFileName(fields.serviceMonth, fields.vendorName, fields.invoiceNumber, file.name);
    const { path, url } = await be.uploadFile(id, file, { name, serviceMonth: fields.serviceMonth });
    fileFields = { filePath: path, fileUrl: url, fileName: name };
  } else if (existing?.filePath && be.relocateFile) {
    // Keep the Drive copy in the right month folder and named after the invoice.
    const name = driveFileName(fields.serviceMonth, fields.vendorName, fields.invoiceNumber, existing.fileName);
    if (name !== existing.fileName || fields.serviceMonth !== existing.serviceMonth) {
      await be.relocateFile(existing.filePath, { name, serviceMonth: fields.serviceMonth });
      fileFields = { fileName: name };
    }
  }
  const now = nowIso();
  if (!existing) {
    const inv: Omit<Invoice, 'id'> = {
      ...fields,
      filePath: '',
      fileName: '',
      fileUrl: '',
      ...fileFields,
      status: 'DRAFT',
      batchId: null,
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      validatedBy: null,
      validatedAt: null,
      history: [entry(by, 'Uploaded')],
    };
    await be.commit([{ type: 'set', col: 'invoices', id, data: inv }]);
  } else {
    const note = existing.batchId ? 'Corrected after being returned' : undefined;
    await be.commit([{
      type: 'update', col: 'invoices', id,
      data: {
        ...fields, ...fileFields,
        status: 'DRAFT', batchId: null, validatedBy: null, validatedAt: null, updatedAt: now,
        history: [...existing.history, entry(by, 'Edited', note)],
      },
    }]);
  }
  return id;
}

export async function validateInvoice(be: Backend, by: string, inv: Invoice, warnings: string[]) {
  const now = nowIso();
  await be.commit([{
    type: 'update', col: 'invoices', id: inv.id,
    data: {
      status: 'VALIDATED', batchId: null, validatedBy: by, validatedAt: now, updatedAt: now,
      history: [...inv.history, entry(by, 'Validated', warnings.length ? `Acknowledged: ${warnings.join(' ')}` : undefined)],
    },
  }]);
}

export async function deleteInvoice(be: Backend, inv: Invoice) {
  await be.commit([{ type: 'delete', col: 'invoices', id: inv.id }]);
}

/** Sends validated invoices for approval, one batch per expense category. */
export async function sendForApproval(be: Backend, by: string, invoices: Invoice[]): Promise<Batch[]> {
  if (!invoices.length) throw new Error('Select at least one validated invoice.');
  if (invoices.some((i) => i.status !== 'VALIDATED' || i.batchId)) throw new Error('Only validated invoices can be sent.');
  const notMine = invoices.filter((i) => i.validatedBy !== by);
  if (notMine.length) {
    throw new Error(`Only the person who validated an invoice can send it. Re-validate: ${notMine.map((i) => i.invoiceNumber).join(', ')}.`);
  }
  const now = nowIso();
  const writes: WriteOp[][] = [];
  const batches: Batch[] = planBatches(invoices).map((p) => {
    const ops: WriteOp[] = [];
    writes.push(ops);
    const batch: Batch = {
      id: newId(),
      batchNo: makeBatchNo(p.category),
      category: p.category,
      invoiceIds: p.invoices.map((i) => i.id),
      invoiceCount: p.invoices.length,
      taxableTotal: p.taxableTotal,
      gstTotal: p.gstTotal,
      totalAmount: p.totalAmount,
      requiresL3: p.requiresL3,
      status: 'PENDING_L1',
      approvals: [],
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      paymentRef: null,
      paidAt: null,
      paidBy: null,
    };
    const { id, ...data } = batch;
    ops.push({ type: 'set', col: 'batches', id, data });
    for (const inv of p.invoices) {
      ops.push({
        type: 'update', col: 'invoices', id: inv.id,
        data: { batchId: batch.id, updatedAt: now, history: [...inv.history, entry(by, 'Sent for approval', batch.batchNo)] },
      });
    }
    return batch;
  });
  // One atomic write per category batch keeps each write within the
  // security-rules lookup limit, however many invoices are sent.
  const sent: Batch[] = [];
  for (let i = 0; i < batches.length; i++) {
    try {
      await be.commit(writes[i]);
      sent.push(batches[i]);
    } catch (e) {
      const done = sent.length ? ` Batches already sent: ${sent.map((b) => b.batchNo).join(', ')}.` : '';
      throw new Error(`Sending the ${batches[i].category} batch failed: ${(e as Error).message}.${done}`);
    }
  }
  return sent;
}

export async function approveBatch(be: Backend, by: string, batch: Batch, comment: string, invoicesById: Map<string, Invoice>) {
  const level = LEVEL_OF[batch.status];
  if (!level) throw new Error('This batch is not awaiting approval.');
  const check = verifyBatchTotal(batch, [...invoicesById.values()]);
  if (!check.ok) throw new Error(`Batch total does not match its invoices (recomputed ${formatINR(check.actual)}). Reject it instead.`);
  const now = nowIso();
  const updated: Batch = {
    ...batch,
    status: nextStatusOnApprove(batch),
    approvals: [...batch.approvals, { level, by, at: now, decision: 'APPROVED', comment: comment.trim() }],
    updatedAt: now,
  };
  const ops: WriteOp[] = [{
    type: 'update', col: 'batches', id: batch.id,
    data: {
      status: updated.status, approvals: updated.approvals, updatedAt: now,
      // The next level starts with nothing approved yet.
      ...(batch.levelApproved?.length ? { levelApproved: [] } : {}),
    },
  }];
  await be.commit(ops);
  return updated;
}

/**
 * Approves only the ticked invoices at this level. When every invoice left in
 * the batch has been approved, the batch moves on to the next level.
 */
export async function approveSelected(be: Backend, by: string, batch: Batch, invoiceIds: string[], comment: string, invoicesById: Map<string, Invoice>) {
  if (!LEVEL_OF[batch.status]) throw new Error('This batch is not awaiting approval.');
  const approved = new Set([...(batch.levelApproved ?? []), ...invoiceIds].filter((id) => batch.invoiceIds.includes(id)));
  if (approved.size === batch.invoiceIds.length) return approveBatch(be, by, batch, comment, invoicesById);
  await be.commit([{
    type: 'update', col: 'batches', id: batch.id,
    data: { levelApproved: batch.invoiceIds.filter((id) => approved.has(id)), updatedAt: nowIso() },
  }]);
  return null;
}

export async function rejectBatch(be: Backend, by: string, batch: Batch, reason: string) {
  const level = LEVEL_OF[batch.status];
  if (!level) throw new Error('This batch is not awaiting approval.');
  if (!reason.trim()) throw new Error('A reason is required to reject.');
  const now = nowIso();
  await be.commit([{
    type: 'update', col: 'batches', id: batch.id,
    data: {
      status: 'REJECTED',
      approvals: [...batch.approvals, { level, by, at: now, decision: 'REJECTED', comment: reason.trim() }],
      updatedAt: now,
    },
  }]);
}

/**
 * Takes selected invoices out of a batch and sends them back to User 1.
 * The rest of the batch stays at the same approval level; its totals and
 * the >₹20 lakh routing are recalculated.
 */
export async function returnInvoices(be: Backend, by: string, batch: Batch, invoiceIds: string[], reason: string, invoicesById: Map<string, Invoice>) {
  const level = LEVEL_OF[batch.status];
  if (!level) throw new Error('This batch is not awaiting approval.');
  if (!reason.trim()) throw new Error('A reason is required to return invoices.');
  const ids = new Set(invoiceIds.filter((id) => batch.invoiceIds.includes(id)));
  if (!ids.size) throw new Error('Select the invoices to return.');
  const remaining = batch.invoiceIds.filter((id) => !ids.has(id));
  if (!remaining.length) throw new Error('All invoices are selected. Use Reject to return the whole batch.');
  const keep = remaining.map((id) => invoicesById.get(id));
  if (keep.some((i) => !i)) throw new Error('Some invoices in this batch could not be loaded. Refresh and try again.');
  const now = nowIso();
  const sum = (k: 'taxableAmount' | 'gstAmount' | 'totalAmount') => round2(keep.reduce((s, i) => s + i![k], 0));
  const totalAmount = sum('totalAmount');
  const returned = [...ids].map((id) => {
    const i = invoicesById.get(id)!;
    return { invoiceId: id, invoiceNumber: i.invoiceNumber, vendorName: i.vendorName, totalAmount: i.totalAmount, level, by, at: now, reason: reason.trim() };
  });
  await be.commit([{
    type: 'update', col: 'batches', id: batch.id,
    data: {
      invoiceIds: remaining,
      invoiceCount: remaining.length,
      taxableTotal: sum('taxableAmount'),
      gstTotal: sum('gstAmount'),
      totalAmount,
      requiresL3: requiresL3(totalAmount),
      returned: [...(batch.returned ?? []), ...returned],
      ...(batch.levelApproved ? { levelApproved: batch.levelApproved.filter((id) => !ids.has(id)) } : {}),
      updatedAt: now,
    },
  }]);
  // If everything left had already been approved one by one, move the batch on.
  const approvedLeft = (batch.levelApproved ?? []).filter((id) => !ids.has(id));
  if (approvedLeft.length && approvedLeft.length === remaining.length) {
    const after: Batch = {
      ...batch, invoiceIds: remaining, invoiceCount: remaining.length, totalAmount,
      requiresL3: requiresL3(totalAmount), levelApproved: approvedLeft,
    };
    return approveBatch(be, by, after, '', invoicesById);
  }
  return null;
}

/**
 * Records UTRs for invoices of one batch (new or corrected). When every invoice
 * in the batch has a payment, the batch becomes PAID and is locked.
 */
export async function recordPayments(be: Backend, by: string, batch: Batch, entries: { invoiceId: string; payment: PaymentInput }[]) {
  if (batch.status !== 'WITH_FINANCE') throw new Error('Payments can only be recorded while the batch is with Finance.');
  const now = nowIso();
  const payments: Record<string, Payment> = { ...(batch.payments ?? {}) };
  for (const { invoiceId, payment } of entries) {
    if (!batch.invoiceIds.includes(invoiceId)) throw new Error('An invoice is not part of this batch.');
    payments[invoiceId] = { ...payment, utr: payment.utr.trim().toUpperCase(), by, at: now };
  }
  const allPaid = batch.invoiceIds.every((id) => payments[id]);
  await be.commit([{
    type: 'update', col: 'batches', id: batch.id,
    data: {
      payments,
      updatedAt: now,
      ...(allPaid ? { status: 'PAID', paidAt: now, paidBy: by } : {}),
    },
  }]);
  return allPaid;
}


export async function saveUser(be: Backend, u: AppUser) {
  const email = u.email.trim().toLowerCase();
  await be.commit([{ type: 'set', col: 'users', id: email, data: { name: u.name.trim(), role: u.role, active: u.active } }]);
}

export async function removeUser(be: Backend, email: string) {
  await be.commit([{ type: 'delete', col: 'users', id: email }]);
}

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Adds a vendor to the shared list. Returns the existing one if the name is already there. */
export async function addVendor(be: Backend, by: string, existing: Vendor[], name: string, gstin: string): Promise<Vendor> {
  const clean = name.trim().replace(/\s+/g, ' ');
  const id = vendorKey(clean);
  if (clean.length < 2 || !id) throw new Error('Enter the vendor name.');
  if (clean.length > 120) throw new Error('Vendor name is too long.');
  const g = gstin.trim().toUpperCase();
  if (g && !GSTIN_RE.test(g)) throw new Error('GSTIN format is invalid (15 characters, e.g. 27ABCDE1234F1Z5).');
  const dup = existing.find((v) => v.id === id);
  if (dup) return dup;
  await be.commit([{ type: 'set', col: 'vendors', id, data: { name: clean, gstin: g, createdBy: by, createdAt: nowIso() } }]);
  return { id, name: clean, gstin: g, custom: true };
}

export async function saveMailSettings(be: Backend, settings: MailSettings) {
  await be.commit([{ type: 'set', col: 'settings', id: 'mail', data: { ...settings } }]);
}

/** Records whether the finance email went out (shown on the batch, with Resend). */
export async function noteFinanceMail(be: Backend, batch: Batch, mail: FinanceMail) {
  await be.commit([{ type: 'update', col: 'batches', id: batch.id, data: { financeMail: mail, updatedAt: nowIso() } }]);
}

/**
 * Emails the finance team (from User 1's mailbox via the mailer) with the
 * batch Excel and invoice PDFs. The outcome is recorded on the batch.
 */
export async function notifyFinance(
  be: Backend, by: string, batch: Batch, invoicesById: Map<string, Invoice>,
  settings: MailSettings | null, nameOf: (e: string) => string, resend = false,
) {
  if (!be.sendFinanceMail) return;
  try {
    if (!settings?.mailerUrl) throw new Error('The finance email is not set up yet (admin: Settings → Finance email).');
    if (!settings.to?.length) throw new Error('No finance email recipients are set (admin: Settings → Finance email).');
    const invoices = batch.invoiceIds.map((id) => invoicesById.get(id)).filter((i): i is Invoice => !!i);
    const { parts } = await be.sendFinanceMail(settings.mailerUrl, {
      batchId: batch.id,
      html: financeMailHtml(batch, invoices, nameOf, location.origin + location.pathname),
      excelBase64: paymentWorkbookBase64([batch], invoicesById),
      excelName: `${batch.batchNo}.xlsx`,
      resend,
    });
    await noteFinanceMail(be, batch, { status: 'sent', at: nowIso(), by, parts });
  } catch (e) {
    const error = (e as Error).message || String(e);
    await noteFinanceMail(be, batch, { status: 'failed', at: nowIso(), by, error }).catch(() => {});
    throw e;
  }
}
