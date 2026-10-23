import { useEffect, useState, type ReactNode } from 'react';
import { STAGE_LABELS, type InvoiceStage } from '../types';
import { useStore } from '../data/store';

export function Modal({ title, onClose, children, footer, wide }: {
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function StageBadge({ stage }: { stage: InvoiceStage }) {
  return <span className={`badge badge-${stage.toLowerCase()}`}>{STAGE_LABELS[stage]}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className={`kpi ${tone ? 'kpi-' + tone : ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

/** Runs an async action with busy state and a visible error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      console.error(e);
      const msg = (e as Error).message || String(e);
      setError(msg.includes('permission') ? 'You do not have permission to do this (blocked by security rules).' : msg);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

export function ErrorNote({ error }: { error: string }) {
  return error ? <div className="note note-error" role="alert">{error}</div> : null;
}

export function AttachmentLink({ path, name }: { path: string; name: string }) {
  const { be } = useStore();
  const { busy, error, run } = useAction();
  if (!path) return <span className="muted">No file</span>;
  return (
    <span>
      <button
        className="link-btn"
        disabled={busy}
        onClick={() => run(async () => {
          const win = window.open('', '_blank');
          const url = await be.getFileUrl(path);
          if (win) win.location.href = url; else window.open(url, '_blank');
        })}
        title={name}
      >
        {busy ? 'Opening…' : '📎 View'}
      </button>
      {error && <span className="err-inline"> {error}</span>}
    </span>
  );
}
