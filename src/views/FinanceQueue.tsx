import { useState } from 'react';
import { markPaid } from '../data/actions';
import { useStore } from '../data/store';
import { downloadPaymentWorkbook } from '../lib/excel';
import { formatDateTime, formatINR, todayIso } from '../lib/format';
import { routeLabel } from '../lib/workflow';
import type { Batch } from '../types';
import { BatchDetail } from '../components/BatchDetail';
import { Empty, ErrorNote, useAction } from '../components/ui';

function PayPanel({ batch, onDone }: { batch: Batch; onDone: () => void }) {
  const { be, me } = useStore();
  const [ref, setRef] = useState('');
  const { busy, error, run } = useAction();
  return (
    <div className="decision">
      <ErrorNote error={error} />
      <input className="decision-input" placeholder="Payment reference / UTR (required)" value={ref} onChange={(e) => setRef(e.target.value)} />
      <button className="btn btn-success" disabled={busy || !ref.trim()} onClick={() => run(async () => { await markPaid(be, me.email, batch, ref); onDone(); })}>
        Mark as paid
      </button>
    </div>
  );
}

export function FinanceQueue() {
  const { batches, invoicesById, loaded } = useStore();
  const [openId, setOpenId] = useState<string | null>(null);
  const queue = batches.filter((b) => b.status === 'WITH_FINANCE');
  const paid = batches.filter((b) => b.status === 'PAID').slice(0, 30);
  const open = openId ? batches.find((b) => b.id === openId) : undefined;
  const total = queue.reduce((s, b) => s + b.totalAmount, 0);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Payment queue</h1>
          <p className="muted">{queue.length} approved batch(es) ready for payment · {formatINR(total)}</p>
        </div>
        <button
          className="btn btn-primary"
          disabled={!queue.length}
          onClick={() => downloadPaymentWorkbook(queue, invoicesById, `Ready_for_payment_${todayIso()}.xlsx`)}
        >⬇ Excel of all ready batches</button>
      </div>

      {!loaded ? <Empty>Loading…</Empty> : queue.length === 0 ? <Empty>No batches waiting for payment.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Batch</th><th>Category</th><th>Invoices</th><th className="num">Total</th><th>Route</th><th>Cleared</th><th /></tr></thead>
            <tbody>
              {queue.map((b) => (
                <tr key={b.id}>
                  <td>{b.batchNo}</td><td>{b.category}</td><td>{b.invoiceCount}</td>
                  <td className="num"><b>{formatINR(b.totalAmount)}</b></td>
                  <td className="small">{routeLabel(b.requiresL3)}</td>
                  <td className="small">{formatDateTime(b.updatedAt)}</td>
                  <td className="actions-col">
                    <button className="btn btn-sm btn-ghost" onClick={() => downloadPaymentWorkbook([b], invoicesById, `${b.batchNo}.xlsx`)}>⬇ Excel</button>
                    <button className="btn btn-sm btn-primary" onClick={() => setOpenId(b.id)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="section-title">Recently paid</h2>
      {paid.length === 0 ? <Empty>No payments recorded yet.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Batch</th><th>Category</th><th className="num">Total</th><th>UTR / Ref</th><th>Paid</th></tr></thead>
            <tbody>
              {paid.map((b) => (
                <tr key={b.id} className="clickable" onClick={() => setOpenId(b.id)}>
                  <td>{b.batchNo}</td><td>{b.category}</td><td className="num">{formatINR(b.totalAmount)}</td>
                  <td className="mono small">{b.paymentRef}</td><td className="small">{formatDateTime(b.paidAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <BatchDetail
          batch={open}
          onClose={() => setOpenId(null)}
          actions={open.status === 'WITH_FINANCE' ? <PayPanel batch={open} onDone={() => setOpenId(null)} /> : undefined}
        />
      )}
    </section>
  );
}
