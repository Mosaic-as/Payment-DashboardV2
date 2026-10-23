import { config } from '../config';
import { paymentWorkbookBase64 } from '../lib/excel';
import { formatINR, newId, nowIso } from '../lib/format';
import { makeDupKey } from '../lib/validation';
import { LEVEL_OF, makeBatchNo, nextStatusOnApprove, planBatches, routeLabel, verifyBatchTotal } from '../lib/workflow';
import type { AppUser, Batch, HistoryEntry, Invoice, WriteOp } from '../types';
import type { Backend } from './backend';

export type InvoiceInput = Pick<
  Invoice,
  'vendorName' | 'vendorGstin' | 'invoiceNumber' | 'invoiceDate' | 'taxableAmount' | 'gstAmount' | 'totalAmount' | 'category' | 'notes'
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
    fileFields = { filePath: await be.uploadFile(id, file), fileName: file.name };
  }
  const now = nowIso();
  if (!existing) {
    const inv: Omit<Invoice, 'id'> = {
      ...fields,
      filePath: '',
      fileName: '',
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
    data: { status: updated.status, approvals: updated.approvals, updatedAt: now },
  }];
  if (updated.status === 'WITH_FINANCE' && config.financeEmail) ops.push(financeMail(updated, invoicesById));
  await be.commit(ops);
  return updated;
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

export async function markPaid(be: Backend, by: string, batch: Batch, paymentRef: string) {
  if (batch.status !== 'WITH_FINANCE') throw new Error('Only batches with finance can be marked paid.');
  if (!paymentRef.trim()) throw new Error('Enter the payment reference / UTR.');
  const now = nowIso();
  await be.commit([{
    type: 'update', col: 'batches', id: batch.id,
    data: { status: 'PAID', paymentRef: paymentRef.trim(), paidAt: now, paidBy: by, updatedAt: now },
  }]);
}

function financeMail(batch: Batch, invoicesById: Map<string, Invoice>): WriteOp {
  return {
    type: 'set', col: 'mail', id: newId(),
    data: {
      to: config.financeEmail.split(',').map((s: string) => s.trim()),
      message: {
        subject: `Payment batch ${batch.batchNo} (${batch.category}) approved — ${formatINR(batch.totalAmount)}`,
        html:
          `<p>Batch <b>${batch.batchNo}</b> has completed approval (${routeLabel(batch.requiresL3)}) and is ready for payment.</p>` +
          `<p>Category: ${batch.category}<br>Invoices: ${batch.invoiceCount}<br>Total: <b>${formatINR(batch.totalAmount)}</b></p>` +
          `<p>The invoice-wise Excel is attached. Open the dashboard to view invoice copies and record payment.</p>`,
        attachments: [{
          filename: `${batch.batchNo}.xlsx`,
          content: paymentWorkbookBase64([batch], invoicesById),
          encoding: 'base64',
        }],
      },
    },
  };
}

export async function saveUser(be: Backend, u: AppUser) {
  const email = u.email.trim().toLowerCase();
  await be.commit([{ type: 'set', col: 'users', id: email, data: { name: u.name.trim(), role: u.role, active: u.active } }]);
}

export async function removeUser(be: Backend, email: string) {
  await be.commit([{ type: 'delete', col: 'users', id: email }]);
}
