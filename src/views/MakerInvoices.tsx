import { useMemo, useState } from 'react';
import { deleteInvoice } from '../data/actions';
import { useStore } from '../data/store';
import { formatAmount, formatDate, formatINR } from '../lib/format';
import { isEditable, stageOf } from '../lib/workflow';
import { STAGE_LABELS, type Invoice, type InvoiceStage } from '../types';
import { AttachmentLink, Empty, ErrorNote, StageBadge, useAction } from '../components/ui';
import { InvoiceForm, ReviewModal, SendModal } from './InvoiceModals';

type Filter = 'ACTIVE' | 'ALL' | InvoiceStage;

export function MakerInvoices() {
  const { be, me, invoices, invoicesById, batchesById, nameOf, loaded } = useStore();
  const [filter, setFilter] = useState<Filter>('ACTIVE');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Invoice | 'new' | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [sending, setSending] = useState<Invoice[] | null>(null);
  const { error, run } = useAction();

  const rows = useMemo(() => invoices.map((inv) => ({ inv, stage: stageOf(inv, batchesById) })), [invoices, batchesById]);
  const counts = useMemo(() => {
    const c: Partial<Record<InvoiceStage, number>> = {};
    rows.forEach((r) => (c[r.stage] = (c[r.stage] ?? 0) + 1));
    return c;
  }, [rows]);

  const needle = q.trim().toLowerCase();
  const visible = rows.filter(({ inv, stage }) => {
    if (filter === 'ACTIVE' ? !isEditable(stage) : filter !== 'ALL' && stage !== filter) return false;
    return !needle || [inv.vendorName, inv.invoiceNumber, inv.category, inv.vendorGstin].some((s) => s.toLowerCase().includes(needle));
  });
  // Security rules only let the user who validated an invoice send it.
  const canSend = (inv: Invoice, stage: InvoiceStage) => stage === 'VALIDATED' && inv.validatedBy === me.email;
  const sendable = visible.filter((r) => canSend(r.inv, r.stage));
  const selectedInvoices = [...selected].map((id) => invoicesById.get(id)).filter((i): i is Invoice => !!i && canSend(i, stageOf(i, batchesById)));
  const selectedTotal = selectedInvoices.reduce((s, i) => s + i.totalAmount, 0);
  const reviewing = reviewId ? invoicesById.get(reviewId) : undefined;

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const allSelected = sendable.length > 0 && sendable.every((r) => selected.has(r.inv.id));

  const filters: [Filter, string, number | undefined][] = [
    ['ACTIVE', 'To action', (counts.DRAFT ?? 0) + (counts.VALIDATED ?? 0) + (counts.RETURNED ?? 0)],
    ['DRAFT', 'Draft', counts.DRAFT],
    ['VALIDATED', 'Validated', counts.VALIDATED],
    ['RETURNED', 'Returned', counts.RETURNED],
    ['ALL', 'All', invoices.length],
  ];

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>My invoices</h1>
          <p className="muted">Upload → review &amp; validate → send for payment approval (individually or in bulk).</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>+ Upload invoice</button>
      </div>

      <div className="toolbar">
        <div className="chips">
          {filters.map(([id, label, n]) => (
            <button key={id} className={`chip ${filter === id ? 'active' : ''}`} onClick={() => setFilter(id)}>
              {label}{n ? <span className="chip-n">{n}</span> : null}
            </button>
          ))}
        </div>
        <input className="search" placeholder="Search vendor, invoice no., GSTIN…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {selectedInvoices.length > 0 && (
        <div className="bulkbar">
          <span><b>{selectedInvoices.length}</b> validated invoice(s) selected · {formatINR(selectedTotal)}</span>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
          <button className="btn btn-primary" onClick={() => setSending(selectedInvoices)}>Send selected for approval →</button>
        </div>
      )}
      <ErrorNote error={error} />

      {!loaded ? <Empty>Loading…</Empty> : visible.length === 0 ? (
        <Empty>{filter === 'ACTIVE' ? 'Nothing to action. Upload an invoice to get started.' : 'No invoices match.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="check-col">
                  <input
                    type="checkbox"
                    aria-label="Select all validated"
                    title="Select all validated invoices"
                    disabled={!sendable.length}
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(sendable.map((r) => r.inv.id)))}
                  />
                </th>
                <th>Vendor</th><th>Invoice no.</th><th>Date</th><th>Category</th>
                <th className="num">Taxable</th><th className="num">GST</th><th className="num">Total</th>
                <th>Status</th><th>Copy</th><th className="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ inv, stage }) => (
                <tr key={inv.id} className={selected.has(inv.id) ? 'selected' : ''}>
                  <td className="check-col">
                    <input
                      type="checkbox"
                      aria-label={`Select ${inv.invoiceNumber}`}
                      disabled={!canSend(inv, stage)}
                      title={stage !== 'VALIDATED' ? 'Validate first to send' : !canSend(inv, stage) ? `Validated by ${nameOf(inv.validatedBy)} — only they can send it` : ''}
                      checked={selected.has(inv.id)}
                      onChange={() => toggle(inv.id)}
                    />
                  </td>
                  <td className="wrap">{inv.vendorName}{inv.vendorGstin && <div className="muted small mono">{inv.vendorGstin}</div>}</td>
                  <td>{inv.invoiceNumber}</td>
                  <td>{formatDate(inv.invoiceDate)}</td>
                  <td>{inv.category}</td>
                  <td className="num">{formatAmount(inv.taxableAmount)}</td>
                  <td className="num">{formatAmount(inv.gstAmount)}</td>
                  <td className="num"><b>{formatAmount(inv.totalAmount)}</b></td>
                  <td>
                    <StageBadge stage={stage} />
                    {inv.batchId && !isEditable(stage) && <div className="muted small">{batchesById.get(inv.batchId)?.batchNo}</div>}
                  </td>
                  <td><AttachmentLink path={inv.filePath} name={inv.fileName} /></td>
                  <td className="actions-col">
                    {canSend(inv, stage) && <button className="btn btn-sm btn-primary" onClick={() => setSending([inv])}>Send</button>}
                    {(stage === 'DRAFT' || stage === 'RETURNED') && <button className="btn btn-sm btn-primary" onClick={() => setReviewId(inv.id)}>Review &amp; validate</button>}
                    {isEditable(stage) && <button className="btn btn-sm btn-ghost" onClick={() => setEditing(inv)}>Edit</button>}
                    {(stage === 'DRAFT' || stage === 'VALIDATED') && (
                      <button
                        className="btn btn-sm btn-ghost danger"
                        onClick={() => confirm(`Delete invoice ${inv.invoiceNumber} from ${inv.vendorName}?`) && run(() => deleteInvoice(be, inv))}
                      >Delete</button>
                    )}
                    {!isEditable(stage) && <span className="muted small">{STAGE_LABELS[stage]}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <InvoiceForm
          invoice={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => { setEditing(null); setReviewId(id); }}
        />
      )}
      {reviewing && (
        <ReviewModal
          invoice={reviewing}
          onClose={() => setReviewId(null)}
          onEdit={() => { setReviewId(null); setEditing(reviewing); }}
          onSend={() => { setReviewId(null); setSending([reviewing]); }}
        />
      )}
      {sending && (
        <SendModal
          invoices={sending}
          onClose={() => setSending(null)}
          onSent={() => setSelected((s) => { const n = new Set(s); sending.forEach((i) => n.delete(i.id)); return n; })}
        />
      )}
    </section>
  );
}
