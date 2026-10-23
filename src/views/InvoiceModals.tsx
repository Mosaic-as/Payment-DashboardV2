import { useMemo, useState } from 'react';
import { config } from '../config';
import { saveInvoice, sendForApproval, validateInvoice as markValidated, type InvoiceInput } from '../data/actions';
import { useStore } from '../data/store';
import { downloadPaymentWorkbook } from '../lib/excel';
import { currentMonth, formatDate, formatINR, formatLakh, formatMonth, monthFolderName, round2, todayIso } from '../lib/format';
import { validateInvoice } from '../lib/validation';
import { planBatches, routeLabel } from '../lib/workflow';
import type { Batch, Invoice } from '../types';
import { AttachmentLink, ErrorNote, Modal, useAction } from '../components/ui';

const blank: InvoiceInput = {
  vendorName: '', vendorGstin: '', invoiceNumber: '', invoiceDate: '', taxableAmount: NaN, gstAmount: NaN, totalAmount: NaN, category: '', serviceMonth: '', notes: '',
};

function ValidationList({ errors, warnings }: { errors: string[]; warnings: string[] }) {
  if (!errors.length && !warnings.length) return <div className="note note-ok">✓ All checks passed.</div>;
  return (
    <div className="checks">
      {errors.map((e) => <div key={e} className="check check-error">✕ {e}</div>)}
      {warnings.map((w) => <div key={w} className="check check-warn">! {w}</div>)}
    </div>
  );
}

/** Upload / edit an invoice (User 1). */
export function InvoiceForm({ invoice, onClose, onSaved }: { invoice: Invoice | null; onClose: () => void; onSaved: (id: string) => void }) {
  const { be, me, invoices } = useStore();
  const [f, setF] = useState<InvoiceInput>(invoice ? { ...invoice } : blank);
  const [file, setFile] = useState<File | null>(null);
  const [touched, setTouched] = useState(false);
  const { busy, error, run } = useAction();

  const set = <K extends keyof InvoiceInput>(k: K, v: InvoiceInput[K]) => setF((p) => ({ ...p, [k]: v }));
  const num = (k: 'taxableAmount' | 'gstAmount' | 'totalAmount') => ({
    value: Number.isNaN(f[k]) ? '' : f[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value === '' ? NaN : Number(e.target.value)),
  });
  const result = useMemo(
    () => validateInvoice({ ...f, id: invoice?.id, hasAttachment: !!file || !!invoice?.filePath }, invoices),
    [f, file, invoice, invoices],
  );
  const suggestedTotal = Number.isFinite(f.taxableAmount) && Number.isFinite(f.gstAmount) ? round2(f.taxableAmount + f.gstAmount) : null;

  async function save() {
    setTouched(true);
    if (!f.vendorName.trim() || !f.invoiceNumber.trim()) throw new Error('Vendor name and invoice number are required to save.');
    if (![f.taxableAmount, f.gstAmount, f.totalAmount].every(Number.isFinite)) throw new Error('Enter the taxable, GST and total amounts.');
    if (Math.abs(f.taxableAmount + f.gstAmount - f.totalAmount) > config.roundOffTolerance) {
      throw new Error('Taxable + GST does not match the total. Correct the amounts before saving.');
    }
    if (!file && !invoice?.filePath) throw new Error('Attach the invoice copy.');
    if (!/^\d{4}-\d{2}$/.test(f.serviceMonth)) throw new Error('Select the month in which the services were taken.');
    const id = await saveInvoice(be, me.email, invoice, f, file);
    onSaved(id);
  }

  return (
    <Modal
      wide
      title={invoice ? `Edit invoice ${invoice.invoiceNumber}` : 'Upload invoice'}
      onClose={onClose}
      footer={
        <>
          <span className="muted small">{invoice?.status === 'VALIDATED' ? 'Saving changes will require validating again.' : ''}</span>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(save)}>{busy ? 'Saving…' : 'Save & review'}</button>
        </>
      }
    >
      <div className="form-grid">
        <label className="span-2">Vendor name *
          <input value={f.vendorName} onChange={(e) => set('vendorName', e.target.value)} placeholder="e.g. Acme Supplies Pvt Ltd" autoFocus />
        </label>
        <label>Vendor GSTIN
          <input value={f.vendorGstin} onChange={(e) => set('vendorGstin', e.target.value.toUpperCase())} placeholder="27ABCDE1234F1Z5" maxLength={15} className="mono" />
        </label>
        <label>Invoice number *
          <input value={f.invoiceNumber} onChange={(e) => set('invoiceNumber', e.target.value)} />
        </label>
        <label>Invoice date *
          <input type="date" value={f.invoiceDate} max={todayIso()} onChange={(e) => set('invoiceDate', e.target.value)} />
        </label>
        <label>Expense category *
          <select value={f.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">Select…</option>
            {config.expenseCategories.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label>Service month *
          <input type="month" value={f.serviceMonth} max={currentMonth().slice(0, 4) + '-12'} onChange={(e) => set('serviceMonth', e.target.value)} />
          {f.serviceMonth && be.mode === 'firebase' && <span className="muted small">Drive folder: {monthFolderName(f.serviceMonth)}</span>}
        </label>
        <label>Taxable amount (₹) *
          <input type="number" min="0" step="0.01" inputMode="decimal" {...num('taxableAmount')} />
        </label>
        <label>GST amount (₹) *
          <input type="number" min="0" step="0.01" inputMode="decimal" {...num('gstAmount')} />
        </label>
        <label>Total amount (₹) *
          <input type="number" min="0" step="0.01" inputMode="decimal" {...num('totalAmount')} />
          {suggestedTotal !== null && suggestedTotal !== f.totalAmount && (
            <button type="button" className="link-btn small" onClick={() => set('totalAmount', suggestedTotal)}>
              Taxable + GST = {formatINR(suggestedTotal)} — use this
            </button>
          )}
        </label>
        <label className="span-3">Invoice copy (PDF / image, max {config.maxAttachmentMb} MB) {invoice?.filePath ? '' : '*'}
          <input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {invoice?.filePath && !file && <span className="muted small">Current: {invoice.fileName} <AttachmentLink inv={invoice} /></span>}
        </label>
        <label className="span-3">Notes
          <input value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="PO number, period, remarks…" />
        </label>
      </div>
      <h3 className="section-title">Checks {result.gstRate !== null && <span className="muted small">· effective GST rate {result.gstRate}%</span>}</h3>
      {touched || f.vendorName || f.invoiceNumber ? <ValidationList {...result} /> : <div className="muted small">Fill in the details to see checks.</div>}
      <ErrorNote error={error} />
    </Modal>
  );
}

/** Review screen where User 1 double-checks and clicks Validate. */
export function ReviewModal({ invoice, onClose, onEdit, onSend }: { invoice: Invoice; onClose: () => void; onEdit: () => void; onSend: () => void }) {
  const { be, me, invoices, batchesById } = useStore();
  const [confirmed, setConfirmed] = useState(false);
  const { busy, error, run } = useAction();
  const result = validateInvoice({ ...invoice, hasAttachment: !!invoice.filePath }, invoices);
  const isValidated = invoice.status === 'VALIDATED' && !invoice.batchId;
  const returned = invoice.batchId ? batchesById.get(invoice.batchId) : undefined;
  const returnNote = returned?.status === 'REJECTED' ? [...returned.approvals].reverse().find((a) => a.decision === 'REJECTED') : undefined;

  const rows: [string, React.ReactNode][] = [
    ['Vendor', invoice.vendorName],
    ['GSTIN', invoice.vendorGstin || '—'],
    ['Invoice no.', invoice.invoiceNumber],
    ['Invoice date', formatDate(invoice.invoiceDate)],
    ['Expense category', invoice.category],
    ['Service month', formatMonth(invoice.serviceMonth)],
    ['Taxable amount', formatINR(invoice.taxableAmount)],
    ['GST amount', formatINR(invoice.gstAmount) + (result.gstRate !== null ? ` (${result.gstRate}%)` : '')],
    ['Total amount', <b key="t">{formatINR(invoice.totalAmount)}</b>],
    ['Invoice copy', <AttachmentLink key="a" inv={invoice} />],
    ['Notes', invoice.notes || '—'],
  ];

  return (
    <Modal
      title={isValidated ? 'Invoice validated' : 'Review & validate invoice'}
      onClose={onClose}
      footer={
        isValidated ? (
          <>
            <button className="btn btn-ghost" onClick={onEdit}>Edit</button>
            <span className="spacer" />
            <button className="btn btn-ghost" onClick={onClose}>Later</button>
            <button className="btn btn-primary" onClick={onSend}>Send for payment approval →</button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={onEdit}>Edit details</button>
            <span className="spacer" />
            <button
              className="btn btn-primary"
              disabled={busy || !confirmed || result.errors.length > 0}
              onClick={() => run(() => markValidated(be, me.email, invoice, result.warnings))}
            >
              {busy ? 'Validating…' : '✓ Validate'}
            </button>
          </>
        )
      }
    >
      {returnNote && (
        <div className="note note-warn">
          Returned by L{returnNote.level} approver ({returnNote.by}): “{returnNote.comment}”. Correct the details if needed and validate again.
        </div>
      )}
      <dl className="detail-list">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {isValidated ? (
        <div className="note note-ok">✓ Validated by {invoice.validatedBy}. You can send it for approval now, or later in bulk from the invoice list.</div>
      ) : (
        <>
          <h3 className="section-title">Checks</h3>
          <ValidationList {...result} />
          <label className="confirm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={result.errors.length > 0} />
            <span>
              I have double-checked the vendor, invoice number, date, category and amounts against the attached invoice copy
              {result.warnings.length > 0 && ', and reviewed the warnings above'}.
            </span>
          </label>
        </>
      )}
      <ErrorNote error={error} />
    </Modal>
  );
}

/** Confirms sending validated invoices; creates one batch per category and downloads the Excel. */
export function SendModal({ invoices, onClose, onSent }: { invoices: Invoice[]; onClose: () => void; onSent: () => void }) {
  const { be, me, invoicesById } = useStore();
  const plan = planBatches(invoices);
  const [created, setCreated] = useState<Batch[] | null>(null);
  const { busy, error, run } = useAction();
  const fileName = useMemo(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `Payment_Batches_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.xlsx`;
  }, []);

  async function send() {
    const batches = await sendForApproval(be, me.email, invoices);
    const map = new Map(invoicesById);
    invoices.forEach((i) => map.set(i.id, i));
    downloadPaymentWorkbook(batches, map, fileName);
    setCreated(batches);
    onSent();
  }

  if (created) {
    return (
      <Modal title="Sent for approval" onClose={onClose} footer={<><span className="spacer" /><button className="btn btn-primary" onClick={onClose}>Done</button></>}>
        <div className="note note-ok">
          ✓ {invoices.length} invoice(s) sent to the L1 approver in {created.length} batch(es). The Excel <b>{fileName}</b> has been downloaded
          for the finance team. You can download it again any time from <i>All batches</i>.
        </div>
        <ul className="plain">
          {created.map((b) => <li key={b.id}><b>{b.batchNo}</b> — {b.category}, {b.invoiceCount} invoice(s), {formatINR(b.totalAmount)} · {routeLabel(b.requiresL3)}</li>)}
        </ul>
        <button className="btn btn-outline" onClick={() => downloadPaymentWorkbook(created, invoicesById, fileName)}>⬇ Download Excel again</button>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Send ${invoices.length} invoice(s) for payment approval`}
      onClose={onClose}
      footer={
        <>
          <span className="muted small">Invoices are grouped into one batch per expense category.</span>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(send)}>{busy ? 'Sending…' : `Send ${plan.length} batch(es) to L1`}</button>
        </>
      }
    >
      <div className="plan">
        {plan.map((p) => (
          <div key={p.category} className="plan-card">
            <div className="plan-head">
              <b>{p.category}</b>
              <span className={`route ${p.requiresL3 ? 'route-l3' : ''}`}>{routeLabel(p.requiresL3)}</span>
            </div>
            <div className="plan-total">{formatINR(p.totalAmount)}</div>
            <div className="muted small">
              {p.invoices.length} invoice(s) · Taxable {formatINR(p.taxableTotal)} · GST {formatINR(p.gstTotal)}
            </div>
            {p.requiresL3 && <div className="small warn-text">Above {formatLakh(config.l3Threshold)} — needs User 4 (L3) approval.</div>}
          </div>
        ))}
      </div>
      <ErrorNote error={error} />
    </Modal>
  );
}
