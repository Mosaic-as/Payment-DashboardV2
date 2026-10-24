import { useEffect, useState, type ReactNode } from 'react';
import { STAGE_LABELS, type Invoice, type InvoiceStage } from '../types';
import { useStore } from '../data/store';

export function Modal({ title, onClose, children, footer, wide, xl }: {
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
  /** Nearly full-screen, for the form + invoice copy side by side. */
  xl?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''} ${xl ? 'modal-xl' : ''}`} role="dialog" aria-modal="true">
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

export function StageBadge({ stage, label }: { stage: InvoiceStage; label?: string }) {
  return <span className={`badge badge-${stage.toLowerCase()}`}>{label ?? STAGE_LABELS[stage]}</span>;
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
      // Keep Firebase's error code visible: it tells rules problems from connection problems.
      const code = (e as { code?: string }).code;
      setError(code === 'permission-denied'
        ? `Blocked by the database security rules (permission-denied). Make sure the latest rules are published. Details: ${msg}`
        : code ? `${msg} [${code}]` : msg);
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

export function AttachmentLink({ inv }: { inv: Pick<Invoice, 'filePath' | 'fileName' | 'fileUrl'> }) {
  const { be } = useStore();
  const { busy, error, run } = useAction();
  const { filePath: path, fileName: name, fileUrl } = inv;
  if (!path) return <span className="muted">No file</span>;
  // Drive copies open in Drive, which checks the viewer's own access.
  if (fileUrl) return <a className="link-btn" href={fileUrl} target="_blank" rel="noreferrer" title={name}>📎 View</a>;
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
