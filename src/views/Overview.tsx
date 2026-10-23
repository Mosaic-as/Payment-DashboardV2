import { useMemo } from 'react';
import { useStore } from '../data/store';
import { formatINR, formatLakh } from '../lib/format';
import { stageOf } from '../lib/workflow';
import { STAGE_LABELS, type BatchStatus } from '../types';
import { Kpi } from '../components/ui';

const PIPELINE: BatchStatus[] = ['PENDING_L1', 'PENDING_L2', 'PENDING_L3', 'WITH_FINANCE'];

export function Overview() {
  const { invoices, batches, batchesById } = useStore();

  const stats = useMemo(() => {
    const stages = invoices.map((i) => ({ i, s: stageOf(i, batchesById) }));
    const sum = (xs: { totalAmount: number }[]) => xs.reduce((a, x) => a + x.totalAmount, 0);
    const pipeline = PIPELINE.map((st) => {
      const bs = batches.filter((b) => b.status === st);
      return { st, count: bs.length, amount: sum(bs) };
    });
    const month = new Date().toISOString().slice(0, 7);
    const paidThisMonth = batches.filter((b) => b.status === 'PAID' && b.paidAt?.startsWith(month));
    const inFlight = batches.filter((b) => PIPELINE.includes(b.status));
    const byCat = new Map<string, number>();
    inFlight.forEach((b) => byCat.set(b.category, (byCat.get(b.category) ?? 0) + b.totalAmount));
    const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    return {
      draft: stages.filter((x) => x.s === 'DRAFT').length,
      validated: stages.filter((x) => x.s === 'VALIDATED'),
      returned: stages.filter((x) => x.s === 'RETURNED').length,
      pipeline,
      paidThisMonth: { count: paidThisMonth.length, amount: sum(paidThisMonth) },
      cats,
      maxCat: Math.max(1, ...cats.map((c) => c[1])),
    };
  }, [invoices, batches, batchesById]);

  return (
    <section>
      <div className="page-head"><div><h1>Dashboard</h1><p className="muted">Live view of invoices and payment batches across the approval chain.</p></div></div>

      <h2 className="section-title">With User 1</h2>
      <div className="kpis">
        <Kpi label="Draft (to validate)" value={stats.draft} />
        <Kpi label="Validated, not sent" value={stats.validated.length} sub={formatLakh(stats.validated.reduce((a, x) => a + x.i.totalAmount, 0))} />
        <Kpi label="Returned by approvers" value={stats.returned} tone={stats.returned ? 'warn' : undefined} />
      </div>

      <h2 className="section-title">Approval pipeline (batches)</h2>
      <div className="kpis">
        {stats.pipeline.map((p) => (
          <Kpi key={p.st} label={STAGE_LABELS[p.st]} value={p.count} sub={formatLakh(p.amount)} tone={p.st === 'WITH_FINANCE' ? 'good' : undefined} />
        ))}
        <Kpi label="Paid this month" value={stats.paidThisMonth.count} sub={formatLakh(stats.paidThisMonth.amount)} />
      </div>

      <h2 className="section-title">In-flight amount by expense category</h2>
      {stats.cats.length === 0 ? <div className="empty">Nothing in the approval pipeline.</div> : (
        <div className="bars">
          {stats.cats.map(([cat, amt]) => (
            <div key={cat} className="bar-row">
              <span className="bar-label">{cat}</span>
              <span className="bar-track"><span className="bar-fill" style={{ width: `${(amt / stats.maxCat) * 100}%` }} /></span>
              <span className="bar-value">{formatINR(amt)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
