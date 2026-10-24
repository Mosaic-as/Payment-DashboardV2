import { useRef, useState } from 'react';
import { approveBatch, approveSelected, notifyFinance, rejectBatch, returnInvoices } from '../data/actions';
import { useStore } from '../data/store';
import { config } from '../config';
import { formatDateTime, formatINR, formatLakh } from '../lib/format';
import { LEVEL_OF, ROLE_QUEUE, nextStatusOnApprove, routeLabel, verifyBatchTotal } from '../lib/workflow';
import { STAGE_LABELS, type Batch } from '../types';
import { BatchDetail } from '../components/BatchDetail';
import { Empty, ErrorNote, StageBadge, useAction } from '../components/ui';

function DecisionPanel({ batch, selected, clearSelection, onDone }: {
  batch: Batch;
  /** Invoices ticked in the batch table. */
  selected: string[];
  clearSelection: () => void;
  onDone: () => void;
}) {
  const { be, me, invoicesById, mailSettings, nameOf } = useStore();
  const [comment, setComment] = useState('');
  const [mode, setMode] = useState<'idle' | 'reject'>('idle');
  // When this decision completes the approvals, email the finance team (in the
  // background; the outcome and a Resend button show on the batch).
  const afterDecision = (b: Batch | null | undefined) => {
    if (b?.status === 'WITH_FINANCE') void notifyFinance(be, me.email, b, invoicesById, mailSettings, nameOf).catch(() => {});
  };
  const { busy, error, setError, run } = useAction();
  const inputRef = useRef<HTMLInputElement>(null);
  const ok = verifyBatchTotal(batch, [...invoicesById.values()]).ok;
  const next = STAGE_LABELS[nextStatusOnApprove(batch)];
  const alreadyApproved = (batch.levelApproved ?? []).length;

  // Buttons stay clickable; a missing reason is explained instead of silently disabling them.
  function needReason(what: string) {
    if (comment.trim()) return false;
    setError(`Type the reason for ${what} first — User 1 will see it.`);
    inputRef.current?.focus();
    return true;
  }

  if (selected.length) {
    const amount = selected.reduce((s, id) => s + (invoicesById.get(id)?.totalAmount ?? 0), 0);
    const all = selected.length >= batch.invoiceIds.length;
    return (
      <div className="decision">
        <ErrorNote error={error} />
        <span className="small"><b>{selected.length}</b> ticked · {formatINR(amount)}</span>
        <input
          ref={inputRef}
          className="decision-input"
          placeholder="Comment — required when returning (User 1 sees it)"
          value={comment}
          onChange={(e) => { setComment(e.target.value); setError(''); }}
        />
        <button className="btn btn-ghost" onClick={clearSelection}>Clear</button>
        {!all && (
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() => !needReason('returning') && run(async () => {
              afterDecision(await returnInvoices(be, me.email, batch, selected, comment, invoicesById));
              setComment('');
              clearSelection();
            })}
          >
            {`Return ${selected.length} to User 1`}
          </button>
        )}
        <button
          className="btn btn-success"
          disabled={busy || !ok}
          onClick={() => run(async () => {
            const moved = await approveSelected(be, me.email, batch, selected, comment, invoicesById);
            setComment('');
            clearSelection();
            afterDecision(moved);
            if (moved) onDone();
          })}
        >
          {busy ? 'Saving…' : `Approve ${selected.length}`}
        </button>
      </div>
    );
  }

  return (
    <div className="decision">
      <ErrorNote error={error} />
      <input
        ref={inputRef}
        className="decision-input"
        placeholder={mode === 'reject' ? 'Reason for rejecting the whole batch (required) — sent back to User 1' : 'Comment (optional)'}
        value={comment}
        onChange={(e) => { setComment(e.target.value); setError(''); }}
      />
      {mode === 'reject' ? (
        <>
          <button className="btn btn-ghost" onClick={() => setMode('idle')}>Back</button>
          <button className="btn btn-danger" disabled={busy} onClick={() => !needReason('rejecting') && run(async () => { await rejectBatch(be, me.email, batch, comment); onDone(); })}>
            Confirm reject batch
          </button>
        </>
      ) : (
        <>
          <button className="btn btn-outline danger" onClick={() => { setMode('reject'); inputRef.current?.focus(); }}>Reject batch…</button>
          <button
            className="btn btn-success"
            disabled={busy || !ok}
            title={`Moves the batch to: ${next}`}
            onClick={() => run(async () => { afterDecision(await approveBatch(be, me.email, batch, comment, invoicesById)); onDone(); })}
          >
            {busy ? 'Approving…' : alreadyApproved ? `Approve remaining ${batch.invoiceIds.length - alreadyApproved} → ${next}` : `Approve all → ${next}`}
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
          actions={open.status === status
            ? (selected, clear) => <DecisionPanel batch={open} selected={selected} clearSelection={clear} onDone={() => setOpenId(null)} />
            : undefined}
        />
      )}
    </section>
  );
}
