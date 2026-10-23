import type { ReactNode } from 'react';
import { useStore } from '../data/store';
import { downloadPaymentWorkbook } from '../lib/excel';
import { formatAmount, formatDate, formatDateTime, formatINR, formatLakh } from '../lib/format';
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

export function BatchInvoicesTable({ invoices }: { invoices: Invoice[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Vendor</th><th>GSTIN</th><th>Invoice no.</th><th>Date</th>
            <th className="num">Taxable</th><th className="num">GST</th><th className="num">Total</th><th>Copy</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id}>
              <td className="wrap">{i.vendorName}{i.notes && <div className="muted small">{i.notes}</div>}</td>
              <td className="mono small">{i.vendorGstin || '—'}</td>
              <td>{i.invoiceNumber}</td>
              <td>{formatDate(i.invoiceDate)}</td>
              <td className="num">{formatAmount(i.taxableAmount)}</td>
              <td className="num">{formatAmount(i.gstAmount)}</td>
              <td className="num"><b>{formatAmount(i.totalAmount)}</b></td>
              <td><AttachmentLink path={i.filePath} name={i.fileName} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BatchDetail({ batch, onClose, actions }: { batch: Batch; onClose: () => void; actions?: ReactNode }) {
  const { invoicesById } = useStore();
  const invoices = batch.invoiceIds.map((id) => invoicesById.get(id)).filter((i): i is Invoice => !!i);
  const check = verifyBatchTotal(batch, invoices);
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
          {actions}
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
      <BatchInvoicesTable invoices={invoices} />
    </Modal>
  );
}
