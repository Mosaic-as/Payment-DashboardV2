import { useState } from 'react';
import { approveBatch, rejectBatch } from '../data/actions';
import { useStore } from '../data/store';
import { config } from '../config';
import { formatDateTime, formatINR, formatLakh } from '../lib/format';
import { LEVEL_OF, ROLE_QUEUE, nextStatusOnApprove, routeLabel, verifyBatchTotal } from '../lib/workflow';
import { STAGE_LABELS, type Batch } from '../types';
import { BatchDetail } from '../components/BatchDetail';
import { Empty, ErrorNote, StageBadge, useAction } from '../components/ui';

function DecisionPanel({ batch, onDone }: { batch: Batch; onDone: () => void }) {
  const { be, me, invoicesById } = useStore();
  const [comment, setComment] = useState('');
  const [mode, setMode] = useState<'idle' | 'reject'>('idle');
  const { busy, error, run } = useAction();
  const ok = verifyBatchTotal(batch, [...invoicesById.values()]).ok;
  const next = STAGE_LABELS[nextStatusOnApprove(batch)];

  return (
    <div className="decision">
      <ErrorNote error={error} />
      <input
        className="decision-input"
        placeholder={mode === 'reject' ? 'Reason for rejection (required) — sent back to User 1' : 'Comment (optional)'}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      {mode === 'reject' ? (
        <>
          <button className="btn btn-ghost" onClick={() => setMode('idle')}>Back</button>
          <button className="btn btn-danger" disabled={busy || !comment.trim()} onClick={() => run(async () => { await rejectBatch(be, me.email, batch, comment); onDone(); })}>
            Confirm reject
          </button>
        </>
      ) : (
        <>
          <button className="btn btn-outline danger" onClick={() => setMode('reject')}>Reject…</button>
          <button
            className="btn btn-success"
            disabled={busy || !ok}
            title={`Moves the batch to: ${next}`}
            onClick={() => run(async () => { await approveBatch(be, me.email, batch, comment, invoicesById); onDone(); })}
          >
            {busy ? 'Approving…' : `Approve → ${next}`}
          </button>
        </>
      )}
    </div>
  );
}

export function ApprovalQueue() {
  const { me, batches, nameOf, loaded } = useStore();
  const status = ROLE_QUEUE[me.profile.role]!;
  const level = LEVEL_OF[status]!;
  const [openId, setOpenId] = useState<string | null>(null);
  const queue = batches.filter((b) => b.status === status).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const mine = batches.filter((b) => b.approvals.some((a) => a.level === level && a.by === me.email)).slice(0, 20);
  const open = openId ? batches.find((b) => b.id === openId) : undefined;
  const total = queue.reduce((s, b) => s + b.totalAmount, 0);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Approval queue — Level {level}</h1>
          <p className="muted">
            {queue.length} batch(es) awaiting your approval · {formatINR(total)}
            {level === 2 && ` · Batches above ${formatLakh(config.l3Threshold)} go to L3 after you; others go straight to Finance.`}
          </p>
        </div>
      </div>

      {!loaded ? <Empty>Loading…</Empty> : queue.length === 0 ? <Empty>🎉 Nothing waiting for you.</Empty> : (
        <div className="cards">
          {queue.map((b) => (
            <button key={b.id} className="batch-card" onClick={() => setOpenId(b.id)}>
              <div className="batch-card-head">
                <b>{b.category}</b>
                <span className={`route ${b.requiresL3 ? 'route-l3' : ''}`}>{routeLabel(b.requiresL3)}</span>
              </div>
              <div className="batch-card-amt">{formatINR(b.totalAmount)}</div>
              <div className="muted small">{b.batchNo} · {b.invoiceCount} invoice(s)</div>
              <div className="muted small">Sent by {nameOf(b.createdBy)} · waiting since {formatDateTime(b.updatedAt)}</div>
              <span className="btn btn-sm btn-primary">Review →</span>
            </button>
          ))}
        </div>
      )}

      <h2 className="section-title">Recently actioned by you</h2>
      {mine.length === 0 ? <Empty>No decisions yet.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Batch</th><th>Category</th><th className="num">Total</th><th>Your decision</th><th>Current status</th></tr></thead>
            <tbody>
              {mine.map((b) => {
                const a = [...b.approvals].reverse().find((x) => x.level === level && x.by === me.email)!;
                return (
                  <tr key={b.id} className="clickable" onClick={() => setOpenId(b.id)}>
                    <td>{b.batchNo}</td><td>{b.category}</td><td className="num">{formatINR(b.totalAmount)}</td>
                    <td>{a.decision === 'APPROVED' ? '✓ Approved' : '✕ Rejected'} <span className="muted small">{formatDateTime(a.at)}</span></td>
                    <td><StageBadge stage={b.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <BatchDetail
          batch={open}
          onClose={() => setOpenId(null)}
          actions={open.status === status ? <DecisionPanel batch={open} onDone={() => setOpenId(null)} /> : undefined}
        />
      )}
    </section>
  );
}
