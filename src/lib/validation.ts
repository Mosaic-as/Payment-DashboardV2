import { config } from '../config';
import type { Invoice } from '../types';
import { currentMonth, formatMonth, round2, todayIso } from './format';

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  /** Effective GST rate in %, for display. */
  gstRate: number | null;
}

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const makeDupKey = (vendorName: string, invoiceNumber: string) =>
  `${vendorName.trim().toLowerCase().replace(/\s+/g, ' ')}|${invoiceNumber.trim().toLowerCase().replace(/\s+/g, '')}`;

type InvoiceFields = Pick<
  Invoice,
  'vendorName' | 'vendorGstin' | 'invoiceNumber' | 'invoiceDate' | 'taxableAmount' | 'gstAmount' | 'totalAmount' | 'category' | 'serviceMonth'
> & { id?: string; hasAttachment: boolean };

/**
 * Checks an invoice before User 1 can mark it as validated.
 * Errors block validation; warnings must be acknowledged by the user.
 */
export function validateInvoice(inv: InvoiceFields, others: Pick<Invoice, 'id' | 'dupKey' | 'invoiceNumber'>[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!inv.vendorName.trim()) errors.push('Vendor name is required.');
  if (!inv.invoiceNumber.trim()) errors.push('Invoice number is required.');
  if (!inv.invoiceDate) errors.push('Invoice date is required.');
  if (!inv.category) errors.push('Expense category is required.');
  else if (!config.expenseCategories.includes(inv.category)) errors.push(`Unknown expense category "${inv.category}".`);
  if (!inv.hasAttachment) errors.push('Attach the invoice copy (PDF or image).');
  if (!inv.serviceMonth) errors.push('Service month is required (decides the Google Drive folder).');
  else if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(inv.serviceMonth)) errors.push('Service month is not a valid month.');
  else if (inv.serviceMonth > currentMonth()) warnings.push(`Service month ${formatMonth(inv.serviceMonth)} is in the future (advance billing?).`);

  const nums: [string, number][] = [
    ['Taxable amount', inv.taxableAmount],
    ['GST amount', inv.gstAmount],
    ['Total amount', inv.totalAmount],
  ];
  for (const [label, v] of nums) {
    if (!Number.isFinite(v)) errors.push(`${label} must be a number.`);
    else if (v < 0) errors.push(`${label} cannot be negative.`);
    else if (round2(v) !== v) errors.push(`${label} can have at most 2 decimal places.`);
  }
  if (Number.isFinite(inv.totalAmount) && inv.totalAmount <= 0) errors.push('Total amount must be greater than zero.');

  let gstRate: number | null = null;
  if (nums.every(([, v]) => Number.isFinite(v))) {
    const diff = round2(inv.taxableAmount + inv.gstAmount - inv.totalAmount);
    if (Math.abs(diff) > config.roundOffTolerance) {
      errors.push(
        `Taxable (${inv.taxableAmount}) + GST (${inv.gstAmount}) = ${round2(inv.taxableAmount + inv.gstAmount)}, ` +
          `which does not match Total (${inv.totalAmount}). Difference: ${diff}.`,
      );
    } else if (diff !== 0) {
      warnings.push(`Round-off difference of ₹${Math.abs(diff).toFixed(2)} between Taxable + GST and Total.`);
    }

    if (inv.taxableAmount > 0) {
      gstRate = round2((inv.gstAmount / inv.taxableAmount) * 100);
      const nearSlab = config.gstSlabs.some((s) => Math.abs(s - gstRate!) <= 0.1);
      if (!nearSlab) {
        warnings.push(`Effective GST rate is ${gstRate}%, which is not a standard slab (${config.gstSlabs.join('%, ')}%). Check for mixed-rate or wrong amounts.`);
      }
    }
  }

  const gstin = inv.vendorGstin.trim().toUpperCase();
  if (gstin && !GSTIN_RE.test(gstin)) errors.push('Vendor GSTIN format is invalid (expected 15 characters, e.g. 27ABCDE1234F1Z5).');
  if (!gstin && inv.gstAmount > 0) warnings.push('GST is charged but vendor GSTIN is blank.');

  if (inv.invoiceDate) {
    if (inv.invoiceDate > todayIso()) errors.push('Invoice date cannot be in the future.');
    const ageDays = (Date.now() - new Date(inv.invoiceDate + 'T00:00:00').getTime()) / 86_400_000;
    if (ageDays > 180) warnings.push(`Invoice is ${Math.floor(ageDays)} days old.`);
  }

  if (inv.vendorName.trim() && inv.invoiceNumber.trim()) {
    const key = makeDupKey(inv.vendorName, inv.invoiceNumber);
    if (others.some((o) => o.id !== inv.id && o.dupKey === key)) {
      errors.push(`Duplicate: invoice "${inv.invoiceNumber}" from this vendor already exists.`);
    }
  }

  return { errors, warnings, gstRate };
}
