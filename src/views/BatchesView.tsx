import { useState } from 'react';
import { config } from '../config';
import { useStore } from '../data/store';
import { downloadPaymentWorkbook } from '../lib/excel';
import { formatDateTime, formatINR, todayIso } from '../lib/format';
import { routeLabel } from '../lib/workflow';
import { STAGE_LABELS, type BatchStatus } from '../types';
import { BatchDetail } from '../components/BatchDetail';
import { Empty, StageBadge } from '../components/ui';

const STATUSES: BatchStatus[] = ['PENDING_L1', 'PENDING_L2', 'PENDING_L3', 'WITH_FINANCE', 'PAID', 'REJECTED'];

/** Read-only register of every batch, with the master Excel export. */
export function BatchesView() {
  const { batches, invoicesById, nameOf, loaded } = useStore();
  const [status, setStatus] = useState<BatchStatus | ''>('');
  const [category, setCategory] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = batches.filter((b) => (!status || b.status === status) && (!category || b.category === category));
  const open = openId ? batches.find((b) => b.id === openId) : undefined;
  const sentForPayment = batches.filter((b) => b.status !== 'REJECTED');

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>All batches</h1>
          <p className="muted">Every batch sent for payment approval, with its approval trail.</p>
        </div>
        <div className="row-gap">
          <button className="btn btn-outline" disabled={!rows.length} onClick={() => downloadPaymentWorkbook(rows, invoicesById, `Batches_filtered_${todayIso()}.xlsx`)}>
            ⬇ Excel (filtered)
          </button>
          <button
            className="btn btn-primary"
            disabled={!sentForPayment.length}
            title="All invoices ever sent for payment, excluding rejected batches"
            onClick={() => downloadPaymentWorkbook(sentForPayment, invoicesById, `Payment_Register_${todayIso()}.xlsx`)}
          >⬇ Payment register</button>
        </div>
      </div>

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value as BatchStatus | '')}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {config.expenseCategories.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>

      {!loaded ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No batches yet.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Batch</th><th>Category</th><th>Invoices</th><th className="num">Total</th><th>Route</th><th>Status</th><th>Sent by</th><th>Last update</th></tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className="clickable" onClick={() => setOpenId(b.id)}>
                  <td>{b.batchNo}</td><td>{b.category}</td><td>{b.invoiceCount}</td>
                  <td className="num"><b>{formatINR(b.totalAmount)}</b></td>
                  <td className="small">{routeLabel(b.requiresL3)}</td>
                  <td><StageBadge stage={b.status} /></td>
                  <td className="small">{nameOf(b.createdBy)}</td>
                  <td className="small">{formatDateTime(b.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <BatchDetail batch={open} onClose={() => setOpenId(null)} />}
    </section>
  );
}
