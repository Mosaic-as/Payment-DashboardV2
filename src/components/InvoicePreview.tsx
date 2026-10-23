import { useEffect, useState } from 'react';
import { useStore } from '../data/store';
import type { Invoice } from '../types';

const isPdfName = (name: string) => /\.pdf$/i.test(name);

/**
 * Shows the invoice copy next to the form: a freshly chosen file is shown
 * straight from the computer; a saved copy is shown from Google Drive.
 */
export function InvoicePreview({ file, inv }: { file?: File | null; inv?: Pick<Invoice, 'filePath' | 'fileName' | 'fileUrl'> | null }) {
  const { be } = useStore();
  const [src, setSrc] = useState<{ url: string; kind: 'pdf' | 'image' | 'drive' } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    if (file) {
      const url = URL.createObjectURL(file);
      setSrc({ url, kind: file.type === 'application/pdf' || isPdfName(file.name) ? 'pdf' : 'image' });
      return () => URL.revokeObjectURL(url);
    }
    if (inv?.fileUrl) {
      // Drive's embeddable viewer; it uses the viewer's own Google login.
      setSrc({ url: inv.fileUrl.replace(/\/view$/, '/preview'), kind: 'drive' });
      return;
    }
    if (inv?.filePath) {
      let revoke = '';
      be.getFileUrl(inv.filePath)
        .then((url) => { revoke = url; setSrc({ url, kind: isPdfName(inv.fileName) ? 'pdf' : 'image' }); })
        .catch((e) => { setSrc(null); setError((e as Error).message); });
      return () => { if (revoke.startsWith('blob:')) URL.revokeObjectURL(revoke); };
    }
    setSrc(null);
  }, [file, inv?.filePath, inv?.fileUrl, inv?.fileName, be]);

  return (
    <aside className="preview" aria-label="Invoice copy">
      {src ? (
        <>
          <div className="preview-bar">
            <span className="muted small" title={file?.name ?? inv?.fileName}>{file?.name ?? inv?.fileName}</span>
            <a className="link-btn small" href={inv?.fileUrl && !file ? inv.fileUrl : src.url} target="_blank" rel="noreferrer">Open in new tab ↗</a>
          </div>
          {src.kind === 'image'
            ? <div className="preview-img"><img src={src.url} alt="Invoice copy" /></div>
            : <iframe className="preview-frame" src={src.kind === 'pdf' ? `${src.url}#view=FitH&navpanes=0` : src.url} title="Invoice copy" />}
        </>
      ) : (
        <div className="preview-empty">
          <div className="preview-icon" aria-hidden>📄</div>
          {error || 'Choose the invoice file — it will appear here so you can read the details while filling in the form.'}
        </div>
      )}
    </aside>
  );
}
