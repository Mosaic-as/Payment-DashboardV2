import { config } from '../config';
import type { Batch, BatchStatus, Invoice, InvoiceStage, Role } from '../types';
import { round2 } from './format';

/** Which batch status each approver role acts on. */
export const ROLE_QUEUE: Partial<Record<Role, BatchStatus>> = {
  approver1: 'PENDING_L1',
  approver2: 'PENDING_L2',
  approver3: 'PENDING_L3',
  finance: 'WITH_FINANCE',
};

export const LEVEL_OF: Partial<Record<BatchStatus, 1 | 2 | 3>> = {
  PENDING_L1: 1,
  PENDING_L2: 2,
  PENDING_L3: 3,
};

export const requiresL3 = (total: number) => total > config.l3Threshold;

/**
 * Approval routing:
 *   L1 (User 2) → L2 (User 3) → [L3 (User 4) only if batch total > ₹20 lakh] → Finance
 */
export function nextStatusOnApprove(batch: Pick<Batch, 'status' | 'requiresL3'>): BatchStatus {
  switch (batch.status) {
    case 'PENDING_L1':
      return 'PENDING_L2';
    case 'PENDING_L2':
      return batch.requiresL3 ? 'PENDING_L3' : 'WITH_FINANCE';
    case 'PENDING_L3':
      return 'WITH_FINANCE';
    default:
      throw new Error(`Batch in status ${batch.status} cannot be approved.`);
  }
}

export function routeLabel(requiresL3: boolean): string {
  return requiresL3 ? 'L1 → L2 → L3 → Finance' : 'L1 → L2 → Finance';
}

export function stageOf(inv: Invoice, batches: Map<string, Batch>): InvoiceStage {
  if (inv.batchId) {
    const b = batches.get(inv.batchId);
    if (b) return b.status === 'REJECTED' ? 'RETURNED' : b.status;
  }
  return inv.status;
}

export const isEditable = (stage: InvoiceStage) => stage === 'DRAFT' || stage === 'VALIDATED' || stage === 'RETURNED';

export interface PlannedBatch {
  category: string;
  invoices: Invoice[];
  taxableTotal: number;
  gstTotal: number;
  totalAmount: number;
  requiresL3: boolean;
}

/** Groups the selected invoices into one batch per expense category. */
export function planBatches(invoices: Invoice[]): PlannedBatch[] {
  const groups = new Map<string, Invoice[]>();
  for (const inv of invoices) {
    const list = groups.get(inv.category) ?? [];
    list.push(inv);
    groups.set(inv.category, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, list]) => {
      const taxableTotal = round2(list.reduce((s, i) => s + i.taxableAmount, 0));
      const gstTotal = round2(list.reduce((s, i) => s + i.gstAmount, 0));
      const totalAmount = round2(list.reduce((s, i) => s + i.totalAmount, 0));
      return { category, invoices: list, taxableTotal, gstTotal, totalAmount, requiresL3: requiresL3(totalAmount) };
    });
}

export function makeBatchNo(category: string, date = new Date()): string {
  const ymd = `${date.getFullYear() % 100}`.padStart(2, '0') +
    `${date.getMonth() + 1}`.padStart(2, '0') + `${date.getDate()}`.padStart(2, '0');
  // 'Warehouse - Electricity' → 'ELEC': use the part after the last dash.
  const cat = category.split('-').pop()!.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'GEN';
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `B${ymd}-${cat}-${rand}`;
}

/** Re-adds invoice amounts so approvers can confirm the batch total wasn't altered. */
export function verifyBatchTotal(batch: Batch, invoices: Invoice[]): { ok: boolean; actual: number; missing: number } {
  const found = invoices.filter((i) => batch.invoiceIds.includes(i.id) && i.batchId === batch.id);
  const actual = round2(found.reduce((s, i) => s + i.totalAmount, 0));
  const missing = batch.invoiceIds.length - found.length;
  return { ok: missing === 0 && Math.abs(actual - batch.totalAmount) < 0.01, actual, missing };
}
