import { useMemo, useState } from 'react';
import { recordPayments } from '../data/actions';
import { useStore } from '../data/store';
import { downloadPaymentWorkbook } from '../lib/excel';
import { formatDate, formatDateTime, formatINR, round2, todayIso } from '../lib/format';
import { checkPayment, downloadUtrTemplate, parseUtrRows, readUploadedRows, type PaymentInput } from '../lib/payments';
import { routeLabel } from '../lib/workflow';
import type { Batch, Invoice } from '../types';
import { BatchDetail } from '../components/BatchDetail';
import { Empty, ErrorNote, Modal, useAction } from '../components/ui';

const paidCount = (b: Batch) => Object.keys(b.payments ?? {}).length;

/** Finance types or corrects UTRs for one batch. */
function PaymentsEditor({ batch }: { batch: Batch }) {
  const { be, me, invoicesById } = useStore();
  const invoices = batch.invoiceIds.map((id) => invoicesById.get(id)).filter((i): i is Invoice => !!i);
  type Draft = { utr: string; date: string; tds: string; paid: string };
  const initial = () => Object.fromEntries(invoices.map((i) => {
    const p = batch.payments?.[i.id];
    return [i.id, p ? { utr: p.utr, date: p.date, tds: String(p.tds), paid: String(p.paid) } : { utr: '', date: '', tds: '', paid: '' }];
  })) as Record<string, Draft>;
  const [draft, setDraft] = useState<Record<string, Draft>>(initial);
  const { busy, error, setError, run } = useAction();
  const [saved, setSaved] = useState('');
  const set = (id: string, k: keyof Draft, v: string) => { setDraft((d) => ({ ...d, [id]: { ...d[id], [k]: v } })); setSaved(''); };

  function collect() {
    const entries: { invoiceId: string; payment: PaymentInput }[] = [];
    const errors: string[] = [];
    for (const i of invoices) {
      const d = draft[i.id];
      const p = batch.payments?.[i.id];
      if (!d.utr.trim()) {
        if (p) errors.push(`${i.invoiceNumber}: a recorded UTR cannot be cleared.`);
        continue;
      }
      const tds = d.tds.trim() === '' ? 0 : Number(d.tds.replace(/,/g, ''));
      const paid = d.paid.trim() === '' ? round2(i.totalAmount - (Number.isFinite(tds) ? tds : 0)) : Number(d.paid.replace(/,/g, ''));
      const payment: PaymentInput = { utr: d.utr.trim().toUpperCase().replace(/\s+/g, ''), date: d.date, tds: round2(tds), paid: round2(paid) };
      if (p && p.utr === payment.utr && p.date === payment.date && p.tds === payment.tds && p.paid === payment.paid) continue;
      const c = checkPayment(payment, i);
      if (c.errors.length) errors.push(`${i.invoiceNumber}: ${c.errors.join(' ')}`);
      else entries.push({ invoiceId: i.id, payment });
    }
    return { entries, errors };
  }

  return (
    <div className="card payments-editor">
      <h3>Enter payments <span className="muted small">— TDS defaults to 0; Amount paid defaults to Total − TDS</span></h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Invoice no.</th><th>Vendor</th><th className="num">Total</th><th>UTR</th><th>Payment date</th><th>TDS</th><th>Amount paid</th></tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id}>
                <td>{i.invoiceNumber}</td>
                <td className="wrap">{i.vendorName}</td>
                <td className="num">{formatINR(i.totalAmount)}</td>
                <td><input className="mono" value={draft[i.id].utr} maxLength={22} placeholder="UTR" onChange={(e) => set(i.id, 'utr', e.target.value.toUpperCase())} /></td>
                <td><input type="date" value={draft[i.id].date} max={todayIso()} onChange={(e) => set(i.id, 'date', e.target.value)} /></td>
                <td><input inputMode="decimal" value={draft[i.id].tds} placeholder="0" onChange={(e) => set(i.id, 'tds', e.target.value)} className="amount-input" /></td>
                <td>
                  <input
                    inputMode="decimal"
                    value={draft[i.id].paid}
                    className="amount-input"
                    placeholder={round2(i.totalAmount - (Number(draft[i.id].tds) || 0)).toFixed(2)}
                    onChange={(e) => set(i.id, 'paid', e.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row-gap">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => run(async () => {
            const { entries, errors } = collect();
            if (errors.length) { setError(errors.join(' • ')); return; }
            if (!entries.length) { setSaved('Nothing new to save.'); return; }
            const done = await recordPayments(be, me.email, batch, entries);
            setSaved(done ? `Saved — all invoices paid, batch marked Paid.` : `Saved ${entries.length} payment(s).`);
          })}
        >{busy ? 'Saving…' : 'Save payments'}</button>
        {saved && <span className="small ok-text">{saved}</span>}
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

type Parsed = ReturnType<typeof parseUtrRows> & { fileName: string };

/** Bulk UTR upload from the Excel template, with a preview before saving. */
function UtrUploadModal({ onClose }: { onClose: () => void }) {
  const { be, me, batches, batchesById, invoicesById } = useStore();
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [result, setResult] = useState('');
  const { busy, error, run } = useAction();

  async function onFile(file: File) {
    setResult('');
    const rows = readUploadedRows(await file.arrayBuffer());
    setParsed({ ...parseUtrRows(rows, batches, invoicesById), fileName: file.name });
  }

  async function save() {
    if (!parsed) return;
    const byBatch = new Map<string, { invoiceId: string; payment: PaymentInput }[]>();
    for (const r of parsed.ready) {
      const list = byBatch.get(r.batchId) ?? [];
      list.push({ invoiceId: r.invoiceId, payment: { utr: r.utr, date: r.date, tds: r.tds, paid: r.paid } });
      byBatch.set(r.batchId, list);
    }
    let saved = 0, fullyPaid = 0;
    const failed: string[] = [];
    for (const [batchId, entries] of byBatch) {
      const b = batchesById.get(batchId)!;
      try {
        if (await recordPayments(be, me.email, b, entries)) fullyPaid++;
        saved += entries.length;
      } catch (e) {
        failed.push(`${b.batchNo}: ${(e as Error).message}`);
      }
    }
    setResult(`Recorded ${saved} payment(s)${fullyPaid ? `; ${fullyPaid} batch(es) now fully paid` : ''}.${failed.length ? ` Not saved — ${failed.join(' • ')}` : ''}`);
    setParsed(null);
  }

  return (
    <Modal
      wide
      title="Upload UTRs from Excel"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
          {parsed && (
            <button className="btn btn-primary" disabled={busy || !parsed.ready.length} onClick={() => run(save)}>
              {busy ? 'Saving…' : `Record ${parsed.ready.length} payment(s)`}
            </button>
          )}
        </>
      }
    >
      {result && <div className="note note-ok">{result}</div>}
      <label className="file-pick upload-pick">
        Choose the filled UTR template (.xlsx)
        <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files?.[0] && run(() => onFile(e.target.files![0]))} />
      </label>
      <p className="muted small">Download the template from <b>⬇ UTR template</b>. Rows without a UTR are ignored. Nothing is saved until you confirm.</p>
      <ErrorNote error={error} />
      {parsed && (
        <>
          <div className="kpis upload-kpis">
            <div className="kpi kpi-good"><div className="kpi-label">Ready to record</div><div className="kpi-value">{parsed.ready.length}</div></div>
            <div className={`kpi ${parsed.problems.length ? 'kpi-bad' : ''}`}><div className="kpi-label">Problems (skipped)</div><div className="kpi-value">{parsed.problems.length}</div></div>
            <div className={`kpi ${parsed.warnings.length ? 'kpi-warn' : ''}`}><div className="kpi-label">Warnings</div><div className="kpi-value">{parsed.warnings.length}</div></div>
          </div>
          {parsed.problems.length > 0 && (
            <div className="checks">
              {parsed.problems.map((p) => <div key={`p${p.row}${p.message}`} className="check check-error">✕ Row {p.row}: {p.message}</div>)}
            </div>
          )}
          {parsed.warnings.length > 0 && (
            <div className="checks">
              {parsed.warnings.map((w) => <div key={`w${w.row}${w.message}`} className="check check-warn">! Row {w.row}: {w.message}</div>)}
            </div>
          )}
          {parsed.ready.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Row</th><th>Batch</th><th>Vendor</th><th>Invoice no.</th><th className="num">Total</th><th>UTR</th><th>Paid on</th><th className="num">TDS</th><th className="num">Paid</th></tr></thead>
                <tbody>
                  {parsed.ready.map((r) => (
                    <tr key={r.invoiceId}>
                      <td>{r.row}</td><td>{r.batchNo}</td><td className="wrap">{r.invoice.vendorName}</td><td>{r.invoice.invoiceNumber}</td>
                      <td className="num">{formatINR(r.invoice.totalAmount)}</td><td className="mono small">{r.utr}</td><td>{formatDate(r.date)}</td>
                      <td className="num">{formatINR(r.tds)}</td><td className="num">{formatINR(r.paid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

export function FinanceQueue() {
  const { batches, invoicesById, loaded } = useStore();
  const [openId, setOpenId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const queue = batches.filter((b) => b.status === 'WITH_FINANCE');
  const paid = batches.filter((b) => b.status === 'PAID').slice(0, 30);
  const open = openId ? batches.find((b) => b.id === openId) : undefined;
  const outstanding = useMemo(
    () => queue.reduce((s, b) => s + b.invoiceIds.filter((id) => !b.payments?.[id]).reduce((t, id) => t + (invoicesById.get(id)?.totalAmount ?? 0), 0), 0),
    [queue, invoicesById],
  );
  const unpaidInvoices = queue.reduce((s, b) => s + b.invoiceIds.length - paidCount(b), 0);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Payment queue</h1>
          <p className="muted">{queue.length} approved batch(es) · {unpaidInvoices} invoice(s) awaiting UTR · {formatINR(outstanding)} outstanding</p>
        </div>
        <div className="row-gap">
          <button className="btn btn-outline" disabled={!unpaidInvoices} onClick={() => downloadUtrTemplate(batches, invoicesById)}>⬇ UTR template</button>
          <button className="btn btn-primary" disabled={!unpaidInvoices} onClick={() => setUploading(true)}>⬆ Upload UTRs</button>
          <button className="btn btn-outline" disabled={!queue.length} onClick={() => downloadPaymentWorkbook(queue, invoicesById, `Ready_for_payment_${todayIso()}.xlsx`)}>
            ⬇ Excel of batches
          </button>
        </div>
      </div>

      {!loaded ? <Empty>Loading…</Empty> : queue.length === 0 ? <Empty>No batches waiting for payment.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Batch</th><th>Category</th><th>Paid</th><th className="num">Total</th><th>Route</th><th>Finance email</th><th>Cleared</th><th /></tr></thead>
            <tbody>
              {queue.map((b) => (
                <tr key={b.id}>
                  <td>{b.batchNo}</td><td>{b.category}</td>
                  <td><b>{paidCount(b)}</b>/{b.invoiceIds.length}</td>
                  <td className="num"><b>{formatINR(b.totalAmount)}</b></td>
                  <td className="small">{routeLabel(b.requiresL3)}</td>
                  <td className="small">{b.financeMail?.status === 'sent' ? '✓ Sent' : b.financeMail?.status === 'failed' ? <span className="danger">Failed</span> : '—'}</td>
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
      {paid.length === 0 ? <Empty>No fully paid batches yet.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Batch</th><th>Category</th><th className="num">Total</th><th className="num">TDS</th><th className="num">Paid</th><th>Fully paid</th></tr></thead>
            <tbody>
              {paid.map((b) => {
                const ps = Object.values(b.payments ?? {});
                return (
                  <tr key={b.id} className="clickable" onClick={() => setOpenId(b.id)}>
                    <td>{b.batchNo}</td><td>{b.category}</td><td className="num">{formatINR(b.totalAmount)}</td>
                    <td className="num">{formatINR(ps.reduce((s, p) => s + p.tds, 0))}</td>
                    <td className="num">{formatINR(ps.reduce((s, p) => s + p.paid, 0))}</td>
                    <td className="small">{formatDateTime(b.paidAt)}</td>
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
          extra={open.status === 'WITH_FINANCE' ? <PaymentsEditor key={open.id + paidCount(open)} batch={open} /> : undefined}
        />
      )}
      {uploading && <UtrUploadModal onClose={() => setUploading(false)} />}
    </section>
  );
}
