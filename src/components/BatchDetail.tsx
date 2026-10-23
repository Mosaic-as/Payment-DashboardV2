import { useState, type ReactNode } from 'react';
import { useStore } from '../data/store';
import { downloadPaymentWorkbook } from '../lib/excel';
import { formatAmount, formatDate, formatDateTime, formatINR, formatLakh, formatMonth } from '../lib/format';
import { routeLabel, verifyBatchTotal } from '../lib/workflow';
import { config } from '../config';
import type { Batch, Invoice } from '../types';
import { AttachmentLink, Modal, StageBadge } from './ui';

type StepState = 'done' | 'current' | 'todo' | 'skipped' | 'rejected';

function Timeline({ batch }: { batch: Batch }) {
  const { nameOf } = useStore();
  const last = (level: number) => [...batch.approvals].reverse().find((a) => a.level === level);
  const order = ['PENDING_L1', 'PENDING_L2', 'PENDING_L3', 'WITH_FINANCE', 'PAID'];
  const rejectedAt = batch.status === 'REJECTED' ? [...batch.approvals].reverse().find((a) => a.decision === 'REJECTED')?.level : undefined;

  const steps: { label: string; state: StepState; detail: ReactNode }[] = [
    { label: 'Sent by User 1', state: 'done', detail: <>{nameOf(batch.createdBy)}<br />{formatDateTime(batch.createdAt)}</> },
  ];
  ([1, 2, 3] as const).forEach((lvl) => {
    const a = last(lvl);
    let state: StepState;
    if (lvl === 3 && !batch.requiresL3) state = 'skipped';
    else if (rejectedAt === lvl) state = 'rejected';
    else if (a?.decision === 'APPROVED' && !(rejectedAt && rejectedAt < lvl)) state = 'done';
    else if (batch.status === `PENDING_L${lvl}`) state = 'current';
    else state = 'todo';
    steps.push({
      label: `L${lvl} approval (User ${lvl + 1})`,
      state,
      detail: state === 'skipped'
        ? `Not required — batch ≤ ${formatLakh(config.l3Threshold)}`
        : a && state !== 'todo' ? <>{nameOf(a.by)}<br />{formatDateTime(a.at)}{a.comment && <><br /><i>“{a.comment}”</i></>}</> : state === 'current' ? 'Awaiting decision' : '',
    });
  });
  const idx = order.indexOf(batch.status);
  steps.push({
    label: 'Finance',
    state: batch.status === 'PAID' ? 'done' : batch.status === 'WITH_FINANCE' ? 'current' : 'todo',
    detail: batch.status === 'PAID' ? <>Paid · {batch.paymentRef}<br />{formatDateTime(batch.paidAt)}</> : idx === 3 ? 'Ready for payment' : '',
  });

  return (
    <ol className="timeline">
      {steps.map((s) => (
        <li key={s.label} className={`step step-${s.state}`}>
          <span className="dot" aria-hidden>{s.state === 'done' ? '✓' : s.state === 'rejected' ? '✕' : s.state === 'skipped' ? '–' : ''}</span>
          <div>
            <div className="step-label">{s.label}</div>
            <div className="step-detail">{s.detail}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function BatchInvoicesTable({ invoices, selected, onToggle }: {
  invoices: Invoice[];
  /** When given, rows get tick boxes (approver returning single invoices). */
  selected?: Set<string>;
  onToggle?: (id: string) => void;
}) {
  const selectable = !!selected && !!onToggle && invoices.length > 1;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {selectable && <th className="check-col" title="Tick invoices to return them to User 1" />}
            <th>Vendor</th><th>GSTIN</th><th>Invoice no.</th><th>Date</th><th>Service month</th>
            <th className="num">Taxable</th><th className="num">GST</th><th className="num">Total</th><th>Copy</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id} className={selected?.has(i.id) ? 'selected' : ''}>
              {selectable && (
                <td className="check-col">
                  <input type="checkbox" aria-label={`Select ${i.invoiceNumber} to return`} checked={selected!.has(i.id)} onChange={() => onToggle!(i.id)} />
                </td>
              )}
              <td className="wrap">{i.vendorName}{i.notes && <div className="muted small">{i.notes}</div>}</td>
              <td className="mono small">{i.vendorGstin || '—'}</td>
              <td>{i.invoiceNumber}</td>
              <td>{formatDate(i.invoiceDate)}</td>
              <td>{formatMonth(i.serviceMonth)}</td>
              <td className="num">{formatAmount(i.taxableAmount)}</td>
              <td className="num">{formatAmount(i.gstAmount)}</td>
              <td className="num"><b>{formatAmount(i.totalAmount)}</b></td>
              <td><AttachmentLink inv={i} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReturnedList({ batch }: { batch: Batch }) {
  const { nameOf } = useStore();
  if (!batch.returned?.length) return null;
  return (
    <>
      <h3 className="section-title">Returned to User 1 ({batch.returned.length})</h3>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Invoice no.</th><th>Vendor</th><th className="num">Total</th><th>Returned by</th><th>Reason</th></tr></thead>
          <tbody>
            {batch.returned.map((r) => (
              <tr key={r.invoiceId + r.at}>
                <td>{r.invoiceNumber}</td>
                <td className="wrap">{r.vendorName}</td>
                <td className="num">{formatAmount(r.totalAmount)}</td>
                <td className="small">L{r.level} · {nameOf(r.by)}<br />{formatDateTime(r.at)}</td>
                <td className="wrap">{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * actions: footer buttons. Pass a function to let the approver tick invoices;
 * it receives the ticked ids and a callback to clear them.
 */
export function BatchDetail({ batch, onClose, actions }: {
  batch: Batch;
  onClose: () => void;
  actions?: ReactNode | ((selectedIds: string[], clear: () => void) => ReactNode);
}) {
  const { invoicesById } = useStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const invoices = batch.invoiceIds.map((id) => invoicesById.get(id)).filter((i): i is Invoice => !!i);
  const check = verifyBatchTotal(batch, invoices);
  const selectable = typeof actions === 'function';
  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const ids = [...selected].filter((id) => batch.invoiceIds.includes(id));
  return (
    <Modal
      wide
      onClose={onClose}
      title={<>Batch {batch.batchNo} <StageBadge stage={batch.status} /></>}
      footer={
        <>
          <button className="btn btn-outline" onClick={() => downloadPaymentWorkbook([batch], invoicesById, `${batch.batchNo}.xlsx`)}>
            ⬇ Excel
          </button>
          <span className="spacer" />
          {typeof actions === 'function' ? actions(ids, () => setSelected(new Set())) : actions}
        </>
      }
    >
      <div className="batch-summary">
        <div><span className="muted">Category</span><b>{batch.category}</b></div>
        <div><span className="muted">Invoices</span><b>{batch.invoiceCount}</b></div>
        <div><span className="muted">Taxable</span><b>{formatINR(batch.taxableTotal)}</b></div>
        <div><span className="muted">GST</span><b>{formatINR(batch.gstTotal)}</b></div>
        <div><span className="muted">Batch total</span><b className="big">{formatINR(batch.totalAmount)}</b></div>
        <div><span className="muted">Route</span><b>{routeLabel(batch.requiresL3)}</b></div>
      </div>
      {!check.ok && (
        <div className="note note-error">
          Integrity check failed: the invoices in this batch add up to {formatINR(check.actual)}
          {check.missing ? ` and ${check.missing} invoice(s) are missing` : ''}. Do not approve — reject and ask User 1 to resend.
        </div>
      )}
      <Timeline batch={batch} />
      {selectable && invoices.length > 1 && (
        <p className="muted small">Tick any invoice that has a problem to return just that invoice to User 1; the rest of the batch continues.</p>
      )}
      <BatchInvoicesTable invoices={invoices} selected={selectable ? selected : undefined} onToggle={selectable ? toggle : undefined} />
      <ReturnedList batch={batch} />
    </Modal>
  );
}
